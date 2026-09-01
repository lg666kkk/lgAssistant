package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
)

type recordingExecutor struct {
	request domain.ExecuteRequest
	profile policy.Profile
}

func (e *recordingExecutor) Execute(
	_ context.Context,
	request domain.ExecuteRequest,
	profile policy.Profile,
) (domain.ExecuteResult, error) {
	e.request = request
	e.profile = profile
	return domain.ExecuteResult{
		RunID:     request.RunID,
		Status:    domain.RunStatusAccepted,
		CreatedAt: time.Now().UTC(),
	}, nil
}

func (*recordingExecutor) Cancel(context.Context, string) error {
	return nil
}

func TestHealth(t *testing.T) {
	handler := newTestHandler(executor.DisabledExecutor{})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"service":"sandbox-broker"`) {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestCreateRunRejectsUnknownProfile(t *testing.T) {
	handler := newTestHandler(executor.DisabledExecutor{})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId":          "run-1",
		"idempotencyKey": "idem-1",
		"profileId":      "host-root",
		"command":        []string{"sh", "-c", "id"},
	})

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", response.Code, response.Body.String())
	}
}

func TestCreateRunClampsTimeoutToProfile(t *testing.T) {
	exec := &recordingExecutor{}
	handler := newTestHandler(exec)
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId":          "run-1",
		"idempotencyKey": "idem-1",
		"profileId":      "skill-trusted",
		"command":        []string{"node", "script.mjs"},
		"timeoutSeconds": 9999,
	})

	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	if exec.request.TimeoutSeconds != exec.profile.TimeoutSeconds {
		t.Fatalf("timeout was not clamped: request=%d profile=%d", exec.request.TimeoutSeconds, exec.profile.TimeoutSeconds)
	}
}

func TestDisabledExecutorReturnsNotImplemented(t *testing.T) {
	handler := newTestHandler(executor.DisabledExecutor{})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId":          "run-1",
		"idempotencyKey": "idem-1",
		"profileId":      "coding-untrusted",
		"command":        []string{"npm", "test"},
	})

	if response.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d: %s", response.Code, response.Body.String())
	}
}

func newTestHandler(exec executor.Executor) *Handler {
	return NewHandler(Dependencies{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Policies: policy.NewRegistry(),
		Executor: exec,
	})
}

func performJSONRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	value any,
) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
