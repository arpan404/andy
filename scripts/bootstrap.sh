#!/usr/bin/env bash
set -euo pipefail

echo "Checking required tools..."

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install with: brew install xcodegen" >&2
  exit 1
fi

if ! xcrun --find swift-format >/dev/null 2>&1; then
  echo "swift-format is required and should come with modern Xcode toolchains." >&2
  exit 1
fi

echo "Tooling looks good."
