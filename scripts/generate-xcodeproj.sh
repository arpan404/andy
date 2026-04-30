#!/usr/bin/env bash
set -euo pipefail

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install: brew install xcodegen" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
xcodegen --spec Apps/project.yml
echo "Generated Apps/AndyApps.xcodeproj"
