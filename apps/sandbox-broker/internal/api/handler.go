package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
)

const maxRequestBytes = 64 * 1024

type Dependencies struct {
	Logger   *slog.Logger
	Policies *policy.Registry
	Executor executor.Executor
}

type Handler struct {
	logger   *slog.Logger
	policies *policy.Registry
	executor executor.Executor
}

func NewHandler(dependencies Dependencies) *Handler {
	return &Handler{
		logger:   dependencies.Logger,
		policies: dependencies.Policies,
		executor: dependencies.Executor,
	}
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /v1/profiles", h.listProfiles)
	mux.HandleFunc("POST /v1/runs", h.createRun)
	mux.HandleFunc("POST /v1/runs/{runID}/cancel", h.cancelRun)
	return h.loggingMiddleware(mux)
}

func (h *Handler) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":    "ok",
		"service":   "sandbox-broker",
		"executor":  "disabled",
		"timestamp": time.Now().UTC(),
	})
}

func (h *Handler) listProfiles(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{
		"profiles": h.policies.List(),
	})
}

func (h *Handler) createRun(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()

	var input domain.ExecuteRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := input.Validate(); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	profile, err := h.policies.Get(input.ProfileID)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "unknown_profile", err.Error())
		return
	}
	if input.TimeoutSeconds <= 0 || input.TimeoutSeconds > profile.TimeoutSeconds {
		input.TimeoutSeconds = profile.TimeoutSeconds
	}

	result, err := h.executor.Execute(request.Context(), input, profile)
	if errors.Is(err, executor.ErrExecutorUnavailable) {
		writeJSON(writer, http.StatusNotImplemented, result)
		return
	}
	if err != nil {
		h.logger.Error("sandbox run failed", "runId", input.RunID, "error", err)
		writeError(writer, http.StatusInternalServerError, "execution_failed", "sandbox execution failed")
		return
	}
	writeJSON(writer, http.StatusAccepted, result)
}

func (h *Handler) cancelRun(writer http.ResponseWriter, request *http.Request) {
	runID := strings.TrimSpace(request.PathValue("runID"))
	if runID == "" {
		writeError(writer, http.StatusBadRequest, "invalid_request", "runId is required")
		return
	}
	if err := h.executor.Cancel(request.Context(), runID); errors.Is(err, executor.ErrExecutorUnavailable) {
		writeError(writer, http.StatusNotImplemented, "executor_unavailable", err.Error())
		return
	} else if err != nil {
		writeError(writer, http.StatusInternalServerError, "cancel_failed", "sandbox cancellation failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (h *Handler) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		startedAt := time.Now()
		next.ServeHTTP(writer, request)
		h.logger.Info("http request",
			"method", request.Method,
			"path", request.URL.Path,
			"durationMs", time.Since(startedAt).Milliseconds(),
		)
	})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code string, message string) {
	writeJSON(writer, status, map[string]string{
		"code":    code,
		"message": message,
	})
}
