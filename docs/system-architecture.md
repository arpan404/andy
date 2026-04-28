# Andy System Architecture

This document describes how Andy is supposed to work and what is actually implemented on the current feature branch. It is intentionally explicit about boundaries and limitations.

## Product Model

Andy is a standalone TypeScript-first, Bun-built, plugin-native AI agent runtime.

The operating model is:

```text
Andy Core = trusted agent kernel + plugin runtime + policy engine + audit system
First-party plugins = system software
User-installed plugins = application software
Apps = local user surfaces over stable core protocols
```

Product capability belongs in plugins. Core should stay small and only provide the runtime primitives needed to load, secure, observe, and coordinate plugins.

## Repository Layout

```text
apps/
  cli/       command-line client
  daemon/   long-running local orchestrator and ACP server
  desktop/  local controller and desktop-hosted web console bridge
  web/      browser UI assets and development ACP bridge

packages/
  core/            trusted runtime kernel
  plugin-sdk/      plugin manifest/schema helpers
  plugin-manager/  installed-plugin registry and trust/review records
  plugin-worker/   subprocess worker protocol helper
  policy/          policy config and decision engine
  skill-sdk/       skill manifest/schema helpers
  skill-manager/   installed-skill registry
  model-ai-sdk/    Vercel AI SDK model-provider adapters
  memory/          memory provider primitives
  tool-catalog/    canonical capabilities/tool names
  vfs/             virtual/scoped filesystem primitives

plugins/
  first-party plugin packages and manifests

docs/
  architecture, security, release, and product notes
```

## High-Level Runtime Flow

```text
user/client request
  -> ACP transport
  -> daemon
  -> AgentKernel
  -> AI SDK model runner
  -> model tool calls
  -> AgentRuntime
  -> policy decision
  -> approval if required
  -> plugin subprocess execution
  -> audit/event/trace records
  -> response back through ACP/client channel
```

No agent should call filesystem, shell, browser, desktop, messaging, voice, vision, memory, secrets, or external services directly. Those actions must go through declared plugin tools.

## Apps Layer

### CLI

The CLI is an ACP client.

It does not call daemon HTTP. For daemon-backed commands, it connects to the
persistent ACP socket first and uses stdio ACP as a fallback:

```text
andy command
  -> connect ACP socket
  -> send typed JSON-RPC request
  -> read JSON-RPC response
  -> print JSON result
```

The CLI uses typed Andy ACP methods for status, config, plugin, skill, approval,
observability, voice, and agent-run operations.

### Daemon

The daemon is the local orchestrator. It owns:

- config loading
- durable state hydration/persistence
- model-provider registration
- plugin registry seeding
- skill registry seeding
- plugin lifecycle startup/shutdown
- background polling
- ACP stdio serving
- webhook ingress
- remote messaging loops

The daemon has two communication roles:

- **ACP stdio** for local clients and agent-client communication.
- **HTTP only for health and external webhook ingress**.

Daemon HTTP local admin routes are intentionally disabled. Local clients must use ACP.

### Desktop

`andy-desktop` is a controller, not a capability provider.

It can:

- start/stop the packaged daemon
- serve the static web console
- expose a local `/acp` bridge for the browser UI
- open the console in the default browser
- persist process state under `$ANDY_HOME/.andy/desktop.json`

The desktop web bridge works like this:

```text
browser UI
  -> POST /acp to desktop web server
  -> desktop process spawns andy-daemon --acp
  -> daemon handles request through ACP
  -> response returns to browser
```

The browser still uses HTTP to load static assets and post to the desktop bridge because browsers cannot speak stdio. The browser does not call daemon HTTP.

### Web

`apps/web` is a browser UI. It is not trusted infrastructure and does not implement product capability.

In release, it is served by `andy-desktop`.

In development, `apps/web/src/server.ts` also exposes `/acp` and forwards to `andy-daemon --acp` so the development web UI follows the same local-client rule.

## Client Protocol: ACP

Andy uses an ACP-style JSON-RPC-over-stdio protocol for local clients.

Daemon mode:

```bash
andy-daemon --acp
```

Implemented methods:

- `initialize`
- `session/new`
- `session/resume`
- `session/load`
- `session/list`
- `session/close`
- `session/prompt`
- `session/cancel` notification
- typed `andy.*` management methods

`session/prompt` runs the real agent kernel. Typed `andy.*` methods expose CLI/web/admin operations such as plugins, skills, events, voice turns, and agent runs without using HTTP or path-shaped local control.

