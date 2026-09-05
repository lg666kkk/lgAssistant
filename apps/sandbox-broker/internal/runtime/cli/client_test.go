package cli

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type runnerCall struct {
	binary    string
	arguments []string
	limit     int
}

type fakeRunner struct {
	calls   []runnerCall
	outputs []CommandOutput
	errors  []error
}

func (runner *fakeRunner) Run(_ context.Context, binary string, arguments []string, limit int) (CommandOutput, error) {
	runner.calls = append(runner.calls, runnerCall{binary: binary, arguments: append([]string(nil), arguments...), limit: limit})
	index := len(runner.calls) - 1
	var output CommandOutput
	if index < len(runner.outputs) {
		output = runner.outputs[index]
	}
	var err error
	if index < len(runner.errors) {
		err = runner.errors[index]
	}
	return output, err
}

func TestClientLifecycle(t *testing.T) {
	runner := &fakeRunner{outputs: []CommandOutput{
		{Stdout: []byte("container-id\n")},
		{},
		{Stdout: []byte("137\n")},
		{Stdout: []byte("true\n")},
		{Stdout: []byte("out"), Stderr: []byte("err"), StdoutTruncated: true},
		{},
		{},
		{},
	}}
	client, err := NewClient("podman", runner)
	if err != nil {
		t.Fatal(err)
	}
	spec := validSpec(t)

	container, err := client.Create(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if container.ID != "container-id" || container.Name != "sandbox-run-1" {
		t.Fatalf("unexpected container: %+v", container)
	}
	if err := client.Start(context.Background(), container.ID); err != nil {
		t.Fatal(err)
	}
	exit, err := client.Wait(context.Background(), container.ID)
	if err != nil {
		t.Fatal(err)
	}
	if exit.ExitCode != 137 || !exit.OOMKilled {
		t.Fatalf("unexpected exit: %+v", exit)
	}
	stdout, stderr, err := client.Logs(context.Background(), container.ID, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(stdout.Data) != "out" || !stdout.Truncated || string(stderr.Data) != "err" {
		t.Fatalf("unexpected logs: stdout=%+v stderr=%+v", stdout, stderr)
	}
	if err := client.Stop(context.Background(), container.ID, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := client.Kill(context.Background(), container.ID); err != nil {
		t.Fatal(err)
	}
	if err := client.Remove(context.Background(), container.ID); err != nil {
		t.Fatal(err)
	}

	wantTail := [][]string{
		{"start", "container-id"},
		{"wait", "container-id"},
		{"inspect", "--format={{.State.OOMKilled}}", "container-id"},
		{"logs", "container-id"},
		{"stop", "--time=2", "container-id"},
		{"kill", "container-id"},
		{"rm", "--force", "container-id"},
	}
	for index, want := range wantTail {
		got := runner.calls[index+1].arguments
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("call %d = %#v, want %#v", index+1, got, want)
		}
	}
}

func TestClientIncludesRuntimeStderr(t *testing.T) {
	runner := &fakeRunner{
		outputs: []CommandOutput{{Stderr: []byte("runtime denied request")}},
		errors:  []error{errors.New("exit status 125")},
	}
	client, err := NewClient("docker", runner)
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.Create(context.Background(), validSpec(t))
	if err == nil || !strings.Contains(err.Error(), "runtime denied request") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLimitedBuffer(t *testing.T) {
	buffer := newLimitedBuffer(4)
	written, err := buffer.Write([]byte("abcdef"))
	if err != nil || written != 6 {
		t.Fatalf("write = %d, %v", written, err)
	}
	if string(buffer.Bytes()) != "abcd" || !buffer.Truncated() {
		t.Fatalf("unexpected buffer: %q truncated=%v", buffer.Bytes(), buffer.Truncated())
	}
}

func TestNewClientRejectsUnknownRuntime(t *testing.T) {
	if _, err := NewClient("sh", &fakeRunner{}); err == nil {
		t.Fatal("expected unknown runtime to be rejected")
	}
}

func TestClientCleansWorkerOrphans(t *testing.T) {
	runner := &fakeRunner{outputs: []CommandOutput{
		{Stdout: []byte("abc123\ndef456\n")}, {}, {},
	}}
	client, err := NewClient("podman", runner)
	if err != nil {
		t.Fatal(err)
	}
	count, err := client.CleanupWorkerContainers(context.Background(), "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("cleaned %d containers", count)
	}
	want := [][]string{
		{"ps", "--all", "--quiet", "--filter=label=sandbox.worker_id=worker-1"},
		{"rm", "--force", "abc123"},
		{"rm", "--force", "def456"},
	}
	for index := range want {
		if !reflect.DeepEqual(runner.calls[index].arguments, want[index]) {
			t.Fatalf("call %d = %#v, want %#v", index, runner.calls[index].arguments, want[index])
		}
	}
}
