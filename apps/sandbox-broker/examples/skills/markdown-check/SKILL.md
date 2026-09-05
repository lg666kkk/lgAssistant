# Markdown Check

Offline example Skill for validating Markdown heading levels.

Published configuration:

```text
runtime: node
entrypoint: node scripts/run.mjs
profile: skill-trusted
input schema: schemas/input.json
output schema: schemas/output.json
network: disabled
```

Create the upload Bundle from this directory:

```bash
tar -cf markdown-check-1.0.0.tar scripts schemas
```

The Worker writes input to `/workspace/input.json`. The Skill must write its
validated JSON result to `/workspace/result.json`.
