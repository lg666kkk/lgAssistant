# Skill configuration and sandbox binding

## Model

A Skill has editable metadata and immutable published versions:

```text
Skill
  id / name / description / enabled
    |
    +-- Version 1.0.0 (immutable)
          runtime
          fixed entrypoint
          Sandbox Profile
          immutable image digest
          Bundle SHA-256
          input/output JSON Schema paths
```

Disabling a Skill immediately prevents new runs and prevents queued versions
from starting. Published rows and Bundles remain available for audit and
historical Run inspection.

## Configure in the application

Apply `docs/schemas/migrations/20260905-skill-list-detail.sql` after the base
sandbox runtime migration. It adds missing Skill audit and soft-delete columns
before replacing the metadata functions. Existing rows without audit columns
receive `legacy:unknown` for their historical creator and updater; subsequent
writes must supply an actor ID. Re-running the base `CREATE TABLE IF NOT EXISTS`
statements does not upgrade an existing table's columns.

Open **连接 -> 技能**. Click **上传 Skill** and choose a local directory
containing a root-level `SKILL.md`. Any signed-in user can:

1. Import the standard `SKILL.md` metadata and supporting files.
2. Review the imported Skill and enable it when ready.

Skill management does not require `CONFIG_ADMIN_EMAILS`. All signed-in users
can import and manage the shared standard Skill catalog. Unauthenticated
requests remain blocked, and writes record the signed-in user's ID for audit.
Imported supporting files are stored as text; they are not executed during
upload.

The Skill list is a responsive grid. Creating, enabling/disabling and deleting
are list-level operations. Selecting a card opens a separate detail view for
metadata editing, version publication and execution tests. The URL stores the
selected `skillId`, so browser back/forward returns to the correct view.

Delete is audit-preserving soft deletion: the Skill disappears and cannot run,
while immutable versions and historical Runs remain. A Skill with an active or
queued Run must be cancelled before deletion. A deleted Skill ID cannot be
reused.

The image digest is supplied by the selected server-side Profile. A browser
cannot publish a different image for that Profile.

The current MVP sends the Bundle as Base64 JSON through Next.js. A 10 MiB
Bundle produces roughly 13.3 MiB of request data, so the reverse proxy limit
must be at least 14 MiB. Production scale should replace this upload path with
a signed object-storage upload and publish only the verified object reference
and digest.

## Bundle contract

```text
scripts/run.mjs
schemas/input.json
schemas/output.json
```

The Bundle must not contain absolute paths, `..`, links, devices, `.git`, or
real `.env` files. The Worker verifies the Bundle SHA-256 and safely extracts
it into a new per-Run Workspace.

The Worker writes request data to `/workspace/input.json`. The fixed entrypoint
runs with `/workspace` as its working directory. A successful Skill must write
`/workspace/result.json`.

Input is validated before a container is created. `result.json` is validated
after execution and before the Run can become `completed`. External JSON Schema
`$ref` values are rejected; only local `#...` references are allowed.

## Sandbox association

The caller submits only:

```json
{
  "skillId": "markdown-check",
  "skillVersion": "1.0.0",
  "input": { "markdown": "# Title" }
}
```

The published version resolves all privileged fields:

```text
skillId + version
  -> fixed entrypoint
  -> fixed Profile
  -> fixed image digest
  -> fixed Bundle digest
  -> fixed input/output Schemas
```

`POST /v1/skill-runs` rejects unknown request fields, so a caller cannot add a
command, mount, image, network mode, capability or resource override. The
Worker resolves the version again and rejects any Run row that no longer
matches its immutable version.

## Example

An offline Markdown heading checker is available at
`examples/skills/markdown-check`.

```bash
cd apps/sandbox-broker/examples/skills/markdown-check
tar -cf markdown-check-1.0.0.tar scripts schemas
```

Publish it with:

```text
runtime       node
entrypoint    node scripts/run.mjs
profile       skill-trusted
input schema  schemas/input.json
output schema schemas/output.json
```

The selected `skill-trusted` image must already contain Node.js and must be
pre-pulled on the Worker host under the configured immutable digest.

## Required configuration

### Trace and Langfuse

Agent Skill calls remain ordinary tool steps in the local `agent_traces` table.
When the current user enables their Langfuse connection, the chat trace also
receives `tool:list_skills`, `tool:view_skill` and `tool:run_skill` spans, as well
as spans for other tools. Skill ID and sandbox version are recorded when present
in the tool input. Status, tool-call ID and `measuredDurationMs` accompany bounded,
redacted input/output previews; supporting file contents and credential fields
are omitted. These previews are not a complete archive or a guarantee that every
possible secret format can be detected.

Spans are projected after execution, so use `measuredDurationMs` rather than the
span's export-time duration to inspect tool latency. Repeated projection within
one request does not duplicate tool spans. Projection failures do not interrupt
chat execution. No additional database migration or global Langfuse credentials
are required for this reporting path.

### Runtime configuration

Next.js:

```text
SANDBOX_BROKER_URL
SANDBOX_BROKER_AUTH_SECRET
SANDBOX_SKILL_IMAGE_DIGEST
SANDBOX_CODING_IMAGE_DIGEST
```

Broker and Worker use the same PostgreSQL database containing
`sandbox_skills`, `sandbox_skill_versions` and `sandbox_runs`. Apply
`docs/schemas/migrations/20260904-sandbox-runtime.sql` and then
`docs/schemas/migrations/20260905-skill-list-detail.sql` before using the page.

Real remote execution additionally requires the rootless Podman checks in
`remote-deployment.md`.
