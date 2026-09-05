package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	eventmemory "github.com/lg/personal-assistant/apps/sandbox-broker/internal/event/memory"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
)

const workerTestImage = "registry.example/sandbox/node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeQueue struct {
	cancelRequested bool
	markedRunning   bool
	finished        *domain.ExecuteResult
	failed          string
}

func (*fakeQueue) Claim(context.Context, string, int, time.Duration) ([]domain.Run, error) {
	return nil, nil
}
func (*fakeQueue) Heartbeat(context.Context, domain.Run, time.Duration) error { return nil }
func (queue *fakeQueue) CancellationRequested(context.Context, domain.Run) (bool, error) {
	return queue.cancelRequested, nil
}
func (queue *fakeQueue) MarkRunning(context.Context, domain.Run, string) error {
	queue.markedRunning = true
	return nil
}
func (queue *fakeQueue) Finish(_ context.Context, _ domain.Run, result domain.ExecuteResult) error {
	queue.finished = &result
	return nil
}
func (queue *fakeQueue) Fail(_ context.Context, _ domain.Run, message string) error {
	queue.failed = message
	return nil
}

type fakeExecutor struct {
	calls  int
	result domain.ExecuteResult
	err    error
}

func (executor *fakeExecutor) Execute(context.Context, domain.ExecuteRequest, policy.Profile) (domain.ExecuteResult, error) {
	executor.calls++
	return executor.result, executor.err
}
func (*fakeExecutor) Cancel(context.Context, string) error { return nil }

func TestWorkerProcessCompletesRun(t *testing.T) {
	queue := &fakeQueue{}
	executor := &fakeExecutor{result: domain.ExecuteResult{RunID: "run-1", Status: domain.RunStatusCompleted}}
	worker := newTestWorker(t, queue, executor)

	worker.process(context.Background(), claimedRun())

	if !queue.markedRunning || queue.finished == nil || queue.finished.Status != domain.RunStatusCompleted {
		t.Fatalf("unexpected queue state: %+v", queue)
	}
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d", executor.calls)
	}
}

func TestWorkerProcessSkipsCancelledRun(t *testing.T) {
	queue := &fakeQueue{cancelRequested: true}
	executor := &fakeExecutor{}
	worker := newTestWorker(t, queue, executor)

	worker.process(context.Background(), claimedRun())

	if executor.calls != 0 || queue.finished == nil || queue.finished.Status != domain.RunStatusCancelled {
		t.Fatalf("unexpected cancelled state: queue=%+v calls=%d", queue, executor.calls)
	}
}

func TestWorkerProcessRetriesInfrastructureFailure(t *testing.T) {
	queue := &fakeQueue{}
	executor := &fakeExecutor{err: errors.New("runtime unavailable")}
	worker := newTestWorker(t, queue, executor)

	worker.process(context.Background(), claimedRun())

	if queue.failed != "runtime unavailable" || queue.finished != nil {
		t.Fatalf("unexpected failure state: %+v", queue)
	}
}

func TestWorkerDoesNotRetryInvalidSkillInput(t *testing.T) {
	queue := &fakeQueue{}
	runExecutor := &fakeExecutor{
		result: domain.ExecuteResult{RunID: "run-1", Status: domain.RunStatusFailed, Message: "invalid input"},
		err:    executor.ErrInvalidSkillInput,
	}
	worker := newTestWorker(t, queue, runExecutor)

	worker.process(context.Background(), claimedRun())

	if queue.finished == nil || queue.finished.Status != domain.RunStatusFailed || queue.failed != "" {
		t.Fatalf("deterministic validation error was retried: %+v", queue)
	}
}

