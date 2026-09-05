package event

import (
	"context"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
)

type Store interface {
	Append(context.Context, string, string, any) (domain.Event, error)
	List(context.Context, string, int64, int) ([]domain.Event, error)
}
