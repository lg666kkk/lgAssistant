package memory_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/store"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/store/memory"
)

func TestRunStoreCreateAndGet(t *testing.T) {
	runStore := memory.NewRunStore()
	want := newRun("run-1", "idem-1")

	created, wasCreated, err := runStore.Create(context.Background(), want)
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if !wasCreated {
		t.Fatal("expected a new run to be created")
	}
	got, err := runStore.Get(context.Background(), want.RunID)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}

	assertRunEqual(t, created, want)
	assertRunEqual(t, got, want)
}

func TestRunStoreCreateIsIdempotent(t *testing.T) {
	runStore := memory.NewRunStore()
	original := newRun("run-1", "idem-1")
	if _, _, err := runStore.Create(context.Background(), original); err != nil {
		t.Fatalf("create original run: %v", err)
	}

	duplicate := newRun("run-2", original.IdempotencyKey)
	duplicate.Command = []string{"different-command"}
	got, wasCreated, err := runStore.Create(context.Background(), duplicate)
	if err != nil {
		t.Fatalf("create duplicate request: %v", err)
	}
	if wasCreated {
		t.Fatal("idempotent request must not create a second run")
	}

	assertRunEqual(t, got, original)
	if _, err := runStore.Get(context.Background(), duplicate.RunID); !errors.Is(err, store.ErrRunNotFound) {
		t.Fatalf("duplicate run must not be stored, got %v", err)
	}
}

func TestRunStoreRejectsIdempotencyConflict(t *testing.T) {
	runStore := memory.NewRunStore()
	original := newRun("run-1", "idem-1")
	original.InputHash = "hash-1"
	if _, _, err := runStore.Create(context.Background(), original); err != nil {
		t.Fatalf("create original run: %v", err)
	}
	conflict := newRun("run-2", "idem-1")
	conflict.InputHash = "hash-2"
	if _, _, err := runStore.Create(context.Background(), conflict); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}
}

func TestRunStoreRejectsDuplicateRunID(t *testing.T) {
	runStore := memory.NewRunStore()
	if _, _, err := runStore.Create(context.Background(), newRun("run-1", "idem-1")); err != nil {
		t.Fatalf("create original run: %v", err)
	}

	_, _, err := runStore.Create(context.Background(), newRun("run-1", "idem-2"))
	if !errors.Is(err, store.ErrDuplicateRun) {
		t.Fatalf("expected ErrDuplicateRun, got %v", err)
	}
}

func TestRunStoreGetReturnsStableNotFoundError(t *testing.T) {
	_, err := memory.NewRunStore().Get(context.Background(), "missing")
	if !errors.Is(err, store.ErrRunNotFound) {
		t.Fatalf("expected ErrRunNotFound, got %v", err)
	}
}

func TestRunStoreHonorsCancelledContext(t *testing.T) {
	runStore := memory.NewRunStore()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, _, err := runStore.Create(ctx, newRun("run-1", "idem-1")); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled from Create, got %v", err)
	}
	if _, err := runStore.Get(ctx, "run-1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled from Get, got %v", err)
	}
	if _, err := runStore.Get(context.Background(), "run-1"); !errors.Is(err, store.ErrRunNotFound) {
		t.Fatalf("cancelled Create must not store a run, got %v", err)
	}
}

func TestRunStoreCopiesCommandSlices(t *testing.T) {
	runStore := memory.NewRunStore()
	run := newRun("run-1", "idem-1")
	created, _, err := runStore.Create(context.Background(), run)
	if err != nil {
		t.Fatalf("create run: %v", err)
	}

	run.Command[0] = "mutated-input"
	created.Command[0] = "mutated-output"
	stored, err := runStore.Get(context.Background(), "run-1")
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if stored.Command[0] != "node" {
		t.Fatalf("stored command was mutated: %q", stored.Command[0])
	}
}

