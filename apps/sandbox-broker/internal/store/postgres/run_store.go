package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/store"
)

const RunColumns = `
id, user_id, session_id, request_id, tool_call_id, kind,
profile_id, profile_version, skill_id, skill_version, skill_bundle_sha256,
idempotency_key, input_hash, command, input,
timeout_seconds, status, attempts, max_attempts, worker_id, lease_token,
lease_until, next_attempt_at, cancel_requested_at, started_at, completed_at,
image_digest, exit_code, timed_out, oom_killed, stdout_ref, stderr_ref,
patch_ref, result_ref, result, error_code, error_message, created_at, updated_at`

type Store struct {
	pool *pgxpool.Pool
}

var _ store.RunStore = (*Store)(nil)

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	if databaseURL == "" {
		return nil, errors.New("sandbox database URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create sandbox database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to sandbox database: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (postgres *Store) Close() {
	postgres.pool.Close()
}

func (postgres *Store) Create(ctx context.Context, run domain.Run) (domain.Run, bool, error) {
	command, err := json.Marshal(run.Command)
	if err != nil {
		return domain.Run{}, false, fmt.Errorf("encode sandbox command: %w", err)
	}
	input := run.Input
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	row := postgres.pool.QueryRow(ctx, `
INSERT INTO sandbox_runs (
  id, user_id, session_id, request_id, tool_call_id, kind,
  profile_id, profile_version, skill_id, skill_version, skill_bundle_sha256,
  idempotency_key, input_hash, command, input,
  timeout_seconds, status, max_attempts, next_attempt_at, created_at, updated_at
) VALUES (
  $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6,
  $7, $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
  $12, $13, $14, $15,
  $16, $17, $18, $19, $20, $20
)
ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING `+RunColumns,
		run.RunID, run.UserID, run.SessionID, run.RequestID, run.ToolCallID, run.Kind,
		run.ProfileID, run.ProfileVersion, run.SkillID, run.SkillVersion, run.SkillBundleSHA256,
		run.IdempotencyKey, run.InputHash, command, input,
		run.TimeoutSeconds, run.Status, run.MaxAttempts, run.NextAttemptAt, run.CreatedAt,
	)
	created, err := ScanRun(row)
	if err == nil {
		return created, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.Run{}, false, classifyWriteError(err)
	}

	existing, err := ScanRun(postgres.pool.QueryRow(ctx,
		`SELECT `+RunColumns+` FROM sandbox_runs WHERE user_id = $1 AND idempotency_key = $2`,
		run.UserID, run.IdempotencyKey,
	))
	if err != nil {
		return domain.Run{}, false, fmt.Errorf("read idempotent sandbox run: %w", err)
	}
	if existing.InputHash != run.InputHash {
		return domain.Run{}, false, fmt.Errorf("%w: %s", store.ErrIdempotencyConflict, run.IdempotencyKey)
	}
	return existing, false, nil
}

func (postgres *Store) Get(ctx context.Context, runID string) (domain.Run, error) {
	run, err := ScanRun(postgres.pool.QueryRow(ctx,
		`SELECT `+RunColumns+` FROM sandbox_runs WHERE id = $1`, runID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunNotFound, runID)
	}
	if err != nil {
		return domain.Run{}, fmt.Errorf("get sandbox run: %w", err)
	}
	return run, nil
}

func (postgres *Store) Update(ctx context.Context, run domain.Run) (domain.Run, error) {
	updated, err := ScanRun(postgres.pool.QueryRow(ctx, `
UPDATE sandbox_runs SET
  status = $5, worker_id = NULLIF($6, ''), lease_token = NULLIF($7, ''),
  lease_until = $8, next_attempt_at = $9, cancel_requested_at = $10,
  started_at = $11, completed_at = $12, image_digest = NULLIF($13, ''),
  exit_code = $14, timed_out = $15, oom_killed = $16,
  stdout_ref = NULLIF($17, ''), stderr_ref = NULLIF($18, ''), patch_ref = NULLIF($19, ''),
  result_ref = NULLIF($20, ''), result = $21,
  error_code = NULLIF($22, ''), error_message = NULLIF($23, ''), updated_at = $24
WHERE id = $1 AND user_id = $2 AND idempotency_key = $3 AND input_hash = $4
RETURNING `+RunColumns,
		run.RunID, run.UserID, run.IdempotencyKey, run.InputHash, run.Status,
		run.WorkerID, run.LeaseToken, run.LeaseUntil, run.NextAttemptAt,
		run.CancelRequestedAt, run.StartedAt, run.CompletedAt, run.ImageDigest,
		run.ExitCode, run.TimedOut, run.OOMKilled, run.StdoutRef, run.StderrRef,
		run.PatchRef, run.ResultRef, nullableJSON(run.Result), run.ErrorCode, run.Message, run.UpdatedAt,
	))
	if err == nil {
		return updated, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.Run{}, fmt.Errorf("update sandbox run: %w", err)
	}
	if _, getErr := postgres.Get(ctx, run.RunID); errors.Is(getErr, store.ErrRunNotFound) {
		return domain.Run{}, getErr
	}
	return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunConflict, run.RunID)
}

