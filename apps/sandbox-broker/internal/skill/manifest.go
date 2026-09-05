package skill

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
)

var (
	skillIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	versionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+$`)
)

type Manifest struct {
	ID           string   `json:"id"`
	Version      string   `json:"version"`
	Runtime      string   `json:"runtime"`
	Entrypoint   []string `json:"entrypoint"`
	ProfileID    string   `json:"profileId"`
	ImageDigest  string   `json:"imageDigest"`
	BundleSHA256 string   `json:"bundleSha256"`
	Network      string   `json:"network"`
	InputSchema  string   `json:"inputSchema"`
	OutputSchema string   `json:"outputSchema"`
}

type Registry struct {
	manifests map[string]Manifest
}

func LoadRegistry(root string, policies *policy.Registry) (*Registry, error) {
	if policies == nil {
		return nil, errors.New("policy registry is required")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("read skill manifest directory: %w", err)
	}
	paths := make([]string, 0)
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("skill manifest cannot be a symlink: %s", entry.Name())
		}
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			paths = append(paths, filepath.Join(root, entry.Name()))
		}
	}
	sort.Strings(paths)
	registry := &Registry{manifests: make(map[string]Manifest, len(paths))}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read skill manifest: %w", err)
		}
		decoder := json.NewDecoder(strings.NewReader(string(data)))
		decoder.DisallowUnknownFields()
		var manifest Manifest
		if err := decoder.Decode(&manifest); err != nil {
			return nil, fmt.Errorf("decode skill manifest %s: %w", filepath.Base(path), err)
		}
		if err := manifest.Validate(policies); err != nil {
			return nil, fmt.Errorf("validate skill manifest %s: %w", filepath.Base(path), err)
		}
		key := manifestKey(manifest.ID, manifest.Version)
		if _, exists := registry.manifests[key]; exists {
			return nil, fmt.Errorf("duplicate immutable skill version: %s", key)
		}
		registry.manifests[key] = manifest
	}
	return registry, nil
}

func (manifest Manifest) Validate(policies *policy.Registry) error {
	if !skillIDPattern.MatchString(manifest.ID) {
		return errors.New("skill id must use lowercase letters, digits, and hyphens")
	}
	if !versionPattern.MatchString(manifest.Version) {
		return errors.New("skill version must be semantic version format")
	}
	if manifest.Runtime != "node" && manifest.Runtime != "python" {
		return errors.New("skill runtime must be node or python")
	}
	if len(manifest.Entrypoint) < 2 || len(manifest.Entrypoint) > 16 {
		return errors.New("skill entrypoint must contain runtime and a bundle script path")
	}
	for _, argument := range manifest.Entrypoint {
		if argument == "" || strings.ContainsAny(argument, "\x00\n\r") {
			return errors.New("skill entrypoint contains an invalid argument")
		}
	}
	expectedRuntime := "node"
	if manifest.Runtime == "python" {
		expectedRuntime = "python3"
	}
	if manifest.Entrypoint[0] != expectedRuntime {
		return fmt.Errorf("skill entrypoint must start with %s", expectedRuntime)
	}
	if err := validateRelativeBundlePath(manifest.Entrypoint[1]); err != nil {
		return fmt.Errorf("invalid skill entrypoint path: %w", err)
	}
	if _, err := policies.Get(manifest.ProfileID); err != nil {
		return err
	}
	if err := sandboxruntime.ValidateImageDigest(manifest.ImageDigest); err != nil {
		return err
	}
	if len(manifest.BundleSHA256) != sha256.Size*2 {
		return errors.New("skill bundle sha256 is required")
	}
	if _, err := hex.DecodeString(manifest.BundleSHA256); err != nil {
		return errors.New("skill bundle sha256 must be hexadecimal")
	}
	if manifest.Network != "disabled" {
		return errors.New("skill networking must be disabled until an egress policy is configured")
	}
	for _, schema := range []string{manifest.InputSchema, manifest.OutputSchema} {
		if err := validateRelativeBundlePath(schema); err != nil {
			return fmt.Errorf("invalid schema path: %w", err)
		}
	}
	return nil
}

func (registry *Registry) Get(id string, version string) (Manifest, error) {
	manifest, ok := registry.manifests[manifestKey(id, version)]
	if !ok {
		return Manifest{}, fmt.Errorf("unknown skill version: %s@%s", id, version)
	}
	manifest.Entrypoint = append([]string(nil), manifest.Entrypoint...)
	return manifest, nil
}

func VerifyBundle(data []byte, expectedSHA256 string) error {
	sum := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), expectedSHA256) {
		return errors.New("skill bundle sha256 mismatch")
	}
	return nil
}

func validateRelativeBundlePath(path string) error {
	if path == "" || filepath.IsAbs(path) {
		return errors.New("path must be relative")
	}
	clean := filepath.Clean(filepath.FromSlash(path))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return errors.New("path escapes skill bundle")
	}
	return nil
}

func manifestKey(id string, version string) string {
	return id + "@" + version
}
