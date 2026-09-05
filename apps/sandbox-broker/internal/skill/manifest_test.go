package skill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
)

func TestLoadRegistryAndResolveImmutableVersion(t *testing.T) {
	root := t.TempDir()
	manifest := `{
  "id":"markdown-check",
  "version":"1.0.0",
  "runtime":"node",
  "entrypoint":["node","scripts/run.mjs"],
  "profileId":"skill-trusted",
  "imageDigest":"image@sha256:` + strings.Repeat("a", 64) + `",
  "bundleSha256":"` + strings.Repeat("b", 64) + `",
  "network":"disabled",
  "inputSchema":"schemas/input.json",
  "outputSchema":"schemas/output.json"
}`
	if err := os.WriteFile(filepath.Join(root, "markdown-check.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	registry, err := LoadRegistry(root, policy.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	got, err := registry.Get("markdown-check", "1.0.0")
	if err != nil || got.Entrypoint[0] != "node" {
		t.Fatalf("unexpected manifest: %+v %v", got, err)
	}
}

func TestManifestRejectsMutableOrEscapingConfiguration(t *testing.T) {
	base := Manifest{
		ID: "skill", Version: "1.0.0", Runtime: "node", Entrypoint: []string{"node"},
		ProfileID: "skill-trusted", ImageDigest: "image@sha256:" + strings.Repeat("a", 64),
		BundleSHA256: strings.Repeat("b", 64), Network: "disabled",
		InputSchema: "schemas/input.json", OutputSchema: "schemas/output.json",
	}
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{name: "mutable image", mutate: func(value *Manifest) { value.ImageDigest = "node:latest" }},
		{name: "network enabled", mutate: func(value *Manifest) { value.Network = "allowlist" }},
		{name: "schema escape", mutate: func(value *Manifest) { value.InputSchema = "../secret" }},
		{name: "unknown profile", mutate: func(value *Manifest) { value.ProfileID = "host-root" }},
		{name: "shell entrypoint", mutate: func(value *Manifest) { value.Entrypoint = []string{"sh", "-c", "id"} }},
		{name: "entrypoint escape", mutate: func(value *Manifest) { value.Entrypoint = []string{"node", "../run.mjs"} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := base
			test.mutate(&manifest)
			if err := manifest.Validate(policy.NewRegistry()); err == nil {
				t.Fatal("expected invalid manifest")
			}
		})
	}
}

func TestVerifyBundle(t *testing.T) {
	data := []byte("bundle")
	if err := VerifyBundle(data, "1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyBundle([]byte("changed"), "1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc"); err == nil {
		t.Fatal("expected changed bundle to fail")
	}
}
