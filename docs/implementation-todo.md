# Implementation Todo

This list tracks the first production path now that the core kernel is ready enough to host real capabilities.

## Current Sequence

1. Build the first real first-party plugin: `memory-markdown`. Done.
2. Load `memory-markdown` through the plugin lifecycle manager. Done.
3. Build a real daemon app that boots config, installed plugins, background polling, and shutdown. Done.
4. Ship the daemon/CLI as a standalone binary so users do not need Bun or another JS runtime. CLI and daemon binary scripts are in place; plugin subprocesses still need a no-runtime strategy.
5. Add OpenAI as the first model provider package/plugin. Done.
6. Build Telegram remote-control flow through the communication bridge. Done for polling mode.
7. Build WhatsApp remote-control flow through the communication bridge. Plugin normalization/send tools are done; daemon webhook server is still pending.
8. Build filesystem plugin with scoped read/write/list/delete. Done.
9. Build shell plugin with approval-gated execution. Done.
10. Build voice, vision, and computer-control plugins behind strict manifests. Done for first subprocess tool surfaces; native provider depth remains incremental.

## Rules

- Product capability belongs in plugins.
- Core only owns kernel, policy, audit, lifecycle, state, and syscall boundaries.
- Every plugin must be typed, manifest-bound, policy-checked, audited, and tested.
- Run `bun run fmt`, `bun run check`, `bun run build`, and a smoke command before marking work complete.
- User-facing release artifacts should be standalone binaries. Users should not need Bun, Node, or another JavaScript runtime.

## Completed

### `memory-markdown`

- Added `@andy/plugin-memory-markdown` as a Bun workspace plugin package.
- Implemented subprocess RPC tools for `memory.save`, `memory.save_fact`, `memory.fetch`, `memory.query`, `memory.list`, and `memory.forget`.
- Backed the plugin with `@andy/memory` `MarkdownMemoryStore`.
- Kept storage inside `ANDY_PLUGIN_STORAGE_ROOT`, so the plugin writes to its sandboxed plugin storage instead of arbitrary user paths.
- Added manifest tool declarations, schemas, sandbox compatibility, and capability bindings.
- Added a lifecycle test that starts the plugin through `PluginLifecycleManager`, registers runtime proxy tools, saves a memory, queries it, and stops the plugin.

### Daemon App

- Added `@andy/daemon` with `--init`, `--status`, `--once`, and long-running modes.
- Daemon config defaults to `.andy/daemon.json` and loads enabled plugin manifests.
- Enabled plugins start through `PluginLifecycleManager`.
- Background jobs are polled on an interval and run through `BackgroundJobExecutor`.
- Shutdown saves state and stops plugin handles.
- Added `bun run build:daemon-binary` for `dist/andy-daemon`.

### OpenAI Model Provider

- Added `@andy/model-ai-sdk`.
- Provider creation uses Vercel AI SDK provider packages behind core `ModelProviderRegistry`.
- Daemon config supports `modelProviders` entries and registers enabled AI SDK OpenAI providers.
- API keys are read from environment variables such as `OPENAI_API_KEY` and are not printed in daemon status.

### First-Party System Plugins

- Added `@andy/plugin-worker` for consistent subprocess JSON-line worker protocol helpers.
- Added `@andy/plugin-filesystem` with scoped `filesystem.read`, `filesystem.list`, `filesystem.write`, and `filesystem.delete`.
- Added `@andy/plugin-shell` with non-interpolated command execution, scoped `cwd`, bounded output, and approval-oriented `shell.execute` metadata.
- Added `@andy/plugin-telegram` with official Bot API polling, send message, webhook configuration, and update normalization tools.
- Added `@andy/plugin-whatsapp` with official Meta Graph API send, webhook verification, and webhook normalization tools.
- Added `@andy/plugin-voice-input` and `@andy/plugin-voice-output` capability surfaces for explicit activation, transcript handoff, and local speech output.
- Added `@andy/plugin-vision` for screen capture and image/OCR provider handoff surfaces.
- Added `@andy/plugin-computer-control` for gated macOS accessibility actions, disabled unless `ANDY_ENABLE_COMPUTER_CONTROL=1`.
- Added lifecycle tests for scoped filesystem behavior, shell approval parking, and messaging normalization.

### Telegram Remote Control

- Daemon config now includes `remoteControl.telegram`.
- When enabled, the daemon polls `telegram.listen`, publishes inbound messages to `CommunicationBridge`, runs an agent session through the selected AI SDK model provider, and sends the response through `telegram.sendMessage`.
- Remote control is disabled by default because it requires credentials, enabled Telegram plugin manifest, and an enabled model provider.
