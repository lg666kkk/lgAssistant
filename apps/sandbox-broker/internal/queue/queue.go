package queue

import (
	"context"
	"errors"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
)

var ErrLeaseLost = errors.New("sandbox run lease was lost")

type Queue interface {
	Claim(context.Context, string, int, time.Duration) ([]domain.Run, error)
	Heartbeat(context.Context, domain.Run, time.Duration) error
	CancellationRequested(context.Context, domain.Run) (bool, error)
	MarkRunning(context.Context, domain.Run, string) error
	Finish(context.Context, domain.Run, domain.ExecuteResult) error
	Fail(context.Context, domain.Run, string) error
}
