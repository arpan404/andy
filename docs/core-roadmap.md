# Core Roadmap

Andy Core should stay small and trusted. It should provide the kernel, policy boundaries, observability, and plugin host contracts that let plugins deliver product features safely.

## Already Started

- First real first-party plugin path: `@andy/plugin-memory-markdown` runs as a subprocess-hosted plugin and backs memory tools with Markdown storage.
- CLI binary packaging uses Bun standalone executable compilation through `bun run build:binary`.
- Daemon app boots config, loads enabled plugin manifests through lifecycle, polls due background jobs, saves state, handles shutdown, and can be compiled with `bun run build:daemon-binary`.
- AI SDK model provider package (`@andy/model-ai-sdk`) registers Vercel AI SDK models behind the core model-provider registry. Andy does not integrate with provider-native SDKs directly.
- First-party system plugins now exist for Markdown memory, persistent memory, semantic memory, scoped filesystem access, approval-gated shell execution, Telegram, WhatsApp, voice input/output, vision, computer-control, background-worker, notifications, and swarm-orchestrator capability surfaces.
- Skills now exist as declarative workflow packages with `@andy/skill-sdk`, `@andy/skill-manager`, daemon APIs, CLI commands, and local first-party skill manifests under `skills/`.
- Plugin-bundled skills are discovered from plugin manifests or `skills/**/skill.json` and installed as plugin-owned skill records.
- The project coding plugin provides scoped read/write/search/diff/run-check tools plus bundled Effect TS and React coding skills.
- The local web console provides a first UI surface for daemon status, plugin/skill inventory, approvals, and skill runs.
- Release packaging now assembles CLI, daemon, web assets, global skills, plugin manifests, plugin binaries, and plugin-bundled skills into `dist/release/andy-<version>-<platform>-<arch>/`.
- Daemon remote control supports Telegram polling/webhook mode and WhatsApp webhook mode: inbound messages are normalized, published through the communication bridge, handled by an agent session using a configured AI SDK model provider, and replied to through the channel plugin.
- Daemon HTTP ingress exposes health/status, approval list/decision endpoints, and Telegram/WhatsApp webhook endpoints with optional shared-secret verification.
- Agent session kernel with AI SDK result types.
- Bounded same-step tool-call execution with ordered tool-result messages.
- Fully qualified internal tool names with ambiguity-safe local aliases.
- AI SDK tool-name adapter that exposes model-safe tool names while mapping back to Andy qualified runtime tools.
- Plugin lifecycle states for install, enable, disable, remove, and upgrade review.
- Manifest capability checks during plugin registration.
- Shared plugin manifest schema for install-time validation.
- Policy-gated runtime tool execution.
- Approval request manager for `ask` policy decisions.
- Audit events for core agent and tool actions.
- Typed event bus and trace manager.
- Secret broker interface with an in-memory implementation.
- Typed host API surface for memory, filesystem, messaging, background, swarm, and secrets.
- Typed plugin tool input schemas are carried from plugin definitions into AI SDK tool definitions.
- Markdown-backed memory package.
- Virtual filesystem package for scratch files and scoped real filesystem access.
- Bounded multi-agent coordinator primitive.
- Plugin host and installer interfaces, with trusted in-process and manifest-fetching scaffolds.
- Worker manifest plugin host can start worker-module plugin entries, proxy manifest-declared tools over a typed RPC protocol, and register those tools with the runtime.
- Subprocess manifest plugin host can start Bun plugin processes with a per-plugin sandbox root, minimal environment, JSON-line RPC, and runtime-registered proxy tools.
- Plugin sandbox factory creates isolated scratch and storage filesystem roots for hosted plugin processes.
- Tool manifests can declare sandbox compatibility and host-privilege requirements, and incompatible tools are rejected before host startup.
- Runtime registration rejects unsandboxed tools unless the host explicitly trusts the plugin id and, by default, the plugin source is local.
- Subprocess launch profiles support process-boundary mode, macOS `sandbox-exec`, and container command generation.
- Communication bridge routes user/agent messages and approval prompts through registered channel plugins such as WhatsApp and Telegram.
- Worker and subprocess plugin RPC supports host API requests with manifest capability checks before forwarding to the host handler.
- Approval resume engine parks approval-gated runtime tool actions and resumes the exact suspended action after the user decision.
- Default hosted-plugin host API handler forwards sandboxed plugin syscall requests back through runtime tools.
- Daemon service graph composes runtime, communication, approvals, approval resume, background, secrets, and hosted plugin host API handler.
- Rule-based policy wrapper supports per-capability, per-plugin, per-user, per-channel, and risk-based policy rules.
- JSON file secret broker provides an early durable secret-store scaffold with encoded values.
- Background job scheduler with due-job lookup, progress events, hydration, and status transitions.
- Core state store contract with in-memory and JSON file implementations.
- Cancellation token registry and timeout helper.
- Streaming agent kernel can consume AI SDK stream events, expose structured stream events, and execute stream-planned tool calls through runtime policy.
- Agent and tool execution contexts carry trace, session, channel, task, and cancellation metadata through policy and audit.
- Runtime validates declared tool input and output JSON schemas at the core boundary.
- Runtime uses AJV for JSON Schema validation instead of a hand-rolled partial checker.
- Plugin lifecycle manager starts hosted plugins, registers runtime proxy tools, and stops plugin handles.
- Plugin install planning validates manifests, checks schema compatibility, pins reviewed sources, summarizes requested permissions, and can materialize a disabled-by-default local package record.
- Event bus keeps bounded replay history for daemon/app subscribers.
- Trace manager tracks hydrated trace contexts and child trace creation.
- Secret broker supports redacted references and rotation audit events.
- Approval resume can persist serializable tool-execution descriptors and hydrate them after daemon restart.
- Background executor runs due jobs through the normal runtime policy boundary and persists job progress.
- Model provider registry keeps provider implementations behind the AI SDK runner interface.
- Process isolation verifier can reject weak profiles when strong untrusted-plugin isolation is required.
- Plugin manager now has a JSON-file registry for durable installed plugin records, preserving manifest, source, lifecycle status, and install/update timestamps across process restarts.
- Daemon boot seeds that registry from config and starts enabled plugins from durable installed-plugin records instead of treating config paths as the only plugin database.
- Plugin lifecycle stop disables runtime proxy tools, and restarting an already-managed plugin replaces the host handle without leaving stale callable tools.
- Runtime tool execution checks cancellation tokens before executing a tool, so cancelled sessions/background jobs do not start new privileged actions.
- Agent sessions, replayable event history, and trace contexts are hydrated from and saved into the core state snapshot.

