package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/auth"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/domain"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/event"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/store"
)

const maxRequestBytes = 64 * 1024

const sandboxUserIDHeader = "X-Sandbox-User-ID"

type Dependencies struct {
	Logger       *slog.Logger
	Policies     *policy.Registry
	Executor     executor.Executor
	ExecutorName string
	Auth         *auth.Verifier
	Runs         store.RunStore
	Events       event.Store
	Skills       skill.Store
	EnqueueOnly  bool
}

type Handler struct {
	logger       *slog.Logger
	policies     *policy.Registry
	executor     executor.Executor
	executorName string
	auth         *auth.Verifier
	runs         store.RunStore
	events       event.Store
	skills       skill.Store
	enqueueOnly  bool
}

func NewHandler(dependencies Dependencies) *Handler {
	return &Handler{
		logger:       dependencies.Logger,
		policies:     dependencies.Policies,
		executor:     dependencies.Executor,
		executorName: dependencies.ExecutorName,
		auth:         dependencies.Auth,
		runs:         dependencies.Runs,
		events:       dependencies.Events,
		skills:       dependencies.Skills,
		enqueueOnly:  dependencies.EnqueueOnly,
	}
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /v1/profiles", h.listProfiles)
	mux.HandleFunc("GET /v1/skills", h.listSkills)
	mux.HandleFunc("POST /v1/runs", h.createRun)
	mux.HandleFunc("POST /v1/skill-runs", h.createSkillRun)
	mux.HandleFunc("GET /v1/runs/{runID}", h.getRun)
	mux.HandleFunc("GET /v1/runs/{runID}/events", h.listEvents)
	mux.HandleFunc("POST /v1/runs/{runID}/cancel", h.cancelRun)
	return h.requestIDMiddleware(h.loggingMiddleware(h.authenticationMiddleware(mux)))
}

func (h *Handler) health(writer http.ResponseWriter, _ *http.Request) {
	executorName := h.executorName
	if executorName == "" {
		executorName = "disabled"
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":    "ok",
		"service":   "sandbox-broker",
		"executor":  executorName,
		"timestamp": time.Now().UTC(),
	})
}

func (h *Handler) listProfiles(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{
		"profiles": h.policies.List(),
	})
}

