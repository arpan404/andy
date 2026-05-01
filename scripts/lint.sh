#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/format-check.sh
./scripts/lint-limits.sh

# Compile with warnings as errors to keep signal high.
swift build \
  -Xswiftc -warnings-as-errors \
  -Xswiftc -strict-concurrency=complete
