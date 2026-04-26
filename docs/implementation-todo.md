# Implementation Todo

This list tracks the first production path now that the core kernel is ready enough to host real capabilities.

## Current Sequence

1. Build the first real first-party plugin: `memory-markdown`. Done.
2. Load `memory-markdown` through the plugin lifecycle manager. Done.
3. Build a real daemon app that boots config, installed plugins, background polling, and shutdown. Done.
4. Ship the daemon/CLI and first-party subprocess plugins as standalone binaries so users do not need Bun or another JS runtime. Done for core binaries and first-party plugin binaries.
5. Add OpenAI as the first model provider package/plugin. Done.
6. Build Telegram remote-control flow through the communication bridge. Done for polling and webhook ingress.
7. Build WhatsApp remote-control flow through the communication bridge. Done for webhook ingress.
8. Build filesystem plugin with scoped read/write/list/delete. Done.
9. Build shell plugin with approval-gated execution. Done.
10. Build voice, vision, and computer-control plugins behind strict manifests. Done for first subprocess tool surfaces; native provider depth remains incremental.
11. Complete core storage, plugin management, host supervision, active cancellation, and durable policy config. Done.
12. Add binary CLI commands for daemon status, plugin management, and approval decisions. Done.
13. Compile first-party plugin workers as standalone binaries and prefer binary plugin launch in release. Done.
14. Implement remaining first-class system plugins: background-worker, notifications, swarm-orchestrator, persistent memory, and semantic memory. Done.
15. Implement a real skills subsystem with typed manifests, durable registry, daemon APIs, CLI commands, and first-party skills. Done.
16. Implement bundled skill discovery, skill-aware agent prompt context, project coding plugin, richer declarative skill workflow controls, install review APIs, more AI SDK providers, native-depth improvements, sensitive filesystem reads, and local web console. Done.

## Core Completion Todo

1. Transactional storage layer. Done.
2. Plugin install/enable/disable/remove API. Done for local manifest installs, GitHub immutable-ref installs, and lifecycle mutation over daemon HTTP.
3. Plugin host crash/restart supervision. Done.
4. Active cancellation propagation for in-flight tool execution. Done.
5. Durable policy config and expiring grants. Done.

## Rules

- Product capability belongs in plugins.
- Core only owns kernel, policy, audit, lifecycle, state, and syscall boundaries.
- Every plugin must be typed, manifest-bound, policy-checked, audited, and tested.
- Run `bun run fmt`, `bun run check`, `bun run build`, and a smoke command before marking work complete.
- User-facing release artifacts should be standalone binaries. Users should not need Bun, Node, or another JavaScript runtime.

## Completed

### Core Plugin And Tool Execution Hardening

