---
name: markdown-check
description: Validate Markdown heading levels
---

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
COPYFILE_DISABLE=1 tar -cf markdown-check-1.0.0.tar scripts schemas
```

E2B runs the entrypoint in `/home/user/workspace`. The runner writes
`input.json` there and reads the validated `result.json` after execution.
