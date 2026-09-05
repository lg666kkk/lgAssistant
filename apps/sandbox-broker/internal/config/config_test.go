package config

import (
	"strings"
	"testing"
	"time"
)

func TestFromEnvRequiresAuthenticationSecretByDefault(t *testing.T) {
	clearConfigEnvironment(t)

	_, err := FromEnv()
	if err == nil || !strings.Contains(err.Error(), "SANDBOX_BROKER_AUTH_SECRET") {
		t.Fatalf("expected missing authentication secret error, got %v", err)
	}
}

func TestFromEnvAllowsExplicitDevelopmentAuthDisable(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_AUTH_DISABLED", "true")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.AuthDisabled {
		t.Fatal("expected authentication to be disabled")
	}
}

func TestFromEnvRejectsProductionAuthDisable(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_ENV", "production")
	t.Setenv("SANDBOX_BROKER_AUTH_DISABLED", "true")

	if _, err := FromEnv(); err == nil {
		t.Fatal("expected production auth disable to fail")
	}
}

func TestFromEnvLoadsAuthentication(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_AUTH_SECRET", strings.Repeat("s", 32))
	t.Setenv("SANDBOX_BROKER_AUTH_MAX_AGE_SECONDS", "120")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.AuthDisabled {
		t.Fatal("authentication must be enabled")
	}
	if cfg.AuthMaxAge != 2*time.Minute {
		t.Fatalf("auth max age = %s", cfg.AuthMaxAge)
	}
}

func TestFromEnvRejectsUnknownRuntime(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_AUTH_DISABLED", "true")
	t.Setenv("SANDBOX_RUNTIME", "sh")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected unknown runtime to fail")
	}
}

func TestFromEnvRequiresCompleteRuntimeConfiguration(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_AUTH_DISABLED", "true")
	t.Setenv("SANDBOX_RUNTIME", "podman")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected incomplete runtime configuration to fail")
	}
}

func TestFromEnvLoadsRuntimeConfiguration(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_AUTH_DISABLED", "true")
	t.Setenv("SANDBOX_RUNTIME", "podman")
	t.Setenv("SANDBOX_WORKER_ID", "worker-1")
	t.Setenv("SANDBOX_WORKSPACE_ROOT", "/var/lib/sandbox/workspaces")
	t.Setenv("SANDBOX_ARTIFACT_ROOT", "/var/lib/sandbox/artifacts")
	t.Setenv("SANDBOX_SKILL_IMAGE_DIGEST", "image@sha256:"+strings.Repeat("a", 64))
	t.Setenv("SANDBOX_CODING_IMAGE_DIGEST", "image@sha256:"+strings.Repeat("b", 64))

	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Runtime != "podman" || cfg.WorkerID != "worker-1" {
		t.Fatalf("unexpected runtime config: %+v", cfg)
	}
}

func TestFromEnvRequiresPostgresInProduction(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_ENV", "production")
	t.Setenv("SANDBOX_BROKER_AUTH_SECRET", strings.Repeat("s", 32))
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected production memory store to fail")
	}
}

func TestFromEnvLoadsPostgresStore(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_BROKER_AUTH_DISABLED", "true")
	t.Setenv("SANDBOX_STORE", "postgres")
	t.Setenv("SANDBOX_DATABASE_URL", "postgres://sandbox@example.invalid/sandbox")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Store != "postgres" || cfg.DatabaseURL == "" {
		t.Fatalf("unexpected postgres config: %+v", cfg)
	}
}

func TestFromEnvForWorkerDoesNotRequireBrokerSecret(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("SANDBOX_STORE", "postgres")
	t.Setenv("SANDBOX_DATABASE_URL", "postgres://sandbox@example.invalid/sandbox")
	cfg, err := FromEnvForWorker()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthSecret != "" {
		t.Fatal("worker unexpectedly received a broker secret")
	}
}

func clearConfigEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"SANDBOX_BROKER_HOST",
		"SANDBOX_BROKER_PORT",
		"SANDBOX_BROKER_ENV",
		"SANDBOX_BROKER_AUTH_DISABLED",
		"SANDBOX_BROKER_AUTH_SECRET",
		"SANDBOX_BROKER_AUTH_MAX_AGE_SECONDS",
		"SANDBOX_STORE",
		"SANDBOX_DATABASE_URL",
		"SANDBOX_RUNTIME",
		"SANDBOX_WORKER_ID",
		"SANDBOX_WORKSPACE_ROOT",
		"SANDBOX_ARTIFACT_ROOT",
		"SANDBOX_SKILL_IMAGE_DIGEST",
		"SANDBOX_CODING_IMAGE_DIGEST",
	} {
		t.Setenv(name, "")
	}
}
