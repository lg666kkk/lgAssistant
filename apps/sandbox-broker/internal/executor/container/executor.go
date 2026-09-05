package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/artifact"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/workspace"
)

const (
	defaultOutputLimit    = 1 << 20
	defaultSkillJSONLimit = 1 << 20
	defaultCleanupTimeout = 10 * time.Second
)

type Config struct {
	Runtime        sandboxruntime.Runtime
	Workspaces     *workspace.Manager
	Artifacts      artifact.Store
	WorkerID       string
	RunAsUID       int
	RunAsGID       int
	ImageDigests   map[string]string
	OutputLimit    int
	CleanupTimeout time.Duration
}

type activeRun struct {
	containerID string
	cancel      context.CancelFunc
	stopOnce    sync.Once
	stopErr     error
}

type Executor struct {
	runtime        sandboxruntime.Runtime
	workspaces     *workspace.Manager
	artifacts      artifact.Store
	workerID       string
	runAsUID       int
	runAsGID       int
	imageDigests   map[string]string
	outputLimit    int
	cleanupTimeout time.Duration
	mu             sync.Mutex
	active         map[string]*activeRun
}

var _ executor.Executor = (*Executor)(nil)

func New(config Config) (*Executor, error) {
	if config.Runtime == nil || config.Workspaces == nil || config.Artifacts == nil {
		return nil, errors.New("container runtime, workspace manager, and artifact store are required")
	}
	if config.WorkerID == "" {
		return nil, errors.New("sandbox worker id is required")
	}
	if config.RunAsUID <= 0 || config.RunAsGID < 0 {
		return nil, errors.New("container executor must run as a non-root worker user")
	}
	if len(config.ImageDigests) == 0 {
		return nil, errors.New("at least one sandbox image digest is required")
	}
	if config.OutputLimit <= 0 {
		config.OutputLimit = defaultOutputLimit
	}
	if config.CleanupTimeout <= 0 {
		config.CleanupTimeout = defaultCleanupTimeout
	}
	images := make(map[string]string, len(config.ImageDigests))
	for profileID, digest := range config.ImageDigests {
		if err := sandboxruntime.ValidateImageDigest(digest); err != nil {
			return nil, fmt.Errorf("invalid image for profile %s: %w", profileID, err)
		}
		images[profileID] = digest
	}
	return &Executor{
		runtime:        config.Runtime,
		workspaces:     config.Workspaces,
		artifacts:      config.Artifacts,
		workerID:       config.WorkerID,
		runAsUID:       config.RunAsUID,
		runAsGID:       config.RunAsGID,
		imageDigests:   images,
		outputLimit:    config.OutputLimit,
		cleanupTimeout: config.CleanupTimeout,
		active:         make(map[string]*activeRun),
	}, nil
}

