package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	sandboxruntime "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime"
)

const testImageDigest = "registry.example/sandbox/node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestBuildCreateArgumentsIncludesSecurityControls(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "run-1")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	resolvedWorkspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}

	arguments, err := BuildCreateArguments("podman", sandboxruntime.ContainerSpec{
		RunID:             "run-1",
		ProfileID:         "coding-untrusted",
		WorkerID:          "worker-1",
		ImageDigest:       testImageDigest,
		WorkspaceRoot:     root,
		WorkspacePath:     workspace,
		WorkspaceWritable: true,
		Command:           []string{"node", "script.mjs"},
		RunAsUID:          1000,
		RunAsGID:          1000,
		CPUQuotaMilli:     500,
		MemoryLimitMB:     256,
		PIDLimit:          64,
		Network:           sandboxruntime.NetworkDisabled,
	})
	if err != nil {
		t.Fatalf("build arguments: %v", err)
	}

	want := []string{
		"create",
		"--name=sandbox-run-1",
		"--label=sandbox.run_id=run-1",
		"--label=sandbox.profile_id=coding-untrusted",
		"--label=sandbox.worker_id=worker-1",
		"--pull=never",
		"--read-only",
		"--network=none",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--pids-limit=64",
		"--memory=256m",
		"--cpus=0.500",
		"--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m",
		"--mount=type=bind,src=" + resolvedWorkspace + ",dst=/workspace,rw",
		"--workdir=/workspace",
		"--env=HOME=/tmp",
		"--init",
		"--stop-timeout=2",
		"--userns=keep-id",
		"--user=1000:1000",
		testImageDigest,
		"node",
		"script.mjs",
	}
	if strings.Join(arguments, "\n") != strings.Join(want, "\n") {
		t.Fatalf("arguments mismatch:\n got: %#v\nwant: %#v", arguments, want)
	}
}

func TestBuildCreateArgumentsRejectsMutableImage(t *testing.T) {
	spec := validSpec(t)
	spec.ImageDigest = "node:latest"
	if _, err := BuildCreateArguments("podman", spec); err == nil {
		t.Fatal("expected mutable image to be rejected")
	}
}

func TestBuildCreateArgumentsRejectsEnabledNetwork(t *testing.T) {
	spec := validSpec(t)
	spec.Network = "allowlist"
	if _, err := BuildCreateArguments("podman", spec); err == nil {
		t.Fatal("expected unsupported network mode to be rejected")
	}
}

func TestContainerNameRejectsUnsafeRunID(t *testing.T) {
	for _, runID := range []string{"UPPER", "../escape", "with space", strings.Repeat("a", 65)} {
		t.Run(runID, func(t *testing.T) {
			if _, err := ContainerName(runID); err == nil {
				t.Fatalf("expected %q to be rejected", runID)
			}
		})
	}
}

func TestBuildCreateArgumentsKeepsDockerWithoutPodmanUserNamespace(t *testing.T) {
	arguments, err := BuildCreateArguments("docker", validSpec(t))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(arguments, " "), "--userns=keep-id") {
		t.Fatal("docker arguments unexpectedly contain Podman user namespace option")
	}
}

func TestValidateWorkspaceRejectsEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	symlink := filepath.Join(root, "escaped")
	if err := os.Symlink(outside, symlink); err != nil {
		t.Fatal(err)
	}

	for name, path := range map[string]string{
		"relative": "relative/path",
		"root":     root,
		"outside":  outside,
		"symlink":  symlink,
		"slash":    "/",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateWorkspace(root, path); err == nil {
				t.Fatalf("expected %s to be rejected", path)
			}
		})
	}
}

func validSpec(t *testing.T) sandboxruntime.ContainerSpec {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "run-1")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	return sandboxruntime.ContainerSpec{
		RunID:             "run-1",
		ProfileID:         "skill-trusted",
		WorkerID:          "worker-1",
		ImageDigest:       testImageDigest,
		WorkspaceRoot:     root,
		WorkspacePath:     workspace,
		WorkspaceWritable: false,
		Command:           []string{"node"},
		RunAsUID:          1000,
		RunAsGID:          1000,
		CPUQuotaMilli:     500,
		MemoryLimitMB:     256,
		PIDLimit:          64,
		Network:           sandboxruntime.NetworkDisabled,
	}
}