- Core state now saves through an atomic JSON envelope with a schema version and temp-file rename.
- Plugin registry JSON now saves through a schema-versioned atomic write.
- Daemon writes and reads durable policy config from `.andy/policy.json`.
- Daemon HTTP now exposes `GET /plugins`, `POST /plugins/install-local`, `POST /plugins/install-github`, `POST /plugins/:id/enable`, `POST /plugins/:id/disable`, `POST /plugins/:id/remove`, and `POST /plugins/restart-crashed`.
- GitHub plugin installs clone immutable commit SHA or semver release tag refs into `.andy/github-plugins`, load the manifest from the checkout, and persist the checkout path in the installed-plugin registry.
- CLI now exposes daemon-backed plugin commands for list, local install, GitHub install, enable, disable, remove, restart crashed hosts, and approval list/approve/deny.
- First-party subprocess plugin manifests now include `binaryEntrypoint`, and the host launches compiled plugin binaries when present before falling back to Bun source entrypoints for development.
- Daemon config parsing merges new default first-party plugin entries and capability gates into existing local configs so upgrades seed newly added plugins disabled-by-default.
- Plugin lifecycle reports host health and can restart crashed plugin hosts; failed restarts disable runtime proxy tools.
- Active runtime cancellation races in-flight tool effects and interrupts hosted worker/subprocess calls.
- Policy config supports per-plugin/channel/risk rules and expiring grants.
- Skills are now declarative workflow packages with `@andy/skill-sdk`, `@andy/skill-manager`, `.andy/skills.json`, daemon APIs, and CLI commands.
- Skill execution composes fully qualified plugin tools through the normal runtime path, so policy, approval, audit, schemas, and plugin lifecycle still apply.
- Plugin installs now discover bundled `skills/**/skill.json` manifests and install them as plugin-owned skill records.
- Skill workflows support `when`, `forEach`, `continueOnError`, and `saveAs` while remaining declarative.
- Agent runs can receive skill instructions, and daemon `POST /agent/run` can inject enabled skills into the model context.
- Added a durable JSON-file plugin registry in `@andy/plugin-manager`.
- Installed plugin records now persist manifest, source, lifecycle status, install time, and update time.
- Daemon boot now seeds the registry from config and starts enabled plugins from installed-plugin records.
- Plugin lifecycle stop now disables runtime proxy tools so stopped plugin handles are not still callable.
- Plugin lifecycle start replaces an already-running handle before starting the new one.
- Runtime tool execution now checks cancellation tokens before executing tools.
- Agent sessions, replayable audit/event history, and trace contexts now hydrate from and save to the core state snapshot.
- Added focused tests for durable plugin registry, lifecycle stop behavior, durable events, session persistence, and cancelled tool execution.

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
- Added `@andy/plugin-background-worker` for durable background task request, schedule, and cancellation records in plugin-owned storage.
- Added `@andy/plugin-notifications` for notification and approval-request delivery records.
- Added `@andy/plugin-swarm-orchestrator` for bounded swarm plan, spawn, delegate, join, and cancel records behind manifest limits.
- Added `@andy/plugin-memory-persistent` for JSON-backed persistent memory save, fetch, query, list, and forget operations.
- Added `@andy/plugin-memory-semantic` for inspectable semantic memory records with deterministic local vector indexing.
- Added lifecycle tests for scoped filesystem behavior, shell approval parking, messaging normalization, background/notification/swarm tools, persistent memory, and semantic memory.

### Skills

- Added `@andy/skill-sdk` for typed skill manifests and workflow validation.
- Added `@andy/skill-manager` for durable install, enable, disable, remove, upgrade, and list state.
- Added daemon skill APIs for listing, installing, lifecycle mutation, and workflow execution.
- Added CLI `andy skill ...` commands.
- Added first-party skills under `skills/remember` and `skills/shell-note`.
- Added `@andy/plugin-project` with scoped project read/write/search/diff/run-check tools.
- Added project-bundled coding skills for Effect TS and React work.
- Added local install review endpoints for plugins and skills.
- Added AI SDK Anthropic and Google provider adapters alongside OpenAI.
- Added `filesystem.read_sensitive` as a separate critical capability with explicit sensitive roots.
- Added a local `@andy/web` console for daemon status, plugin/skill visibility, and skill execution.

### Release Packaging

- Added `bun run package:release` to assemble compiled release artifacts into `dist/release/andy-<version>-<platform>-<arch>/`.
- Added `bun run build:release` to build workspaces, plugin binaries, CLI binary, daemon binary, and the release package in one command.
- The release package includes `bin/andy`, `bin/andy-daemon`, built web assets, global first-party skills, first-party plugin manifests, plugin worker binaries, plugin-bundled skills, and `release.json`.
- Packaging fails when a required binary, manifest, skill, or web asset is missing, so release validation catches incomplete runtime-free bundles.

### Telegram Remote Control

- Daemon config now includes `remoteControl.telegram`.
- When enabled, the daemon polls `telegram.listen`, publishes inbound messages to `CommunicationBridge`, runs an agent session through the selected AI SDK model provider, and sends the response through `telegram.sendMessage`.
- Remote control is disabled by default because it requires credentials, enabled Telegram plugin manifest, and an enabled model provider.

### HTTP Ingress And Remote Approvals

- Daemon HTTP server now exposes `GET /health`, `GET /status`, `GET /approvals`, `POST /approvals/:id/approve`, and `POST /approvals/:id/deny`.
- Webhook ingress exists at `POST /webhooks/telegram` and `POST /webhooks/whatsapp`.
- Webhook requests can be protected with `X-Andy-Webhook-Secret` using the configured `http.webhookSecretEnv`.
- Telegram and WhatsApp inbound messages are normalized, published through `CommunicationBridge`, and can drive agent sessions when the channel remote-control config is enabled.
- Approval-gated tool calls now carry `channelId` and `conversationId`, so approval prompts route back through Telegram/WhatsApp with `/approve <id>` and `/deny <id>` commands.
