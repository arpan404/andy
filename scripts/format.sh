#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

xcrun swift-format format \
  --in-place \
  --recursive \
  --parallel \
  --configuration .swift-format \
  Sources \
  Tests \
  Apps/Desktop/Sources
