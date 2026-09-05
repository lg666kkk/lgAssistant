package domain

import "testing"

func TestExecuteInputHashIsDeterministicAndExcludesRequestIdentity(t *testing.T) {
	first := ExecuteRequest{
		UserID: "user-1",
		RunID:  "run-1", IdempotencyKey: "idem-1", ProfileID: "skill-trusted",
		Command: []string{"node", "script.mjs"}, TimeoutSeconds: 20,
	}
	second := first
	second.RunID = "run-2"
	second.IdempotencyKey = "idem-2"
	if ExecuteInputHash(first) != ExecuteInputHash(second) {
		t.Fatal("request identity must not change the execution input hash")
	}
	second.Command = []string{"node", "other.mjs"}
	if ExecuteInputHash(first) == ExecuteInputHash(second) {
		t.Fatal("command change must change the execution input hash")
	}
}