## HTTP Boundary

HTTP is not the local control protocol.

HTTP remains only for:

- `GET /health`
- `POST /webhooks/telegram`
- `POST /webhooks/whatsapp`
- future external webhook ingress required by external platforms

This is necessary because Telegram, WhatsApp, and similar external systems deliver webhooks over HTTP. Removing HTTP completely would break those remote-control integrations.

## Durable Skill Tasks

Skill workflow runs are compiled into durable task graphs before execution.

```text
andy skill run
  -> typed ACP `andy.skills.run`
  -> load enabled skill manifest
  -> compile workflow steps into a task graph
  -> create durable task run
  -> execute ready steps through AgentRuntime
  -> persist task graph/run/step state
  -> return taskRunId and step outputs
```

The current executor runs ready skill steps immediately in the daemon process and
persists after each step. Approval-gated tool calls move the step into
`waiting_approval`. Broader cron/event/webhook dispatch and compensation
execution remain v2 follow-up work.

## Core Layer

`packages/core` is the trusted kernel.

It owns:

- `AgentKernel`
- `AgentRuntime`
- model runner interfaces
- plugin lifecycle manager
- subprocess plugin host
- policy/audit integration
- approval manager and approval resume
- cancellation registry
- event bus
- trace manager
- background job primitives
- session store
- durable state store
- secret broker interface and OS-backed implementation

Core should not contain product-specific behavior like browser automation, messaging app logic, filesystem operations, shell execution, voice, vision, or desktop control. Those are plugins.

## Agent Kernel

The agent kernel owns the generic model loop:

```text
session state
  -> visible tools
  -> AI SDK model runner
  -> text response or tool calls
  -> bounded parallel tool execution
  -> ordered tool result messages
  -> final response or next model step
```

Andy uses Vercel AI SDK result/message/tool-call types at the model boundary. Concrete providers live behind model-provider adapters.

Same-step tool calls are executed as bounded parallel batches, but tool results are appended in the model-requested order.

## Runtime Tool Execution

Every tool call flows through `AgentRuntime`:

```text
tool name
  -> local alias resolution or fully qualified lookup
  -> plugin enabled check
  -> JSON input schema validation
  -> policy decision
  -> approval parking if needed
  -> plugin execution
  -> JSON output schema validation
  -> audit event
```

Canonical runtime tool names are fully qualified:

```text
<pluginId>.<toolName>
```

Examples:

```text
andy.memory.markdown.memory.save
andy.filesystem.filesystem.read
andy.browser.browser.navigate
andy.codex.codex.run
```

Local aliases are allowed only when unambiguous.

## Plugin Architecture

Plugins declare:

- stable id/name/version
- entrypoint and optional binary entrypoint
- execution mode
- capabilities
- tools
- input/output schemas
- risk metadata
- filesystem/network/secret permissions
- sensitive read roots where needed
- bundled skills where included

Release plugins run as subprocess workers through a JSON-line protocol. The host prefers compiled plugin binaries and falls back to Bun source entrypoints only in development.

Current default execution isolation is a subprocess boundary, not a true OS sandbox.

## First-Party Plugins

Current first-party plugin set on this branch:

- `andy.memory.markdown`
- `andy.filesystem`
- `andy.shell`
- `andy.messaging.telegram`
- `andy.messaging.whatsapp`
- `andy.voice.input`
- `andy.voice.output`
- `andy.vision`
- `andy.browser`
- `andy.codex`
- `andy.computer-control`
- `andy.background-worker`
- `andy.notifications`
- `andy.swarm-orchestrator`
- `andy.memory.persistent`
- `andy.memory.semantic`
- `andy.project`

Depth varies:

- More complete: memory markdown, filesystem, shell, project, browser CDP, plugin lifecycle, policy, audit, registry.
- Adapter-level: computer control, vision screenshot/multimodal image handoff, voice output, notifications.
- Incomplete: real audio STT, OCR, accessibility tree control, marketplace UX, native tray app, signed native installers.

## Skills Architecture

Skills are declarative workflows and instruction packs over plugin tools.

They do not define executable tools.

```text
plugin = executable capability provider
skill = declarative workflow/instruction pack using plugin tools
core = validates, runs, audits, and policy-checks both
```

Skills may be global or plugin-bundled. Plugin-bundled skills are owned by the plugin lifecycle. If the owning plugin is disabled or removed, the skill cannot be used.

