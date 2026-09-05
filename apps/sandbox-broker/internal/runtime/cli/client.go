package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
)

const controlOutputLimit = 64 * 1024

type CommandOutput struct {
	Stdout          []byte
	Stderr          []byte
	StdoutTruncated bool
	StderrTruncated bool
}

type CommandRunner interface {
	Run(context.Context, string, []string, int) (CommandOutput, error)
}

type Client struct {
	binary string
	runner CommandRunner
}

var _ sandboxruntime.Runtime = (*Client)(nil)

func NewClient(binary string, runner CommandRunner) (*Client, error) {
	if binary != "podman" && binary != "docker" {
		return nil, errors.New("container runtime must be podman or docker")
	}
	if runner == nil {
		runner = OSCommandRunner{}
	}
	return &Client{binary: binary, runner: runner}, nil
}

func (client *Client) Create(ctx context.Context, spec sandboxruntime.ContainerSpec) (sandboxruntime.Container, error) {
	arguments, err := BuildCreateArguments(client.binary, spec)
	if err != nil {
		return sandboxruntime.Container{}, err
	}
	output, err := client.run(ctx, arguments, controlOutputLimit)
	if err != nil {
		return sandboxruntime.Container{}, fmt.Errorf("create sandbox container: %w", err)
	}
	id := strings.TrimSpace(string(output.Stdout))
	if id == "" {
		return sandboxruntime.Container{}, errors.New("container runtime returned an empty container id")
	}
	name, _ := ContainerName(spec.RunID)
	return sandboxruntime.Container{ID: id, Name: name}, nil
}

func (client *Client) Start(ctx context.Context, id string) error {
	_, err := client.run(ctx, []string{"start", id}, controlOutputLimit)
	return wrapOperationError("start", err)
}

func (client *Client) Wait(ctx context.Context, id string) (sandboxruntime.ExitResult, error) {
	output, err := client.run(ctx, []string{"wait", id}, controlOutputLimit)
	if err != nil {
		return sandboxruntime.ExitResult{}, fmt.Errorf("wait for sandbox container: %w", err)
	}
	exitCode, err := strconv.Atoi(strings.TrimSpace(string(output.Stdout)))
	if err != nil {
		return sandboxruntime.ExitResult{}, fmt.Errorf("parse sandbox exit code: %w", err)
	}

	inspect, err := client.run(ctx, []string{"inspect", "--format={{.State.OOMKilled}}", id}, controlOutputLimit)
	if err != nil {
		return sandboxruntime.ExitResult{}, fmt.Errorf("inspect sandbox container: %w", err)
	}
	oomKilled, err := strconv.ParseBool(strings.TrimSpace(string(inspect.Stdout)))
	if err != nil {
		return sandboxruntime.ExitResult{}, fmt.Errorf("parse sandbox OOM state: %w", err)
	}
	return sandboxruntime.ExitResult{ExitCode: exitCode, OOMKilled: oomKilled}, nil
}

func (client *Client) Logs(ctx context.Context, id string, limit int) (sandboxruntime.Output, sandboxruntime.Output, error) {
	if limit <= 0 {
		return sandboxruntime.Output{}, sandboxruntime.Output{}, errors.New("log output limit must be positive")
	}
	output, err := client.run(ctx, []string{"logs", id}, limit)
	if err != nil {
		return sandboxruntime.Output{}, sandboxruntime.Output{}, fmt.Errorf("read sandbox logs: %w", err)
	}
	return sandboxruntime.Output{Data: output.Stdout, Truncated: output.StdoutTruncated},
		sandboxruntime.Output{Data: output.Stderr, Truncated: output.StderrTruncated}, nil
}

func (client *Client) Stop(ctx context.Context, id string, grace time.Duration) error {
	seconds := int(grace.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	_, err := client.run(ctx, []string{"stop", "--time=" + strconv.Itoa(seconds), id}, controlOutputLimit)
	return wrapOperationError("stop", err)
}

func (client *Client) Kill(ctx context.Context, id string) error {
	_, err := client.run(ctx, []string{"kill", id}, controlOutputLimit)
	return wrapOperationError("kill", err)
}

func (client *Client) Remove(ctx context.Context, id string) error {
	_, err := client.run(ctx, []string{"rm", "--force", id}, controlOutputLimit)
	return wrapOperationError("remove", err)
}

func (client *Client) CleanupWorkerContainers(ctx context.Context, workerID string) (int, error) {
	if !containerIDPattern.MatchString(workerID) {
		return 0, errors.New("worker id must use safe label characters")
	}
	output, err := client.run(ctx, []string{
		"ps", "--all", "--quiet", "--filter=label=sandbox.worker_id=" + workerID,
	}, controlOutputLimit)
	if err != nil {
		return 0, fmt.Errorf("list orphan sandbox containers: %w", err)
	}
	containerIDs := strings.Fields(string(output.Stdout))
	for _, containerID := range containerIDs {
		if !containerIDPattern.MatchString(containerID) {
			return 0, fmt.Errorf("container runtime returned an unsafe container id: %q", containerID)
		}
		if err := client.Remove(ctx, containerID); err != nil {
			return 0, err
		}
	}
	return len(containerIDs), nil
}

func (client *Client) run(ctx context.Context, arguments []string, limit int) (CommandOutput, error) {
	output, err := client.runner.Run(ctx, client.binary, arguments, limit)
	if err == nil {
		return output, nil
	}
	message := strings.TrimSpace(string(output.Stderr))
	if len(message) > 4096 {
		message = message[:4096]
	}
	if message == "" {
		return output, err
	}
	return output, fmt.Errorf("%w: %s", err, message)
}

func wrapOperationError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s sandbox container: %w", operation, err)
}

type OSCommandRunner struct{}

func (OSCommandRunner) Run(ctx context.Context, binary string, arguments []string, limit int) (CommandOutput, error) {
	stdout := newLimitedBuffer(limit)
	stderr := newLimitedBuffer(limit)
	command := exec.CommandContext(ctx, binary, arguments...)
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	return CommandOutput{
		Stdout:          stdout.Bytes(),
		Stderr:          stderr.Bytes(),
		StdoutTruncated: stdout.Truncated(),
		StderrTruncated: stderr.Truncated(),
	}, err
}

type limitedBuffer struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func newLimitedBuffer(limit int) *limitedBuffer {
	return &limitedBuffer{limit: limit}
}

func (buffer *limitedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := buffer.limit - buffer.buffer.Len()
	if remaining <= 0 {
		buffer.truncated = buffer.truncated || originalLength > 0
		return originalLength, nil
	}
	if len(value) > remaining {
		value = value[:remaining]
		buffer.truncated = true
	}
	_, _ = buffer.buffer.Write(value)
	return originalLength, nil
}

func (buffer *limitedBuffer) Bytes() []byte {
	return bytes.Clone(buffer.buffer.Bytes())
}

func (buffer *limitedBuffer) Truncated() bool {
	return buffer.truncated
}
