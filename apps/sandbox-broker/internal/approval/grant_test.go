package approval

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestApprovalBindsPatchAndIsConsumedOnce(t *testing.T) {
	now := time.Date(2026, time.September, 4, 0, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	store.now = func() time.Time { return now }
	patch := []byte("diff --git a/file b/file")
	grant, err := store.Create("user-1", "run-1", "input-hash", patch, "commit-1", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Consume(grant.ID, "user-1", "run-1", "input-hash", []byte("changed"), "commit-1"); !errors.Is(err, ErrApprovalMismatch) {
		t.Fatalf("expected changed patch to fail, got %v", err)
	}
	if _, err := store.Consume(grant.ID, "user-1", "run-1", "input-hash", patch, "commit-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Consume(grant.ID, "user-1", "run-1", "input-hash", patch, "commit-1"); !errors.Is(err, ErrApprovalConsumed) {
		t.Fatalf("expected second consume to fail, got %v", err)
	}
}

func TestApprovalConcurrentConsumeHasOneWinner(t *testing.T) {
	now := time.Now()
	store := NewMemoryStore()
	patch := []byte("patch")
	grant, err := store.Create("user-1", "run-1", "input", patch, "commit", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	var waitGroup sync.WaitGroup
	winners := make(chan struct{}, 20)
	for range 20 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			if _, err := store.Consume(grant.ID, "user-1", "run-1", "input", patch, "commit"); err == nil {
				winners <- struct{}{}
			}
		}()
	}
	waitGroup.Wait()
	close(winners)
	if len(winners) != 1 {
		t.Fatalf("expected one approval consumer, got %d", len(winners))
	}
}

func TestValidateChangedPaths(t *testing.T) {
	if err := ValidateChangedPaths([]string{"app/page.tsx", "lib/tool.ts"}, []string{"app", "lib"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../secret", ".git/config", ".env.production", "deploy/production.sh"} {
		if err := ValidateChangedPaths([]string{path}, []string{"app", "lib"}); err == nil {
			t.Fatalf("expected %s to be rejected", path)
		}
	}
}
