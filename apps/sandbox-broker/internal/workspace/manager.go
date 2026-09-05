package workspace

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultMaxArchiveBytes = 50 << 20
	defaultMaxFiles        = 10_000
	defaultMaxTotalBytes   = 100 << 20
)

type Config struct {
	Root            string
	MaxArchiveBytes int64
	MaxFiles        int
	MaxTotalBytes   int64
}

type Manager struct {
	root            string
	maxArchiveBytes int64
	maxFiles        int
	maxTotalBytes   int64
}

type Workspace struct {
	Path    string
	cleanup func() error
}

func NewManager(config Config) (*Manager, error) {
	if !filepath.IsAbs(config.Root) || filepath.Clean(config.Root) == string(filepath.Separator) {
		return nil, errors.New("workspace root must be an absolute non-root path")
	}
	if config.MaxArchiveBytes <= 0 {
		config.MaxArchiveBytes = defaultMaxArchiveBytes
	}
	if config.MaxFiles <= 0 {
		config.MaxFiles = defaultMaxFiles
	}
	if config.MaxTotalBytes <= 0 {
		config.MaxTotalBytes = defaultMaxTotalBytes
	}
	if err := os.MkdirAll(config.Root, 0o700); err != nil {
		return nil, fmt.Errorf("create workspace root: %w", err)
	}
	root, err := filepath.EvalSymlinks(config.Root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	return &Manager{
		root:            root,
		maxArchiveBytes: config.MaxArchiveBytes,
		maxFiles:        config.MaxFiles,
		maxTotalBytes:   config.MaxTotalBytes,
	}, nil
}

func (manager *Manager) PrepareEmpty() (Workspace, error) {
	path, err := os.MkdirTemp(manager.root, "run-")
	if err != nil {
		return Workspace{}, fmt.Errorf("create workspace: %w", err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		_ = os.RemoveAll(path)
		return Workspace{}, fmt.Errorf("secure workspace: %w", err)
	}
	return Workspace{Path: path, cleanup: func() error { return os.RemoveAll(path) }}, nil
}

func (manager *Manager) PrepareTar(ctx context.Context, source io.Reader, expectedSHA256 string) (Workspace, error) {
	if len(expectedSHA256) != sha256.Size*2 {
		return Workspace{}, errors.New("workspace archive sha256 is required")
	}
	workspace, err := manager.PrepareEmpty()
	if err != nil {
		return Workspace{}, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = workspace.Cleanup()
		}
	}()

	archive, err := os.CreateTemp(manager.root, "archive-")
	if err != nil {
		return Workspace{}, fmt.Errorf("create workspace archive spool: %w", err)
	}
	archivePath := archive.Name()
	defer os.Remove(archivePath)
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(archive, hasher), io.LimitReader(source, manager.maxArchiveBytes+1))
	if closeErr := archive.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return Workspace{}, fmt.Errorf("read workspace archive: %w", copyErr)
	}
	if written > manager.maxArchiveBytes {
		return Workspace{}, errors.New("workspace archive exceeds size limit")
	}
	if !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), expectedSHA256) {
		return Workspace{}, errors.New("workspace archive sha256 mismatch")
	}

	archive, err = os.Open(archivePath)
	if err != nil {
		return Workspace{}, fmt.Errorf("open workspace archive: %w", err)
	}
	defer archive.Close()
	if err := manager.extractTar(ctx, workspace.Path, tar.NewReader(archive)); err != nil {
		return Workspace{}, err
	}
	ok = true
	return workspace, nil
}

func (manager *Manager) extractTar(ctx context.Context, root string, reader *tar.Reader) error {
	files := 0
	var totalBytes int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read workspace archive entry: %w", err)
		}
		files++
		if files > manager.maxFiles {
			return errors.New("workspace archive exceeds file count limit")
		}
		if header.Size < 0 || totalBytes+header.Size > manager.maxTotalBytes {
			return errors.New("workspace archive exceeds extracted size limit")
		}
		totalBytes += header.Size

		target, err := secureArchivePath(root, header.Name)
		if err != nil {
			return err
		}
		if protectedArchivePath(header.Name) {
			return fmt.Errorf("workspace archive contains protected path: %s", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return fmt.Errorf("create workspace directory: %w", err)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return fmt.Errorf("create workspace parent: %w", err)
			}
			mode := os.FileMode(header.Mode) & 0o755
			mode &^= 0o6000
			file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return fmt.Errorf("create workspace file: %w", err)
			}
			_, copyErr := io.CopyN(file, reader, header.Size)
			closeErr := file.Close()
			if copyErr != nil {
				return fmt.Errorf("write workspace file: %w", copyErr)
			}
			if closeErr != nil {
				return fmt.Errorf("close workspace file: %w", closeErr)
			}
		default:
			return fmt.Errorf("workspace archive entry type is not allowed: %s", header.Name)
		}
	}
}

func (workspace Workspace) Cleanup() error {
	if workspace.cleanup == nil {
		return nil
	}
	return workspace.cleanup()
}

func (workspace Workspace) WriteFile(relativePath string, data []byte, mode os.FileMode) error {
	target, err := secureArchivePath(workspace.Path, relativePath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create workspace file parent: %w", err)
	}
	if err := os.WriteFile(target, data, mode&0o700); err != nil {
		return fmt.Errorf("write workspace file: %w", err)
	}
	return nil
}

func (workspace Workspace) ReadFile(relativePath string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, errors.New("workspace read limit must be positive")
	}
	target, err := secureArchivePath(workspace.Path, relativePath)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace file: %w", err)
	}
	relative, err := filepath.Rel(workspace.Path, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, errors.New("workspace file escapes destination")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, fmt.Errorf("open workspace file: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("workspace path is not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read workspace file: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("workspace file exceeds size limit")
	}
	return data, nil
}

func secureArchivePath(root string, name string) (string, error) {
	if name == "" || filepath.IsAbs(name) {
		return "", errors.New("workspace archive path must be relative")
	}
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace archive path escapes destination")
	}
	target := filepath.Join(root, clean)
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace archive path escapes destination")
	}
	return target, nil
}

func protectedArchivePath(name string) bool {
	parts := strings.Split(filepath.ToSlash(filepath.Clean(name)), "/")
	for _, part := range parts {
		lower := strings.ToLower(part)
		if lower == ".git" || lower == ".env" || (strings.HasPrefix(lower, ".env.") && lower != ".env.example") {
			return true
		}
	}
	return false
}
