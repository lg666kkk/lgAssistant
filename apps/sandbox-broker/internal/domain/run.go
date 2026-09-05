package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	MaxUserIDBytes          = 128
	MaxRunIDBytes           = 64
	MaxIdempotencyKeyBytes  = 256
	MaxCommandArguments     = 64
	MaxCommandArgumentBytes = 4096
)

var runIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

type RunStatus string

type RunKind string

const (
	RunKindCommand RunKind = "command"
	RunKindSkill   RunKind = "skill"
	RunKindCoding  RunKind = "coding"
)

const (
	RunStatusAccepted    RunStatus = "accepted"
	RunStatusQueued      RunStatus = "queued"
	RunStatusPreparing   RunStatus = "preparing"
	RunStatusRunning     RunStatus = "running"
	RunStatusCollecting  RunStatus = "collecting_artifacts"
	RunStatusCompleted   RunStatus = "completed"
	RunStatusFailed      RunStatus = "failed"
	RunStatusTimedOut    RunStatus = "timed_out"
	RunStatusCancelled   RunStatus = "cancelled"
	RunStatusRetryWait   RunStatus = "retry_wait"
	RunStatusDead        RunStatus = "dead"
	RunStatusUnavailable RunStatus = "unavailable"
)

type ExecuteRequest struct {
	UserID              string          `json:"userId"`
	SessionID           string          `json:"sessionId,omitempty"`
	ToolCallID          string          `json:"toolCallId,omitempty"`
	RunID               string          `json:"runId"`
	IdempotencyKey      string          `json:"idempotencyKey"`
	ProfileID           string          `json:"profileId"`
	Command             []string        `json:"command"`
	Input               json.RawMessage `json:"input,omitempty"`
	TimeoutSeconds      int             `json:"timeoutSeconds,omitempty"`
	Bundle              []byte          `json:"-"`
	BundleSHA256        string          `json:"-"`
	ResolvedImageDigest string          `json:"-"`
	InputSchemaPath     string          `json:"-"`
	OutputSchemaPath    string          `json:"-"`
}

type SkillRunRequest struct {
	UserID         string          `json:"userId"`
	SessionID      string          `json:"sessionId,omitempty"`
	ToolCallID     string          `json:"toolCallId,omitempty"`
	RunID          string          `json:"runId"`
	IdempotencyKey string          `json:"idempotencyKey"`
	SkillID        string          `json:"skillId"`
	SkillVersion   string          `json:"skillVersion"`
	Input          json.RawMessage `json:"input"`
}

func (request SkillRunRequest) Validate() error {
	base := ExecuteRequest{
		UserID: request.UserID, RunID: request.RunID,
		IdempotencyKey: request.IdempotencyKey, ProfileID: "skill",
		Command: []string{"skill"},
	}
	if err := base.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(request.SkillID) == "" {
		return errors.New("skillId is required")
	}
	if strings.TrimSpace(request.SkillVersion) == "" {
		return errors.New("skillVersion is required")
	}
	if len(request.Input) == 0 || !json.Valid(request.Input) {
		return errors.New("input must be valid JSON")
	}
	return nil
}