func (sandbox *Executor) Execute(
	ctx context.Context,
	request domain.ExecuteRequest,
	profile policy.Profile,
) (domain.ExecuteResult, error) {
	createdAt := time.Now().UTC()
	imageDigest, ok := sandbox.imageDigests[profile.ID]
	if !ok || imageDigest == "" {
		return unavailableResult(request.RunID, createdAt, "sandbox image is not configured for profile"), executor.ErrExecutorUnavailable
	}
	if request.ResolvedImageDigest != "" && request.ResolvedImageDigest != imageDigest {
		return failedResult(request.RunID, createdAt, "published skill image is not allowed by the worker"), errors.New("published skill image does not match the configured profile image")
	}
	var work workspace.Workspace
	var err error
	if len(request.Bundle) > 0 {
		work, err = sandbox.workspaces.PrepareTar(ctx, bytes.NewReader(request.Bundle), request.BundleSHA256)
	} else {
		work, err = sandbox.workspaces.PrepareEmpty()
	}
	if err != nil {
		return failedResult(request.RunID, createdAt, "workspace preparation failed"), fmt.Errorf("prepare workspace: %w", err)
	}
	defer work.Cleanup()
	if len(request.Input) > 0 {
		if err := work.WriteFile("input.json", request.Input, 0o600); err != nil {
			return failedResult(request.RunID, createdAt, "sandbox input preparation failed"), err
		}
	}
	if request.InputSchemaPath != "" {
		schema, err := work.ReadFile(request.InputSchemaPath, defaultSkillJSONLimit)
		if err != nil {
			return failedResult(request.RunID, createdAt, "skill input schema could not be read"), err
		}
		if err := skill.ValidateJSON(schema, request.Input); err != nil {
			return failedResult(request.RunID, createdAt, "skill input did not match its schema"), fmt.Errorf("%w: %v", executor.ErrInvalidSkillInput, err)
		}
	}

	executionCtx, cancel := context.WithTimeout(ctx, time.Duration(request.TimeoutSeconds)*time.Second)
	defer cancel()
	container, err := sandbox.runtime.Create(executionCtx, sandboxruntime.ContainerSpec{
		RunID:             request.RunID,
		ProfileID:         profile.ID,
		WorkerID:          sandbox.workerID,
		ImageDigest:       imageDigest,
		WorkspaceRoot:     workspaceRoot(work.Path),
		WorkspacePath:     work.Path,
		WorkspaceWritable: profile.WritableWorkspace,
		Command:           append([]string(nil), request.Command...),
		RunAsUID:          sandbox.runAsUID,
		RunAsGID:          sandbox.runAsGID,
		CPUQuotaMilli:     profile.CPUQuotaMilli,
		MemoryLimitMB:     profile.MemoryLimitMB,
		PIDLimit:          profile.PIDLimit,
		Network:           sandboxruntime.NetworkMode(profile.Network),
	})
	if err != nil {
		return failedResult(request.RunID, createdAt, "container creation failed"), err
	}

	active := &activeRun{containerID: container.ID, cancel: cancel}
	sandbox.mu.Lock()
	if _, exists := sandbox.active[request.RunID]; exists {
		sandbox.mu.Unlock()
		sandbox.cleanupContainer(active)
		return failedResult(request.RunID, createdAt, "run is already active"), fmt.Errorf("run %s is already active", request.RunID)
	}
	sandbox.active[request.RunID] = active
	sandbox.mu.Unlock()
	defer func() {
		sandbox.mu.Lock()
		delete(sandbox.active, request.RunID)
		sandbox.mu.Unlock()
		sandbox.removeContainer(container.ID)
	}()

	if err := sandbox.runtime.Start(executionCtx, container.ID); err != nil {
		sandbox.stopContainer(active)
		return failedResult(request.RunID, createdAt, "container start failed"), err
	}
	exit, waitErr := sandbox.runtime.Wait(executionCtx, container.ID)
	if waitErr != nil {
		sandbox.stopContainer(active)
	}

	result := domain.ExecuteResult{RunID: request.RunID, CreatedAt: createdAt}
	if executionCtx.Err() != nil {
		if errors.Is(executionCtx.Err(), context.DeadlineExceeded) {
			result.Status = domain.RunStatusTimedOut
			result.TimedOut = true
			result.Message = "sandbox execution timed out"
		} else {
			result.Status = domain.RunStatusCancelled
			result.Message = "sandbox execution was cancelled"
		}
	} else if waitErr != nil {
		result.Status = domain.RunStatusFailed
		result.Message = "container wait failed"
	} else {
		result.ExitCode = &exit.ExitCode
		result.OOMKilled = exit.OOMKilled
		switch {
		case exit.OOMKilled:
			result.Status = domain.RunStatusFailed
			result.Message = "sandbox container was OOM killed"
		case exit.ExitCode == 0:
			result.Status = domain.RunStatusCompleted
		default:
			result.Status = domain.RunStatusFailed
			result.Message = fmt.Sprintf("sandbox command exited with code %d", exit.ExitCode)
		}
	}

	stdout, stderr, logsErr := sandbox.readLogs(container.ID)
	if logsErr != nil && waitErr == nil {
		return failedResult(request.RunID, createdAt, "container log collection failed"), logsErr
	}
	if len(stdout.Data) > 0 {
		stored, err := sandbox.artifacts.Put(context.Background(), artifact.PutRequest{
			RunID: request.RunID, Kind: artifact.KindStdout, ContentType: "text/plain; charset=utf-8",
			Data: stdout.Data, Truncated: stdout.Truncated,
		})
		if err != nil {
			return failedResult(request.RunID, createdAt, "stdout artifact storage failed"), err
		}
		result.StdoutRef = stored.Ref
	}
	if len(stderr.Data) > 0 {
		stored, err := sandbox.artifacts.Put(context.Background(), artifact.PutRequest{
			RunID: request.RunID, Kind: artifact.KindStderr, ContentType: "text/plain; charset=utf-8",
			Data: stderr.Data, Truncated: stderr.Truncated,
		})
		if err != nil {
			return failedResult(request.RunID, createdAt, "stderr artifact storage failed"), err
		}
		result.StderrRef = stored.Ref
	}
	if result.Status == domain.RunStatusCompleted && request.OutputSchemaPath != "" {
		output, err := work.ReadFile("result.json", defaultSkillJSONLimit)
		if err != nil {
			return failedResult(request.RunID, createdAt, "skill result.json could not be read"), err
		}
		schema, err := work.ReadFile(request.OutputSchemaPath, defaultSkillJSONLimit)
		if err != nil {
			return failedResult(request.RunID, createdAt, "skill output schema could not be read"), err
		}
		if err := skill.ValidateJSON(schema, output); err != nil {
			return failedResult(request.RunID, createdAt, "skill output did not match its schema"), fmt.Errorf("%w: %v", executor.ErrInvalidSkillOutput, err)
		}
		stored, err := sandbox.artifacts.Put(context.Background(), artifact.PutRequest{
			RunID: request.RunID, Kind: artifact.KindResult, ContentType: "application/json", Data: output,
		})
		if err != nil {
			return failedResult(request.RunID, createdAt, "skill result artifact storage failed"), err
		}
		result.ResultRef = stored.Ref
		result.Result = append([]byte(nil), output...)
	}
	return result, nil
}

