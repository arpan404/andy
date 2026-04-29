# Development Workflow

## Prerequisites

- Rust toolchain (`rustup`, `cargo`)
- `just` command runner (`cargo install just`)

## Strict Commands

- Setup tools: `just setup` (or `./scripts/bootstrap.sh`)
- Format: `just fmt`
- Format check: `just fmt-check`
- Lint: `just lint`
- Type/build check: `just check`
- Tests: `just test`
- Security audit: `just audit`
- Dependency/license policy: `just deny`
- Full local CI: `just ci`
- Build release executables: `just build-release`

## Local Runs

- CLI ping: `just run-cli ping`
- Desktop IPC ping: `just run-desktop ping`

## Release Artifacts

- `just build-release` builds optimized binaries and stages them in:
  - `dist/bin/cli`
  - `dist/bin/desktop`

## Notes

- Warnings are denied via `.cargo/config.toml` rustflags.
- Workspace lints are configured in the root `Cargo.toml`.
- Toolchain is pinned in `rust-toolchain.toml`.
- `cargo-deny` policy is configured in `deny.toml`.
