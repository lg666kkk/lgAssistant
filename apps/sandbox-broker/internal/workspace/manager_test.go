package workspace

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

type tarEntry struct {
	name     string
	body     string
	typeflag byte
}

func TestPrepareTarExtractsVerifiedArchive(t *testing.T) {
	manager := newTestManager(t)
	archive := makeTar(t, []tarEntry{
		{name: "src/", typeflag: tar.TypeDir},
		{name: "src/index.js", body: "console.log('ok')", typeflag: tar.TypeReg},
		{name: ".env.example", body: "KEY=", typeflag: tar.TypeReg},
	})

	workspace, err := manager.PrepareTar(context.Background(), bytes.NewReader(archive), digest(archive))
	if err != nil {
		t.Fatalf("prepare tar: %v", err)
	}
	defer workspace.Cleanup()
	content, err := os.ReadFile(filepath.Join(workspace.Path, "src", "index.js"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "console.log('ok')" {
		t.Fatalf("unexpected content: %q", content)
	}
}

func TestPrepareTarRejectsUnsafeEntriesAndCleansUp(t *testing.T) {
	tests := []struct {
		name  string
		entry tarEntry
	}{
		{name: "path traversal", entry: tarEntry{name: "../escape", body: "x", typeflag: tar.TypeReg}},
		{name: "absolute path", entry: tarEntry{name: "/escape", body: "x", typeflag: tar.TypeReg}},
		{name: "symlink", entry: tarEntry{name: "link", typeflag: tar.TypeSymlink}},
		{name: "git metadata", entry: tarEntry{name: ".git/config", body: "x", typeflag: tar.TypeReg}},
		{name: "environment file", entry: tarEntry{name: ".env.production", body: "SECRET=x", typeflag: tar.TypeReg}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			manager, err := NewManager(Config{Root: root})
			if err != nil {
				t.Fatal(err)
			}
			archive := makeTar(t, []tarEntry{test.entry})
			if _, err := manager.PrepareTar(context.Background(), bytes.NewReader(archive), digest(archive)); err == nil {
				t.Fatal("expected unsafe archive to fail")
			}
			entries, err := os.ReadDir(root)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("temporary files were not cleaned up: %v", entries)
			}
		})
	}
}

func TestPrepareTarRejectsDigestMismatch(t *testing.T) {
	manager := newTestManager(t)
	archive := makeTar(t, []tarEntry{{name: "file.txt", body: "x", typeflag: tar.TypeReg}})
	if _, err := manager.PrepareTar(context.Background(), bytes.NewReader(archive), string(make([]byte, 64))); err == nil {
		t.Fatal("expected digest mismatch")
	}
}

func TestPrepareTarHonorsContextCancellation(t *testing.T) {
	manager := newTestManager(t)
	archive := makeTar(t, []tarEntry{{name: "file.txt", body: "x", typeflag: tar.TypeReg}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.PrepareTar(ctx, bytes.NewReader(archive), digest(archive)); err == nil {
		t.Fatal("expected context cancellation")
	}
}

func TestWorkspaceWriteFileRejectsEscape(t *testing.T) {
	manager := newTestManager(t)
	workspace, err := manager.PrepareEmpty()
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Cleanup()
	if err := workspace.WriteFile("input.json", []byte(`{"ok":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := workspace.WriteFile("../escape", []byte("x"), 0o600); err == nil {
		t.Fatal("expected workspace escape to fail")
	}
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	manager, err := NewManager(Config{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func makeTar(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o644, Size: int64(len(entry.body)), Typeflag: entry.typeflag}
		if entry.typeflag == tar.TypeDir {
			header.Mode = 0o755
			header.Size = 0
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.body != "" {
			if _, err := writer.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