## Needed Next

### Real AI SDK Tool Binding

Core has an adapter that turns runtime tool records into AI SDK tool definitions passed to `generateText` and `streamText`, and runtime validates declared tool input/output schemas.

Still needed: provider-specific compatibility tests and a decision on whether AI SDK should only plan tool calls or also auto-execute selected low-risk tools.

### Streaming Agent Loop

The kernel has a complete-response loop and an initial streaming loop that exposes structured stream events and executes stream-planned tool calls through the runtime.

Still needed: richer usage/warning/final-message propagation from provider streams and app transport adapters. Streaming must not bypass policy or plugin execution rules.

### Approval Flow

Core can create approval requests when policy returns `ask`, route approval prompts through the communication bridge, and park/resume the exact runtime tool action that was suspended.

Pending approval expiry exists in memory. Runtime tool approvals record serializable action descriptors for restart-safe resume; non-tool custom closures remain in-memory only. Approval prompts can route through communication channels when tool context includes a channel and conversation id.

### Plugin Host Isolation

The current runtime can start worker plugins and subprocess plugins and execute manifest-declared tools through typed RPC protocols. The lifecycle manager starts hosted plugins, registers proxy tools, and stops handles. The runtime registers proxy tools from the manifest, so plugin code does not run in the core process.

Still needed for stronger untrusted execution:

- stricter OS-level subprocess confinement
- restricted host API transport
- no ambient `fs`, shell, secrets, desktop, or network access
- restart policy and crash recovery

Bun workers and subprocesses isolate plugin code from the core process. The subprocess launcher can also build macOS sandbox and container commands, but availability depends on the host OS and installed runtime. High-risk third-party plugins should use a platform sandbox, container, or remote execution profile with explicit filesystem and network restrictions.

### Manifest Schema And Validation

Core now has a first strict manifest schema in `@andy/plugin-sdk`, optional schema versioning, tool input/output schema declarations, installer compatibility checks, and AJV runtime validation.

Still needed: installer integration against real plugin packages.

### Durable State

Core has in-memory stores for tests and atomic JSON-file stores for the local daemon. The JSON stores write schema-versioned envelopes through temp-file rename so partial writes do not corrupt state.

The daemon now hydrates and saves:

