package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
)

const (
	defaultHost = "127.0.0.1"
	defaultPort = 8081
)

type Config struct {
	Host string
	Port int
}

func FromEnv() (Config, error) {
	cfg := Config{
		Host: envOrDefault("SANDBOX_BROKER_HOST", defaultHost),
		Port: defaultPort,
	}

	if rawPort := os.Getenv("SANDBOX_BROKER_PORT"); rawPort != "" {
		port, err := strconv.Atoi(rawPort)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("SANDBOX_BROKER_PORT must be between 1 and 65535")
		}
		cfg.Port = port
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
