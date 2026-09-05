package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/auth"
)

const requestIDHeader = "X-Request-ID"

type requestIDContextKey struct{}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(body)
}

func (writer *statusWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (h *Handler) requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestID, err := newRequestID()
		if err != nil {
			h.logger.Error("request id generation failed", "error", err)
			writeError(writer, http.StatusInternalServerError, "internal_error", "request could not be initialized")
			return
		}
		writer.Header().Set(requestIDHeader, requestID)
		ctx := context.WithValue(request.Context(), requestIDContextKey{}, requestID)
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func (h *Handler) authenticationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/healthz" || h.auth == nil {
			next.ServeHTTP(writer, request)
			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxRequestBytes))
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				writeError(writer, http.StatusRequestEntityTooLarge, "request_too_large", "request body exceeds limit")
				return
			}
			writeError(writer, http.StatusBadRequest, "invalid_request", "request body could not be read")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		if err := h.auth.Verify(
			request.Header.Get(auth.TimestampHeader),
			request.Header.Get(auth.SignatureHeader),
			request.Method,
			request.URL.RequestURI(),
			request.Header.Get(sandboxUserIDHeader),
			body,
		); err != nil {
			writeError(writer, http.StatusUnauthorized, "authentication_failed", "request authentication failed")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (h *Handler) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		startedAt := time.Now()
		wrapped := &statusWriter{ResponseWriter: writer}
		next.ServeHTTP(wrapped, request)
		status := wrapped.status
		if status == 0 {
			status = http.StatusOK
		}
		h.logger.Info("http request",
			"requestId", RequestIDFromContext(request.Context()),
			"method", request.Method,
			"path", request.URL.Path,
			"status", status,
			"durationMs", time.Since(startedAt).Milliseconds(),
		)
	})
}

func RequestIDFromContext(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDContextKey{}).(string)
	return requestID
}

func newRequestID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func isJSONContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
}
