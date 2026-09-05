package container

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	artifactfs "github.com/lg/personal-assistant/apps/sandbox-broker/internal/artifact/filesystem"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/workspace"
)

const executorTestImage = "registry.example/sandbox/node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeRuntime struct {
	mu          sync.Mutex
	createdSpec sandboxruntime.ContainerSpec
	inputData   []byte
	created     chan struct{}
	waitForDone bool
	stops       int
	kills       int
	removes     int
	exit        sandboxruntime.ExitResult
	stdout      sandboxruntime.Output
	stderr      sandboxruntime.Output
	stopErr     error
	resultData  []byte
}

func (runtime *fakeRuntime) Create(_ context.Context, spec sandboxruntime.ContainerSpec) (sandboxruntime.Container, error) {
	runtime.mu.Lock()
	runtime.createdSpec = spec
	runtime.inputData, _ = os.ReadFile(filepath.Join(spec.WorkspacePath, "input.json"))
	created := runtime.created
	runtime.mu.Unlock()
	if created != nil {
		close(created)
	}
	return sandboxruntime.Container{ID: "container-1", Name: "sandbox-" + spec.RunID}, nil
}

func (runtime *fakeRuntime) Start(context.Context, string) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.resultData != nil {
		return os.WriteFile(filepath.Join(runtime.createdSpec.WorkspacePath, "result.json"), runtime.resultData, 0o600)
	}
	return nil
}

func (runtime *fakeRuntime) Wait(ctx context.Context, _ string) (sandboxruntime.ExitResult, error) {
	if runtime.waitForDone {
		<-ctx.Done()
		return sandboxruntime.ExitResult{}, ctx.Err()
	}
	return runtime.exit, nil
}

func (runtime *fakeRuntime) Logs(context.Context, string, int) (sandboxruntime.Output, sandboxruntime.Output, error) {
	return runtime.stdout, runtime.stderr, nil
}

func (runtime *fakeRuntime) Stop(context.Context, string, time.Duration) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.stops++
	return runtime.stopErr
}

func (runtime *fakeRuntime) Kill(context.Context, string) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.kills++
	return nil
}

func (runtime *fakeRuntime) Remove(context.Context, string) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.removes++
	return nil
}

