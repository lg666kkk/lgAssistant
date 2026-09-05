package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	TimestampHeader = "X-Sandbox-Timestamp"
	SignatureHeader = "X-Sandbox-Signature"
)

var (
	ErrMissingCredentials = errors.New("sandbox authentication credentials are required")
	ErrInvalidTimestamp   = errors.New("sandbox authentication timestamp is invalid")
	ErrExpiredSignature   = errors.New("sandbox authentication signature is outside the allowed time window")
	ErrInvalidSignature   = errors.New("sandbox authentication signature is invalid")
)

type Verifier struct {
	secret []byte
	maxAge time.Duration
	now    func() time.Time
}

func NewVerifier(secret string, maxAge time.Duration) (*Verifier, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, errors.New("sandbox authentication secret is required")
	}
	if maxAge <= 0 {
		return nil, errors.New("sandbox authentication max age must be positive")
	}
	return &Verifier{
		secret: []byte(secret),
		maxAge: maxAge,
		now:    time.Now,
	}, nil
}

func (v *Verifier) Verify(
	timestampValue string,
	signatureValue string,
	method string,
	requestTarget string,
	userID string,
	body []byte,
) error {
	if timestampValue == "" || signatureValue == "" {
		return ErrMissingCredentials
	}
	timestampSeconds, err := strconv.ParseInt(timestampValue, 10, 64)
	if err != nil {
		return ErrInvalidTimestamp
	}
	timestamp := time.Unix(timestampSeconds, 0)
	age := v.now().Sub(timestamp)
	if age < -v.maxAge || age > v.maxAge {
		return ErrExpiredSignature
	}

	want := Sign(v.secret, timestampValue, method, requestTarget, userID, body)
	got, err := hex.DecodeString(signatureValue)
	if err != nil || !hmac.Equal(got, want) {
		return ErrInvalidSignature
	}
	return nil
}

func Sign(secret []byte, timestampValue string, method string, requestTarget string, userID string, body []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = fmt.Fprintf(mac, "%s\n%s\n%s\n%s\n", timestampValue, method, requestTarget, userID)
	_, _ = mac.Write(body)
	return mac.Sum(nil)
}

func SignatureHex(
	secret []byte,
	timestampValue string,
	method string,
	requestTarget string,
	userID string,
	body []byte,
) string {
	return hex.EncodeToString(Sign(secret, timestampValue, method, requestTarget, userID, body))
}
