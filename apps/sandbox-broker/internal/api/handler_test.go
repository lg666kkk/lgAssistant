package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/auth"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	eventmemory "github.com/lg/personal-assistant/apps/sandbox-broker/internal/event/memory"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
	storememory "github.com/lg/personal-assistant/apps/sandbox-broker/internal/store/memory"
)

type recordingExecutor struct {
	request        domain.ExecuteRequest
	profile        policy.Profile
	executeCalls   int
	cancelledRunID string
}

func (e *recordingExecutor) Execute(
	_ context.Context,
	request domain.ExecuteRequest,
	profile policy.Profile,
) (domain.ExecuteResult, error) {
	e.executeCalls++
	e.request = request
	e.profile = profile
	return domain.ExecuteResult{
		RunID:     request.RunID,
		Status:    domain.RunStatusAccepted,
		CreatedAt: time.Now().UTC(),
	}, nil
}

func (e *recordingExecutor) Cancel(_ context.Context, runID string) error {
	e.cancelledRunID = runID
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

func TestRoutesSetRequestIDAndLogResponseStatus(t *testing.T) {
	var logs bytes.Buffer
	handler := NewHandler(Dependencies{
		Logger:   slog.New(slog.NewJSONHandler(&logs, nil)),
		Policies: policy.NewRegistry(),
		Executor: executor.DisabledExecutor{},
	})
	request := httptest.NewRequest(http.MethodGet, "/missing", nil)
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	requestID := response.Header().Get(requestIDHeader)
	if len(requestID) != 32 {
		t.Fatalf("expected 32-character request id, got %q", requestID)
	}
	if !strings.Contains(logs.String(), `"status":404`) {
		t.Fatalf("log does not contain response status: %s", logs.String())
	}
	if !strings.Contains(logs.String(), `"requestId":"`+requestID+`"`) {
		t.Fatalf("log does not contain request id: %s", logs.String())
	}
}

func TestRoutesRequireAuthenticationWhenConfigured(t *testing.T) {
	verifier, err := auth.NewVerifier("test-secret", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	handler := newAuthenticatedTestHandler(verifier)
	request := httptest.NewRequest(http.MethodGet, "/v1/profiles", nil)
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", response.Code, response.Body.String())
	}
}

func TestRoutesAcceptValidAuthentication(t *testing.T) {
	const secret = "test-secret"
	verifier, err := auth.NewVerifier(secret, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	handler := newAuthenticatedTestHandler(verifier)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	request := httptest.NewRequest(http.MethodGet, "/v1/profiles", nil)
	request.Header.Set(auth.TimestampHeader, timestamp)
	request.Header.Set(auth.SignatureHeader, auth.SignatureHex(
		[]byte(secret), timestamp, request.Method, request.URL.RequestURI(), "", nil,
	))
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
}

func TestCreateRunRejectsWrongContentType(t *testing.T) {
	handler := newTestHandler(&recordingExecutor{})
	request := httptest.NewRequest(http.MethodPost, "/v1/runs", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d: %s", response.Code, response.Body.String())
	}
}

func TestCreateRunRejectsMultipleJSONValues(t *testing.T) {
	handler := newTestHandler(&recordingExecutor{})
	request := httptest.NewRequest(http.MethodPost, "/v1/runs", strings.NewReader(
		`{"runId":"run-1","idempotencyKey":"idem-1","profileId":"skill-trusted","command":["node"]} {}`,
	))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", response.Code, response.Body.String())
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

func TestCreateRunRejectsNegativeTimeout(t *testing.T) {
	handler := newTestHandler(&recordingExecutor{})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId":          "run-1",
		"idempotencyKey": "idem-1",
		"profileId":      "skill-trusted",
		"command":        []string{"node", "script.mjs"},
		"timeoutSeconds": -1,
	})

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestCreateRunIsIdempotentAndCanBeQueried(t *testing.T) {
	exec := &recordingExecutor{}
	handler := newTestHandler(exec)
	payload := map[string]any{
		"runId":          "run-1",
		"idempotencyKey": "idem-1",
		"profileId":      "skill-trusted",
		"command":        []string{"node", "script.mjs"},
	}

	first := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", payload)
	second := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId":          "run-2",
		"idempotencyKey": "idem-1",
		"profileId":      "skill-trusted",
		"command":        []string{"node", "script.mjs"},
	})

	if first.Code != http.StatusAccepted || second.Code != http.StatusAccepted {
		t.Fatalf("expected 202 responses, got first=%d second=%d", first.Code, second.Code)
	}
	if exec.executeCalls != 1 {
		t.Fatalf("idempotent requests executed %d times", exec.executeCalls)
	}
	if !strings.Contains(second.Body.String(), `"runId":"run-1"`) {
		t.Fatalf("duplicate request did not return original run: %s", second.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/runs/run-1", nil)
	request.Header.Set(sandboxUserIDHeader, "user-1")
	response := httptest.NewRecorder()
	handler.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"runId":"run-1"`) {
		t.Fatalf("unexpected run response: %s", response.Body.String())
	}
}

func TestCreateRunRejectsIdempotencyKeyReuseWithDifferentInput(t *testing.T) {
	exec := &recordingExecutor{}
	handler := newTestHandler(exec)
	first := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId": "run-1", "idempotencyKey": "idem-1", "profileId": "skill-trusted",
		"command": []string{"node", "first.mjs"},
	})
	second := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId": "run-2", "idempotencyKey": "idem-1", "profileId": "skill-trusted",
		"command": []string{"node", "second.mjs"},
	})

	if first.Code != http.StatusAccepted || second.Code != http.StatusConflict {
		t.Fatalf("expected 202 then 409, got first=%d second=%d", first.Code, second.Code)
	}
	if exec.executeCalls != 1 {
		t.Fatalf("conflicting idempotent request executed %d times", exec.executeCalls)
	}
}

func TestCreateRunEnqueuesWithoutCallingExecutor(t *testing.T) {
	exec := &recordingExecutor{}
	handler := NewHandler(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Policies: policy.NewRegistry(),
		Executor: exec, Runs: storememory.NewRunStore(), EnqueueOnly: true,
	})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId": "run-1", "idempotencyKey": "idem-1", "profileId": "skill-trusted",
		"command": []string{"node"},
	})

	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	if exec.executeCalls != 0 {
		t.Fatalf("enqueue-only handler called executor %d times", exec.executeCalls)
	}
	if !strings.Contains(response.Body.String(), `"status":"queued"`) {
		t.Fatalf("unexpected queued response: %s", response.Body.String())
	}
}

func TestCancelQueuedRunDoesNotCallExecutor(t *testing.T) {
	exec := &recordingExecutor{}
	runs := storememory.NewRunStore()
	handler := NewHandler(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Policies: policy.NewRegistry(),
		Executor: exec, Runs: runs, Events: eventmemory.New(), EnqueueOnly: true,
	})
	created := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId": "run-1", "idempotencyKey": "idem-1", "profileId": "skill-trusted", "command": []string{"node"},
	})
	if created.Code != http.StatusAccepted {
		t.Fatalf("create run: %d %s", created.Code, created.Body.String())
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/runs/run-1/cancel", nil)
	request.Header.Set(sandboxUserIDHeader, "user-1")
	response := httptest.NewRecorder()
	handler.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || exec.cancelledRunID != "" {
		t.Fatalf("unexpected cancel response=%d executorRun=%q", response.Code, exec.cancelledRunID)
	}
	run, err := runs.Get(context.Background(), "run-1")
	if err != nil || run.Status != domain.RunStatusCancelled {
		t.Fatalf("queued run was not cancelled: %+v %v", run, err)
	}
}

func TestGetRunReturnsNotFound(t *testing.T) {
	handler := newTestHandler(&recordingExecutor{})
	request := httptest.NewRequest(http.MethodGet, "/v1/runs/missing", nil)
	request.Header.Set(sandboxUserIDHeader, "user-1")
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", response.Code, response.Body.String())
	}
}

func TestGetRunHidesOtherUsersRun(t *testing.T) {
	handler := newTestHandler(&recordingExecutor{})
	created := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"userId": "user-1", "runId": "run-1", "idempotencyKey": "idem-1",
		"profileId": "skill-trusted", "command": []string{"node"},
	})
	if created.Code != http.StatusAccepted {
		t.Fatalf("create run: %d %s", created.Code, created.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/runs/run-1", nil)
	request.Header.Set(sandboxUserIDHeader, "user-2")
	response := httptest.NewRecorder()
	handler.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", response.Code, response.Body.String())
	}
}

func TestListEventsResumesAfterSequence(t *testing.T) {
	runs := storememory.NewRunStore()
	events := eventmemory.New()
	handler := NewHandler(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Policies: policy.NewRegistry(),
		Executor: &recordingExecutor{}, Runs: runs, Events: events,
	})
	created := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId": "run-1", "idempotencyKey": "idem-1", "profileId": "skill-trusted", "command": []string{"node"},
	})
	if created.Code != http.StatusAccepted {
		t.Fatalf("create run: %d %s", created.Code, created.Body.String())
	}
	_, _ = events.Append(context.Background(), "run-1", "running", map[string]string{"status": "running"})
	_, _ = events.Append(context.Background(), "run-1", "completed", map[string]string{"status": "completed"})
	request := httptest.NewRequest(http.MethodGet, "/v1/runs/run-1/events?after=1", nil)
	request.Header.Set(sandboxUserIDHeader, "user-1")
	response := httptest.NewRecorder()

	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"sequence":1`) || !strings.Contains(response.Body.String(), `"sequence":2`) {
		t.Fatalf("unexpected event response: %d %s", response.Code, response.Body.String())
	}
}

func TestCancelRunRecordsRequestAndCallsExecutor(t *testing.T) {
	exec := &recordingExecutor{}
	handler := newTestHandler(exec)
	created := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/runs", map[string]any{
		"runId":          "run-1",
		"idempotencyKey": "idem-1",
		"profileId":      "skill-trusted",
		"command":        []string{"node"},
	})
	if created.Code != http.StatusAccepted {
		t.Fatalf("create run: %d %s", created.Code, created.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/runs/run-1/cancel", nil)
	request.Header.Set(sandboxUserIDHeader, "user-1")
	response := httptest.NewRecorder()
	handler.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", response.Code, response.Body.String())
	}
	if exec.cancelledRunID != "run-1" {
		t.Fatalf("executor cancelled %q", exec.cancelledRunID)
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

func TestCreateSkillRunUsesPublishedSandboxBinding(t *testing.T) {
	exec := &recordingExecutor{}
	policies := policy.NewRegistry()
	handler := NewHandler(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Policies: policies,
		Executor: exec, Runs: storememory.NewRunStore(), Events: eventmemory.New(),
		Skills: newTestSkillStore(t, policies, true),
	})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/skill-runs", map[string]any{
		"runId": "skill-run-1", "idempotencyKey": "skill-idem-1",
		"skillId": "markdown-check", "skillVersion": "1.0.0",
		"input": map[string]any{"markdown": "# Title"},
	})

	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	if exec.executeCalls != 1 || exec.profile.ID != "skill-trusted" {
		t.Fatalf("unexpected executor binding: calls=%d profile=%+v", exec.executeCalls, exec.profile)
	}
	if strings.Join(exec.request.Command, " ") != "node scripts/run.mjs" || string(exec.request.Bundle) != "bundle" {
		t.Fatalf("executor did not receive published skill configuration: %+v", exec.request)
	}
}

