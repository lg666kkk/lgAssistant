package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHost              = "127.0.0.1"
	defaultPort              = 8081
	defaultAuthMaxAgeSeconds = 300
)

type Config struct {
	Host              string
	Port              int
	Environment       string
	AuthDisabled      bool
	AuthSecret        string
	AuthMaxAge        time.Duration
	Store             string
	DatabaseURL       string
	Runtime           string
	WorkerID          string
	WorkspaceRoot     string
	ArtifactRoot      string
	SkillImageDigest  string
	CodingImageDigest string
}

func FromEnv() (Config, error) {
	return fromEnv(true)
}

func FromEnvForWorker() (Config, error) {
	return fromEnv(false)
}

func fromEnv(requireBrokerAuth bool) (Config, error) {
	cfg := Config{
		Host:              envOrDefault("SANDBOX_BROKER_HOST", defaultHost),
		Port:              defaultPort,
		Environment:       envOrDefault("SANDBOX_BROKER_ENV", "development"),
		AuthSecret:        os.Getenv("SANDBOX_BROKER_AUTH_SECRET"),
		AuthMaxAge:        defaultAuthMaxAgeSeconds * time.Second,
		Store:             envOrDefault("SANDBOX_STORE", "memory"),
		DatabaseURL:       os.Getenv("SANDBOX_DATABASE_URL"),
		Runtime:           envOrDefault("SANDBOX_RUNTIME", "disabled"),
		WorkerID:          os.Getenv("SANDBOX_WORKER_ID"),
		WorkspaceRoot:     os.Getenv("SANDBOX_WORKSPACE_ROOT"),
		ArtifactRoot:      os.Getenv("SANDBOX_ARTIFACT_ROOT"),
		SkillImageDigest:  os.Getenv("SANDBOX_SKILL_IMAGE_DIGEST"),
		CodingImageDigest: os.Getenv("SANDBOX_CODING_IMAGE_DIGEST"),
	}

	if rawPort := os.Getenv("SANDBOX_BROKER_PORT"); rawPort != "" {
		port, err := strconv.Atoi(rawPort)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("SANDBOX_BROKER_PORT must be between 1 and 65535")
		}
		cfg.Port = port
	}
	if rawDisabled := os.Getenv("SANDBOX_BROKER_AUTH_DISABLED"); rawDisabled != "" {
		disabled, err := strconv.ParseBool(rawDisabled)
		if err != nil {
			return Config{}, fmt.Errorf("SANDBOX_BROKER_AUTH_DISABLED must be true or false")
		}
		cfg.AuthDisabled = disabled
	}
	if rawMaxAge := os.Getenv("SANDBOX_BROKER_AUTH_MAX_AGE_SECONDS"); rawMaxAge != "" {
		seconds, err := strconv.Atoi(rawMaxAge)
		if err != nil || seconds < 30 || seconds > 900 {
			return Config{}, fmt.Errorf("SANDBOX_BROKER_AUTH_MAX_AGE_SECONDS must be between 30 and 900")
		}
		cfg.AuthMaxAge = time.Duration(seconds) * time.Second
	}
	if requireBrokerAuth && strings.EqualFold(cfg.Environment, "production") && cfg.AuthDisabled {
		return Config{}, fmt.Errorf("sandbox authentication cannot be disabled in production")
	}
	if requireBrokerAuth && !cfg.AuthDisabled && len(cfg.AuthSecret) < 32 {
		return Config{}, fmt.Errorf("SANDBOX_BROKER_AUTH_SECRET must contain at least 32 bytes when authentication is enabled")
	}
	switch cfg.Store {
	case "memory":
		if strings.EqualFold(cfg.Environment, "production") {
			return Config{}, fmt.Errorf("SANDBOX_STORE must be postgres in production")
		}
	case "postgres":
		if strings.TrimSpace(cfg.DatabaseURL) == "" {
			return Config{}, fmt.Errorf("SANDBOX_DATABASE_URL is required for the postgres store")
		}
	default:
		return Config{}, fmt.Errorf("SANDBOX_STORE must be memory or postgres")
	}
	switch cfg.Runtime {
	case "disabled":
	case "podman", "docker":
		if strings.TrimSpace(cfg.WorkerID) == "" {
			return Config{}, fmt.Errorf("SANDBOX_WORKER_ID is required when the container runtime is enabled")
		}
		if err := validateRuntimePath("SANDBOX_WORKSPACE_ROOT", cfg.WorkspaceRoot); err != nil {
			return Config{}, err
		}
		if err := validateRuntimePath("SANDBOX_ARTIFACT_ROOT", cfg.ArtifactRoot); err != nil {
			return Config{}, err
		}
		if filepath.Clean(cfg.WorkspaceRoot) == filepath.Clean(cfg.ArtifactRoot) {
			return Config{}, fmt.Errorf("workspace and artifact roots must be different directories")
		}
		if cfg.SkillImageDigest == "" || cfg.CodingImageDigest == "" {
			return Config{}, fmt.Errorf("both sandbox image digests are required when the container runtime is enabled")
		}
	default:
		return Config{}, fmt.Errorf("SANDBOX_RUNTIME must be disabled, podman, or docker")
	}

	return cfg, nil
}

func (c Config) Address() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

func envOrDefault(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func validateRuntimePath(name string, value string) error {
	if !filepath.IsAbs(value) || filepath.Clean(value) == string(filepath.Separator) {
		return fmt.Errorf("%s must be an absolute non-root path", name)
	}
	return nil
}
