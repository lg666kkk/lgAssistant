package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	// 内部包路径使用 go.mod 中的 module Path 作为所有内部包的统一前缀
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/api"
	artifactfs "github.com/lg/personal-assistant/apps/sandbox-broker/internal/artifact/filesystem"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/auth"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/config"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/event"
	eventmemory "github.com/lg/personal-assistant/apps/sandbox-broker/internal/event/memory"
	eventpostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/event/postgres"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor"
	containerexecutor "github.com/lg/personal-assistant/apps/sandbox-broker/internal/executor/container"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	runtimecli "github.com/lg/personal-assistant/apps/sandbox-broker/internal/runtime/cli"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
	skillpostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill/postgres"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/store"
	storememory "github.com/lg/personal-assistant/apps/sandbox-broker/internal/store/memory"
	storepostgres "github.com/lg/personal-assistant/apps/sandbox-broker/internal/store/postgres"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/workspace"
)

func main() {
	// 创建日志器
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	// 读取配置
	cfg, err := config.FromEnv()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	var verifier *auth.Verifier
	if !cfg.AuthDisabled {
		verifier, err = auth.NewVerifier(cfg.AuthSecret, cfg.AuthMaxAge)
		if err != nil {
			logger.Error("invalid authentication configuration", "error", err)
			os.Exit(1)
		}
	}
	policies := policy.NewRegistry()
	memorySkills, err := skill.NewMemoryStore(policies)
	if err != nil {
		logger.Error("initialize skill store", "error", err)
		os.Exit(1)
	}
	var skillStore skill.Store = memorySkills
	var runStore store.RunStore = storememory.NewRunStore()
	var eventStore event.Store = eventmemory.New()
	enqueueOnly := false
	var postgresStore *storepostgres.Store
	if cfg.Store == "postgres" {
		connectCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		postgresStore, err = storepostgres.Open(connectCtx, cfg.DatabaseURL)
		if err != nil {
			cancel()
			logger.Error("sandbox database connection failed", "error", err)
			os.Exit(1)
		}
		defer postgresStore.Close()
		runStore = postgresStore
		postgresEvents, eventErr := eventpostgres.Open(connectCtx, cfg.DatabaseURL)
		if eventErr != nil {
			cancel()
			logger.Error("sandbox event database connection failed", "error", eventErr)
			os.Exit(1)
		}
		defer postgresEvents.Close()
		eventStore = postgresEvents
		postgresSkills, skillErr := skillpostgres.Open(connectCtx, cfg.DatabaseURL, policies)
		cancel()
		if skillErr != nil {
			logger.Error("sandbox skill database connection failed", "error", skillErr)
			os.Exit(1)
		}
		defer postgresSkills.Close()
		skillStore = postgresSkills
		enqueueOnly = true
	}
	var runExecutor executor.Executor = executor.DisabledExecutor{}
	executorName := "disabled"
	if cfg.Runtime != "disabled" && !enqueueOnly {
		runtimeClient, runtimeErr := runtimecli.NewClient(cfg.Runtime, nil)
		if runtimeErr != nil {
			logger.Error("invalid container runtime", "error", runtimeErr)
			os.Exit(1)
		}
		workspaceManager, workspaceErr := workspace.NewManager(workspace.Config{Root: cfg.WorkspaceRoot})
		if workspaceErr != nil {
			logger.Error("invalid workspace configuration", "error", workspaceErr)
			os.Exit(1)
		}
		artifactStore, artifactErr := artifactfs.New(cfg.ArtifactRoot, 10<<20)
		if artifactErr != nil {
			logger.Error("invalid artifact configuration", "error", artifactErr)
			os.Exit(1)
		}
		containerExecutor, executorErr := containerexecutor.New(containerexecutor.Config{
			Runtime: runtimeClient, Workspaces: workspaceManager, Artifacts: artifactStore,
			WorkerID: cfg.WorkerID, RunAsUID: os.Getuid(), RunAsGID: os.Getgid(),
			ImageDigests: map[string]string{
				"skill-trusted":    cfg.SkillImageDigest,
				"coding-untrusted": cfg.CodingImageDigest,
			},
		})
		if executorErr != nil {
			logger.Error("invalid container executor configuration", "error", executorErr)
			os.Exit(1)
		}
		runExecutor = containerExecutor
		executorName = cfg.Runtime
	}
	if enqueueOnly {
		executorName = "postgres-queue"
	}
	// 组装依赖
	handler := api.NewHandler(api.Dependencies{
		Logger:       logger,
		Policies:     policies,
		Executor:     runExecutor,
		ExecutorName: executorName,
		Runs:         runStore,
		Events:       eventStore,
		Skills:       skillStore,
		Auth:         verifier,
		EnqueueOnly:  enqueueOnly,
	})
	server := &http.Server{
		Addr:              cfg.Address(),    // 监听地址
		Handler:           handler.Routes(), // 请求路由
		ReadHeaderTimeout: 5 * time.Second,  // 读取请求头最多 5 秒
		ReadTimeout:       15 * time.Second, // 读取请求体最多 15 秒
		WriteTimeout:      30 * time.Second, // 写响应最多 30 秒
		IdleTimeout:       60 * time.Second, // 空闲连接超时 60 秒
	}
	// 监听退出信号
	/**
	 * syscall.SIGINT: Ctrl+C
	 * syscall.SIGTERM: kill 命令
	 */
	shutdownContext, stop := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer stop()
	// 启动关闭协程
	go func() {
		<-shutdownContext.Done()
		// 给 10 秒钟优雅关闭时间
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
		}
	}()

	logger.Info("sandbox broker listening", "address", cfg.Address())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("sandbox broker stopped unexpectedly", "error", err)
		os.Exit(1)
	}
}
