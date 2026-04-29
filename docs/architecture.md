# Architecture

## Monorepo Layout

- `crates/cli`: backend service entrypoint and future headless API surface.
- `crates/desktop`: desktop surface that talks to CLI through IPC.
- `crates/protocol`: typed IPC request/response contracts shared by CLI and desktop.

## Direction

- CLI is the backend boundary and must remain reusable by future UIs.
- Desktop is a client of CLI over IPC (`stdin/stdout` JSON lines for now).
- Additional UI layers should integrate by speaking the same protocol crate contracts.

## Current IPC

- Desktop spawns CLI in `serve --stdio` mode.
- Desktop sends `CliRequest` JSON lines.
- CLI returns `CliResponse` JSON lines.
- Both sides use `crates/protocol` for schema stability.
