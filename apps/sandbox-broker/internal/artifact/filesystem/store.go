package filesystem

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/artifact"
)

const defaultMaxArtifactBytes = 10 << 20

var safeSegment = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,127}$`)

type Store struct {
	root     string
	maxBytes int
	now      func() time.Time
}

var _ artifact.Store = (*Store)(nil)

func New(root string, maxBytes int) (*Store, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
		return nil, errors.New("artifact root must be an absolute non-root path")
	}
	if maxBytes <= 0 {
		maxBytes = defaultMaxArtifactBytes
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create artifact root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact root: %w", err)
	}
	return &Store{root: resolved, maxBytes: maxBytes, now: time.Now}, nil
}

func (store *Store) Put(ctx context.Context, request artifact.PutRequest) (artifact.Artifact, error) {
	if err := ctx.Err(); err != nil {
		return artifact.Artifact{}, err
	}
	if !safeSegment.MatchString(request.RunID) || !safeSegment.MatchString(string(request.Kind)) {
		return artifact.Artifact{}, errors.New("artifact run id and kind must use safe path characters")
	}
	if len(request.Data) > store.maxBytes {
		return artifact.Artifact{}, errors.New("artifact exceeds size limit")
	}
	sum := sha256.Sum256(request.Data)
	digest := hex.EncodeToString(sum[:])
	directory := filepath.Join(store.root, request.RunID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return artifact.Artifact{}, fmt.Errorf("create artifact directory: %w", err)
	}
	name := string(request.Kind) + "-" + digest + ".bin"
	path := filepath.Join(directory, name)
	temporary, err := os.CreateTemp(directory, ".artifact-")
	if err != nil {
		return artifact.Artifact{}, fmt.Errorf("create artifact: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return artifact.Artifact{}, fmt.Errorf("secure artifact: %w", err)
	}
	if _, err := temporary.Write(request.Data); err != nil {
		return artifact.Artifact{}, fmt.Errorf("write artifact: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return artifact.Artifact{}, fmt.Errorf("sync artifact: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return artifact.Artifact{}, fmt.Errorf("close artifact: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return artifact.Artifact{}, fmt.Errorf("commit artifact: %w", err)
	}
	committed = true
	return artifact.Artifact{
		Ref:         "artifact://" + request.RunID + "/" + name,
		RunID:       request.RunID,
		Kind:        request.Kind,
		SHA256:      digest,
		SizeBytes:   int64(len(request.Data)),
		ContentType: request.ContentType,
		Truncated:   request.Truncated,
		CreatedAt:   store.now().UTC(),
	}, nil
}

func (store *Store) Read(ctx context.Context, ref string) ([]byte, artifact.Artifact, error) {
	if err := ctx.Err(); err != nil {
		return nil, artifact.Artifact{}, err
	}
	const prefix = "artifact://"
	if !strings.HasPrefix(ref, prefix) {
		return nil, artifact.Artifact{}, artifact.ErrArtifactNotFound
	}
	parts := strings.Split(strings.TrimPrefix(ref, prefix), "/")
	if len(parts) != 2 || !safeSegment.MatchString(parts[0]) || !safeSegment.MatchString(strings.TrimSuffix(parts[1], ".bin")) {
		return nil, artifact.Artifact{}, artifact.ErrArtifactNotFound
	}
	path := filepath.Join(store.root, parts[0], parts[1])
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, artifact.Artifact{}, artifact.ErrArtifactNotFound
	}
	if err != nil {
		return nil, artifact.Artifact{}, fmt.Errorf("read artifact: %w", err)
	}
	nameParts := strings.SplitN(strings.TrimSuffix(parts[1], ".bin"), "-", 2)
	if len(nameParts) != 2 {
		return nil, artifact.Artifact{}, artifact.ErrArtifactNotFound
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if digest != nameParts[1] {
		return nil, artifact.Artifact{}, errors.New("artifact integrity check failed")
	}
	return data, artifact.Artifact{
		Ref:       ref,
		RunID:     parts[0],
		Kind:      artifact.Kind(nameParts[0]),
		SHA256:    digest,
		SizeBytes: int64(len(data)),
	}, nil
}
