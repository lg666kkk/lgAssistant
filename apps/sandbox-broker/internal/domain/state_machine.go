package domain

import (
	"errors"
	"fmt"
	"time"
)

var ErrInvalidRunTransition = errors.New("invalid sandbox run transition")

func (run *Run) Transition(next RunStatus, now time.Time) error {
	if run.Status == next {
		run.UpdatedAt = now
		return nil
	}
	if !CanTransition(run.Status, next) {
		return fmt.Errorf("%w: %s -> %s", ErrInvalidRunTransition, run.Status, next)
	}
	run.Status = next
	run.UpdatedAt = now
	if next == RunStatusRunning && run.StartedAt == nil {
		run.StartedAt = timePointer(now)
	}
	if next.IsTerminal() {
		run.CompletedAt = timePointer(now)
		run.LeaseToken = ""
		run.LeaseUntil = nil
	}
	return nil
}

func CanTransition(current RunStatus, next RunStatus) bool {
	switch current {
	case RunStatusAccepted:
		return next == RunStatusQueued || next == RunStatusUnavailable
	case RunStatusQueued:
		return next == RunStatusPreparing || next == RunStatusCancelled || next == RunStatusDead || next == RunStatusUnavailable
	case RunStatusPreparing:
		return next == RunStatusRunning || next == RunStatusRetryWait || next == RunStatusFailed || next == RunStatusDead || next == RunStatusCancelled
	case RunStatusRunning:
		return next == RunStatusPreparing || next == RunStatusCollecting || next == RunStatusRetryWait || next == RunStatusFailed || next == RunStatusTimedOut || next == RunStatusDead || next == RunStatusCancelled
	case RunStatusCollecting:
		return next == RunStatusPreparing || next == RunStatusCompleted || next == RunStatusRetryWait || next == RunStatusFailed || next == RunStatusDead || next == RunStatusCancelled
	case RunStatusRetryWait:
		return next == RunStatusQueued || next == RunStatusPreparing || next == RunStatusDead || next == RunStatusCancelled
	default:
		return false
	}
}

func timePointer(value time.Time) *time.Time {
	return &value
}
