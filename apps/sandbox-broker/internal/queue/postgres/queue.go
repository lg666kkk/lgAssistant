package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/queue"
	storepostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/store/postgres"
)

type Queue struct {
	pool *pgxpool.Pool
}

var _ queue.Queue = (*Queue)(nil)

func Open(ctx context.Context, databaseURL string) (*Queue, error) {
	if databaseURL == "" {
		return nil, errors.New("sandbox database URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create sandbox queue pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to sandbox queue database: %w", err)
	}
	return &Queue{pool: pool}, nil
}

func (postgres *Queue) Close() {
	postgres.pool.Close()
}

func (postgres *Queue) Claim(ctx context.Context, workerID string, limit int, lease time.Duration) ([]domain.Run, error) {
	rows, err := postgres.pool.Query(ctx,
		`SELECT `+storepostgres.RunColumns+` FROM claim_sandbox_runs($1, $2, $3)`,
		workerID, limit, durationSeconds(lease),
	)
	if err != nil {
		return nil, fmt.Errorf("claim sandbox runs: %w", err)
	}
	defer rows.Close()
	runs := make([]domain.Run, 0, limit)
	for rows.Next() {
		run, err := storepostgres.ScanRun(rows)
		if err != nil {
			return nil, fmt.Errorf("scan claimed sandbox run: %w", err)
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read claimed sandbox runs: %w", err)
	}
	return runs, nil
}

func (postgres *Queue) Heartbeat(ctx context.Context, run domain.Run, lease time.Duration) error {
	var renewed bool
	if err := postgres.pool.QueryRow(ctx,
		`SELECT heartbeat_sandbox_run($1, $2, $3, $4)`,
		run.RunID, run.WorkerID, run.LeaseToken, durationSeconds(lease),
	).Scan(&renewed); err != nil {
		return fmt.Errorf("heartbeat sandbox run: %w", err)
	}
	if !renewed {
		return fmt.Errorf("%w: %s", queue.ErrLeaseLost, run.RunID)
	}
	return nil
}

func (postgres *Queue) CancellationRequested(ctx context.Context, run domain.Run) (bool, error) {
	var requested bool
	err := postgres.pool.QueryRow(ctx, `
SELECT cancel_requested_at IS NOT NULL
FROM sandbox_runs
WHERE id = $1 AND worker_id = $2 AND lease_token = $3 AND lease_until > NOW()`,
		run.RunID, run.WorkerID, run.LeaseToken,
	).Scan(&requested)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("%w: %s", queue.ErrLeaseLost, run.RunID)
	}
	if err != nil {
		return false, fmt.Errorf("read sandbox cancellation state: %w", err)
	}
	return requested, nil
}

func (postgres *Queue) MarkRunning(ctx context.Context, run domain.Run, imageDigest string) error {
	commandTag, err := postgres.pool.Exec(ctx, `
UPDATE sandbox_runs
SET status = 'running', started_at = COALESCE(started_at, NOW()),
    image_digest = $4, updated_at = NOW()
WHERE id = $1 AND worker_id = $2 AND lease_token = $3
  AND status = 'preparing' AND lease_until > NOW() AND cancel_requested_at IS NULL`,
		run.RunID, run.WorkerID, run.LeaseToken, imageDigest,
	)
	return leaseWriteResult("mark sandbox run running", run.RunID, commandTag.RowsAffected(), err)
}

func (postgres *Queue) Finish(ctx context.Context, run domain.Run, result domain.ExecuteResult) error {
	if !result.Status.IsTerminal() || result.Status == domain.RunStatusDead || result.Status == domain.RunStatusUnavailable {
		return fmt.Errorf("invalid worker terminal status: %s", result.Status)
	}
	tx, err := postgres.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin sandbox finish transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var currentStatus string
	var cancelRequested bool
	err = tx.QueryRow(ctx, `
SELECT status, cancel_requested_at IS NOT NULL
FROM sandbox_runs
WHERE id = $1 AND worker_id = $2 AND lease_token = $3 AND lease_until > NOW()
FOR UPDATE`, run.RunID, run.WorkerID, run.LeaseToken).Scan(&currentStatus, &cancelRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: %s", queue.ErrLeaseLost, run.RunID)
	}
	if err != nil {
		return fmt.Errorf("lock sandbox run for finish: %w", err)
	}

	status := result.Status
	if cancelRequested {
		status = domain.RunStatusCancelled
	}
	if status == domain.RunStatusCompleted && currentStatus == string(domain.RunStatusRunning) {
		if _, err := tx.Exec(ctx, `UPDATE sandbox_runs SET status = 'collecting_artifacts', updated_at = NOW() WHERE id = $1`, run.RunID); err != nil {
			return fmt.Errorf("mark sandbox artifact collection: %w", err)
		}
		currentStatus = string(domain.RunStatusCollecting)
	}
	if !domain.CanTransition(domain.RunStatus(currentStatus), status) {
		return fmt.Errorf("%w: %s -> %s", domain.ErrInvalidRunTransition, currentStatus, status)
	}

	commandTag, err := tx.Exec(ctx, `
UPDATE sandbox_runs SET
  status = $4, exit_code = $5, timed_out = $6, oom_killed = $7,
  stdout_ref = NULLIF($8, ''), stderr_ref = NULLIF($9, ''), patch_ref = NULLIF($10, ''),
  result_ref = NULLIF($11, ''), result = $12, error_message = NULLIF($13, ''), completed_at = NOW(),
  worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = NOW()
WHERE id = $1 AND worker_id = $2 AND lease_token = $3`,
		run.RunID, run.WorkerID, run.LeaseToken, status, result.ExitCode,
		result.TimedOut, result.OOMKilled, result.StdoutRef, result.StderrRef,
		result.PatchRef, result.ResultRef, nullableJSON(result.Result), result.Message,
	)
	if err := leaseWriteResult("finish sandbox run", run.RunID, commandTag.RowsAffected(), err); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit sandbox finish: %w", err)
	}
	return nil
}

func (postgres *Queue) Fail(ctx context.Context, run domain.Run, message string) error {
	status := domain.RunStatusRetryWait
	if run.Attempts >= run.MaxAttempts {
		status = domain.RunStatusDead
	}
	delaySeconds := 5 * (1 << max(0, run.Attempts-1))
	if delaySeconds > 300 {
		delaySeconds = 300
	}
	commandTag, err := postgres.pool.Exec(ctx, `
UPDATE sandbox_runs SET
  status = $4, error_code = 'execution_failed', error_message = $5,
  next_attempt_at = NOW() + make_interval(secs => $6),
  worker_id = NULL, lease_token = NULL, lease_until = NULL,
  completed_at = CASE WHEN $4 = 'dead' THEN NOW() ELSE completed_at END,
  updated_at = NOW()
WHERE id = $1 AND worker_id = $2 AND lease_token = $3 AND lease_until > NOW()
  AND status IN ('preparing', 'running', 'collecting_artifacts')`,
		run.RunID, run.WorkerID, run.LeaseToken, status, truncate(message, 4000), delaySeconds,
	)
	return leaseWriteResult("fail sandbox run", run.RunID, commandTag.RowsAffected(), err)
}

func durationSeconds(value time.Duration) int {
	seconds := int(value.Round(time.Second) / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}

func leaseWriteResult(operation string, runID string, rowsAffected int64, err error) error {
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	if rowsAffected != 1 {
		return fmt.Errorf("%w: %s", queue.ErrLeaseLost, runID)
	}
	return nil
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func nullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}
