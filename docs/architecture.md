# Andy Architecture

Andy is a TypeScript-first, plugin-native AI agent runtime.

Every product feature must be delivered as a plugin or as an app surface calling stable core APIs. Core exists to run, secure, observe, and coordinate plugins.

## Kernel

The core runtime owns the minimal trusted path:

- agent sessions
- plugin registration
- capability registry
- policy decisions
- tool execution wrapping
- audit events
- memory and model interfaces

Everything with operational power should live behind a plugin boundary.

Core must not grow channel-specific features. WhatsApp, Telegram, voice, vision, computer control, background workers, swarm orchestration, notifications, filesystem access, shell access, browser control, memory providers, and model providers are plugins.

## Execution Flow

```text
user goal
  -> planner
  -> tool request
  -> capability policy
  -> approval or denial
  -> plugin execution
  -> audit event
  -> memory update
```

## Plugin Contract

Plugins declare:

- identity: `id`, `name`, `version`
- capabilities
- tools
- risk level per tool
- typed input and output schemas in later iterations

The runtime never calls undeclared capabilities directly.

## Tool Identity

Plugins can expose convenient local tool names like `memory.save`, `filesystem.read`, or `telegram.listen`, but core registers every tool under a fully qualified name:

```text
<pluginId>.<toolName>
```

Examples:

- `andy.memory.markdown.memory.save`
- `andy.filesystem.filesystem.read`
- `andy.messaging.telegram.telegram.listen`

Local names are aliases only when exactly one installed plugin provides that name. If two plugins both expose `memory.save`, the alias is ambiguous and the runner must require a fully qualified name.

Canonical names should live in `@andy/tool-catalog` so first-party and third-party plugins can share stable capabilities and tool names.

## Plugin Installation And Sandboxing

Users must be able to install plugins from GitHub in the first release. Marketplace support can come later, but the install model should already support source provenance, version pinning, capability review, and future signing.

```text
plugin source
  -> fetch manifest
  -> validate schema
  -> review capabilities and permissions
  -> pin source ref
  -> install package
  -> disabled by default or enabled with approval
  -> execute through sandboxed plugin host
```

All installed plugins are untrusted by default. A manifest is not a grant of permission; it is the maximum capability envelope the plugin is allowed to request. The policy engine still decides whether a specific action is allowed, denied, or requires approval.

Manifest-bound execution rules:

- Plugin tools cannot request capabilities outside the plugin manifest.
- Runtime rejects undeclared capabilities during plugin registration.
- Plugin context exposes only approved host APIs.
- Filesystem access goes through `@andy/vfs` or scoped filesystem plugins.
- Sensitive filesystem access requires explicit `permissions.filesystem.sensitiveReadRoots` declarations and must be blocked by the runner when undeclared.
- Network access must be allowlisted.
- Secrets come only from a secret broker.
- Plugin upgrades cannot silently gain new capabilities.
- Every install, enable, upgrade, permission change, and tool call is audited.

Sandbox levels:

- `metadata`: manifest inspection only
- `trusted-in-process`: first-party development only
- `subprocess`: default installed-plugin target
- `worker`: restricted JS worker
- `container`: stronger high-risk isolation later
- `remote`: isolated remote execution later

GitHub installs should pin to a commit SHA or immutable release tag. Marketplace installs should later add signing, review metadata, reputation, and automated security scans.

## Messaging

Andy must be reachable from anywhere through messaging apps. The first release requires WhatsApp and Telegram as first-party plugins.

Messaging is a remote-control surface, so channel integrations are high-risk plugins. They must verify inbound webhooks or polling tokens, normalize incoming messages into a shared messaging interface, map platform identities to Andy identities, and policy-check all outbound replies.

```text
WhatsApp / Telegram
  -> channel plugin
  -> messaging gateway normalization
  -> sender and channel policy
  -> agent session
  -> tool/plugin execution
  -> outbound policy
  -> channel plugin response
  -> audit trail
```

