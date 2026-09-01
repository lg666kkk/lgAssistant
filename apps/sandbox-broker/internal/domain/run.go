package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

const MaxCommandArguments = 64

type RunStatus string

const (
	RunStatusAccepted    RunStatus = "accepted"
	RunStatusRunning     RunStatus = "running"
	RunStatusCompleted   RunStatus = "completed"
	RunStatusFailed      RunStatus = "failed"
	RunStatusCancelled   RunStatus = "cancelled"
	RunStatusUnavailable RunStatus = "unavailable"
)

type ExecuteRequest struct {
	RunID          string   `json:"runId"`
	IdempotencyKey string   `json:"idempotencyKey"`
	ProfileID      string   `json:"profileId"`
	Command        []string `json:"command"`
	TimeoutSeconds int      `json:"timeoutSeconds,omitempty"`
}

type ExecuteResult struct {
	RunID     string    `json:"runId"`
	Status    RunStatus `json:"status"`
	ExitCode  *int      `json:"exitCode,omitempty"`
	StdoutRef string    `json:"stdoutRef,omitempty"`
	StderrRef string    `json:"stderrRef,omitempty"`
	PatchRef  string    `json:"patchRef,omitempty"`
	TimedOut  bool      `json:"timedOut"`
	OOMKilled bool      `json:"oomKilled"`
	Message   string    `json:"message,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

func (r ExecuteRequest) Validate() error {
	if strings.TrimSpace(r.RunID) == "" {
		return errors.New("runId is required")
	}
	if strings.TrimSpace(r.IdempotencyKey) == "" {
		return errors.New("idempotencyKey is required")
	}
	if strings.TrimSpace(r.ProfileID) == "" {
		return errors.New("profileId is required")
	}
	if len(r.Command) == 0 {
		return errors.New("command is required")
	}
	if len(r.Command) > MaxCommandArguments {
		return fmt.Errorf("command cannot contain more than %d arguments", MaxCommandArguments)
	}
	for index, argument := range r.Command {
		if strings.TrimSpace(argument) == "" {
			return fmt.Errorf("command argument %d cannot be empty", index)
		}
	}
	return nil
}
