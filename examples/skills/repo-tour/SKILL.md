---
name: repo-tour
description: Give a quick, structured tour of a codebase (layout, languages, entry points, how to run it). Use when asked to explain, onboard onto, or summarise a repository.
---

# Repo tour

1. Run `bash /skills/repo-tour/scripts/summarize.sh <repo-dir>` to get file counts by extension and the top-level layout.
2. Read the README and the main build/manifest file (package.json, pyproject.toml, go.mod, Cargo.toml…) if present.
3. Find entry points (main files, CLI definitions, server start-up) with `grep`/`glob`.
4. Reply with these sections, each a few bullets:
   - **What it is**
   - **Layout** (top-level folders and what lives in each)
   - **Tech stack**
   - **How to run / test it**
   - **Where to start reading**

Keep it under 300 words. Do not modify files.