The shared messaging layer should define common concepts such as channel, conversation, participant, message, attachment, delivery status, and reply target. Platform-specific metadata must be preserved for debugging and audit.

First-party messaging plugins:

- `andy.messaging.whatsapp`
- `andy.messaging.telegram`

Use official platform APIs for first-party plugins. Do not use unofficial WhatsApp automation or browser-session scraping for first release.

## Multimodal Control

Andy must support vision, computer control, voice input/output, and background execution as first-class product capabilities. They remain plugins, not core features.

Required first-class plugins:

- `andy.vision`
- `andy.computer-control`
- `andy.voice.input`
- `andy.voice.output`
- `andy.background-worker`
- `andy.swarm-orchestrator`
- `andy.notifications`

These plugins should compose through the agent runtime:

```text
voice / message / UI input
  -> agent session
  -> planner
  -> vision or screen inspection
  -> computer/browser/system action
  -> background continuation if needed
  -> notification or voice/message response
```

Computer control is high risk because it can act on behalf of the user across apps. Mouse, keyboard, window control, app launching, screen capture, and accessibility-tree access must be capability-scoped, policy-checked, and audited.

Background work is also high risk because time separates user intent from execution. Background jobs must persist task state, support cancellation, re-check policy before each tool action, and surface approval requests through notification or messaging plugins.

## Swarm Orchestration

Andy must be able to use multiple agents when a task benefits from decomposition, parallel research, coding/review separation, or long-running background work. This must be plugin-based.

```text
user task
  -> agent session
  -> swarm plugin plans delegation
  -> policy approves spawn/delegate
  -> child agents run with bounded capabilities
  -> swarm plugin joins results
  -> parent agent responds or continues
```

Swarm plugins must declare:

- maximum agent count
- maximum delegation depth
- allowed roles
- allowed capabilities
- approval thresholds

Child agents must not receive ambient access to host tools. They get only the capabilities approved for their subtask, and each child tool call still goes through policy and audit.

## Memory

Andy must support strong long-term memory through plugins. Core defines memory interfaces and policy/audit behavior; memory storage, retrieval, embedding, semantic search, and persistence are plugin capabilities.

Required first-party memory plugins:

- `andy.memory.markdown`
- `andy.memory.persistent`
- `andy.memory.semantic`

Memory capabilities:

- `memory.fetch`
- `memory.save`
- `memory.query`
- `memory.semantic_query`
- `memory.embed`
- `memory.forget`
- `memory.list`

Markdown-backed memory is the preferred persistent memory provider. The agent should manage memory in `.md` files so memory is inspectable, editable, diffable, and reviewable by the user. Semantic/vector memory can be added as an index, but Markdown should remain the source of truth unless a user chooses another provider.

Memory records must preserve scope, namespace, key, value, tags, trust level, source, creation time, update time, and optional expiration. User-scope persistent memory is sensitive and should require approval unless narrowly preauthorized.

Untrusted external content must not directly become trusted long-term memory. Memory plugins should store provenance and trust level so the agent can distinguish user-approved facts from derived or untrusted observations.

## Virtual Filesystem

Andy uses `@andy/vfs` as its filesystem boundary. Agent scratch space should default to an in-memory virtual filesystem so planning artifacts, temporary files, intermediate tool outputs, and generated patches can be fast and isolated from the user's real disk.

The initial implementation uses `memfs` for the in-memory backend because it implements a Node-style filesystem API, is maintained, and is TypeScript-oriented. Real disk access remains available through a scoped `RealFileSystem` adapter and must be policy-gated before plugins can use it.

Filesystem rules:

- Use virtual scratch files for temporary agent work.
- Use real filesystem access only through scoped roots.
- Never expose raw host paths to plugins unless the policy layer has allowed that root.
- Treat virtual-to-real commits as high-impact operations when they overwrite, delete, or move user files.

## First-Party Plugin Targets

- filesystem
- shell
- memory-sqlite
- browser
- desktop-control
- voice
- vision
- external services

High-risk plugins must pass through policy gates and approval flows before execution.