- installed plugin records and lifecycle state through `@andy/plugin-manager`
- GitHub plugin checkouts under `.andy/github-plugins` for immutable commit SHA or semver release tag installs
- installed skill records through `.andy/skills.json`
- agent sessions
- approvals and restart-safe approval action descriptors
- background jobs
- audit traces
- replayable audit/event envelopes
- durable policy config from `.andy/policy.json`

JSON file storage is acceptable for the first local release. A later multi-user or marketplace host can replace these stores with SQLite or another transactional backend behind the same core store boundaries.

### Background Job Kernel

Core has initial background scheduling, cancellation ids, due-job lookup, progress events, hydration, due-job execution through runtime policy, status transitions, and a first-party background-worker plugin that stores task request/schedule/cancel records in plugin-owned storage.

Still needed:

- persist richer task state
- provider-specific long-running workflow adapters
- prevent stale elevated permissions with narrower grant scopes

The actual long-running behaviors should still be plugins.

### Event Bus

Core has an in-memory typed event bus, audit sink adapter, and bounded replay history.

Still needed: durable event streams, stronger subscriber backpressure, and app/daemon transport integration.

### Secret Broker Interface

Core has an initial secret broker contract that lets plugins request declared secret scopes without exposing raw credentials broadly. Secret references are redacted and rotation is audited.

Still needed: policy checks and app-specific backing stores.

### Model Provider Plugins

Core has an LLM runner interface and the first AI SDK OpenAI provider package. Future providers should stay as plugins or provider packages behind that interface and construct Vercel AI SDK `LanguageModel` instances.

AI SDK provider adapters now include OpenAI, Anthropic, and Google. Needed providers still include local models and routing services.

### First-Party Plugin Depth

The first-party plugin packages are now real subprocess-hosted packages with manifests and lifecycle tests. Remaining depth is provider-specific:

- WhatsApp needs platform signature validation beyond the local shared-secret ingress guard.
- Voice input needs a speech-to-text provider plugin and explicit microphone capture adapter.
- Vision needs OCR and vision-model provider integration.
- Computer control needs a richer accessibility adapter and cross-platform implementations.
- Filesystem sensitive reads need a separate `filesystem.read_sensitive` tool and policy path.
- Filesystem sensitive reads now have a separate `filesystem.read_sensitive` tool and critical capability path.
- Notifications need native desktop and remote notification adapters beyond plugin-storage delivery records.
- Swarm orchestration currently manages bounded swarm state; executing child agent sessions across the daemon remains the next provider-specific adapter.

### Capability And Policy Refinement

Core has rule-based policy with capability, plugin, user, channel, task, risk, and temporary grant matching. It still needs richer policy around:

- task-scoped temporary grants
- approval thresholds
- deny reasons
- audit correlation ids
- high-risk action classification

Policy decisions must remain explicit for external messaging, filesystem writes, shell execution, computer control, browser form submission, memory writes, secret access, and swarm spawning.

### Observability And Tracing

Core has a trace manager and trace ids are threaded through agent sessions, model requests, tool requests, policy decisions, plugin execution audits, and background jobs. It still needs full trace ids across:

- approval
- memory write

This is required for debugging, safety review, and user trust.

### Cancellation And Timeouts

Core has a cancellation token registry and timeout helper. Agent sessions can carry cancellation ids, model calls accept abort signals, and runtime tool execution refuses to start a tool when its cancellation token is already cancelled. These still need to be threaded into active plugin subprocess cancellation and swarm child agents.

No plugin or child agent should run indefinitely without an inspectable state and cancellation path.

### Plugin Installation From GitHub

Core has plugin installer and manifest fetcher interfaces with manifest validation, schema compatibility checks, source pin planning, permission summaries, and disabled-by-default local materialization.

Still needed:

- pin to commit SHA or immutable tag
- display requested permissions
- install disabled by default or enable after approval
- block upgrade permission expansion without approval

Marketplace support can be layered on later.

## What Should Not Move Into Core

The following remain plugins:

- WhatsApp and Telegram
- voice input and output
- vision and screen understanding
- computer and browser control
- shell and filesystem tools
- memory providers
- model providers
- notifications
- workflow packs and skills
  Executable behavior for workflow packs and skills must stay declarative and plugin-backed. Skill manifests may describe tool workflows, but they must not introduce arbitrary code execution outside plugin manifests, policy, and audit.
- swarm planning behavior

Core may define stable interfaces for these areas, but feature behavior belongs behind plugin manifests, policy, and audit.
