package approval

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ErrApprovalNotFound = errors.New("sandbox approval was not found")
	ErrApprovalExpired  = errors.New("sandbox approval has expired")
	ErrApprovalConsumed = errors.New("sandbox approval was already consumed")
	ErrApprovalMismatch = errors.New("sandbox approval does not match the patch")
)

type Grant struct {
	ID             string     `json:"id"`
	UserID         string     `json:"userId"`
	RunID          string     `json:"runId"`
	InputHash      string     `json:"inputHash"`
	ArtifactHash   string     `json:"artifactHash"`
	BaselineCommit string     `json:"baselineCommit"`
	ExpiresAt      time.Time  `json:"expiresAt"`
	ConsumedAt     *time.Time `json:"consumedAt,omitempty"`
}

type MemoryStore struct {
	mu     sync.Mutex
	grants map[string]Grant
	now    func() time.Time
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{grants: make(map[string]Grant), now: time.Now}
}

func (store *MemoryStore) Create(
	userID string,
	runID string,
	inputHash string,
	patch []byte,
	baselineCommit string,
	expiresAt time.Time,
) (Grant, error) {
	if userID == "" || runID == "" || inputHash == "" || baselineCommit == "" || len(patch) == 0 {
		return Grant{}, errors.New("approval identity, hashes, baseline, and patch are required")
	}
	if !expiresAt.After(store.now()) {
		return Grant{}, ErrApprovalExpired
	}
	id, err := randomID()
	if err != nil {
		return Grant{}, err
	}
	grant := Grant{
		ID: id, UserID: userID, RunID: runID, InputHash: inputHash,
		ArtifactHash: PatchHash(patch), BaselineCommit: baselineCommit, ExpiresAt: expiresAt.UTC(),
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.grants[id] = grant
	return grant, nil
}

func (store *MemoryStore) Consume(
	grantID string,
	userID string,
	runID string,
	inputHash string,
	patch []byte,
	baselineCommit string,
) (Grant, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	grant, ok := store.grants[grantID]
	if !ok {
		return Grant{}, ErrApprovalNotFound
	}
	if grant.ConsumedAt != nil {
		return Grant{}, ErrApprovalConsumed
	}
	if !store.now().Before(grant.ExpiresAt) {
		return Grant{}, ErrApprovalExpired
	}
	if grant.UserID != userID || grant.RunID != runID || grant.InputHash != inputHash ||
		grant.ArtifactHash != PatchHash(patch) || grant.BaselineCommit != baselineCommit {
		return Grant{}, ErrApprovalMismatch
	}
	now := store.now().UTC()
	grant.ConsumedAt = &now
	store.grants[grantID] = grant
	return grant, nil
}

func PatchHash(patch []byte) string {
	sum := sha256.Sum256(patch)
	return hex.EncodeToString(sum[:])
}

func ValidateChangedPaths(paths []string, allowedPrefixes []string) error {
	for _, path := range paths {
		clean := filepath.Clean(filepath.FromSlash(path))
		if filepath.IsAbs(path) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return fmt.Errorf("patch path escapes repository: %s", path)
		}
		lower := strings.ToLower(filepath.ToSlash(clean))
		if lower == ".git" || strings.HasPrefix(lower, ".git/") || lower == ".env" || strings.HasPrefix(lower, ".env.") {
			return fmt.Errorf("patch path is protected: %s", path)
		}
		allowed := false
		for _, prefix := range allowedPrefixes {
			cleanPrefix := strings.TrimSuffix(filepath.ToSlash(filepath.Clean(prefix)), "/")
			if lower == strings.ToLower(cleanPrefix) || strings.HasPrefix(lower, strings.ToLower(cleanPrefix)+"/") {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("patch path is outside approved prefixes: %s", path)
		}
	}
	return nil
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate approval id: %w", err)
	}
	return hex.EncodeToString(value), nil
}
