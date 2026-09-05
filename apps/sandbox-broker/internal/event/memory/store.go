package memory

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/event"
)

type Store struct {
	mu     sync.RWMutex
	events map[string][]domain.Event
	now    func() time.Time
}

var _ event.Store = (*Store)(nil)

func New() *Store {
	return &Store{events: make(map[string][]domain.Event), now: time.Now}
}

func (store *Store) Append(ctx context.Context, runID string, eventType string, payload any) (domain.Event, error) {
	if err := ctx.Err(); err != nil {
		return domain.Event{}, err
	}
	if runID == "" || eventType == "" {
		return domain.Event{}, errors.New("event run id and type are required")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return domain.Event{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	created := domain.Event{
		RunID: runID, Sequence: int64(len(store.events[runID]) + 1), Type: eventType,
		Payload: encoded, CreatedAt: store.now().UTC(),
	}
	store.events[runID] = append(store.events[runID], created)
	return cloneEvent(created), nil
}

func (store *Store) List(ctx context.Context, runID string, after int64, limit int) ([]domain.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		return nil, errors.New("event limit must be between 1 and 500")
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	result := make([]domain.Event, 0, limit)
	for _, item := range store.events[runID] {
		if item.Sequence <= after {
			continue
		}
		result = append(result, cloneEvent(item))
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func cloneEvent(value domain.Event) domain.Event {
	value.Payload = append(json.RawMessage(nil), value.Payload...)
	return value
}
