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

## Effect TS

- Use Effect TS for runtime code.
- Async, fallible, filesystem, network, plugin, memory, audit, and tool execution APIs should return `Effect.Effect`, not raw `Promise`.
- Run effects only at application boundaries such as CLI entrypoints, tests, and future HTTP/webhook handlers.
- Prefer `Effect.gen`, `Effect.fn`, typed errors, services/layers for business logic, and structured Effect logging.
- Do not introduce new ad hoc async/throw/catch flows when an Effect error channel can model the failure.
- Keep `@effect/language-service` configured in TypeScript.

## Product Direction

Andy should feel like a secure, extensible Jarvis-style agent system: voice-aware, vision-aware, computer-controlling, background-capable, externally connected, observable, and powerful enough to control local and external systems through explicit permissions.

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
- background jobs and schedulers
- multi-agent swarm orchestration
- notifications
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

First-class agent capability requirements:

- vision plugin for image, screenshot, OCR, and screen understanding
- computer-control plugin for mouse, keyboard, window, app, and accessibility-tree control
- voice-input plugin for microphone capture, wake/activation modes, and speech-to-text
- voice-output plugin for text-to-speech and interruption-aware responses
- background-worker plugin for long-running tasks, scheduled jobs, retries, and resumable work
- notification plugin for local and remote alerts, approval prompts, and task completion updates
- swarm-orchestrator plugin for spawning, delegating to, joining, and cancelling multiple bounded agents when useful
- markdown-memory, persistent-memory, and semantic-memory plugins for saving, fetching, querying, and forgetting long-term memory

These capabilities must be composable. For example, a remote WhatsApp message can start a background task, the background task can use browser/computer-control plugins, a vision plugin can inspect a screenshot, and a notification plugin can ask the user for approval before an external action.

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
- source provenance when installed from GitHub or marketplace
- network, filesystem, secret, and external-service permissions when needed
- sensitive filesystem roots with reason and data classes when reading OS-level, app-level, or private user data
- memory scopes, namespaces, retention behavior, and semantic-search support when storing or retrieving memory

Capabilities should be granular, for example:

- `filesystem.read`
- `filesystem.read_sensitive`
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
- `memory.fetch`
- `memory.save`
- `memory.query`
- `memory.semantic_query`
- `memory.embed`
- `memory.forget`
- `memory.list`
- `microphone.read`
- `speaker.speak`
- `camera.read`
- `screen.capture`
- `screen.ocr`
- `screen.describe`
- `computer.mouse`
- `computer.keyboard`
- `computer.window`
- `computer.app`
- `computer.accessibility_tree`
- `voice.listen`
- `voice.transcribe`
- `voice.speak`
- `background.run`
- `background.schedule`
- `background.cancel`
- `swarm.plan`
- `swarm.spawn`
- `swarm.delegate`
- `swarm.join`
- `swarm.cancel`
- `notification.send`
- `notification.approval_request`
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

## Plugin Installation And Trust

Users must be able to install plugins easily from GitHub in the first release. Later, Andy should support a marketplace with signing, reviews, version pinning, and reputation metadata.

Plugin sources:

- local development plugin
- GitHub repository URL with explicit ref or version
- marketplace package later

All non-core plugins are untrusted by default, including plugins installed from GitHub and future marketplace plugins. First-party plugins should still follow the same manifest and capability rules.

Plugin install requirements:

- Fetch plugin metadata before execution.
- Show requested capabilities, permissions, risk level, source, version/ref, and entrypoint before enabling.
- Pin GitHub installs to a commit SHA or immutable release tag where possible.
- Store installed plugin manifests locally.
- Allow disabling, upgrading, removing, and permission-reviewing plugins.
- Do not auto-enable new capabilities during plugin upgrade without user approval.
- Do not run install scripts with ambient host privileges.

Secure execution requirements:

- A plugin must not do anything outside its manifest.
- A plugin tool must not request capabilities the plugin manifest did not declare.
- The runtime must reject undeclared tool capabilities at registration time.
- Tool calls must be checked against policy every time, not only at install time.
- Untrusted plugins should run out-of-process or in a stronger sandbox once the host exists.
- Plugin execution context should expose only approved host APIs, not raw unrestricted `fs`, shell, network, secrets, or desktop control.
- Network access must be host allowlisted by manifest and policy.
- Filesystem access must use scoped roots or virtual scratch files.
- Sensitive filesystem reads must use `filesystem.read_sensitive` and explicitly declare `permissions.filesystem.sensitiveReadRoots`.
- Secrets must come from the secret broker and only for declared secret scopes.
- Audit plugin install, enable, disable, upgrade, permission change, tool request, policy decision, and execution result.

Sandbox levels:

- `metadata`: manifest only, no code execution
- `trusted-in-process`: first-party development only
- `subprocess`: default target for installed plugins
- `worker`: isolated JS worker with restricted host APIs
- `container`: stronger isolation for high-risk or third-party plugins later
- `remote`: isolated remote worker later

