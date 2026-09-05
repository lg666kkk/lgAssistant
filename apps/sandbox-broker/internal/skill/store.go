package skill

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
)

var (
	ErrSkillNotFound        = errors.New("skill not found")
	ErrSkillVersionNotFound = errors.New("skill version not found")
	ErrSkillDisabled        = errors.New("skill is disabled")
	ErrSkillVersionConflict = errors.New("immutable skill version already exists with different content")
)

type Definition struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Enabled     bool      `json:"enabled"`
	CreatedBy   string    `json:"createdBy,omitempty"`
	UpdatedBy   string    `json:"updatedBy,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type Version struct {
	Manifest  Manifest  `json:"manifest"`
	Bundle    []byte    `json:"-"`
	CreatedBy string    `json:"createdBy,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type ConfiguredSkill struct {
	Definition Definition `json:"skill"`
	Versions   []Manifest `json:"versions"`
}

type Store interface {
	List(context.Context) ([]ConfiguredSkill, error)
	Upsert(context.Context, Definition) (Definition, error)
	Publish(context.Context, Version) (Version, bool, error)
	GetVersion(context.Context, string, string) (Definition, Version, error)
}

type MemoryStore struct {
	mu          sync.RWMutex
	definitions map[string]Definition
	versions    map[string]Version
	policies    *policy.Registry
	now         func() time.Time
}

var _ Store = (*MemoryStore)(nil)

func NewMemoryStore(policies *policy.Registry) (*MemoryStore, error) {
	if policies == nil {
		return nil, errors.New("policy registry is required")
	}
	return &MemoryStore{
		definitions: make(map[string]Definition),
		versions:    make(map[string]Version),
		policies:    policies,
		now:         time.Now,
	}, nil
}

func (store *MemoryStore) List(ctx context.Context) ([]ConfiguredSkill, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	result := make([]ConfiguredSkill, 0, len(store.definitions))
	for _, definition := range store.definitions {
		item := ConfiguredSkill{Definition: definition}
		for _, version := range store.versions {
			if version.Manifest.ID == definition.ID {
				item.Versions = append(item.Versions, cloneManifest(version.Manifest))
			}
		}
		sort.Slice(item.Versions, func(i, j int) bool {
			return item.Versions[i].Version > item.Versions[j].Version
		})
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Definition.ID < result[j].Definition.ID })
	return result, nil
}

func (store *MemoryStore) Upsert(ctx context.Context, definition Definition) (Definition, error) {
	if err := ctx.Err(); err != nil {
		return Definition{}, err
	}
	if !skillIDPattern.MatchString(definition.ID) || definition.Name == "" {
		return Definition{}, errors.New("valid skill id and name are required")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.now().UTC()
	if current, ok := store.definitions[definition.ID]; ok {
		definition.CreatedAt = current.CreatedAt
		definition.CreatedBy = current.CreatedBy
	} else {
		definition.CreatedAt = now
	}
	definition.UpdatedAt = now
	store.definitions[definition.ID] = definition
	return definition, nil
}

func (store *MemoryStore) Publish(ctx context.Context, version Version) (Version, bool, error) {
	if err := ctx.Err(); err != nil {
		return Version{}, false, err
	}
	if err := version.Manifest.Validate(store.policies); err != nil {
		return Version{}, false, err
	}
	if err := VerifyBundle(version.Bundle, version.Manifest.BundleSHA256); err != nil {
		return Version{}, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, ok := store.definitions[version.Manifest.ID]; !ok {
		return Version{}, false, fmt.Errorf("%w: %s", ErrSkillNotFound, version.Manifest.ID)
	}
	key := manifestKey(version.Manifest.ID, version.Manifest.Version)
	if current, ok := store.versions[key]; ok {
		if manifestsEqual(current.Manifest, version.Manifest) && string(current.Bundle) == string(version.Bundle) {
			return cloneVersion(current), false, nil
		}
		return Version{}, false, fmt.Errorf("%w: %s", ErrSkillVersionConflict, key)
	}
	version.Manifest = cloneManifest(version.Manifest)
	version.Bundle = append([]byte(nil), version.Bundle...)
	version.CreatedAt = store.now().UTC()
	store.versions[key] = version
	return cloneVersion(version), true, nil
}

func (store *MemoryStore) GetVersion(ctx context.Context, id string, version string) (Definition, Version, error) {
	if err := ctx.Err(); err != nil {
		return Definition{}, Version{}, err
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	definition, ok := store.definitions[id]
	if !ok {
		return Definition{}, Version{}, fmt.Errorf("%w: %s", ErrSkillNotFound, id)
	}
	if !definition.Enabled {
		return Definition{}, Version{}, fmt.Errorf("%w: %s", ErrSkillDisabled, id)
	}
	published, ok := store.versions[manifestKey(id, version)]
	if !ok {
		return Definition{}, Version{}, fmt.Errorf("%w: %s@%s", ErrSkillVersionNotFound, id, version)
	}
	return definition, cloneVersion(published), nil
}

func cloneManifest(manifest Manifest) Manifest {
	manifest.Entrypoint = append([]string(nil), manifest.Entrypoint...)
	return manifest
}

func cloneVersion(version Version) Version {
	version.Manifest = cloneManifest(version.Manifest)
	version.Bundle = append([]byte(nil), version.Bundle...)
	return version
}

func manifestsEqual(left Manifest, right Manifest) bool {
	if left.ID != right.ID || left.Version != right.Version || left.Runtime != right.Runtime ||
		left.ProfileID != right.ProfileID || left.ImageDigest != right.ImageDigest ||
		left.BundleSHA256 != right.BundleSHA256 || left.Network != right.Network ||
		left.InputSchema != right.InputSchema || left.OutputSchema != right.OutputSchema ||
		len(left.Entrypoint) != len(right.Entrypoint) {
		return false
	}
	for index := range left.Entrypoint {
		if left.Entrypoint[index] != right.Entrypoint[index] {
			return false
		}
	}
	return true
}
