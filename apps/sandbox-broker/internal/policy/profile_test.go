package policy

import "testing"

func TestRegistryProfilesAreRestrictiveByDefault(t *testing.T) {
	registry := NewRegistry()
	profiles := registry.List()
	if len(profiles) != 2 {
		t.Fatalf("expected 2 profiles, got %d", len(profiles))
	}

	for _, profile := range profiles {
		if profile.Network != NetworkDisabled {
			t.Fatalf("profile %s must disable network by default", profile.ID)
		}
		if profile.MemoryLimitMB <= 0 || profile.PIDLimit <= 0 || profile.TimeoutSeconds <= 0 {
			t.Fatalf("profile %s has invalid resource limits", profile.ID)
		}
	}

	coding, err := registry.Get("coding-untrusted")
	if err != nil {
		t.Fatal(err)
	}
	if !coding.ProducesPatch {
		t.Fatal("coding profile must produce a patch instead of mutating the host workspace")
	}
}

func TestRegistryRejectsUnknownProfile(t *testing.T) {
	_, err := NewRegistry().Get("host-root")
	if err == nil {
		t.Fatal("expected unknown profile to be rejected")
	}
}
