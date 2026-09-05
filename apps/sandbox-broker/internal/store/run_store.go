package store

import (
	"context"
	"errors"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
)

var (
	ErrRunNotFound         = errors.New("sandbox run not found")
	ErrDuplicateRun        = errors.New("sandbox run already exists")
	ErrRunConflict         = errors.New("sandbox run update conflicts with stored identity")
	ErrIdempotencyConflict = errors.New("idempotency key was already used for different input")
	ErrRunNotCancellable   = errors.New("sandbox run is already terminal")
)

type RunStore interface {
	Create(context.Context, domain.Run) (domain.Run, bool, error)
	Get(context.Context, string) (domain.Run, error)
	Update(context.Context, domain.Run) (domain.Run, error)
	RequestCancel(context.Context, string, time.Time) (domain.Run, error)
}
