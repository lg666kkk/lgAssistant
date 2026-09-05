package memory

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/store"
)

type RunStore struct {
	mu                    sync.RWMutex
	runsByID              map[string]domain.Run
	runIDByIdempotencyKey map[string]string
}

var _ store.RunStore = (*RunStore)(nil)

func NewRunStore() *RunStore {
	return &RunStore{
		runsByID:              make(map[string]domain.Run),
		runIDByIdempotencyKey: make(map[string]string),
	}
}

func (s *RunStore) Create(ctx context.Context, run domain.Run) (domain.Run, bool, error) {
	if err := ctx.Err(); err != nil {
		return domain.Run{}, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return domain.Run{}, false, err
	}
	idempotencyScope := run.UserID + "\x00" + run.IdempotencyKey
	if runID, ok := s.runIDByIdempotencyKey[idempotencyScope]; ok {
		stored := s.runsByID[runID]
		if stored.InputHash != run.InputHash {
			return domain.Run{}, false, fmt.Errorf("%w: %s", store.ErrIdempotencyConflict, run.IdempotencyKey)
		}
		return cloneRun(stored), false, nil
	}
	if _, ok := s.runsByID[run.RunID]; ok {
		return domain.Run{}, false, fmt.Errorf("%w: %s", store.ErrDuplicateRun, run.RunID)
	}

	stored := cloneRun(run)
	s.runsByID[stored.RunID] = stored
	s.runIDByIdempotencyKey[idempotencyScope] = stored.RunID
	return cloneRun(stored), true, nil
}

func (s *RunStore) Get(ctx context.Context, runID string) (domain.Run, error) {
	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}
	run, ok := s.runsByID[runID]
	if !ok {
		return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunNotFound, runID)
	}
	return cloneRun(run), nil
}

func (s *RunStore) Update(ctx context.Context, run domain.Run) (domain.Run, error) {
	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}
	stored, ok := s.runsByID[run.RunID]
	if !ok {
		return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunNotFound, run.RunID)
	}
	if stored.UserID != run.UserID || stored.IdempotencyKey != run.IdempotencyKey || stored.InputHash != run.InputHash {
		return domain.Run{}, fmt.Errorf("%w: idempotency key", store.ErrRunConflict)
	}

	updated := cloneRun(run)
	s.runsByID[run.RunID] = updated
	return cloneRun(updated), nil
}

func (s *RunStore) RequestCancel(ctx context.Context, runID string, requestedAt time.Time) (domain.Run, error) {
	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}
	run, ok := s.runsByID[runID]
	if !ok {
		return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunNotFound, runID)
	}
	if run.Status.IsTerminal() {
		return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunNotCancellable, runID)
	}
	run.CancelRequestedAt = &requestedAt
	run.UpdatedAt = requestedAt
	if run.Status == domain.RunStatusQueued || run.Status == domain.RunStatusRetryWait {
		run.Status = domain.RunStatusCancelled
		run.CompletedAt = &requestedAt
	}
	s.runsByID[runID] = run
	return cloneRun(run), nil
}

func cloneRun(run domain.Run) domain.Run {
	run.Command = append([]string(nil), run.Command...)
	run.Input = append([]byte(nil), run.Input...)
	run.Result = append([]byte(nil), run.Result...)
	return run
}
