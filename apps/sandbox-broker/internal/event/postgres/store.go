package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/event"
)

type Store struct {
	pool *pgxpool.Pool
}

var _ event.Store = (*Store)(nil)

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	if databaseURL == "" {
		return nil, errors.New("sandbox database URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create sandbox event pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to sandbox event database: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (store *Store) Close() { store.pool.Close() }

func (store *Store) Append(ctx context.Context, runID string, eventType string, payload any) (domain.Event, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return domain.Event{}, fmt.Errorf("encode sandbox event: %w", err)
	}
	var created domain.Event
	err = store.pool.QueryRow(ctx, `
SELECT run_id, sequence, type, payload, created_at
FROM append_sandbox_event($1, $2, $3)`, runID, eventType, encoded).Scan(
		&created.RunID, &created.Sequence, &created.Type, &created.Payload, &created.CreatedAt,
	)
	if err != nil {
		return domain.Event{}, fmt.Errorf("append sandbox event: %w", err)
	}
	return created, nil
}

func (store *Store) List(ctx context.Context, runID string, after int64, limit int) ([]domain.Event, error) {
	if limit <= 0 || limit > 500 {
		return nil, errors.New("event limit must be between 1 and 500")
	}
	rows, err := store.pool.Query(ctx, `
SELECT run_id, sequence, type, payload, created_at
FROM sandbox_events
WHERE run_id = $1 AND sequence > $2
ORDER BY sequence
LIMIT $3`, runID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list sandbox events: %w", err)
	}
	defer rows.Close()
	events := make([]domain.Event, 0, limit)
	for rows.Next() {
		var item domain.Event
		if err := rows.Scan(&item.RunID, &item.Sequence, &item.Type, &item.Payload, &item.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan sandbox event: %w", err)
		}
		events = append(events, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read sandbox events: %w", err)
	}
	return events, nil
}
