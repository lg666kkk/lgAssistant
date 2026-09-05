---
name: text-stats
description: Count characters, words, and lines in a text passage.
---

# Text Stats

Use this skill when the user asks for basic text statistics.

## Procedure

1. Read the text supplied by the user.
2. Count Unicode characters, whitespace-separated words, and lines.
3. Return the counts with a short explanation.

## Included helper

The `scripts/count.mjs` file contains a deterministic local implementation for
testing that the uploaded Skill files are preserved correctly.
