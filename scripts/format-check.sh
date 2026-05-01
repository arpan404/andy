#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

xcrun swift-format lint \
  --strict \
  --recursive \
  --parallel \
  --configuration .swift-format \
  Sources \
  Tests \
  Apps/Desktop/Sources