func TestCreateSkillRunRejectsCallerCommand(t *testing.T) {
	policies := policy.NewRegistry()
	handler := NewHandler(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Policies: policies,
		Executor: &recordingExecutor{}, Runs: storememory.NewRunStore(), Events: eventmemory.New(),
		Skills: newTestSkillStore(t, policies, true),
	})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/skill-runs", map[string]any{
		"runId": "skill-run-1", "idempotencyKey": "skill-idem-1",
		"skillId": "markdown-check", "skillVersion": "1.0.0", "input": map[string]any{},
		"command": []string{"sh", "-c", "id"},
	})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", response.Code, response.Body.String())
	}
}

func TestCreateSkillRunRejectsDisabledSkill(t *testing.T) {
	policies := policy.NewRegistry()
	handler := NewHandler(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Policies: policies,
		Executor: &recordingExecutor{}, Runs: storememory.NewRunStore(), Events: eventmemory.New(),
		Skills: newTestSkillStore(t, policies, false),
	})
	response := performJSONRequest(t, handler.Routes(), http.MethodPost, "/v1/skill-runs", map[string]any{
		"runId": "skill-run-1", "idempotencyKey": "skill-idem-1",
		"skillId": "markdown-check", "skillVersion": "1.0.0", "input": map[string]any{},
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", response.Code, response.Body.String())
	}
}

