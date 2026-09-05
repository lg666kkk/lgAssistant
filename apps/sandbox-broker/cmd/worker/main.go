package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	artifactfs "github.com/lg/personal-assistant/apps/sandbox-broker/internal/artifact/filesystem"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/config"
	eventpostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/event/postgres"
	containerexecutor "github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor/container"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	queuepostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/queue/postgres"
	runtimecli "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime/cli"
	skillpostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill/postgres"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/worker"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/workspace"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.FromEnvForWorker()
	if err != nil {
		logger.Error("invalid worker configuration", "error", err)
		os.Exit(1)
	}
	if cfg.Store != "postgres" {
		logger.Error("worker requires SANDBOX_STORE=postgres")
		os.Exit(1)
	}
	if cfg.Runtime == "disabled" {
		logger.Error("worker requires SANDBOX_RUNTIME=podman or docker")
		os.Exit(1)
	}

	shutdownContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	connectContext, cancelConnect := context.WithTimeout(shutdownContext, 10*time.Second)
	queue, err := queuepostgres.Open(connectContext, cfg.DatabaseURL)
	if err != nil {
		cancelConnect()
		logger.Error("sandbox queue connection failed", "error", err)
		os.Exit(1)
	}
	defer queue.Close()
	eventStore, err := eventpostgres.Open(connectContext, cfg.DatabaseURL)
	if err != nil {
		cancelConnect()
		logger.Error("sandbox event connection failed", "error", err)
		os.Exit(1)
	}
	defer eventStore.Close()
	policies := policy.NewRegistry()
	skillStore, err := skillpostgres.Open(connectContext, cfg.DatabaseURL, policies)
	cancelConnect()
	if err != nil {
		logger.Error("sandbox skill connection failed", "error", err)
		os.Exit(1)
	}
	defer skillStore.Close()

	runtimeClient, err := runtimecli.NewClient(cfg.Runtime, nil)
	if err != nil {
		logger.Error("invalid container runtime", "error", err)
		os.Exit(1)
	}
	workspaceManager, err := workspace.NewManager(workspace.Config{Root: cfg.WorkspaceRoot})
	if err != nil {
		logger.Error("invalid workspace configuration", "error", err)
		os.Exit(1)
	}
	artifactStore, err := artifactfs.New(cfg.ArtifactRoot, 10<<20)
	if err != nil {
		logger.Error("invalid artifact configuration", "error", err)
		os.Exit(1)
	}
	images := map[string]string{
		"skill-trusted":    cfg.SkillImageDigest,
		"coding-untrusted": cfg.CodingImageDigest,
	}
	executor, err := containerexecutor.New(containerexecutor.Config{
		Runtime: runtimeClient, Workspaces: workspaceManager, Artifacts: artifactStore,
		WorkerID: cfg.WorkerID, RunAsUID: os.Getuid(), RunAsGID: os.Getgid(), ImageDigests: images,
	})
	if err != nil {
		logger.Error("invalid container executor configuration", "error", err)
		os.Exit(1)
	}
	runner, err := worker.New(worker.Config{
		Logger: logger, Queue: queue, Executor: executor, Events: eventStore, Policies: policies, Skills: skillStore,
		WorkerID: cfg.WorkerID, ImageDigests: images, Concurrency: 2,
		OrphanCleaner: runtimeClient,
		LeaseDuration: time.Minute, HeartbeatInterval: 20 * time.Second, PollInterval: time.Second,
	})
	if err != nil {
		logger.Error("invalid worker configuration", "error", err)
		os.Exit(1)
	}

	logger.Info("sandbox worker started", "workerId", cfg.WorkerID, "runtime", cfg.Runtime)
	if err := runner.Run(shutdownContext); err != nil {
		logger.Error("sandbox worker stopped unexpectedly", "error", err)
		os.Exit(1)
	}
	logger.Info("sandbox worker stopped")
}
