# Development Workflow

## Prerequisites

- Rust toolchain (`rustup`, `cargo`)

## Strict Commands

- Format: `cargo fmt --all`
- Format check: `cargo fmt-check`
- Lint: `cargo lint`
- Type/build check: `cargo check-all`
- Tests: `cargo test --workspace --all-targets`

## Local Runs

- CLI ping: `cargo run -p cli -- ping`
- Desktop IPC ping: `cargo run -p desktop -- ping`

## Notes

- Warnings are denied via `.cargo/config.toml` rustflags.
- Workspace lints are configured in the root `Cargo.toml`.
