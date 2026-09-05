package filesystem

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/artifact"
)

func TestStorePutAndRead(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Put(context.Background(), artifact.PutRequest{
		RunID:       "run-1",
		Kind:        artifact.KindStdout,
		ContentType: "text/plain",
		Data:        []byte("hello"),
		Truncated:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Ref, "artifact://run-1/stdout-") || created.SizeBytes != 5 || !created.Truncated {
		t.Fatalf("unexpected artifact: %+v", created)
	}
	data, loaded, err := store.Read(context.Background(), created.Ref)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" || loaded.SHA256 != created.SHA256 {
		t.Fatalf("unexpected loaded artifact: %q %+v", data, loaded)
	}
}

func TestStoreRejectsUnsafeIdentifiersAndOversize(t *testing.T) {
	store, err := New(t.TempDir(), 4)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []artifact.PutRequest{
		{RunID: "../run", Kind: artifact.KindStdout, Data: []byte("x")},
		{RunID: "run-1", Kind: "../output", Data: []byte("x")},
		{RunID: "run-1", Kind: artifact.KindStdout, Data: []byte("12345")},
	} {
		if _, err := store.Put(context.Background(), request); err == nil {
			t.Fatalf("expected request to fail: %+v", request)
		}
	}
}

func TestStoreReadRejectsUnknownRef(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Read(context.Background(), "artifact://../secret"); !errors.Is(err, artifact.ErrArtifactNotFound) {
		t.Fatalf("expected ErrArtifactNotFound, got %v", err)
	}
}
