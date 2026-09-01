# Sandbox Broker

Go implementation skeleton for the Personal Assistant sandbox control plane.
It is a separate service inside the repository, not a library imported into the
Next.js process.

## Current scope

- HTTP server with graceful shutdown.
- Health endpoint and controlled execution-profile discovery.
- Versioned run and cancellation API shape.
- Request validation and profile-owned resource limits.
- Replaceable `Executor` port.
- Disabled executor that returns HTTP `501` instead of running host commands.

No Docker or Podman socket is accessed yet. The service cannot execute a shell
command in its current state.

## Run locally

```bash
cd apps/sandbox-broker
go run ./cmd/broker
```

The default address is `127.0.0.1:8081`. Override it with:

```bash
SANDBOX_BROKER_HOST=127.0.0.1 SANDBOX_BROKER_PORT=8082 go run ./cmd/broker
```

## Endpoints

```text
GET  /healthz
GET  /v1/profiles
POST /v1/runs
POST /v1/runs/{runId}/cancel
```

Example request:

```json
{
  "runId": "run-123",
  "idempotencyKey": "user-session-tool-hash",
  "profileId": "skill-trusted",
  "command": ["node", "scripts/check.mjs"],
  "timeoutSeconds": 20
}
```

`POST /v1/runs` currently responds with `501 Not Implemented`. The next phase
should add a rootless Docker or Podman executor behind the existing interface.

## Security invariants for the next phase

- The Next.js container must never receive a Docker or Podman socket.
- Clients select a fixed `profileId`; they cannot supply arbitrary mounts,
  capabilities, network mode, resource limits, or container flags.
- Sandbox containers receive no application, database, Supabase, or model
  credentials.
- Images are selected from a Broker-side digest allowlist.
- Networking remains disabled unless a profile explicitly uses an egress
  allowlist.
- Coding runs return a patch artifact. They do not write directly into the host
  repository.
- Timeout and cancellation must kill the underlying container, not only return
  early to the caller.

## Verify

```bash
go test ./...
go vet ./...
go build ./cmd/broker
```
