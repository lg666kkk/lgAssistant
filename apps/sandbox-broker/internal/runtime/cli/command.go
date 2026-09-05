package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
)

var (
	containerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
)

func BuildCreateArguments(binary string, spec sandboxruntime.ContainerSpec) ([]string, error) {
	if binary != "podman" && binary != "docker" {
		return nil, errors.New("container runtime must be podman or docker")
	}
	name, err := ContainerName(spec.RunID)
	if err != nil {
		return nil, err
	}
	if err := sandboxruntime.ValidateImageDigest(spec.ImageDigest); err != nil {
		return nil, err
	}
	workspace, err := ValidateWorkspace(spec.WorkspaceRoot, spec.WorkspacePath)
	if err != nil {
		return nil, err
	}
	if !containerIDPattern.MatchString(spec.ProfileID) || !containerIDPattern.MatchString(spec.WorkerID) {
		return nil, errors.New("profile id and worker id must use safe label characters")
	}
	if len(spec.Command) == 0 {
		return nil, errors.New("container command is required")
	}
	if spec.RunAsUID <= 0 || spec.RunAsGID < 0 {
		return nil, errors.New("container must run as a non-root worker uid")
	}
	if spec.CPUQuotaMilli <= 0 || spec.MemoryLimitMB <= 0 || spec.PIDLimit <= 0 {
		return nil, errors.New("container resource limits must be positive")
	}
	if spec.Network != sandboxruntime.NetworkDisabled {
		return nil, errors.New("only disabled container networking is currently supported")
	}

	mountMode := "ro"
	if spec.WorkspaceWritable {
		mountMode = "rw"
	}
	arguments := []string{
		"create",
		"--name=" + name,
		"--label=sandbox.run_id=" + spec.RunID,
		"--label=sandbox.profile_id=" + spec.ProfileID,
		"--label=sandbox.worker_id=" + spec.WorkerID,
		"--pull=never",
		"--read-only",
		"--network=none",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--pids-limit=" + strconv.Itoa(spec.PIDLimit),
		"--memory=" + strconv.Itoa(spec.MemoryLimitMB) + "m",
		"--cpus=" + strconv.FormatFloat(float64(spec.CPUQuotaMilli)/1000, 'f', 3, 64),
		"--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m",
		"--mount=type=bind,src=" + workspace + ",dst=/workspace," + mountMode,
		"--workdir=/workspace",
		"--env=HOME=/tmp",
		"--init",
		"--stop-timeout=2",
	}
	if binary == "podman" {
		arguments = append(arguments, "--userns=keep-id")
	}
	arguments = append(arguments,
		"--user="+strconv.Itoa(spec.RunAsUID)+":"+strconv.Itoa(spec.RunAsGID),
		spec.ImageDigest,
	)
	return append(arguments, spec.Command...), nil
}

func ContainerName(runID string) (string, error) {
	if !containerIDPattern.MatchString(runID) {
		return "", errors.New("run id must contain only lowercase letters, digits, dot, underscore, or hyphen and be at most 64 characters")
	}
	return "sandbox-" + runID, nil
}

func ValidateWorkspace(root string, path string) (string, error) {
	if !filepath.IsAbs(root) || !filepath.IsAbs(path) {
		return "", errors.New("workspace root and path must be absolute")
	}
	cleanRoot := filepath.Clean(root)
	cleanPath := filepath.Clean(path)
	if cleanRoot == string(filepath.Separator) || cleanPath == string(filepath.Separator) || cleanRoot == cleanPath {
		return "", errors.New("workspace must be a child of a non-root workspace directory")
	}
	if strings.ContainsAny(cleanPath, ",\n\r\x00") {
		return "", errors.New("workspace path contains unsupported characters")
	}
	if home, err := os.UserHomeDir(); err == nil && (cleanRoot == filepath.Clean(home) || cleanPath == filepath.Clean(home)) {
		return "", errors.New("workspace cannot be the user home directory")
	}

	resolvedRoot, err := filepath.EvalSymlinks(cleanRoot)
	if err != nil {
		return "", fmt.Errorf("resolve workspace root: %w", err)
	}
	resolvedPath, err := filepath.EvalSymlinks(cleanPath)
	if err != nil {
		return "", fmt.Errorf("resolve workspace path: %w", err)
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return "", fmt.Errorf("stat workspace path: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("workspace path must be a directory")
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace path escapes the approved root")
	}
	return resolvedPath, nil
}
