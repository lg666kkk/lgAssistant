package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/event"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/queue"
	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
)

type Config struct {
	Logger            *slog.Logger
	Queue             queue.Queue
	Executor          executor.Executor
	Events            event.Store
	Policies          *policy.Registry
	Skills            skill.Store
	WorkerID          string
	ImageDigests      map[string]string
	Concurrency       int
	LeaseDuration     time.Duration
	HeartbeatInterval time.Duration
	PollInterval      time.Duration
	OrphanCleaner     sandboxruntime.OrphanCleaner
}

type Worker struct {
	logger            *slog.Logger
	queue             queue.Queue
	executor          executor.Executor
	events            event.Store
	policies          *policy.Registry
	skills            skill.Store
	workerID          string
	imageDigests      map[string]string
	concurrency       int
	leaseDuration     time.Duration
	heartbeatInterval time.Duration
	pollInterval      time.Duration
	orphanCleaner     sandboxruntime.OrphanCleaner
}

func New(config Config) (*Worker, error) {
	if config.Logger == nil || config.Queue == nil || config.Executor == nil || config.Events == nil || config.Policies == nil || config.Skills == nil {
		return nil, errors.New("worker logger, queue, executor, event store, policies, and skills are required")
	}
	if config.WorkerID == "" {
		return nil, errors.New("worker id is required")
	}
	if config.Concurrency <= 0 || config.Concurrency > 20 {
		return nil, errors.New("worker concurrency must be between 1 and 20")
	}
	if config.LeaseDuration < 15*time.Second || config.LeaseDuration > 30*time.Minute {
		return nil, errors.New("worker lease duration must be between 15 seconds and 30 minutes")
	}
	if config.HeartbeatInterval <= 0 || config.HeartbeatInterval >= config.LeaseDuration/2 {
		return nil, errors.New("heartbeat interval must be positive and less than half the lease duration")
	}
	if config.PollInterval <= 0 {
		return nil, errors.New("worker poll interval must be positive")
	}
	for profileID, digest := range config.ImageDigests {
		if err := sandboxruntime.ValidateImageDigest(digest); err != nil {
			return nil, fmt.Errorf("invalid image for profile %s: %w", profileID, err)
		}
	}
	return &Worker{
		logger: config.Logger, queue: config.Queue, executor: config.Executor, events: config.Events,
		policies: config.Policies, skills: config.Skills, workerID: config.WorkerID, imageDigests: config.ImageDigests,
		concurrency: config.Concurrency, leaseDuration: config.LeaseDuration,
		heartbeatInterval: config.HeartbeatInterval, pollInterval: config.PollInterval,
		orphanCleaner: config.OrphanCleaner,
	}, nil
}

func (worker *Worker) Run(ctx context.Context) error {
	if worker.orphanCleaner != nil {
		cleaned, err := worker.orphanCleaner.CleanupWorkerContainers(ctx, worker.workerID)
		if err != nil {
			return fmt.Errorf("clean orphan sandbox containers: %w", err)
		}
		worker.logger.Info("sandbox orphan cleanup completed", "containers", cleaned)
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		runs, err := worker.queue.Claim(ctx, worker.workerID, worker.concurrency, worker.leaseDuration)
		if err != nil {
			worker.logger.Error("sandbox claim failed", "error", err)
			if !waitForNextPoll(ctx, worker.pollInterval) {
				return nil
			}
			continue
		}
		if len(runs) == 0 {
			if !waitForNextPoll(ctx, worker.pollInterval) {
				return nil
			}
			continue
		}

		var waitGroup sync.WaitGroup
		for _, run := range runs {
			run := run
			waitGroup.Add(1)
			go func() {
				defer waitGroup.Done()
				worker.process(ctx, run)
			}()
		}
		waitGroup.Wait()
	}
}