func (postgres *Store) RequestCancel(ctx context.Context, runID string, requestedAt time.Time) (domain.Run, error) {
	run, err := ScanRun(postgres.pool.QueryRow(ctx, `
UPDATE sandbox_runs
SET cancel_requested_at = COALESCE(cancel_requested_at, $2),
    status = CASE WHEN status IN ('queued', 'retry_wait') THEN 'cancelled' ELSE status END,
    completed_at = CASE WHEN status IN ('queued', 'retry_wait') THEN $2 ELSE completed_at END,
    updated_at = $2
WHERE id = $1
  AND status NOT IN ('completed', 'failed', 'timed_out', 'cancelled', 'dead', 'unavailable')
RETURNING `+RunColumns, runID, requestedAt))
	if err == nil {
		return run, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.Run{}, fmt.Errorf("request sandbox cancellation: %w", err)
	}
	if _, getErr := postgres.Get(ctx, runID); errors.Is(getErr, store.ErrRunNotFound) {
		return domain.Run{}, getErr
	}
	return domain.Run{}, fmt.Errorf("%w: %s", store.ErrRunNotCancellable, runID)
}

type RowScanner interface {
	Scan(...any) error
}

func ScanRun(row RowScanner) (domain.Run, error) {
	var run domain.Run
	var command []byte
	var input []byte
	var result []byte
	var kind string
	var status string
	var sessionID, toolCallID, workerID, leaseToken, imageDigest *string
	var skillID, skillVersion, skillBundleSHA256 *string
	var stdoutRef, stderrRef, patchRef, resultRef, errorCode, errorMessage *string
	var exitCode *int
	err := row.Scan(
		&run.RunID, &run.UserID, &sessionID, &run.RequestID, &toolCallID, &kind,
		&run.ProfileID, &run.ProfileVersion, &skillID, &skillVersion, &skillBundleSHA256,
		&run.IdempotencyKey, &run.InputHash, &command, &input,
		&run.TimeoutSeconds, &status, &run.Attempts, &run.MaxAttempts, &workerID, &leaseToken,
		&run.LeaseUntil, &run.NextAttemptAt, &run.CancelRequestedAt, &run.StartedAt, &run.CompletedAt,
		&imageDigest, &exitCode, &run.TimedOut, &run.OOMKilled, &stdoutRef, &stderrRef,
		&patchRef, &resultRef, &result, &errorCode, &errorMessage, &run.CreatedAt, &run.UpdatedAt,
	)
	if err != nil {
		return domain.Run{}, err
	}
	if err := json.Unmarshal(command, &run.Command); err != nil {
		return domain.Run{}, fmt.Errorf("decode sandbox command: %w", err)
	}
	run.Input = append(json.RawMessage(nil), input...)
	run.Kind = domain.RunKind(kind)
	run.Status = domain.RunStatus(status)
	run.SessionID = stringValue(sessionID)
	run.ToolCallID = stringValue(toolCallID)
	run.SkillID = stringValue(skillID)
	run.SkillVersion = stringValue(skillVersion)
	run.SkillBundleSHA256 = stringValue(skillBundleSHA256)
	run.WorkerID = stringValue(workerID)
	run.LeaseToken = stringValue(leaseToken)
	run.ImageDigest = stringValue(imageDigest)
	run.ExitCode = exitCode
	run.StdoutRef = stringValue(stdoutRef)
	run.StderrRef = stringValue(stderrRef)
	run.PatchRef = stringValue(patchRef)
	run.ResultRef = stringValue(resultRef)
	run.Result = append(json.RawMessage(nil), result...)
	run.ErrorCode = stringValue(errorCode)
	run.Message = stringValue(errorMessage)
	return run, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

func classifyWriteError(err error) error {
	if pgError, ok := err.(*pgconn.PgError); ok && pgError.Code == "23505" {
		return fmt.Errorf("%w: %s", store.ErrDuplicateRun, pgError.ConstraintName)
	}
	return fmt.Errorf("create sandbox run: %w", err)
}