Skill workflows can currently express:

- ordered steps
- `when`
- `forEach`
- `continueOnError`
- `saveAs`
- input/output schemas
- templated tool inputs

All skill tool calls still go through normal runtime policy and audit.

## Model Providers

Model calls use Vercel AI SDK through `@andy/model-ai-sdk`.

Current provider adapters:

- OpenAI via `@ai-sdk/openai`
- Anthropic via `@ai-sdk/anthropic`
- Google via `@ai-sdk/google`

Model provider config stores environment variable names, not raw API keys.

Codex is not treated as an AI SDK model provider. It is a first-party plugin that delegates coding tasks to the locally authenticated Codex SDK/CLI/App Server flow.

## Codex Integration

`andy.codex` exposes:

```text
andy.codex.codex.run
```

It uses `@openai/codex-sdk` and the locally authenticated Codex environment. It does not convert a ChatGPT/Codex subscription into an OpenAI API key.

Security status:

- disabled by default
- `critical` risk
- approval-required capabilities: `codex.run`, `codex.thread`
- may inspect/edit/run code in the configured workspace because Codex is a nested coding agent

## Policy And Approvals

Policy decides:

- allow
- deny
- ask for approval

Policy inputs include:

- plugin id
- capability
- risk level
- channel id
- user/task context
- configured grants
- denied plugins
- approval-required channels/capabilities/risks

Approval-gated actions are parked. Approval resume later runs the exact parked action if approved, or clears it if denied.

## Audit, Events, And Traces

Andy records operational history through:

- audit sink
- event bus
- trace manager
- durable state snapshots

CLI and web console observability use typed ACP methods:

- `andy.events.query`
- `andy.logs.query`
- `andy.traces.query`

Observability is read-only and must not expose raw secret values.

## Storage

Current storage is atomic schema-versioned JSON files under `$ANDY_HOME/.andy`.

Examples:

```text
.andy/daemon.json
.andy/state.json
.andy/plugins.json
.andy/skills.json
.andy/policy.json
.andy/secrets.json
```

This is acceptable for local-first development, but not a production indexed store. SQLite or another transactional store is still a future hardening item.

## Secrets

The daemon wires an OS-backed secret broker:

- macOS Keychain through `security`
- Linux Secret Service through `secret-tool`
- Windows Credential Manager through PowerShell/Win32 APIs

If native storage is unavailable, Andy falls back to encoded `.andy/secrets.json` records. That fallback is not equivalent to a secure keychain.

Plugins can request only declared secret scopes.

## Release Packaging

`bun run build:release` produces:

```text
dist/release/andy-<version>-<platform>-<arch>/
  bin/andy
  bin/andy-daemon
  bin/andy-desktop
  web/
  plugins/
  skills/
  release.json

dist/installers/
  andy-<version>-<platform>-<arch>.tar.gz
  andy-<version>-<platform>-<arch>.tar.gz.sha256
```

The release bundle includes compiled plugin binaries so users do not need Bun for first-party plugin execution.

## Security Reality

Implemented security boundaries:

- manifest-declared capabilities
- JSON schema validation
- policy decisions per tool call
- approval parking/resume
- audit/events/traces
- disabled-plugin execution blocking
- subprocess plugin host
- plugin storage roots
- scoped filesystem plugin behavior
- secret broker scope checks
- plugin signature/trust records

Not yet hardened:

- no true OS sandbox for plugin subprocesses
- no enforced OS-level network allowlist
- no kernel-level filesystem syscall interception
- no production marketplace trust UX
- no full native installer signing/notarization
- no production multi-user auth boundary

The honest current security model is policy-gated subprocess execution, not hardened hostile-code containment.

## Current Architecture Summary

```text
Local CLI
  -> ACP stdio
  -> daemon
  -> core runtime
  -> plugins

Desktop web console
  -> browser HTTP to desktop bridge
  -> ACP stdio
  -> daemon
  -> core runtime
  -> plugins

External messaging platform
  -> HTTP webhook
  -> channel plugin
  -> communication bridge
  -> agent kernel
  -> core runtime
  -> plugins

Agent tool call
  -> AgentRuntime
  -> policy/approval/audit
  -> subprocess plugin
```

This is the target direction and current branch reality: ACP-first for local clients, plugin-native for product capability, HTTP only where external systems require it, and subprocess/policy boundaries until stronger sandboxing is implemented.