func TestRunStoreUpdate(t *testing.T) {
	runStore := memory.NewRunStore()
	run := newRun("run-1", "idem-1")
	if _, _, err := runStore.Create(context.Background(), run); err != nil {
		t.Fatalf("create run: %v", err)
	}

	run.Status = domain.RunStatusRunning
	run.UpdatedAt = run.CreatedAt.Add(time.Second)
	updated, err := runStore.Update(context.Background(), run)
	if err != nil {
		t.Fatalf("update run: %v", err)
	}
	if updated.Status != domain.RunStatusRunning {
		t.Fatalf("expected running status, got %s", updated.Status)
	}

	run.IdempotencyKey = "changed"
	if _, err := runStore.Update(context.Background(), run); !errors.Is(err, store.ErrRunConflict) {
		t.Fatalf("expected ErrRunConflict, got %v", err)
	}
}

func TestRunStoreRequestCancel(t *testing.T) {
	runStore := memory.NewRunStore()
	run := newRun("run-1", "idem-1")
	if _, _, err := runStore.Create(context.Background(), run); err != nil {
		t.Fatalf("create run: %v", err)
	}

	requestedAt := run.CreatedAt.Add(time.Second)
	updated, err := runStore.RequestCancel(context.Background(), run.RunID, requestedAt)
	if err != nil {
		t.Fatalf("request cancel: %v", err)
	}
	if updated.CancelRequestedAt == nil || !updated.CancelRequestedAt.Equal(requestedAt) {
		t.Fatal("cancel request timestamp was not stored")
	}
}

func TestRunStoreCancelsQueuedRunImmediately(t *testing.T) {
	runStore := memory.NewRunStore()
	run := newRun("run-1", "idem-1")
	run.Status = domain.RunStatusQueued
	if _, _, err := runStore.Create(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	updated, err := runStore.RequestCancel(context.Background(), run.RunID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != domain.RunStatusCancelled || updated.CompletedAt == nil {
		t.Fatalf("queued run was not completed as cancelled: %+v", updated)
	}
}

func TestRunStoreSupportsConcurrentAccess(t *testing.T) {
	runStore := memory.NewRunStore()
	const goroutineCount = 20

	var waitGroup sync.WaitGroup
	errorsChannel := make(chan error, goroutineCount)
	for index := 0; index < goroutineCount; index++ {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			runID := fmt.Sprintf("run-%d", index)
			created, _, err := runStore.Create(context.Background(), newRun(runID, "idem-"+runID))
			if err != nil {
				errorsChannel <- fmt.Errorf("create %s: %w", runID, err)
				return
			}
			got, err := runStore.Get(context.Background(), runID)
			if err != nil {
				errorsChannel <- fmt.Errorf("get %s: %w", runID, err)
				return
			}
			if got.RunID != created.RunID {
				errorsChannel <- fmt.Errorf("get %s returned %s", runID, got.RunID)
			}
		}(index)
	}
	waitGroup.Wait()
	close(errorsChannel)

	for err := range errorsChannel {
		t.Error(err)
	}
}

func newRun(runID string, idempotencyKey string) domain.Run {
	return domain.Run{
		UserID:         "user-1",
		RunID:          runID,
		IdempotencyKey: idempotencyKey,
		ProfileID:      "skill-trusted",
		Command:        []string{"node", "script.mjs"},
		TimeoutSeconds: 20,
		Status:         domain.RunStatusAccepted,
		CreatedAt:      time.Date(2026, time.September, 4, 0, 0, 0, 0, time.UTC),
	}
}

func assertRunEqual(t *testing.T, got domain.Run, want domain.Run) {
	t.Helper()
	if got.RunID != want.RunID ||
		got.IdempotencyKey != want.IdempotencyKey ||
		got.ProfileID != want.ProfileID ||
		got.TimeoutSeconds != want.TimeoutSeconds ||
		got.Status != want.Status ||
		!got.CreatedAt.Equal(want.CreatedAt) {
		t.Fatalf("run mismatch:\n got: %+v\nwant: %+v", got, want)
	}
	if len(got.Command) != len(want.Command) {
		t.Fatalf("command length mismatch: got %d, want %d", len(got.Command), len(want.Command))
	}
	for index := range want.Command {
		if got.Command[index] != want.Command[index] {
			t.Fatalf("command[%d] = %q, want %q", index, got.Command[index], want.Command[index])
		}
	}
}