func newTestHandler(exec executor.Executor) *Handler {
	return NewHandler(Dependencies{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Policies: policy.NewRegistry(),
		Executor: exec,
		Runs:     storememory.NewRunStore(),
		Events:   eventmemory.New(),
	})
}

func newAuthenticatedTestHandler(verifier *auth.Verifier) *Handler {
	return NewHandler(Dependencies{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Policies: policy.NewRegistry(),
		Executor: executor.DisabledExecutor{},
		Auth:     verifier,
		Runs:     storememory.NewRunStore(),
		Events:   eventmemory.New(),
	})
}

func newTestSkillStore(t *testing.T, policies *policy.Registry, enabled bool) skill.Store {
	t.Helper()
	store, err := skill.NewMemoryStore(policies)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Upsert(context.Background(), skill.Definition{
		ID: "markdown-check", Name: "Markdown Check", Enabled: enabled,
	}); err != nil {
		t.Fatal(err)
	}
	bundle := []byte("bundle")
	sum := sha256.Sum256(bundle)
	if _, _, err := store.Publish(context.Background(), skill.Version{Manifest: skill.Manifest{
		ID: "markdown-check", Version: "1.0.0", Runtime: "node",
		Entrypoint: []string{"node", "scripts/run.mjs"}, ProfileID: "skill-trusted",
		ImageDigest:  "image@sha256:" + strings.Repeat("a", 64),
		BundleSHA256: hex.EncodeToString(sum[:]), Network: "disabled",
		InputSchema: "schemas/input.json", OutputSchema: "schemas/output.json",
	}, Bundle: bundle}); err != nil {
		t.Fatal(err)
	}
	return store
}

func performJSONRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	value any,
) *httptest.ResponseRecorder {
	t.Helper()
	if method == http.MethodPost && (path == "/v1/runs" || path == "/v1/skill-runs") {
		if object, ok := value.(map[string]any); ok {
			if _, exists := object["userId"]; !exists {
				copy := make(map[string]any, len(object)+1)
				for key, item := range object {
					copy[key] = item
				}
				copy["userId"] = "user-1"
				value = copy
			}
		}
	}
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	if method == http.MethodPost && (path == "/v1/runs" || path == "/v1/skill-runs") {
		request.Header.Set(sandboxUserIDHeader, "user-1")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