func TestExecutorCompletesAndStoresOutput(t *testing.T) {
	runtime := &fakeRuntime{
		exit:   sandboxruntime.ExitResult{ExitCode: 0},
		stdout: sandboxruntime.Output{Data: []byte("hello"), Truncated: true},
		stderr: sandboxruntime.Output{Data: []byte("warning")},
	}
	sandbox := newTestExecutor(t, runtime)

	request := testRequest(30)
	request.Input = []byte(`{"value":42}`)
	result, err := sandbox.Execute(context.Background(), request, testProfile())
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Status != domain.RunStatusCompleted || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.StdoutRef == "" || result.StderrRef == "" {
		t.Fatalf("output artifacts were not stored: %+v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.createdSpec.ImageDigest != executorTestImage || runtime.removes != 1 || string(runtime.inputData) != `{"value":42}` {
		t.Fatalf("unexpected runtime state: %+v", runtime)
	}
}

func TestExecutorValidatesSkillInputAndOutput(t *testing.T) {
	bundle := skillBundle(t)
	sum := sha256.Sum256(bundle)
	runtime := &fakeRuntime{
		exit:       sandboxruntime.ExitResult{ExitCode: 0},
		resultData: []byte(`{"valid":true}`),
	}
	sandbox := newTestExecutor(t, runtime)
	request := testRequest(30)
	request.Input = []byte(`{"markdown":"# Title"}`)
	request.Bundle = bundle
	request.BundleSHA256 = hex.EncodeToString(sum[:])
	request.InputSchemaPath = "schemas/input.json"
	request.OutputSchemaPath = "schemas/output.json"
	request.ResolvedImageDigest = executorTestImage

	result, err := sandbox.Execute(context.Background(), request, testProfile())
	if err != nil {
		t.Fatalf("execute skill: %v", err)
	}
	if result.Status != domain.RunStatusCompleted || result.ResultRef == "" || string(result.Result) != `{"valid":true}` {
		t.Fatalf("validated result artifact missing: %+v", result)
	}
}

func TestExecutorRejectsSkillInputBeforeContainerCreate(t *testing.T) {
	bundle := skillBundle(t)
	sum := sha256.Sum256(bundle)
	runtime := &fakeRuntime{exit: sandboxruntime.ExitResult{ExitCode: 0}}
	sandbox := newTestExecutor(t, runtime)
	request := testRequest(30)
	request.Input = []byte(`{"markdown":42}`)
	request.Bundle = bundle
	request.BundleSHA256 = hex.EncodeToString(sum[:])
	request.InputSchemaPath = "schemas/input.json"

	if _, err := sandbox.Execute(context.Background(), request, testProfile()); err == nil {
		t.Fatal("expected invalid Skill input to fail")
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.createdSpec.RunID != "" {
		t.Fatal("container was created before Skill input validation")
	}
}

func TestExecutorTimeoutStopsAndRemovesContainer(t *testing.T) {
	runtime := &fakeRuntime{waitForDone: true}
	sandbox := newTestExecutor(t, runtime)

	result, err := sandbox.Execute(context.Background(), testRequest(0), testProfile())
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Status != domain.RunStatusTimedOut || !result.TimedOut {
		t.Fatalf("unexpected timeout result: %+v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.stops != 1 || runtime.removes != 1 {
		t.Fatalf("expected stop and remove, got stops=%d removes=%d", runtime.stops, runtime.removes)
	}
}

func TestExecutorCancelStopsActiveContainer(t *testing.T) {
	runtime := &fakeRuntime{created: make(chan struct{}), waitForDone: true}
	sandbox := newTestExecutor(t, runtime)
	resultChannel := make(chan domain.ExecuteResult, 1)
	errorChannel := make(chan error, 1)
	go func() {
		result, err := sandbox.Execute(context.Background(), testRequest(30), testProfile())
		resultChannel <- result
		errorChannel <- err
	}()
	<-runtime.created

	if err := sandbox.Cancel(context.Background(), "run-1"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	result := <-resultChannel
	if err := <-errorChannel; err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Status != domain.RunStatusCancelled {
		t.Fatalf("unexpected cancel result: %+v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.stops != 1 || runtime.removes != 1 {
		t.Fatalf("expected one stop and remove, got stops=%d removes=%d", runtime.stops, runtime.removes)
	}
}

func TestExecutorKillsWhenGracefulStopFails(t *testing.T) {
	runtime := &fakeRuntime{waitForDone: true, stopErr: context.DeadlineExceeded}
	sandbox := newTestExecutor(t, runtime)

	_, err := sandbox.Execute(context.Background(), testRequest(0), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.kills != 1 {
		t.Fatalf("expected kill fallback, got %d", runtime.kills)
	}
}

func newTestExecutor(t *testing.T, runtime sandboxruntime.Runtime) *Executor {
	t.Helper()
	workspaces, err := workspace.NewManager(workspace.Config{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	artifacts, err := artifactfs.New(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sandbox, err := New(Config{
		Runtime: runtime, Workspaces: workspaces, Artifacts: artifacts,
		WorkerID: "worker-1", RunAsUID: 1000, RunAsGID: 1000,
		ImageDigests: map[string]string{"skill-trusted": executorTestImage},
	})
	if err != nil {
		t.Fatal(err)
	}
	return sandbox
}

func testRequest(timeout int) domain.ExecuteRequest {
	return domain.ExecuteRequest{
		UserID: "user-1",
		RunID:  "run-1", IdempotencyKey: "idem-1", ProfileID: "skill-trusted",
		Command: []string{"node", "script.mjs"}, TimeoutSeconds: timeout,
	}
}

func testProfile() policy.Profile {
	profile, _ := policy.NewRegistry().Get("skill-trusted")
	return profile
}

func skillBundle(t *testing.T) []byte {
	t.Helper()
	files := map[string]string{
		"scripts/run.mjs":     "// test",
		"schemas/input.json":  `{"type":"object","required":["markdown"],"properties":{"markdown":{"type":"string"}}}`,
		"schemas/output.json": `{"type":"object","required":["valid"],"properties":{"valid":{"type":"boolean"}}}`,
	}
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for name, content := range files {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
