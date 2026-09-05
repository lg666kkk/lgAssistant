# Sandbox Broker

Go control plane and worker for isolated Personal Assistant command execution.
It is a separate service inside the repository, not a library imported into the
Next.js process.

For the project-driven Go learning and implementation sequence, see
[`docs/agent/learning/go-sandbox-zero-to-one-roadmap.md`](../../docs/agent/learning/go-sandbox-zero-to-one-roadmap.md).

## Implemented scope

- Broker and independent Worker binaries with graceful shutdown.
- Fail-closed HMAC authentication covering timestamp, method, target, user and
  raw body; request IDs and response-status logging.
- User-scoped idempotent Run creation, query, cancellation and resumable events.
- PostgreSQL Run state, atomic claim, lease, heartbeat, retry and dead state.
- Rootless Podman or development Docker CLI adapter without shell invocation.
- Immutable image digests and Broker-owned execution Profiles.
- Read-only root filesystem, disabled network, dropped capabilities,
  `no-new-privileges`, non-root UID, PID/memory/CPU limits and bounded tmpfs.
- Workspace path/symlink validation and safe tar extraction.
- Bounded stdout/stderr collection and content-addressed Artifact storage.
- Startup cleanup for containers owned by the same Worker ID.
- Configurable Skill metadata and immutable published versions linked to a
  Sandbox Profile, fixed entrypoint, immutable image and Bundle digest.
- Skill input/output JSON Schema validation before and after container
  execution; validated `result.json` is stored as a result Artifact.
- Patch approval binding and Egress policy primitives. Network remains closed.

Run requests currently enforce these protocol limits before reaching an
executor:

- `runId`: at most 64 safe lowercase identifier bytes.
- `idempotencyKey`: at most 256 bytes.
- `command`: at most 64 non-empty arguments, each at most 4096 bytes.
- `timeoutSeconds`: zero selects the Profile default; negative values are
  rejected.

`SANDBOX_STORE=memory` is development-only. Production refuses to start unless
`SANDBOX_STORE=postgres`. With `SANDBOX_RUNTIME=disabled`, execution remains
fail-closed and returns HTTP `501`; there is no host-process fallback.

## Run locally

```bash
cd apps/sandbox-broker
SANDBOX_BROKER_AUTH_DISABLED=true go run ./cmd/broker
```

The default address is `127.0.0.1:8081`. Override it with:

```bash
SANDBOX_BROKER_HOST=127.0.0.1 SANDBOX_BROKER_PORT=8082 go run ./cmd/broker
```

## Endpoints

```text
GET  /healthz
GET  /v1/profiles
GET  /v1/skills
POST /v1/runs
POST /v1/skill-runs
GET  /v1/runs/{runId}
GET  /v1/runs/{runId}/events?after={sequence}&limit={limit}
POST /v1/runs/{runId}/cancel
```

Example request:

```json
{
  "userId": "user-123",
  "runId": "run-123",
  "idempotencyKey": "user-session-tool-hash",
  "profileId": "skill-trusted",
  "command": ["node", "scripts/check.mjs"],
  "timeoutSeconds": 20
}
```

Authenticated requests also send `X-Sandbox-User-ID`. The HMAC canonical input
is:

```text
timestamp + "\n" + method + "\n" + request-target + "\n" + user-id + "\n" + raw-body
```

See [`docs/remote-deployment.md`](docs/remote-deployment.md) and the protected
environment examples in [`deploy/`](deploy/).

## Security invariants

- The Next.js container must never receive a Docker or Podman socket.
- Clients select a fixed `profileId`; they cannot supply arbitrary mounts,
  capabilities, network mode, resource limits, or container flags.
- Sandbox containers receive no application, database, Supabase, or model
  credentials.
- Images are selected from a Worker-side digest allowlist and use `--pull=never`.
- Networking remains disabled. The Egress package validates future allowlists,
  but no Profile currently enables network access.
- Coding runs return a patch artifact. They do not write directly into the host
  repository.
- Timeout and cancellation must kill the underlying container, not only return
  early to the caller.

## Verify

```bash
go test ./...
go test -race ./...
go vet ./...
go build ./cmd/broker ./cmd/worker
```

The local suite verifies state, policy, CLI arguments and cleanup through fake
runtime adapters. Real rootless Podman, cgroup, OOM, fork-bomb, network and
Worker-crash tests require the target Linux server and immutable images. They
must pass before production rollout is declared complete.