func (h *Handler) listSkills(writer http.ResponseWriter, request *http.Request) {
	if h.skills == nil {
		writeError(writer, http.StatusNotImplemented, "skill_store_unavailable", "skill configuration is not configured")
		return
	}
	items, err := h.skills.List(request.Context())
	if err != nil {
		h.logger.Error("sandbox skill list failed", "error", err)
		writeError(writer, http.StatusInternalServerError, "skill_store_failed", "sandbox skills could not be listed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"skills": items})
}

func (h *Handler) createSkillRun(writer http.ResponseWriter, request *http.Request) {
	if h.skills == nil || h.runs == nil {
		writeError(writer, http.StatusNotImplemented, "skill_store_unavailable", "skill execution is not configured")
		return
	}
	if !isJSONContentType(request.Header.Get("Content-Type")) {
		writeError(writer, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input domain.SkillRunRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		writeError(writer, http.StatusBadRequest, "invalid_request", "request body must contain a single JSON object")
		return
	}
	if err := input.Validate(); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !authorizeRequestUser(writer, request, input.UserID) {
		return
	}
	_, published, err := h.skills.GetVersion(request.Context(), input.SkillID, input.SkillVersion)
	if errors.Is(err, skill.ErrSkillNotFound) || errors.Is(err, skill.ErrSkillVersionNotFound) {
		writeError(writer, http.StatusNotFound, "skill_version_not_found", "published skill version not found")
		return
	}
	if errors.Is(err, skill.ErrSkillDisabled) {
		writeError(writer, http.StatusConflict, "skill_disabled", err.Error())
		return
	}
	if err != nil {
		h.logger.Error("sandbox skill resolve failed", "skillId", input.SkillID, "version", input.SkillVersion, "error", err)
		writeError(writer, http.StatusInternalServerError, "skill_store_failed", "sandbox skill could not be resolved")
		return
	}
	profile, err := h.policies.Get(published.Manifest.ProfileID)
	if err != nil {
		writeError(writer, http.StatusConflict, "skill_profile_invalid", err.Error())
		return
	}
	now := time.Now().UTC()
	initialStatus := domain.RunStatusAccepted
	if h.enqueueOnly {
		initialStatus = domain.RunStatusQueued
	}
	run := domain.Run{
		UserID: input.UserID, SessionID: input.SessionID,
		RequestID: RequestIDFromContext(request.Context()), ToolCallID: input.ToolCallID,
		Kind: domain.RunKindSkill, RunID: input.RunID, IdempotencyKey: input.IdempotencyKey,
		InputHash: domain.SkillInputHash(input), ProfileID: published.Manifest.ProfileID,
		ProfileVersion: "v1", SkillID: input.SkillID, SkillVersion: input.SkillVersion,
		SkillBundleSHA256: published.Manifest.BundleSHA256,
		Command:           append([]string(nil), published.Manifest.Entrypoint...), Input: append([]byte(nil), input.Input...),
		TimeoutSeconds: profile.TimeoutSeconds, Status: initialStatus, MaxAttempts: 3,
		ImageDigest: published.Manifest.ImageDigest, NextAttemptAt: now, CreatedAt: now, UpdatedAt: now,
	}
	stored, created, err := h.runs.Create(request.Context(), run)
	if errors.Is(err, store.ErrDuplicateRun) {
		writeError(writer, http.StatusConflict, "duplicate_run", err.Error())
		return
	}
	if errors.Is(err, store.ErrIdempotencyConflict) {
		writeError(writer, http.StatusConflict, "idempotency_conflict", err.Error())
		return
	}
	if err != nil {
		h.logger.Error("sandbox skill run reservation failed", "runId", input.RunID, "error", err)
		writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox skill run could not be reserved")
		return
	}
	if !created {
		writeJSON(writer, statusForStoredRun(stored), stored)
		return
	}
	if h.events != nil {
		_, _ = h.events.Append(request.Context(), stored.RunID, "queued", map[string]any{
			"status": stored.Status, "skillId": stored.SkillID, "skillVersion": stored.SkillVersion,
		})
	}
	if h.enqueueOnly {
		writeJSON(writer, http.StatusAccepted, stored)
		return
	}
	executeRequest := domain.ExecuteRequest{
		UserID: input.UserID, SessionID: input.SessionID, ToolCallID: input.ToolCallID,
		RunID: input.RunID, IdempotencyKey: input.IdempotencyKey,
		ProfileID: published.Manifest.ProfileID, Command: append([]string(nil), published.Manifest.Entrypoint...),
		Input: append([]byte(nil), input.Input...), TimeoutSeconds: profile.TimeoutSeconds,
		Bundle: append([]byte(nil), published.Bundle...), BundleSHA256: published.Manifest.BundleSHA256,
		ResolvedImageDigest: published.Manifest.ImageDigest,
		InputSchemaPath:     published.Manifest.InputSchema, OutputSchemaPath: published.Manifest.OutputSchema,
	}
	result, executeErr := h.executor.Execute(request.Context(), executeRequest, profile)
	stored.Status = result.Status
	stored.ExitCode = result.ExitCode
	stored.TimedOut = result.TimedOut
	stored.OOMKilled = result.OOMKilled
	stored.Message = result.Message
	stored.StdoutRef = result.StdoutRef
	stored.StderrRef = result.StderrRef
	stored.PatchRef = result.PatchRef
	stored.ResultRef = result.ResultRef
	stored.Result = append([]byte(nil), result.Result...)
	stored.UpdatedAt = time.Now().UTC()
	if _, updateErr := h.runs.Update(request.Context(), stored); updateErr != nil {
		writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox skill result could not be persisted")
		return
	}
	if errors.Is(executeErr, executor.ErrExecutorUnavailable) {
		writeJSON(writer, http.StatusNotImplemented, result)
		return
	}
	if executeErr != nil {
		writeError(writer, http.StatusInternalServerError, "execution_failed", "sandbox skill execution failed")
		return
	}
	writeJSON(writer, http.StatusAccepted, result)
}

func (h *Handler) createRun(writer http.ResponseWriter, request *http.Request) {
	if !isJSONContentType(request.Header.Get("Content-Type")) {
		writeError(writer, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()

	var input domain.ExecuteRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		writeError(writer, http.StatusBadRequest, "invalid_request", "request body must contain a single JSON object")
		return
	}
	if err := input.Validate(); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !authorizeRequestUser(writer, request, input.UserID) {
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

	var run domain.Run
	if h.runs != nil {
		now := time.Now().UTC()
		initialStatus := domain.RunStatusAccepted
		if h.enqueueOnly {
			initialStatus = domain.RunStatusQueued
		}
		run = domain.Run{
			UserID:         input.UserID,
			SessionID:      input.SessionID,
			RequestID:      RequestIDFromContext(request.Context()),
			ToolCallID:     input.ToolCallID,
			Kind:           domain.RunKindCommand,
			RunID:          input.RunID,
			IdempotencyKey: input.IdempotencyKey,
			InputHash:      domain.ExecuteInputHash(input),
			ProfileID:      input.ProfileID,
			ProfileVersion: "v1",
			Command:        append([]string(nil), input.Command...),
			Input:          append([]byte(nil), input.Input...),
			TimeoutSeconds: input.TimeoutSeconds,
			Status:         initialStatus,
			MaxAttempts:    3,
			NextAttemptAt:  now,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		stored, created, err := h.runs.Create(request.Context(), run)
		if errors.Is(err, store.ErrDuplicateRun) {
			writeError(writer, http.StatusConflict, "duplicate_run", err.Error())
			return
		}
		if errors.Is(err, store.ErrIdempotencyConflict) {
			writeError(writer, http.StatusConflict, "idempotency_conflict", err.Error())
			return
		}
		if err != nil {
			h.logger.Error("sandbox run reservation failed", "runId", input.RunID, "error", err)
			writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox run could not be reserved")
			return
		}
		if !created {
			writeJSON(writer, statusForStoredRun(stored), stored)
			return
		}
		run = stored
		if h.enqueueOnly {
			if h.events != nil {
				if _, err := h.events.Append(request.Context(), stored.RunID, "queued", map[string]string{"status": string(stored.Status)}); err != nil {
					h.logger.Error("sandbox queued event failed", "runId", stored.RunID, "error", err)
				}
			}
			writeJSON(writer, http.StatusAccepted, stored)
			return
		}
	}

	result, err := h.executor.Execute(request.Context(), input, profile)
	if h.runs != nil {
		run.Status = result.Status
		run.ExitCode = result.ExitCode
		run.TimedOut = result.TimedOut
		run.OOMKilled = result.OOMKilled
		run.Message = result.Message
		run.StdoutRef = result.StdoutRef
		run.StderrRef = result.StderrRef
		run.PatchRef = result.PatchRef
		run.ResultRef = result.ResultRef
		run.Result = append([]byte(nil), result.Result...)
		run.UpdatedAt = time.Now().UTC()
		if _, updateErr := h.runs.Update(request.Context(), run); updateErr != nil {
			h.logger.Error("sandbox run result persistence failed", "runId", input.RunID, "error", updateErr)
			writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox run result could not be persisted")
			return
		}
	}
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

func (h *Handler) getRun(writer http.ResponseWriter, request *http.Request) {
	if h.runs == nil {
		writeError(writer, http.StatusNotImplemented, "run_store_unavailable", "run query is not configured")
		return
	}
	runID := strings.TrimSpace(request.PathValue("runID"))
	run, err := h.runs.Get(request.Context(), runID)
	if errors.Is(err, store.ErrRunNotFound) {
		writeError(writer, http.StatusNotFound, "run_not_found", err.Error())
		return
	}
	if err != nil {
		h.logger.Error("sandbox run query failed", "runId", runID, "error", err)
		writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox run could not be queried")
		return
	}
	if !authorizeRunUser(writer, request, run) {
		return
	}
	writeJSON(writer, http.StatusOK, run)
}

func (h *Handler) listEvents(writer http.ResponseWriter, request *http.Request) {
	if h.runs == nil || h.events == nil {
		writeError(writer, http.StatusNotImplemented, "event_store_unavailable", "run events are not configured")
		return
	}
	runID := strings.TrimSpace(request.PathValue("runID"))
	run, err := h.runs.Get(request.Context(), runID)
	if errors.Is(err, store.ErrRunNotFound) {
		writeError(writer, http.StatusNotFound, "run_not_found", err.Error())
		return
	} else if err != nil {
		writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox run could not be queried")
		return
	}
	if !authorizeRunUser(writer, request, run) {
		return
	}
	after, err := parseNonNegativeInt64(request.URL.Query().Get("after"), 0)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", "after must be a non-negative integer")
		return
	}
	limit64, err := parseNonNegativeInt64(request.URL.Query().Get("limit"), 100)
	if err != nil || limit64 < 1 || limit64 > 500 {
		writeError(writer, http.StatusBadRequest, "invalid_request", "limit must be between 1 and 500")
		return
	}
	events, err := h.events.List(request.Context(), runID, after, int(limit64))
	if err != nil {
		h.logger.Error("sandbox event query failed", "runId", runID, "error", err)
		writeError(writer, http.StatusInternalServerError, "event_store_failed", "sandbox events could not be queried")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"events": events})
}

func (h *Handler) cancelRun(writer http.ResponseWriter, request *http.Request) {
	runID := strings.TrimSpace(request.PathValue("runID"))
	if runID == "" {
		writeError(writer, http.StatusBadRequest, "invalid_request", "runId is required")
		return
	}
	if h.runs != nil {
		run, err := h.runs.Get(request.Context(), runID)
		if errors.Is(err, store.ErrRunNotFound) {
			writeError(writer, http.StatusNotFound, "run_not_found", err.Error())
			return
		}
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox run could not be queried")
			return
		}
		if !authorizeRunUser(writer, request, run) {
			return
		}
		updated, err := h.runs.RequestCancel(request.Context(), runID, time.Now().UTC())
		if errors.Is(err, store.ErrRunNotFound) {
			writeError(writer, http.StatusNotFound, "run_not_found", err.Error())
			return
		}
		if errors.Is(err, store.ErrRunNotCancellable) {
			writeError(writer, http.StatusConflict, "run_not_cancellable", err.Error())
			return
		}
		if err != nil {
			h.logger.Error("sandbox cancellation request failed", "runId", runID, "error", err)
			writeError(writer, http.StatusInternalServerError, "run_store_failed", "sandbox cancellation could not be recorded")
			return
		}
		if h.events != nil {
			_, _ = h.events.Append(request.Context(), runID, "cancel_requested", map[string]string{"status": string(updated.Status)})
		}
		if h.enqueueOnly {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
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

func statusForStoredRun(run domain.Run) int {
	if run.Status == domain.RunStatusUnavailable {
		return http.StatusNotImplemented
	}
	if run.Status.IsTerminal() {
		return http.StatusOK
	}
	return http.StatusAccepted
}

func parseNonNegativeInt64(value string, fallback int64) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 0, errors.New("value must be a non-negative integer")
	}
	return parsed, nil
}

func authorizeRunUser(writer http.ResponseWriter, request *http.Request, run domain.Run) bool {
	return authorizeRequestUserWithNotFound(writer, request, run.UserID)
}

func authorizeRequestUser(writer http.ResponseWriter, request *http.Request, expectedUserID string) bool {
	userID := strings.TrimSpace(request.Header.Get(sandboxUserIDHeader))
	if userID == "" {
		writeError(writer, http.StatusBadRequest, "user_context_required", sandboxUserIDHeader+" is required")
		return false
	}
	if userID != expectedUserID {
		writeError(writer, http.StatusBadRequest, "user_context_mismatch", "signed user context does not match request userId")
		return false
	}
	return true
}

func authorizeRequestUserWithNotFound(writer http.ResponseWriter, request *http.Request, expectedUserID string) bool {
	userID := strings.TrimSpace(request.Header.Get(sandboxUserIDHeader))
	if userID == "" {
		writeError(writer, http.StatusBadRequest, "user_context_required", sandboxUserIDHeader+" is required")
		return false
	}
	if userID != expectedUserID {
		writeError(writer, http.StatusNotFound, "run_not_found", "sandbox run not found")
		return false
	}
	return true
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
