package domain

import (
	"strings"
	"testing"
)

func TestExecuteRequestValidate(t *testing.T) {
	tests := []struct {
		name        string
		request     ExecuteRequest
		wantMessage string
	}{
		{
			name: "missing user id",
			request: ExecuteRequest{
				RunID: "run-1", IdempotencyKey: "idem-1", ProfileID: "skill-trusted", Command: []string{"node"},
			},
			wantMessage: "userId is required",
		},
		{
			name: "valid request",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node", "scripts/check.mjs"},
			},
		},
		{
			name: "missing run id",
			request: ExecuteRequest{
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
			},
			wantMessage: "runId is required",
		},
		{
			name: "run id at maximum length",
			request: ExecuteRequest{
				RunID:          strings.Repeat("r", MaxRunIDBytes),
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
			},
		},
		{
			name: "run id exceeds maximum length",
			request: ExecuteRequest{
				RunID:          strings.Repeat("r", MaxRunIDBytes+1),
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
			},
			wantMessage: "runId cannot exceed 64 bytes",
		},
		{
			name: "run id contains unsafe characters",
			request: ExecuteRequest{
				RunID: "../RUN", IdempotencyKey: "idem-1", ProfileID: "skill-trusted", Command: []string{"node"},
			},
			wantMessage: "runId must contain only lowercase letters, digits, dot, underscore, or hyphen",
		},
		{
			name: "idempotency key at maximum length",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: strings.Repeat("i", MaxIdempotencyKeyBytes),
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
			},
		},
		{
			name: "idempotency key exceeds maximum length",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: strings.Repeat("i", MaxIdempotencyKeyBytes+1),
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
			},
			wantMessage: "idempotencyKey cannot exceed 256 bytes",
		},
		{
			name: "missing command",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
			},
			wantMessage: "command is required",
		},
		{
			name: "maximum number of command arguments",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        repeatedArguments(MaxCommandArguments, "x"),
			},
		},
		{
			name: "too many command arguments",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        repeatedArguments(MaxCommandArguments+1, "x"),
			},
			wantMessage: "command cannot contain more than 64 arguments",
		},
		{
			name: "empty command argument",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node", ""},
			},
			wantMessage: "command argument 1 cannot be empty",
		},
		{
			name: "command argument at maximum length",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{strings.Repeat("x", MaxCommandArgumentBytes)},
			},
		},
		{
			name: "command argument exceeds maximum length",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{strings.Repeat("x", MaxCommandArgumentBytes+1)},
			},
			wantMessage: "command argument 0 cannot exceed 4096 bytes",
		},
		{
			name: "zero timeout uses profile default",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
				TimeoutSeconds: 0,
			},
		},
		{
			name: "negative timeout",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node"},
				TimeoutSeconds: -1,
			},
			wantMessage: "timeoutSeconds cannot be negative",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := test.request
			if test.name != "missing user id" && request.UserID == "" {
				request.UserID = "user-1"
			}
			err := request.Validate()
			if test.wantMessage == "" && err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
			if test.wantMessage != "" && (err == nil || err.Error() != test.wantMessage) {
				t.Fatalf("expected validation error %q, got %v", test.wantMessage, err)
			}
		})
	}
}

func repeatedArguments(count int, value string) []string {
	arguments := make([]string, count)
	for index := range arguments {
		arguments[index] = value
	}
	return arguments
}
