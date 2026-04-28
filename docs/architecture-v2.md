# Andy Architecture V2

This is the proposed scalable architecture for Andy. It deliberately replaces parts of the current prototype shape instead of polishing around them.

## Why Rethink

The current architecture proves the product direction, but several choices do not scale:

- CLI and web ACP bridges now prefer a persistent daemon ACP socket, but still retain one-shot `andy-daemon --acp` fallback.
- Local admin operations are encoded as path-like `andy/request` calls instead of typed protocol methods.
- JSON-file persistence is acceptable for local development, but not for growing sessions, events, jobs, approvals, and plugin metadata.
- The daemon mixes kernel boot, transport serving, webhook ingress, background polling, plugin lifecycle, config mutation, and app-facing APIs in one large app boundary.
- Browser UI still needs an HTTP-hosted bridge because browsers cannot speak stdio.
- Plugin subprocess isolation is policy-gated but not a real sandbox.
- Model providers are packages/adapters, not fully plugin-managed providers.

The v2 architecture should keep the correct principles:

- plugin-native product capability
- ACP-first local client protocol
- explicit policy and audit on every privileged action
- small trusted kernel
- first-party plugins as system software

But it should change process topology, protocol design, storage, and host isolation.

## Target Shape

```text
Local clients
  CLI / Desktop / IDE / Web bridge
    -> ACP transport
      -> Andy Runtime Daemon
        -> Kernel services
        -> Plugin supervisor
        -> Policy + approval engine
        -> Event store
        -> Model provider registry
        -> Tool execution
          -> Plugin hosts

External platforms
  Telegram / WhatsApp / GitHub / Slack webhooks
    -> Ingress plugin host
      -> verified normalized message/event
        -> Kernel communication bus
```

The daemon becomes a long-lived runtime service. Clients connect to it instead of spawning a new daemon per operation.

## Process Topology

### Runtime Daemon

One long-lived `andy-daemon` process owns the local runtime:

- load config
- open database
- start enabled plugin hosts
- open ACP listener
- run background scheduler
- supervise plugin processes
- persist audit/events/traces/jobs/sessions
- manage approvals
- route tool execution

It should not be restarted for each CLI/web request.

### ACP Listener

ACP should be a daemon transport, not only a one-shot stdio mode.

Supported local transports:

- `stdio` for IDE/app-server style embedding
- Unix domain socket on macOS/Linux
- named pipe on Windows

Recommended default:

```text
$ANDY_HOME/.andy/andy.sock
```

CLI connects to the socket first. If no daemon is running, CLI can either:

- fail with a clear message
- start the daemon through `andy-desktop`/launch service
- use an explicit `--oneshot` mode for development only

### Desktop App

The desktop app becomes the process manager and local UI shell:

- starts/stops daemon
- watches daemon health
- opens native or browser UI
- bridges browser UI to daemon ACP over socket/pipe
- shows approval badges and status

The desktop app must not implement product capabilities directly.

### Web UI

The web UI is just a frontend.

It cannot speak stdio or Unix sockets directly, so it must run behind a local desktop bridge:

```text
browser
  -> local desktop bridge
  -> ACP socket/pipe
  -> daemon
```

The browser should never call the daemon HTTP API.

### External Ingress

HTTP is allowed only for external ingress where the outside platform requires it.

Ingress should move into plugin-owned listeners where practical:

```text
telegram plugin
  -> owns Telegram webhook verification route
  -> normalizes update
  -> publishes communication event
```

The core daemon may provide a generic ingress host capability, but platform-specific verification and parsing belong in plugins.

## Protocol Design

ACP should be the primary local control protocol.

Current generic path-based method:

```text
andy/request { method, path, query, body }
```

This is acceptable as a compatibility bridge, but v2 should replace it with typed ACP methods:

