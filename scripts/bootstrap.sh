#!/usr/bin/env bash
set -euo pipefail

rustup show >/dev/null
cargo --version
rustc --version

cargo install cargo-audit --locked || true
cargo install cargo-deny --locked || true
cargo install cargo-nextest --locked || true

echo "Bootstrap complete."
