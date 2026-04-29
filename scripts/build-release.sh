#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
TARGET_DIR="${ROOT_DIR}/target/release"

cd "${ROOT_DIR}"

cargo build --release --workspace

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/bin"

cp "${TARGET_DIR}/cli" "${DIST_DIR}/bin/cli"
cp "${TARGET_DIR}/desktop" "${DIST_DIR}/bin/desktop"

echo "Built release executables:"
echo "  ${DIST_DIR}/bin/cli"
echo "  ${DIST_DIR}/bin/desktop"
