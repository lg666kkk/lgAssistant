package auth

import (
	"errors"
	"strconv"
	"testing"
	"time"
)

func TestVerifier(t *testing.T) {
	secret := "test-secret"
	now := time.Date(2026, time.September, 4, 12, 0, 0, 0, time.UTC)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	expiredTimestamp := strconv.FormatInt(now.Add(-5*time.Minute-time.Second).Unix(), 10)
	futureTimestamp := strconv.FormatInt(now.Add(5*time.Minute+time.Second).Unix(), 10)
	method := "POST"
	requestTarget := "/v1/runs"
	userID := "user-1"
	body := []byte(`{"runId":"run-1"}`)

	verifier, err := NewVerifier(secret, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	verifier.now = func() time.Time { return now }

	tests := []struct {
		name      string
		timestamp string
		signature string
		method    string
		target    string
		userID    string
		body      []byte
		wantErr   error
	}{
		{
			name:      "valid signature",
			timestamp: timestamp,
			signature: SignatureHex([]byte(secret), timestamp, method, requestTarget, userID, body),
			method:    method,
			target:    requestTarget,
			userID:    userID,
			body:      body,
		},
		{
			name:    "missing credentials",
			body:    body,
			wantErr: ErrMissingCredentials,
		},
		{
			name:      "invalid timestamp",
			timestamp: "not-a-timestamp",
			signature: "00",
			body:      body,
			wantErr:   ErrInvalidTimestamp,
		},
		{
			name:      "expired signature",
			timestamp: expiredTimestamp,
			signature: "00",
			body:      body,
			wantErr:   ErrExpiredSignature,
		},
		{
			name:      "future signature",
			timestamp: futureTimestamp,
			signature: "00",
			body:      body,
			wantErr:   ErrExpiredSignature,
		},
		{
			name:      "body was changed",
			timestamp: timestamp,
			signature: SignatureHex([]byte(secret), timestamp, method, requestTarget, userID, body),
			method:    method,
			target:    requestTarget,
			userID:    userID,
			body:      []byte(`{"runId":"run-2"}`),
			wantErr:   ErrInvalidSignature,
		},
		{
			name:      "request target was changed",
			timestamp: timestamp,
			signature: SignatureHex([]byte(secret), timestamp, method, requestTarget, userID, body),
			method:    method,
			target:    "/v1/profiles",
			userID:    userID,
			body:      body,
			wantErr:   ErrInvalidSignature,
		},
		{
			name:      "user context was changed",
			timestamp: timestamp,
			signature: SignatureHex([]byte(secret), timestamp, method, requestTarget, userID, body),
			method:    method,
			target:    requestTarget,
			userID:    "user-2",
			body:      body,
			wantErr:   ErrInvalidSignature,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := verifier.Verify(test.timestamp, test.signature, test.method, test.target, test.userID, test.body)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("expected %v, got %v", test.wantErr, err)
			}
		})
	}
}

func TestNewVerifierRejectsInvalidConfiguration(t *testing.T) {
	if _, err := NewVerifier("", time.Minute); err == nil {
		t.Fatal("expected empty secret to fail")
	}
	if _, err := NewVerifier("secret", 0); err == nil {
		t.Fatal("expected zero max age to fail")
	}
}