type Run struct {
	UserID            string          `json:"userId"`
	SessionID         string          `json:"sessionId,omitempty"`
	RequestID         string          `json:"requestId"`
	ToolCallID        string          `json:"toolCallId,omitempty"`
	Kind              RunKind         `json:"kind"`
	RunID             string          `json:"runId"`
	IdempotencyKey    string          `json:"idempotencyKey"`
	InputHash         string          `json:"inputHash"`
	ProfileID         string          `json:"profileId"`
	ProfileVersion    string          `json:"profileVersion"`
	SkillID           string          `json:"skillId,omitempty"`
	SkillVersion      string          `json:"skillVersion,omitempty"`
	SkillBundleSHA256 string          `json:"skillBundleSha256,omitempty"`
	Command           []string        `json:"command"`
	Input             json.RawMessage `json:"input,omitempty"`
	TimeoutSeconds    int             `json:"timeoutSeconds"`
	Status            RunStatus       `json:"status"`
	Attempts          int             `json:"attempts"`
	MaxAttempts       int             `json:"maxAttempts"`
	WorkerID          string          `json:"workerId,omitempty"`
	LeaseToken        string          `json:"-"`
	LeaseUntil        *time.Time      `json:"leaseUntil,omitempty"`
	NextAttemptAt     time.Time       `json:"nextAttemptAt"`
	ExitCode          *int            `json:"exitCode,omitempty"`
	TimedOut          bool            `json:"timedOut"`
	OOMKilled         bool            `json:"oomKilled"`
	Message           string          `json:"message,omitempty"`
	ErrorCode         string          `json:"errorCode,omitempty"`
	ImageDigest       string          `json:"imageDigest,omitempty"`
	StdoutRef         string          `json:"stdoutRef,omitempty"`
	StderrRef         string          `json:"stderrRef,omitempty"`
	PatchRef          string          `json:"patchRef,omitempty"`
	ResultRef         string          `json:"resultRef,omitempty"`
	Result            json.RawMessage `json:"result,omitempty"`
	CancelRequestedAt *time.Time      `json:"cancelRequestedAt,omitempty"`
	StartedAt         *time.Time      `json:"startedAt,omitempty"`
	CompletedAt       *time.Time      `json:"completedAt,omitempty"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

func (status RunStatus) IsTerminal() bool {
	switch status {
	case RunStatusCompleted,
		RunStatusFailed,
		RunStatusTimedOut,
		RunStatusCancelled,
		RunStatusDead,
		RunStatusUnavailable:
		return true
	default:
		return false
	}
}

type ExecuteResult struct {
	RunID     string          `json:"runId"`
	Status    RunStatus       `json:"status"`
	ExitCode  *int            `json:"exitCode,omitempty"`
	StdoutRef string          `json:"stdoutRef,omitempty"`
	StderrRef string          `json:"stderrRef,omitempty"`
	PatchRef  string          `json:"patchRef,omitempty"`
	ResultRef string          `json:"resultRef,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	TimedOut  bool            `json:"timedOut"`
	OOMKilled bool            `json:"oomKilled"`
	Message   string          `json:"message,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
}

func (r ExecuteRequest) Validate() error {
	if strings.TrimSpace(r.UserID) == "" {
		return errors.New("userId is required")
	}
	if len(r.UserID) > MaxUserIDBytes {
		return fmt.Errorf("userId cannot exceed %d bytes", MaxUserIDBytes)
	}
	if strings.TrimSpace(r.RunID) == "" {
		return errors.New("runId is required")
	}
	if len(r.RunID) > MaxRunIDBytes {
		return fmt.Errorf("runId cannot exceed %d bytes", MaxRunIDBytes)
	}
	if !runIDPattern.MatchString(r.RunID) {
		return errors.New("runId must contain only lowercase letters, digits, dot, underscore, or hyphen")
	}
	if strings.TrimSpace(r.IdempotencyKey) == "" {
		return errors.New("idempotencyKey is required")
	}
	if len(r.IdempotencyKey) > MaxIdempotencyKeyBytes {
		return fmt.Errorf("idempotencyKey cannot exceed %d bytes", MaxIdempotencyKeyBytes)
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
	if r.TimeoutSeconds < 0 {
		return errors.New("timeoutSeconds cannot be negative")
	}
	for index, argument := range r.Command {
		if strings.TrimSpace(argument) == "" {
			return fmt.Errorf("command argument %d cannot be empty", index)
		}
		if len(argument) > MaxCommandArgumentBytes {
			return fmt.Errorf("command argument %d cannot exceed %d bytes", index, MaxCommandArgumentBytes)
		}
	}
	return nil
}
