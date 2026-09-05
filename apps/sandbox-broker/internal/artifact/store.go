package artifact

import (
	"context"
	"errors"
	"time"
)

type Kind string

const (
	KindStdout Kind = "stdout"
	KindStderr Kind = "stderr"
	KindPatch  Kind = "patch"
	KindResult Kind = "result"
)

var ErrArtifactNotFound = errors.New("sandbox artifact not found")

type Artifact struct {
	Ref         string    `json:"ref"`
	RunID       string    `json:"runId"`
	Kind        Kind      `json:"kind"`
	SHA256      string    `json:"sha256"`
	SizeBytes   int64     `json:"sizeBytes"`
	ContentType string    `json:"contentType"`
	Truncated   bool      `json:"truncated"`
	CreatedAt   time.Time `json:"createdAt"`
}

type PutRequest struct {
	RunID       string
	Kind        Kind
	ContentType string
	Data        []byte
	Truncated   bool
}

type Store interface {
	Put(context.Context, PutRequest) (Artifact, error)
	Read(context.Context, string) ([]byte, Artifact, error)
}