func TestWorkerRejectsSkillImageDriftWithoutRetry(t *testing.T) {
	queue := &fakeQueue{}
	runExecutor := &recordingSkillExecutor{result: domain.ExecuteResult{RunID: "run-1", Status: domain.RunStatusCompleted}}
	worker := newTestWorkerWithExecutor(t, queue, runExecutor)
	bundle := []byte("bundle")
	sum := sha256.Sum256(bundle)
	run := claimedRun()
	run.Kind = domain.RunKindSkill
	run.SkillID = "markdown-check"
	run.SkillVersion = "1.0.0"
	run.SkillBundleSHA256 = hex.EncodeToString(sum[:])
	run.ImageDigest = workerTestImage
	run.Command = []string{"node", "scripts/run.mjs"}
	worker.imageDigests["skill-trusted"] = "other@sha256:" + strings.Repeat("b", 64)

	worker.process(context.Background(), run)

	if queue.finished == nil || queue.finished.Status != domain.RunStatusFailed || queue.failed != "" {
		t.Fatalf("image drift was retried: %+v", queue)
	}
	if runExecutor.request.RunID != "" {
		t.Fatal("executor was called after image drift")
	}
}

func TestWorkerResolvesSkillBundleAndFixedEntrypoint(t *testing.T) {
	queue := &fakeQueue{}
	executor := &recordingSkillExecutor{result: domain.ExecuteResult{RunID: "run-1", Status: domain.RunStatusCompleted}}
	worker := newTestWorkerWithExecutor(t, queue, executor)
	bundle := []byte("bundle")
	sum := sha256.Sum256(bundle)
	run := claimedRun()
	run.Kind = domain.RunKindSkill
	run.SkillID = "markdown-check"
	run.SkillVersion = "1.0.0"
	run.SkillBundleSHA256 = hex.EncodeToString(sum[:])
	run.ImageDigest = workerTestImage
	run.Command = []string{"node", "scripts/run.mjs"}

	worker.process(context.Background(), run)

	if string(executor.request.Bundle) != "bundle" || len(executor.request.Command) != 2 || executor.request.Command[1] != "scripts/run.mjs" {
		t.Fatalf("skill was not resolved from published version: %+v", executor.request)
	}
}

type recordingSkillExecutor struct {
	request domain.ExecuteRequest
	result  domain.ExecuteResult
}

func (skillExecutor *recordingSkillExecutor) Execute(_ context.Context, request domain.ExecuteRequest, _ policy.Profile) (domain.ExecuteResult, error) {
	skillExecutor.request = request
	return skillExecutor.result, nil
}

func (*recordingSkillExecutor) Cancel(context.Context, string) error { return nil }

func newTestWorker(t *testing.T, queue *fakeQueue, executor *fakeExecutor) *Worker {
	return newTestWorkerWithExecutor(t, queue, executor)
}

func newTestWorkerWithExecutor(t *testing.T, queue *fakeQueue, runExecutor executor.Executor) *Worker {
	t.Helper()
	policies := policy.NewRegistry()
	skills, err := skill.NewMemoryStore(policies)
	if err != nil {
		t.Fatal(err)
	}
	bundle := []byte("bundle")
	sum := sha256.Sum256(bundle)
	_, _ = skills.Upsert(context.Background(), skill.Definition{ID: "markdown-check", Name: "Markdown Check", Enabled: true})
	_, _, err = skills.Publish(context.Background(), skill.Version{Manifest: skill.Manifest{
		ID: "markdown-check", Version: "1.0.0", Runtime: "node",
		Entrypoint: []string{"node", "scripts/run.mjs"}, ProfileID: "skill-trusted",
		ImageDigest: workerTestImage, BundleSHA256: hex.EncodeToString(sum[:]), Network: "disabled",
		InputSchema: "schemas/input.json", OutputSchema: "schemas/output.json",
	}, Bundle: bundle})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := New(Config{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Queue: queue, Executor: runExecutor,
		Events: eventmemory.New(), Skills: skills,
		Policies: policies, WorkerID: "worker-1",
		ImageDigests: map[string]string{"skill-trusted": workerTestImage},
		Concurrency:  2, LeaseDuration: time.Minute, HeartbeatInterval: 20 * time.Second,
		PollInterval: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

func claimedRun() domain.Run {
	return domain.Run{
		UserID: "user-1", RunID: "run-1", IdempotencyKey: "idem-1",
		ProfileID: "skill-trusted", Command: []string{"node"}, TimeoutSeconds: 30,
		Status: domain.RunStatusPreparing, WorkerID: "worker-1", LeaseToken: "lease-1",
		Attempts: 1, MaxAttempts: 3,
	}
}