```text
andy.status
andy.config.get
andy.config.updateModelProvider
andy.plugins.list
andy.plugins.reviewLocal
andy.plugins.installLocal
andy.plugins.installGithub
andy.plugins.enable
andy.plugins.disable
andy.plugins.remove
andy.skills.list
andy.skills.run
andy.approvals.list
andy.approvals.decide
andy.events.query
andy.traces.query
andy.voice.turn
andy.voice.stop
andy.agent.run
```

Benefits:

- typed request/response schemas
- easier compatibility versioning
- better client SDK generation
- no fake HTTP semantics inside ACP
- clearer audit naming

## Kernel Services

The kernel should be split into explicit services:

```text
SessionService
AgentKernelService
ToolRuntimeService
PluginRegistryService
PluginSupervisorService
SkillRegistryService
PolicyService
ApprovalService
AuditService
EventStoreService
TraceService
BackgroundJobService
ModelProviderService
SecretBrokerService
IngressService
ConfigService
```

Each service should expose Effect-based APIs.

App entrypoints are allowed to run effects. Business logic should return `Effect`.

## Storage V2

Replace atomic JSON as the main store with SQLite.

Suggested tables:

```text
plugins
plugin_versions
plugin_trust
plugin_capabilities
skills
skill_versions
sessions
session_messages
approvals
approval_actions
events
traces
background_jobs
memories_index
policy_rules
grants
config_entries
secret_metadata
```

Keep Markdown memory as inspectable user memory where appropriate, but use SQLite for runtime metadata and query-heavy records.

Requirements:

- migrations
- schema versioning
- transactional writes
- indexed event/session queries
- cleanup/retention policies
- export/import support

## Plugin Runtime V2

Plugins remain product capability providers.

Plugin execution tiers:

```text
metadata       inspect manifest only
subprocess     default first-party and local dev tier
worker         restricted JS worker tier
sandbox        OS sandbox profile
container      stronger third-party isolation
remote         hosted/remote plugin worker
```

The current subprocess host is not enough for untrusted plugins. V2 should introduce a real sandbox boundary.

Needed hardening:

- OS-level filesystem constraints
- OS-level network constraints
- process resource limits
- plugin-specific env minimization
- durable crash/restart policy
- per-tool timeout budgets
- structured plugin logs
- signed plugin bundles
- marketplace trust metadata

## Tool Execution V2

Tool execution must stay fully qualified and policy-gated:

```text
agent/tool request
  -> resolve fully qualified tool
  -> validate JSON input
  -> check plugin enabled
  -> check manifest capability
  -> policy decision
  -> approval if needed
  -> execute plugin tool
  -> validate JSON output
  -> write audit/event/trace
```

Same-step tool calls should remain bounded parallel batches.

Tool calls should carry:

- session id
- trace id
- parent tool call id
- plugin id
- capability
- risk
- channel id
- user id
- cancellation token
- timeout budget

## Model Providers V2

Model providers should become provider plugins or provider packages with plugin-like lifecycle:

```text
andy.model.openai
andy.model.anthropic
andy.model.google
andy.model.local
andy.model.codex
```

Core owns the model-provider interface, not concrete provider behavior.

Vercel AI SDK remains the model runner type boundary.

Codex remains different:

- it is not an API-key model provider
- it delegates coding work to locally authenticated Codex SDK/CLI/App Server
- it should stay high-risk and approval-gated

## Skills V2

Skills remain declarative.

They should not define executable tools.

V2 improvements:

- typed workflow schemas
- reusable workflow composition
- typed outputs/contracts
- richer conditionals
- policy annotations per step
- skill context selection by agent planner
- explicit skill provenance
- bundled skill upgrade diffs

Plugin-bundled skills remain plugin-owned.

## Messaging And Remote Control

Remote messaging should be plugin-owned:

```text
Telegram plugin
  -> verify webhook/poll
  -> normalize message
  -> publish communication event
  -> send response through Telegram API
```

Messaging is high risk because it controls Andy remotely.

Required controls:

- sender allowlists
- channel-specific policy
- outbound send approval when needed
- identity mapping
- webhook signature verification
- audit inbound/outbound events

HTTP is acceptable here because the external platform requires it.

## Voice, Vision, Computer Control

These remain plugins.

V2 direction:

- voice input: real STT provider plugin
- voice output: interruptible TTS with platform adapters
- vision: multimodal model image input plus optional OCR plugin
- computer control: cross-platform mouse/keyboard/window adapters plus accessibility-tree plugin
- browser automation: CDP plugin with stronger origin/form-submission policy

All local control is high-risk and approval-gated by default.

## Observability V2

Observability should be backed by the event store.

Views:

- event timeline
- trace tree
- tool-call history
- approval history
- plugin lifecycle history
- background job history
- remote message history
- secret access metadata

Queries should be ACP methods, not HTTP endpoints.

## Security Model V2

Target guarantees:

- no undeclared capability execution
- no disabled plugin execution
- no secret access outside declared scopes
- no sensitive filesystem reads without sensitive root declarations
- no plugin upgrade silently adding capabilities
- all privileged actions audited
- all high-risk actions approval-gated by default
- local clients use ACP
- HTTP exists only for platform ingress

Still needed for production-grade security:

- real sandboxing
- marketplace signing and revocation
- OS-level network/filesystem enforcement
- signed release installers
- local auth/session boundary for UI
- secure update channel

## Scalable Data Flow

### Local CLI Command

```text
andy plugin list
  -> connect ACP socket
  -> andy.plugins.list
  -> daemon PluginRegistryService
  -> SQLite query
  -> JSON result
```

### Web Console

```text
browser
  -> desktop bridge
  -> ACP socket
  -> typed ACP method
  -> daemon service
  -> result
```

### Agent Task

```text
client prompt
  -> ACP session/prompt
  -> SessionService
  -> AgentKernelService
  -> ModelProviderService
  -> ToolRuntimeService
  -> PluginSupervisorService
  -> EventStoreService
  -> ACP response/stream
```

### External Message

```text
Telegram webhook
  -> Telegram plugin ingress
  -> signature verification
  -> normalized communication event
  -> policy
  -> agent session
  -> Telegram send tool
  -> audit
```

## Migration Plan

### Phase 1: Stabilize ACP

- Keep current stdio ACP mode. Done.
- Add Unix socket/named pipe ACP listener. Done.
- Convert CLI from one-shot subprocess ACP to persistent daemon ACP. Done with stdio fallback.
- Convert desktop bridge from one-shot subprocess ACP to persistent daemon ACP. Done with stdio fallback.
- Replace path-based `andy/request` with typed ACP methods.

### Phase 2: Split Daemon Internals

- Extract daemon API operations into service modules.
- Keep app entrypoint thin.
- Move route/method handlers out of `apps/daemon/src/index.ts`.
- Add typed request/response schemas.

### Phase 3: Storage

- Add SQLite store package.
- Migrate JSON state into SQLite.
- Keep JSON import/export.
- Add event/session indexes and retention.

### Phase 4: Plugin Supervision And Sandbox

- Add durable supervisor records.
- Add restart backoff.
- Add plugin logs.
- Add stronger sandbox backends.
- Enforce network/filesystem at host level where possible.

### Phase 5: UI And Release

- Build native tray/menu app.
- Add local auth boundary.
- Add signed release installers.
- Add update channel.
- Add marketplace signing/revocation UX.

## Honest Conclusion

The current architecture is a strong prototype, but not the scalable endpoint.

The scalable architecture is:

```text
long-lived daemon
  + persistent ACP listener
  + typed ACP methods
  + SQLite-backed kernel state
  + supervised sandboxed plugins
  + desktop ACP bridge for browser UI
  + HTTP only for external webhooks
```

This keeps the important product principle intact: Andy is plugin-native, policy-gated, auditable, and ACP-first for local clients.
