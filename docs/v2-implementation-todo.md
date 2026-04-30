# V2 Implementation Todo

This is the implementation checklist for the scalable Andy architecture. It tracks what is done, what is in progress, and the acceptance bar for each subsystem.

## Done

- ACP-first local clients.
  - CLI uses ACP instead of daemon HTTP.
  - Desktop and web console use an ACP bridge instead of calling daemon HTTP.
  - Daemon HTTP local admin routes are disabled.
- Persistent daemon ACP listener.
  - Long-running daemon opens a Unix socket on macOS/Linux and a named pipe on Windows.
  - CLI, desktop bridge, and development web bridge prefer the persistent ACP transport.
  - Stdio ACP remains as embedding and one-shot fallback.
- Typed ACP local control.
  - Removed path-shaped `andy/request` local control.
  - CLI, desktop bridge, and web console call typed `andy.*` ACP methods.
  - Packaged smoke confirms legacy `andy/request` is rejected.

## In Progress

### SQLite Durable Store

Goal: move durable runtime state out of JSON files and into SQLite while keeping JSON only for simple config.

Implemented foundation:

- Add `SqliteCoreStateStore`.
- Store sessions, messages, approvals, background jobs, events, traces, and snapshot domains in SQLite.
- Wire daemon default state storage to `.andy/andy.sqlite`.
- Keep JSON state store available as explicit fallback.
- Store plugin registry records in SQLite by default.
- Store skill registry records in SQLite by default.
- Store policy config in SQLite by default.
- Store structured memory metadata and review state in SQLite.

Remaining:

- Add import/export between JSON and SQLite for migrations.

Acceptance:

- Fresh daemon creates `.andy/andy.sqlite`.
- Sessions, approvals, background jobs, events, and traces survive daemon restart.
- Existing JSON configs still boot.
- Full `bun run check` and release smoke pass.

## Next

### Durable Task Engine

Goal: compile skills into durable task graphs instead of one-shot ordered steps.

Implemented foundation:

- task graph schema
- task instances and step instances
- dependency graph
- retry policy
- timeout policy
- leases and locks
- idempotency keys
- compensation metadata
- pause/resume
- approval checkpoints
- event/cron/webhook trigger metadata
- SQLite snapshot persistence for task graphs, runs, and steps
- Skill workflow invocations now compile into durable task graphs.
- `andy skill run` creates and executes a durable task run.
- `andy task list` exposes persisted task graphs and runs through typed ACP.

Remaining:

- Broaden the task executor beyond immediate in-process skill runs.
- Persist task graph tables as first-class daemon APIs.
- Add cron/event/webhook trigger dispatchers.
- Add compensation execution for failed downstream steps.
- Add richer web visibility for task runs.

Acceptance:

- A skill workflow can compile into a persisted task graph.
- A task can pause for approval and resume after restart.
- A failed step can retry according to policy.
- Every task state transition emits audit/event records.

### Plugin Execution Hardening

Goal: subprocess is not the only containment tier.

Required:

- sandbox policy model in plugin manifests
- host-level file/network enforcement plan
- macOS sandbox profile launcher
- Linux bubblewrap/firejail launcher
- Windows job object/AppContainer adapter
- WASI adapter for simple pure plugins
- explicit fallback behavior when requested containment is unavailable

Acceptance:

- Untrusted/high-risk plugins cannot run in plain subprocess mode by default.
- Plugin startup fails closed when requested containment is unavailable.
- Runtime records the effective sandbox tier in plugin health.

### MCP Adapter

Goal: support MCP ecosystem reach without replacing Andy plugins.

Shape:

```text
Andy tool
  -> Andy runtime/policy/audit
  -> MCP client adapter plugin
  -> MCP server
```

Acceptance:

- Install/register an MCP server as an Andy plugin adapter.
- MCP tools appear as fully qualified Andy tools.
- Every MCP call is policy checked and audited.
- MCP server capabilities are declared before enablement.

Implemented foundation:

- Added first-party `andy.mcp.client` plugin.
- Supports explicit stdio MCP server commands.
- Exposes policy-gated `mcp.list_tools` and `mcp.call_tool`.
- Keeps MCP calls behind Andy plugin manifests, capability gates, and audit.

Remaining:

- Durable MCP server registry.
- Per-server capability review before enabling.
- Dynamic projection of MCP tools into fully qualified Andy tool names.
- Long-lived MCP server supervision instead of per-call server startup.

### Evaluation Harness

Goal: stop making product claims without measured evals.

Implemented foundation:

- Added `@andy/evals`.
- Defined suite/case/result/metric types for product and safety evals.
- Added a runner abstraction that executes eval cases through an injected runner.
- Added summary aggregation for success rate, latency/time, model calls, tool calls, cost, approvals, unsafe action rate, user intervention count, and recovery quality.

Suites:

- email triage
- calendar scheduling
- browser booking
- file organization
- coding task delegation
- multi-step research
- desktop control
- voice interaction
- memory recall
- background reminders
- security refusal
- prompt injection resistance
- tool failure recovery

Metrics:

- task success
- time to completion
- model calls
- tool calls
- cost
- latency
- approval correctness
- unsafe action rate
- user intervention count
- recovery quality

Remaining:

- Add first-party eval suites and fixtures.
- Wire eval runners to packaged Andy/ACP sessions.
- Persist eval results to SQLite.
- Add CLI commands for running eval suites.
- Add CI thresholds for regressions.

### Prompt Injection And Provenance

Goal: treat external content as hostile by default.

Implemented foundation:

- source labels
- read/write separation
- secret-exfiltration checks
- cross-domain action checks
- confirmation before external side effects
- policy rules based on provenance
- `AgentRunInput` and `AgentSession` carry provenance labels.
- Agent kernels pass session provenance into every model-requested tool call.
- Remote messaging channels default to untrusted provenance.
- Local ACP/user requests default to trusted user provenance.
- Explicit provenance labels can be supplied to typed agent-run ACP payloads.
- Untrusted session provenance is also summarized in the system prompt so the model sees the source boundary, while runtime policy still enforces it.
- Tool outputs can add explicit provenance labels.
- Browser, filesystem read/list, and messaging-style tool outputs are inferred as untrusted context when they do not provide explicit labels.
- Inferred untrusted tool-output provenance is merged into the session before the next model step, so later write/external side-effect tool calls inherit the taint.
- First-party browser inspect/screenshot outputs include explicit browser provenance.
- First-party filesystem read/read-sensitive/list outputs include explicit file provenance.
- First-party Telegram and WhatsApp normalized inbound messages include explicit messaging provenance.
- First-party vision image/screen outputs include explicit visual provenance.
- First-party project read/search outputs include explicit file provenance.

Remaining:

- Label future email, document, calendar, Slack, PDF, and browser page subresources with richer source domains.
- Add richer cross-domain action rules.
- Surface provenance in approvals and observability UI.
- Add eval cases for prompt injection and secret exfiltration.

Acceptance:

- Browser/email/document/calendar content enters the runtime as untrusted.
- Tool calls that combine untrusted reads with external writes are denied or approval-gated.
- Secret access is denied when the request path includes untrusted instructions.

### Real Voice Architecture

Goal: move beyond adapter-level TTS/recording.

Required:

- push-to-talk and optional wake-word activation
- streaming STT
- voice activity detection
- barge-in interruption
- partial transcript handling
- low-latency model routing
- streaming TTS
- conversation repair

### Structured Memory Review

Goal: memory records must be typed, reviewable, scoped, and deletable.

Implemented foundation:

- Added `SqliteStructuredMemoryStore`.
- Records include type, subject, content, provenance source, confidence, sensitivity, visibility, and timestamps.
- High-sensitivity saved memories default to `user-review-required`.
- Daemon exposes typed ACP methods for memory list, approve, reject, and forget.
- CLI exposes `andy memory list`, `andy memory approve`, `andy memory reject`, and `andy memory forget`.
- Durable skill memory writes are indexed into structured memory after successful tool execution or approval resume.

Required schema fields:

- type
- subject
- content
- source/provenance
- confidence
- sensitivity
- visibility
- created/updated/expires timestamps

Acceptance:

- User-scope memory writes can require review.
- Users can inspect, approve, edit, and delete memory records.
- Semantic memory indexes inspectable records instead of becoming the only source of truth.

Remaining:

- Add edit/update commands for existing records.
- Hook arbitrary agent/runtime `memory.save` tool calls into structured indexing, not only durable skill task execution paths.
- Propagate richer source labels from browser, messaging, email, files, and documents.
- Add semantic indexing over reviewed structured memory.
- Add web/desktop memory review UI.

### Product Connectors

Goal: everyday Jarvis surfaces should be first-class plugins.

Priority connectors:

- email
- calendar
- contacts
- notes
- reminders
- documents
- spreadsheets
- browser
- messages
- filesystem
- terminal
- IDE
- notifications
- mobile
- desktop apps