func (worker *Worker) process(parent context.Context, run domain.Run) {
	worker.appendEvent(parent, run.RunID, "claimed", map[string]any{"workerId": worker.workerID, "attempt": run.Attempts})
	executeRequest := domain.ExecuteRequest{
		UserID: run.UserID, SessionID: run.SessionID, ToolCallID: run.ToolCallID,
		RunID: run.RunID, IdempotencyKey: run.IdempotencyKey, ProfileID: run.ProfileID,
		Command: append([]string(nil), run.Command...), Input: append([]byte(nil), run.Input...),
		TimeoutSeconds: run.TimeoutSeconds,
	}
	if run.Kind == domain.RunKindSkill {
		_, published, err := worker.skills.GetVersion(parent, run.SkillID, run.SkillVersion)
		if err != nil {
			worker.reject(parent, run, fmt.Errorf("resolve published skill: %w", err))
			return
		}
		if err := validateSkillRunBinding(run, published); err != nil {
			worker.reject(parent, run, err)
			return
		}
		executeRequest.ProfileID = published.Manifest.ProfileID
		executeRequest.Command = append([]string(nil), published.Manifest.Entrypoint...)
		executeRequest.Bundle = append([]byte(nil), published.Bundle...)
		executeRequest.BundleSHA256 = published.Manifest.BundleSHA256
		executeRequest.ResolvedImageDigest = published.Manifest.ImageDigest
		executeRequest.InputSchemaPath = published.Manifest.InputSchema
		executeRequest.OutputSchemaPath = published.Manifest.OutputSchema
	}
	profile, err := worker.policies.Get(run.ProfileID)
	if err != nil {
		worker.fail(parent, run, err)
		return
	}
	imageDigest, ok := worker.imageDigests[run.ProfileID]
	if !ok {
		worker.fail(parent, run, errors.New("sandbox image is not configured for profile"))
		return
	}
	if run.Kind == domain.RunKindSkill && executeRequest.ResolvedImageDigest != imageDigest {
		worker.reject(parent, run, errors.New("published Skill image does not match the Worker Profile image"))
		return
	}
	cancelRequested, err := worker.queue.CancellationRequested(parent, run)
	if err != nil {
		worker.logLeaseError(run, err)
		return
	}
	if cancelRequested {
		result := domain.ExecuteResult{RunID: run.RunID, Status: domain.RunStatusCancelled}
		_ = worker.queue.Finish(parent, run, result)
		worker.appendEvent(parent, run.RunID, "cancelled", result)
		return
	}
	if err := worker.queue.MarkRunning(parent, run, imageDigest); err != nil {
		worker.logLeaseError(run, err)
		return
	}
	worker.appendEvent(parent, run.RunID, "running", map[string]string{"imageDigest": imageDigest})

	runCtx, cancel := context.WithCancel(parent)
	defer cancel()
	heartbeatDone := make(chan error, 1)
	go worker.heartbeat(runCtx, run, cancel, heartbeatDone)
	result, executeErr := worker.executor.Execute(runCtx, executeRequest, profile)
	cancel()
	heartbeatErr := <-heartbeatDone
	if parent.Err() != nil {
		return
	}
	if errors.Is(heartbeatErr, queue.ErrLeaseLost) {
		worker.logger.Warn("sandbox lease lost", "runId", run.RunID)
		return
	}
	if heartbeatErr != nil {
		worker.logger.Error("sandbox heartbeat failed", "runId", run.RunID, "error", heartbeatErr)
		return
	}
	if executeErr != nil {
		cancelRequested, cancelErr := worker.queue.CancellationRequested(parent, run)
		if cancelErr == nil && cancelRequested {
			_ = worker.queue.Finish(parent, run, domain.ExecuteResult{RunID: run.RunID, Status: domain.RunStatusCancelled})
			return
		}
		if errors.Is(executeErr, executor.ErrInvalidSkillInput) || errors.Is(executeErr, executor.ErrInvalidSkillOutput) {
			if err := worker.queue.Finish(parent, run, result); err != nil {
				worker.logLeaseError(run, err)
				return
			}
			worker.appendEvent(parent, run.RunID, "failed", map[string]string{"message": result.Message})
			return
		}
		worker.fail(parent, run, executeErr)
		return
	}
	if err := worker.queue.Finish(parent, run, result); err != nil {
		worker.logLeaseError(run, err)
	}
	worker.appendEvent(parent, run.RunID, string(result.Status), result)
}

func validateSkillRunBinding(run domain.Run, version skill.Version) error {
	manifest := version.Manifest
	if run.SkillID != manifest.ID || run.SkillVersion != manifest.Version ||
		run.SkillBundleSHA256 != manifest.BundleSHA256 || run.ProfileID != manifest.ProfileID ||
		run.ImageDigest != "" && run.ImageDigest != manifest.ImageDigest ||
		!equalStrings(run.Command, manifest.Entrypoint) {
		return errors.New("sandbox skill run does not match its immutable published version")
	}
	return nil
}

func equalStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func (worker *Worker) heartbeat(ctx context.Context, run domain.Run, cancel context.CancelFunc, done chan<- error) {
	ticker := time.NewTicker(worker.heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			done <- nil
			return
		case <-ticker.C:
			if err := worker.queue.Heartbeat(ctx, run, worker.leaseDuration); err != nil {
				cancel()
				_ = worker.executor.Cancel(context.Background(), run.RunID)
				done <- err
				return
			}
			cancelRequested, err := worker.queue.CancellationRequested(ctx, run)
			if err != nil {
				cancel()
				_ = worker.executor.Cancel(context.Background(), run.RunID)
				done <- err
				return
			}
			if cancelRequested {
				cancel()
				_ = worker.executor.Cancel(context.Background(), run.RunID)
			}
		}
	}
}

func (worker *Worker) fail(ctx context.Context, run domain.Run, err error) {
	if updateErr := worker.queue.Fail(ctx, run, err.Error()); updateErr != nil {
		worker.logLeaseError(run, updateErr)
	}
	worker.appendEvent(ctx, run.RunID, "execution_failed", map[string]string{"message": truncateError(err.Error(), 4000)})
}

func (worker *Worker) reject(ctx context.Context, run domain.Run, err error) {
	result := domain.ExecuteResult{
		RunID: run.RunID, Status: domain.RunStatusFailed,
		Message: truncateError(err.Error(), 4000),
	}
	if updateErr := worker.queue.Finish(ctx, run, result); updateErr != nil {
		worker.logLeaseError(run, updateErr)
		return
	}
	worker.appendEvent(ctx, run.RunID, "failed", map[string]string{"message": result.Message})
}

func (worker *Worker) appendEvent(ctx context.Context, runID string, eventType string, payload any) {
	if _, err := worker.events.Append(ctx, runID, eventType, payload); err != nil {
		worker.logger.Error("sandbox event append failed", "runId", runID, "type", eventType, "error", err)
	}
}

func truncateError(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func (worker *Worker) logLeaseError(run domain.Run, err error) {
	if errors.Is(err, queue.ErrLeaseLost) {
		worker.logger.Warn("sandbox lease lost", "runId", run.RunID)
		return
	}
	worker.logger.Error("sandbox worker update failed", "runId", run.RunID, "error", err)
}

func waitForNextPoll(ctx context.Context, interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
