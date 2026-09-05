package domain

import (
	"errors"
	"testing"
	"time"
)

func TestRunTransitionLifecycle(t *testing.T) {
	now := time.Date(2026, time.September, 4, 0, 0, 0, 0, time.UTC)
	run := Run{Status: RunStatusQueued}
	for index, status := range []RunStatus{RunStatusPreparing, RunStatusRunning, RunStatusCollecting, RunStatusCompleted} {
		if err := run.Transition(status, now.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatalf("transition to %s: %v", status, err)
		}
	}
	if run.StartedAt == nil || run.CompletedAt == nil || !run.Status.IsTerminal() {
		t.Fatalf("lifecycle timestamps were not recorded: %+v", run)
	}
}

func TestRunTransitionRejectsTerminalMutation(t *testing.T) {
	run := Run{Status: RunStatusCompleted}
	err := run.Transition(RunStatusRunning, time.Now())
	if !errors.Is(err, ErrInvalidRunTransition) {
		t.Fatalf("expected ErrInvalidRunTransition, got %v", err)
	}
}

func TestRunTransitionAllowsExpiredLeaseRecovery(t *testing.T) {
	for _, status := range []RunStatus{RunStatusRunning, RunStatusCollecting} {
		run := Run{Status: status}
		if err := run.Transition(RunStatusPreparing, time.Now()); err != nil {
			t.Fatalf("recover %s: %v", status, err)
		}
	}
}
