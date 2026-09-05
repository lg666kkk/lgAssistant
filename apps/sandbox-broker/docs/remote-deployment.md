# Sandbox Broker remote deployment

## Deployment boundary

Production uses two processes:

```text
Next.js -> loopback/private HTTP -> sandbox-broker -> PostgreSQL
                                                 -> sandbox-worker -> rootless Podman
```

The Broker never receives a Podman or Docker socket. Broker and Worker use
different Linux accounts. The Worker runs as the dedicated, non-root
`sandbox-worker` user and invokes rootless Podman directly.
The application, database, Supabase, model, and OAuth credentials are never
passed into sandbox containers.

## Prerequisites

- Linux with cgroup v2.
- Rootless Podman available to the `sandbox-worker` user.
- `/etc/subuid` and `/etc/subgid` ranges configured for `sandbox-worker`.
- PostgreSQL reachable by Broker and Worker over TLS or loopback.
- Two pre-pulled immutable container images selected by SHA-256 digest.
- `/var/lib/personal-assistant/sandbox/{workspaces,artifacts}` owned by
  `sandbox-worker:sandbox-worker` with mode `0700`.
- `/var/lib/personal-assistant/sandbox/worker-home` owned by
  `sandbox-worker:sandbox-worker`;
  the Worker systemd unit uses it for rootless Podman storage instead of a
  regular login home.

Never enable `SANDBOX_RUNTIME=docker` on a production Worker that talks to a
root-owned Docker socket. Possession of that socket is normally equivalent to
host root access.

The Worker unit intentionally does not set systemd `NoNewPrivileges` or
`RestrictSUIDSGID`: rootless Podman may need the setuid `newuidmap/newgidmap`
helpers to establish its subordinate UID/GID range. The sandbox container
itself still uses `--security-opt=no-new-privileges` and drops every capability.

## Install order

1. Apply `docs/schemas/migrations/20260904-sandbox-runtime.sql` using a database
   migration role, then apply `docs/schemas/migrations/20260905-skill-list-detail.sql`.
   The base migration also upgrades tables created by its earlier version:
   it adds missing audit, soft-delete and Run result columns before dependent
   functions are created. Missing historical actor fields use `legacy:unknown`;
   new writes must supply an actor ID. Both files can be re-run without dropping
   tables or deleting existing records.
2. Build Linux Broker and Worker binaries from the pinned Go module.
3. Install the binaries in `/opt/personal-assistant/bin`.
4. Install the example systemd units and create protected environment files in
   `/etc/personal-assistant` with mode `0600`.
5. Start `sandbox-broker`, verify `/healthz`, then start `sandbox-worker`.
6. Send a signed request and verify `queued -> running -> completed` through
   the Run and Events endpoints.

The environment examples contain placeholders only. Do not commit real HMAC,
database, registry, application, model, or OAuth credentials.

## Required runtime checks

Run these as the `sandbox-worker` user before enabling the Worker:

```bash
podman info --format '{{.Host.Security.Rootless}} {{.Host.CgroupsVersion}}'
podman image inspect <immutable-image-digest>
systemctl --user status podman.socket
```

Rootless must be `true` and cgroups must report version `v2`. The Worker uses
`--pull=never`, so missing images fail instead of pulling mutable content at
execution time.

## Acceptance tests

- Invalid or missing HMAC receives `401`.
- Reusing an idempotency key with changed input receives `409`.
- A queued Run survives Broker restart.
- Killing the Worker causes the expired lease to be reclaimed.
- An old Worker cannot ACK after lease loss.
- Timeout and cancellation remove the underlying container.
- Container has a read-only root filesystem, no network, no capabilities,
  non-root UID, PID/memory/CPU limits, and only one Workspace bind mount.
- `.env`, home directories, loopback, Redis, and cloud metadata are inaccessible.
- Unlimited output is truncated and stored as an Artifact.
- Coding runs produce a Patch Artifact and never mutate the host repository.

## Rollback

Stop the Worker first, then the Broker. Existing Run and Event rows remain in
PostgreSQL. Reinstall the previous binaries and restart the Broker before the
Worker. Do not drop the sandbox tables during an application rollback. New
queued Runs can be cancelled or drained after the previous compatible Worker
is restored.

## Current verification boundary

Unit, race, vet, build, SQL static, and CLI argument tests run locally. A real
rootless Podman security and failure-injection run requires the target Linux
server and approved immutable images. Deployment and server mutation are a
separate explicitly approved operation.

## Capability status

| Capability | Repository status | Production gate |
|---|---|---|
| Broker API, HMAC, user isolation and idempotency | Implemented and locally tested | Rotate and inject production HMAC secret |
| PostgreSQL Run, events, claim, lease, retry and dead state | Implemented and statically checked | Apply migration and run multi-Worker database tests |
| Rootless Podman container execution and cleanup | Implemented behind the Runtime interface | Verify on target Linux with immutable images and fault injection |
| Workspace archive validation and local Artifact store | Implemented and locally tested | Replace or back the Artifact store with durable shared storage |
| Skill configuration, immutable versions and `run_skill` | Implemented with database-backed Bundle and Schema validation | Apply migration, publish immutable images, and run a real Skill on target Podman |
| Coding Patch approval binding | Policy core implemented | Add trusted snapshot source, patch generation, and separate apply service |
| Egress URL/DNS/IP policy | Policy core implemented; network stays disabled | Build a dedicated proxy and credential-capability service before enabling |
| Metrics, alerts and production SLOs | Structured logs/events implemented | Connect metrics/trace exporters and alert rules |

The production gates are external integration and target-host verification,
not code paths that should be replaced with unsafe local fallbacks.
