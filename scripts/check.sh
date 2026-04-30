#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/bootstrap.sh
./scripts/lint.sh
./scripts/test.sh
./scripts/generate-xcodeproj.sh
