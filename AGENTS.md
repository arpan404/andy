# AGENTS.md

Andy is a standalone TypeScript-first, Bun-only, plugin-native AI agent runtime. It is not an AFK/Python project.

Every product feature must be implemented as a plugin or as a minimal core interface that enables plugins. Do not add feature-specific behavior directly to core unless it is necessary for the plugin runtime, policy engine, audit system, memory/model interfaces, or execution kernel.

## Repository Shape

- Active project code lives in `apps/`, `packages/`, `plugins/`, and `docs/`.
- `apps/` contains user-facing entrypoints such as CLI, daemon, desktop, and web UI.
- `packages/` contains the trusted Andy runtime libraries.
- `plugins/` contains first-party plugins and plugin manifests.
- `docs/` contains architecture and product planning notes.
- `.references/` is ignored and may be used only for disposable reference material. Do not import runtime code from it.

## Package Management

- Use `bun` strictly for dependency management and project commands.
- Add dependencies with `bun add` or `bun add -d`.
- Do not introduce pnpm, npm, yarn, uv, pip, Python virtualenvs, or Python package-management workflows.
- Keep workspaces declared in the root `package.json`.
- Prefer TypeScript for runtime, tools, plugins, tests, and scripts.

## Product Direction

Andy should feel like a secure, extensible Jarvis-style agent system: voice-aware, vision-aware, system-capable, externally connected, observable, and powerful enough to control local and external systems through explicit permissions.

The core design principle is:

```text
Andy Core = secure agent kernel + plugin runtime + policy engine
Everything else = plugin
```

This is a hard architectural rule. Voice is a plugin. Vision is a plugin. Messaging apps are plugins. Filesystem access is a plugin. Shell/system control is a plugin. Browser automation is a plugin. External SaaS integrations are plugins. Memory providers are plugins. Model providers are plugins. UI surfaces should integrate through stable core APIs and may have their own app packages, but channel-specific behavior still belongs in plugins.

The agent should be powerful, but never ambiently privileged. All system control must flow through declared plugin capabilities, policy decisions, audit events, and approval gates where appropriate.

## Architecture

The trusted core should stay small:

- agent sessions and task lifecycle
- model routing and LLM call abstraction
- plugin discovery and registration
- capability registry
- tool execution wrapper
- policy decisions: allow, deny, ask, sandbox later
- approval flow
- audit and trace events
- memory interfaces
- event bus
- configuration and secret-broker interfaces

Operational power belongs in plugins:

- filesystem
- shell
- browser control
- desktop/system control
- voice input and output
- vision and screen understanding
- email, calendar, messaging, GitHub, and other external services
- memory providers
- model providers
- workflow packs and skills

First-release external messaging requirements:

- WhatsApp plugin
- Telegram plugin
- shared messaging gateway interface
- inbound webhook handling
- outbound message sending
- identity/contact mapping
- conversation state handoff to the agent runtime
- per-channel policy gates for sending messages as the user/agent

The user must be able to communicate with Andy from anywhere through supported messaging apps. Messaging channels are remote control surfaces and must be treated as security-sensitive plugins, not trusted local UI.

## Execution Flow

```text
user goal
  -> agent planner
  -> requested tool/capability
  -> policy decision
  -> approval if required
  -> plugin execution
  -> watcher/verification later
  -> audit event
  -> memory update
```

Do not let the agent call undeclared capabilities directly.

Remote messaging flow:

```text
messaging webhook or poller
  -> channel plugin verifies source and parses update
  -> messaging gateway normalizes message
  -> policy checks sender, channel, and requested action
  -> agent session receives message
  -> agent requests tools/plugins as needed
  -> policy approves outbound reply
  -> channel plugin sends response
  -> audit records inbound and outbound events
```

## Plugin Rules

Every plugin must declare:

- stable plugin id, name, and version
- entrypoint
- capabilities
- tools
- risk metadata
- typed inputs and outputs

Capabilities should be granular, for example:

- `filesystem.read`
- `filesystem.write`
- `filesystem.delete`
- `shell.execute`
- `browser.navigate`
- `browser.submit_form`
- `desktop.click`
- `desktop.type`
- `email.read`
- `email.send`
- `calendar.read`
- `calendar.write`
- `memory.read`
- `memory.write`
- `microphone.read`
- `speaker.speak`
- `camera.read`
- `messaging.receive`
- `messaging.send`
- `messaging.manage_webhook`
- `messaging.read_contact`
- `messaging.map_identity`

High-risk plugins such as shell, filesystem writes/deletes, browser form submission, desktop typing, secrets, and external communication must be policy-gated.

Messaging plugin rules:

- WhatsApp and Telegram are required first-release plugins.
- Each messaging app integration must live in its own plugin package.
- Shared abstractions belong in a generic messaging package/plugin interface, not in app-specific core logic.
- Inbound webhooks must verify platform signatures, tokens, or shared secrets where the platform supports them.
- Outbound messages must pass policy checks because they communicate externally as Andy or the user.
- Plugins must normalize inbound messages into a shared shape before handing them to the agent.
- Plugins must preserve platform-specific metadata for audit and debugging.
- Plugins must support disabling outbound actions while keeping inbound read-only mode.
- Secrets such as bot tokens, webhook secrets, app secrets, and access tokens must come from the secret broker interface.
- Do not use unofficial or terms-violating messaging APIs for first-party plugins.

## LLM Backend

- Use a replaceable TypeScript model-provider layer, not a heavyweight agent framework as the core.
- Prefer the Vercel AI SDK for provider-agnostic LLM calls, streaming, and tool-call normalization.
- Keep OpenAI, Anthropic, Google, local models, and future providers behind model plugins or adapters.
- Andy owns the agent runtime, plugin/security model, memory, approvals, and audit behavior.

## Security Requirements

- No tool runs without declared capabilities.
- No plugin receives blanket filesystem, shell, network, secret, or desktop access.
- Risky or irreversible actions require explicit approval unless narrowly preauthorized.
- Untrusted content from browsers, files, emails, and external systems must not rewrite identity, policy, permissions, or trusted memory.
- Audit every tool request, policy decision, approval, plugin execution, and result.
- Keep secrets behind a broker interface; do not expose raw credentials to model text unless unavoidable and approved.
- Prefer scoped roots, allowlists, and structured APIs over broad shell access.

## Virtual Filesystem

- Use `@andy/vfs` for agent scratch files and scoped real filesystem access.
- Temporary agent artifacts should go into the in-memory scratch filesystem by default.
- Real filesystem access must use scoped roots and policy-gated capabilities.
- Plugins should receive filesystem access through runtime context or explicit filesystem plugins, not by importing host `fs` directly for user data.
- Treat commits from virtual scratch space to real disk as policy-relevant writes.

## Validation

Run the narrowest useful checks for each change. For current scaffold work, prefer:

```bash
bun install
bun run build
bun run check
bun run test
bun run andy
```
