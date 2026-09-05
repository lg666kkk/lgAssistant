package executor

import (
	"context"
	"errors"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
)

var (
	ErrExecutorUnavailable = errors.New("sandbox executor is not configured")
	ErrRunNotActive        = errors.New("sandbox run is not active")
	ErrInvalidSkillInput   = errors.New("sandbox skill input is invalid")
	ErrInvalidSkillOutput  = errors.New("sandbox skill output is invalid")
)

type Executor interface {
	Execute(context.Context, domain.ExecuteRequest, policy.Profile) (domain.ExecuteResult, error)
	Cancel(context.Context, string) error
}

type DisabledExecutor struct{}

func (DisabledExecutor) Execute(
	_ context.Context,
	request domain.ExecuteRequest,
	_ policy.Profile,
) (domain.ExecuteResult, error) {
	return domain.ExecuteResult{
		RunID:     request.RunID,
		Status:    domain.RunStatusUnavailable,
		Message:   ErrExecutorUnavailable.Error(),
		CreatedAt: time.Now().UTC(),
	}, ErrExecutorUnavailable
}

func (DisabledExecutor) Cancel(context.Context, string) error {
	return ErrExecutorUnavailable
}
