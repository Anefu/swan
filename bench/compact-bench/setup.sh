#!/bin/sh
# Set up Compact-Bench with Swan's checkpoint as two more summary methods, and build its image.
#   bench/compact-bench/setup.sh [dir]     (default ~/.swan-bench/compact-bench)
# Upstream: https://github.com/cai-jianfeng/compact-bench (Apache-2.0), pinned below.
set -eu
COMMIT=9dd9a3f
IMAGE=localhost/compact-bench:$COMMIT-swan
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${1:-$HOME/.swan-bench/compact-bench}

if [ ! -d "$DIR/.git" ]; then
  git clone -q https://github.com/cai-jianfeng/compact-bench.git "$DIR"
fi
cd "$DIR"
git checkout -q -- . && git clean -qfd harness tests run.py
git checkout -q "$COMMIT"
git apply "$HERE/swan.patch"
cp "$HERE/swan_checkpoint.py" harness/
cp "$HERE/test_swan_checkpoint.py" tests/
mkdir -p data results work
podman build -q -t "$IMAGE" . >/dev/null
echo "Built $IMAGE from $DIR"
