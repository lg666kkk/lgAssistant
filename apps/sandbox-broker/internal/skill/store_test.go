package skill

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
)

func TestMemoryStorePublishesImmutableVersion(t *testing.T) {
	store, err := NewMemoryStore(policy.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Upsert(context.Background(), Definition{ID: "markdown-check", Name: "Markdown Check", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	bundle := []byte("bundle")
	version := Version{Manifest: testManifest(bundle), Bundle: bundle}
	published, created, err := store.Publish(context.Background(), version)
	if err != nil || !created {
		t.Fatalf("publish: created=%v version=%+v err=%v", created, published, err)
	}
	if _, created, err := store.Publish(context.Background(), version); err != nil || created {
		t.Fatalf("idempotent publish: created=%v err=%v", created, err)
	}
	version.Manifest.Entrypoint = []string{"node", "other.mjs"}
	if _, _, err := store.Publish(context.Background(), version); !errors.Is(err, ErrSkillVersionConflict) {
		t.Fatalf("expected immutable conflict, got %v", err)
	}
}

func TestMemoryStoreRequiresEnabledSkill(t *testing.T) {
	store, _ := NewMemoryStore(policy.NewRegistry())
	bundle := []byte("bundle")
	_, _ = store.Upsert(context.Background(), Definition{ID: "markdown-check", Name: "Markdown Check", Enabled: false})
	if _, _, err := store.Publish(context.Background(), Version{Manifest: testManifest(bundle), Bundle: bundle}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.GetVersion(context.Background(), "markdown-check", "1.0.0"); !errors.Is(err, ErrSkillDisabled) {
		t.Fatalf("expected disabled skill, got %v", err)
	}
}

func TestMemoryStoreListsConfiguredVersionsWithoutBundle(t *testing.T) {
	store, _ := NewMemoryStore(policy.NewRegistry())
	bundle := []byte("bundle")
	_, _ = store.Upsert(context.Background(), Definition{ID: "markdown-check", Name: "Markdown Check", Enabled: true})
	_, _, _ = store.Publish(context.Background(), Version{Manifest: testManifest(bundle), Bundle: bundle})
	items, err := store.List(context.Background())
	if err != nil || len(items) != 1 || len(items[0].Versions) != 1 {
		t.Fatalf("unexpected list: %+v %v", items, err)
	}
}

func testManifest(bundle []byte) Manifest {
	sum := sha256.Sum256(bundle)
	return Manifest{
		ID: "markdown-check", Version: "1.0.0", Runtime: "node",
		Entrypoint: []string{"node", "scripts/run.mjs"}, ProfileID: "skill-trusted",
		ImageDigest:  "image@sha256:" + strings.Repeat("a", 64),
		BundleSHA256: hex.EncodeToString(sum[:]), Network: "disabled",
		InputSchema: "schemas/input.json", OutputSchema: "schemas/output.json",
	}
}
