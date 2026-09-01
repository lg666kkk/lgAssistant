package domain

import "testing"

func TestExecuteRequestValidate(t *testing.T) {
	tests := []struct {
		name    string
		request ExecuteRequest
		wantErr bool
	}{
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
			wantErr: true,
		},
		{
			name: "missing command",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
			},
			wantErr: true,
		},
		{
			name: "empty command argument",
			request: ExecuteRequest{
				RunID:          "run-1",
				IdempotencyKey: "idem-1",
				ProfileID:      "skill-trusted",
				Command:        []string{"node", ""},
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.request.Validate()
			if test.wantErr && err == nil {
				t.Fatal("expected validation error")
			}
			if !test.wantErr && err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
		})
	}
}
