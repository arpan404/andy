set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

setup:
  rustup show
  cargo --version
  rustc --version
  cargo install cargo-audit --locked || true
  cargo install cargo-deny --locked || true
  cargo install cargo-nextest --locked || true

fmt:
  cargo fmt --all

fmt-check:
  cargo fmt --all -- --check

lint:
  cargo clippy --workspace --all-targets --all-features -- -D warnings

check:
  cargo check --workspace --all-targets

test:
  cargo test --workspace --all-targets

test-fast:
  cargo nextest run --workspace --all-targets

audit:
  cargo audit

deny:
  cargo deny check

fix:
  cargo fmt --all
  cargo clippy --workspace --all-targets --all-features --fix --allow-dirty --allow-staged -- -D warnings

ci:
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  cargo check --workspace --all-targets
  cargo test --workspace --all-targets

run-cli *args:
  cargo run -p cli -- {{args}}

run-desktop *args:
  cargo run -p desktop -- {{args}}

build-release:
  ./scripts/build-release.sh
