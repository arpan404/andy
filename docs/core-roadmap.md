# Core Roadmap

Andy Core should stay small and trusted. It should provide the kernel, policy boundaries, observability, and plugin host contracts that let plugins deliver product features safely.

## Already Started

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
- Background job scheduler with due-job lookup and status transitions.
- Core state store contract with in-memory and JSON file implementations.
- Cancellation token registry and timeout helper.

## Needed Next

### Real AI SDK Tool Binding

Core has an initial adapter that turns runtime tool records into AI SDK tool definitions passed to `generateText` and `streamText`.

Still needed: provider-specific compatibility tests, output schema validation, and a decision on whether AI SDK should only plan tool calls or also auto-execute selected low-risk tools.

### Streaming Agent Loop

The kernel currently has a complete-response loop. Core still needs a streaming loop that can expose AI SDK stream parts to app surfaces while still handling tool calls, tool results, cancellation, usage, warnings, and final messages.

Streaming should not bypass policy or plugin execution rules.

### Approval Flow

Core can create approval requests when policy returns `ask` and can route approval prompts through the communication bridge.

Still needed:

- pause or park the tool call
- resume, deny, or expire the pending action
- persist approvals across daemon restarts

### Plugin Host Isolation

The current runtime can start worker plugins and subprocess plugins and execute manifest-declared tools through typed RPC protocols. The runtime registers proxy tools from the manifest, so plugin code does not run in the core process.

Still needed for stronger untrusted execution:

- stricter OS-level subprocess confinement
- restricted host API transport
- no ambient `fs`, shell, secrets, desktop, or network access
- lifecycle-controlled startup and shutdown

Bun workers and subprocesses isolate plugin code from the core process. The subprocess launcher can also build macOS sandbox and container commands, but availability depends on the host OS and installed runtime. High-risk third-party plugins should use a platform sandbox, container, or remote execution profile with explicit filesystem and network restrictions.

### Manifest Schema And Validation

Core now has a first strict manifest schema in `@andy/plugin-sdk`.

Still needed: tool input/output schema declarations, schema versioning, compatibility checks, and installer integration against real plugin packages.

### Durable State

Core has in-memory and JSON file state store implementations. The daemon still needs durable stores for:

- installed plugin records
- plugin lifecycle state
- approval requests
- agent sessions
- background jobs
- audit traces
- configuration
- secret references

In-memory implementations are acceptable for tests only. JSON file storage is acceptable for early local daemon development, but production should move to a transactional store.

### Background Job Kernel

Core has initial background scheduling, cancellation, due-job lookup, and status transitions.

Still needed:

- durable resume behavior
- persist task state
- re-check policy before each resumed tool action
- expose progress and completion events
- prevent stale elevated permissions

The actual long-running behaviors should still be plugins.

### Event Bus

Core has an in-memory typed event bus and audit sink adapter.

Still needed: durable/replayable event streams, subscriber backpressure, and app/daemon transport integration.

### Secret Broker Interface

Core has an initial secret broker contract that lets plugins request declared secret scopes without exposing raw credentials broadly.

Still needed: policy checks, redaction in logs, secret rotation, and app-specific backing stores.

### Model Provider Plugins

Core has an LLM runner interface, but production model providers should be implemented as plugins or provider packages behind that interface.

Needed providers should include OpenAI first, with room for Anthropic, Google, local models, and routing services.

### Capability And Policy Refinement

Core needs richer policy rules:

- per-plugin permissions
- per-user and per-channel permissions
- task-scoped temporary grants
- approval thresholds
- deny reasons
- audit correlation ids
- high-risk action classification

Policy decisions must remain explicit for external messaging, filesystem writes, shell execution, computer control, browser form submission, memory writes, secret access, and swarm spawning.

### Observability And Tracing

Core has a trace manager. It still needs trace ids threaded across:

- agent session
- model call
- tool call
- policy decision
- approval
- plugin execution
- background job
- memory write

This is required for debugging, safety review, and user trust.

### Cancellation And Timeouts

Core has a cancellation token registry and timeout helper. These still need to be threaded into model calls, tool executions, background jobs, and swarm child agents.

No plugin or child agent should run indefinitely without an inspectable state and cancellation path.

### Plugin Installation From GitHub

Core has plugin installer and manifest fetcher interfaces.

Still needed:

- pin to commit SHA or immutable tag
- validate manifest
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
- swarm planning behavior

Core may define stable interfaces for these areas, but feature behavior belongs behind plugin manifests, policy, and audit.