func (sandbox *Executor) Cancel(ctx context.Context, runID string) error {
	sandbox.mu.Lock()
	active, ok := sandbox.active[runID]
	sandbox.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", executor.ErrRunNotActive, runID)
	}
	active.cancel()
	return sandbox.stopContainer(active)
}

func (sandbox *Executor) stopContainer(active *activeRun) error {
	active.stopOnce.Do(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), sandbox.cleanupTimeout)
		defer cancel()
		if err := sandbox.runtime.Stop(cleanupCtx, active.containerID, 2*time.Second); err != nil {
			active.stopErr = sandbox.runtime.Kill(cleanupCtx, active.containerID)
		}
	})
	return active.stopErr
}

func (sandbox *Executor) cleanupContainer(active *activeRun) {
	_ = sandbox.stopContainer(active)
	sandbox.removeContainer(active.containerID)
}

func (sandbox *Executor) removeContainer(containerID string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), sandbox.cleanupTimeout)
	defer cancel()
	_ = sandbox.runtime.Remove(cleanupCtx, containerID)
}

func (sandbox *Executor) readLogs(containerID string) (sandboxruntime.Output, sandboxruntime.Output, error) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), sandbox.cleanupTimeout)
	defer cancel()
	return sandbox.runtime.Logs(cleanupCtx, containerID, sandbox.outputLimit)
}

func workspaceRoot(path string) string {
	return filepath.Dir(path)
}

func unavailableResult(runID string, createdAt time.Time, message string) domain.ExecuteResult {
	return domain.ExecuteResult{RunID: runID, Status: domain.RunStatusUnavailable, Message: message, CreatedAt: createdAt}
}

func failedResult(runID string, createdAt time.Time, message string) domain.ExecuteResult {
	return domain.ExecuteResult{RunID: runID, Status: domain.RunStatusFailed, Message: message, CreatedAt: createdAt}
}
