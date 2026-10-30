#!/usr/bin/env bash
# Summarise a directory: top-level layout and file counts by extension.
set -euo pipefail
dir="${1:-.}"
echo "== Top level of $dir"
ls -1p "$dir" | head -50
echo
echo "== Files by extension"
rg --files "$dir" 2>/dev/null | sed -E 's/.*\.([A-Za-z0-9]+)$/\1/;t;s/.*/(none)/' | sort | uniq -c | sort -rn | head -20