Prefer the least powerful execution level that can support the plugin's declared capabilities.

Vision, voice, computer-control, and background rules:

- Vision plugins may read images, screenshots, camera frames, and OCR output only through declared capabilities.
- Computer-control plugins are high-risk. Mouse, keyboard, app control, browser form submission, and OS automation must be policy-gated and audited.
- Voice-input plugins must support explicit activation modes. Always-listening behavior requires clear configuration and auditability.
- Voice-output plugins must support interruption/cancel semantics so the user can stop speech or background responses.
- Background-worker plugins must persist task state, support cancellation, and record audit events for every resumed action.
- Long-running background jobs must not hold elevated permissions indefinitely. Re-check policy before each tool action.
- Notifications and approval prompts are plugins, but approval decisions must be recorded by core audit/policy interfaces.

Swarm orchestration rules:

- Multi-agent swarms must be implemented through a plugin such as `andy.swarm-orchestrator`, not hardcoded into core.
- Swarm plugins must declare maximum agent count, maximum delegation depth, allowed agent roles, and allowed capabilities.
- Spawning additional agents is a policy-relevant action and must be audited.
- Swarm agents inherit only the capabilities explicitly granted by the swarm plugin and policy decision.
- Swarm agents must not gain broader filesystem, shell, network, messaging, computer-control, or secret access than the parent task.
- Swarm plugins must support cancellation and join/summary behavior so background child agents do not run indefinitely.
- User approval is required when a swarm exceeds the plugin's configured approval threshold or requests high-risk capabilities.

Memory plugin rules:

- Memory is a plugin-provided capability, not hardcoded product behavior.
- Prefer Markdown-backed memory files as the default persistent memory format so the user and agent can inspect, edit, diff, and review memory directly.
- The agent must be able to manage its own memory through memory plugins: save, fetch, query, list, and forget.
- Persistent memory plugins must declare supported scopes, namespaces, retention behavior, and whether semantic search is enabled.
- Supported memory scopes are `user`, `project`, `session`, `agent`, and `plugin`.
- Saving user-scope memory is policy-relevant and should require approval unless explicitly preauthorized.
- Plugins must support fetching, querying, saving, and forgetting memory through declared capabilities.
- Semantic/vector memory should be treated as an index over inspectable memory, not the only source of truth.
- Untrusted content must not directly write trusted memory. Store it as `untrusted` or require review before promoting it.
- Users must be able to inspect and delete persistent memories.
- Memory providers must preserve provenance: source plugin, source tool, timestamp, trust level, and scope.

## LLM Backend

- Use a replaceable TypeScript model-provider layer, not a heavyweight agent framework as the core.
- Prefer the Vercel AI SDK for provider-agnostic LLM calls, streaming, and tool-call normalization.
- Keep OpenAI, Anthropic, Google, local models, and future providers behind model plugins or adapters.
- Andy owns the agent runtime, plugin/security model, memory, approvals, and audit behavior.

## Security Requirements

- No tool runs without declared capabilities.
- No plugin receives blanket filesystem, shell, network, secret, or desktop access.
- Plugins that need OS-level folders, other app folders, browser profiles, message stores, credentials, or other private user data must explicitly declare those sensitive roots in the manifest. The runner must block access when the manifest does not declare the sensitive root.
- Treat all installed plugins as untrusted unless explicitly marked first-party and reviewed.
- Manifest declarations are upper bounds, not automatic permission grants.
- Risky or irreversible actions require explicit approval unless narrowly preauthorized.
- Untrusted content from browsers, files, emails, and external systems must not rewrite identity, policy, permissions, or trusted memory.
- Audit every tool request, policy decision, approval, plugin execution, and result.
- Keep secrets behind a broker interface; do not expose raw credentials to model text unless unavoidable and approved.
- Prefer scoped roots, allowlists, and structured APIs over broad shell access.

## Virtual Filesystem

- Use `@andy/vfs` for agent scratch files and scoped real filesystem access.
- Temporary agent artifacts should go into the in-memory scratch filesystem by default.
- Real filesystem access must use scoped roots and policy-gated capabilities.
- Sensitive filesystem access must use explicit sensitive root declarations with a reason and data classes. It is never covered by broad `filesystem.read`.
- Plugins should receive filesystem access through runtime context or explicit filesystem plugins, not by importing host `fs` directly for user data.
- Treat commits from virtual scratch space to real disk as policy-relevant writes.

## Validation

Before marking work complete, run the relevant validation for the changed code.
For code changes, run lint, format check, typecheck, and tests:

```bash
bun install
bun run lint
bun run fmt:check
bun run typecheck
bun run test
```

For scaffold or packaging changes, also run:

```bash
bun run build
bun run check
bun run andy
```
