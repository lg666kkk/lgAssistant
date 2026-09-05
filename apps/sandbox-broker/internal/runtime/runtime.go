package runtime

import (
	"context"
	"errors"
	"regexp"
	"time"
)

var imageDigestPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64}$`)

type NetworkMode string

const (
	NetworkDisabled NetworkMode = "disabled"
)

type ContainerSpec struct {
	RunID             string
	ProfileID         string
	WorkerID          string
	ImageDigest       string
	WorkspaceRoot     string
	WorkspacePath     string
	WorkspaceWritable bool
	Command           []string
	RunAsUID          int
	RunAsGID          int
	CPUQuotaMilli     int
	MemoryLimitMB     int
	PIDLimit          int
	Network           NetworkMode
}

type Container struct {
	ID   string
	Name string
}

type ExitResult struct {
	ExitCode  int
	OOMKilled bool
}

type Output struct {
	Data      []byte
	Truncated bool
}

type Runtime interface {
	Create(context.Context, ContainerSpec) (Container, error)
	Start(context.Context, string) error
	Wait(context.Context, string) (ExitResult, error)
	Logs(context.Context, string, int) (stdout Output, stderr Output, err error)
	Stop(context.Context, string, time.Duration) error
	Kill(context.Context, string) error
	Remove(context.Context, string) error
}

type OrphanCleaner interface {
	CleanupWorkerContainers(context.Context, string) (int, error)
}

func ValidateImageDigest(image string) error {
	if !imageDigestPattern.MatchString(image) {
		return errors.New("container image must use an immutable sha256 digest")
	}
	return nil
}
