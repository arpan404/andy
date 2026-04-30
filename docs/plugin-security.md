# Plugin Security

Andy treats plugins as untrusted code. The manifest is the plugin's maximum allowed capability envelope, not a permission grant.

## Install Flow

```text
GitHub or marketplace source
  -> fetch manifest
  -> validate manifest
  -> verify schemaVersion compatibility
  -> display capabilities and permissions
  -> pin source version
  -> install disabled or enable after approval
  -> run through plugin host
```

## Manifest Requirements

Every plugin must declare:

- id, name, version, and entrypoint
- source provenance
- capabilities
- risk level
- tool definitions
- network hosts when network is needed
- filesystem roots when real filesystem access is needed
- sensitive filesystem roots, reasons, and data classes when OS-level, app-level, or private user data is needed
- secret scopes when credentials are needed
- swarm limits when spawning or delegating to other agents is needed
- memory scopes, namespaces, retention, and semantic-search behavior when storing or retrieving memory
- sandbox compatibility for every tool that needs a specific execution mode
- explicit `sandbox.isolation: "unsandboxed"` for tools that need host privileges

## Runtime Enforcement

- Reject tools that request undeclared capabilities.
- Check policy on every tool call.
- Expose only approved APIs to plugin context.
- Treat host APIs as syscalls: first check the caller plugin declared the requested capability, then forward through policy-gated tools.
- Messaging integrations must go through the core communication bridge. WhatsApp, Telegram, and future channels are channel plugins behind that bridge, not separate direct agent-control paths.
- Keep scratch work in the virtual filesystem by default.
- Keep plugin application storage isolated from other plugins by default.
- Require scoped roots for real filesystem access.
- Require `filesystem.read_sensitive` plus `permissions.filesystem.sensitiveReadRoots` for OS folders, app folders, browser profiles, message stores, credentials, and other private user data.
- Require allowlisted hosts for network access.
- Require secret broker access for credentials.
- Audit install and execution lifecycle events.
- Block disabled or removed plugin tools from execution.
- Block host API calls for undeclared capabilities before any target tool runs.
- Treat swarm spawn/delegate/join/cancel as audited plugin actions.
- Treat persistent user memory writes, memory deletion, and semantic indexing as audited plugin actions.
- Validate declared tool input and output schemas at the runtime boundary.
- Use AJV for JSON Schema validation so plugin contracts can use standard JSON Schema features such as `enum`, `additionalProperties`, and nested schema constraints.
- Carry trace, session, user, channel, task, and cancellation metadata through policy and audit for correlation.
- Prefer Markdown memory as the inspectable source of truth; treat vector or database-backed memory as indexes or alternate providers selected by the user.
- Reject tools at host startup when their declared sandbox compatibility does not include the selected execution mode.
- Tools that require host privileges must declare `sandbox.isolation: "unsandboxed"` and `sandbox.requiresHostPrivileges`.
- Unsandboxed tools are rejected at runtime registration unless the host explicitly allows the plugin id in `hostPrivilegePolicy`.
- Unsandboxed tools must come from a local trusted source by default. GitHub and marketplace plugins cannot register unsandboxed tools unless the host deliberately disables that local-source requirement.
- Unsandboxed tools still need declared capabilities, normal policy checks, approval for high-risk actions, audit events, and source review. Unsandboxed means "not isolated by worker/subprocess/container", not "unrestricted".

## Execution Levels

- `metadata`: inspect manifest without executing code.
- `trusted-in-process`: first-party development only.
- `subprocess`: default target for installed plugins.
- `worker`: restricted JS worker with limited APIs.
- `container`: stronger isolation for high-risk plugins later.
- `remote`: isolated remote execution later.

## Sandboxed Filesystem

Subprocess plugins receive a per-plugin sandbox root with separate scratch and storage directories:

- `ANDY_PLUGIN_SANDBOX_ROOT`
- `ANDY_PLUGIN_SCRATCH_ROOT`
- `ANDY_PLUGIN_STORAGE_ROOT`

The subprocess host starts the plugin with the sandbox root as `cwd`, a minimal environment, and no direct core object references. Runtime tool calls cross a newline-delimited JSON RPC channel and are still policy-checked by Andy before execution.

This sandbox root is the only filesystem location a well-behaved plugin should use directly. Access to user files, OS folders, app folders, browser profiles, credentials, or external project files must still go through declared filesystem capabilities and policy-gated host APIs.

Subprocess launch profiles:

- `process-boundary`: separate process, sandbox cwd, minimal environment, JSON RPC.
- `macos-sandbox-exec`: wraps the Bun plugin process in a macOS sandbox profile that denies default filesystem access and allows only the sandbox root plus runtime paths needed to start Bun.
- `container`: builds a Docker/Podman command with no network by default, read-only root, tmpfs `/tmp`, and mounted scratch/storage roots.

Bun subprocesses are a process boundary, not a complete OS sandbox. A malicious plugin process can still attempt direct host syscalls when launched with `process-boundary`. High-risk third-party plugins should use `macos-sandbox-exec`, `container`, or `remote` when those are available on the host.

Some tools are intentionally not sandbox-compatible. Examples include desktop accessibility control, global keyboard/mouse control, app window management, and local microphone/camera capture. These tools must declare host-only sandbox compatibility and should be first-party, trusted, policy-gated, and audited.

Example host-only tool policy:

```json
{
  "sandbox": {
    "isolation": "unsandboxed",
    "compatibleExecutionModes": ["trusted-in-process"],
    "requiresHostPrivileges": true,
    "reason": "Desktop keyboard control needs the host accessibility session."
  }
}
```

## Communication Bridge

Andy Core owns a communication bridge between users, agents, approval requests, and channel plugins. Messaging plugins such as WhatsApp and Telegram must register as communication channels and send/receive through the bridge.

Rules:

- Channel plugins verify platform-specific auth, signatures, webhooks, and sender identity.
- Channel plugins normalize inbound messages into core communication messages.
- Agent and approval replies go back through the communication bridge.
- Approval prompts use the communication bridge so the same approval system can route to UI, Telegram, WhatsApp, desktop notifications, or future channels.
- Remote approval prompts include an approval id and support `/approve <id>` and `/deny <id>` replies through channel plugins.
- Plugins must not create their own hidden messaging path around the communication bridge.

## Daemon HTTP Ingress

The daemon's HTTP surface is not the local client/admin API. Local clients use ACP stdio. HTTP remains only for health checks and external webhook ingress:

- `GET /health`
- `POST /webhooks/telegram`
- `POST /webhooks/whatsapp`

Webhook routes can require `X-Andy-Webhook-Secret` by setting `http.webhookSecretEnv` to an environment variable name. Platform-specific signature validation should be added per channel where the platform supports it; the shared-secret guard is the local daemon baseline.

## Sandboxed Host API RPC

Worker and subprocess plugins may request host APIs through the plugin RPC channel. The host checks that:

- the request plugin id matches the hosted manifest
- the manifest declared the requested capability
- a host API handler is configured

The default host API handler routes requests back through policy-gated runtime tools. This keeps sandboxed plugins from receiving direct core object references while still letting them request syscalls such as memory, filesystem, communication, secrets, background, or swarm.

Subprocess transport enforces bounded message size and request timeouts. Production hosts should still prefer OS sandbox, container, or remote execution profiles for untrusted plugins because transport limits do not replace process confinement. The process isolation verifier can reject the basic process-boundary profile when strong isolation is required.

## Approval Resume

Approval requests are parked with the runtime tool action they would run. After the user approves through a communication channel, the approval resume engine executes the exact suspended action and clears it. Denied approvals clear the parked action without running it.

Pending approvals can be expired and cleared from the parked-action table. Runtime tool approvals include serializable action descriptors so they can be hydrated after daemon restart. Custom in-memory closures remain non-durable by design.

## Lifecycle

Hosted plugins should be started through the core lifecycle manager. The manager starts the selected host, registers the hosted proxy tools with the runtime, audits lifecycle events, and stops handles during shutdown. If runtime registration fails, the host handle is stopped so plugin code is not left running without registered policy gates.

First-party subprocess plugin manifests include both `entry` and `binaryEntrypoint`. Development can run the source entrypoint through Bun, but release builds compile each first-party plugin to `dist/plugin`. The subprocess host launches `binaryEntrypoint` when it exists, so release packages do not require Bun for first-party plugin execution.

Plugin hosts report health as `running`, `stopped`, or `crashed`. The daemon exposes host health in status output and can call lifecycle restart supervision through typed ACP method `andy.plugins.restartCrashed`. If restart fails, runtime proxy tools are disabled so crashed plugins do not remain callable.

Plugin packages installed from a reviewed plan are materialized disabled by default. Enabling remains a separate lifecycle step so install, review, enable, and runtime execution stay distinct audit points.

Stopping a hosted plugin disables its runtime proxy tools before the host handle is torn down. This prevents stopped plugin processes from leaving stale callable tools in the runtime catalog.

The plugin manager includes a schema-versioned atomic JSON-file registry for local daemon development. Registry records preserve manifest, source, lifecycle status, install time, and update time. Daemon boot seeds this registry from config and starts enabled plugins from durable installed records.

Runtime tool execution checks cancellation tokens before a tool starts and races active tool execution against cancellation. Hosted worker and subprocess calls are interrupted on active cancellation so cancelled sessions and background jobs do not keep privileged tool actions running.

The daemon exposes local plugin management through typed ACP methods:

- `andy.plugins.list`
- `andy.plugins.reviewLocal`
- `andy.plugins.installLocal`
- `andy.plugins.installGithub`
- `andy.plugins.setEnabled`
- `andy.plugins.remove`
- `andy.plugins.restartCrashed`

Local and GitHub install records are disabled unless explicitly enabled, and enable/disable/remove still flow through registry state, lifecycle state, runtime tool enablement, policy, and audit. GitHub installs require an immutable commit SHA or semver release tag, clone into `.andy/github-plugins`, and store the local checkout path in the registry so daemon startup never executes directly from a remote URL.

Plugin packages may include `plugin.signature.json` next to `plugin.json`. The signature file signs the canonical plugin manifest with Ed25519. Daemon config can list trusted publishers with public keys under `trustedPublishers`; install/review output records plugin trust as `unsigned` or `verified` with the publisher id and public-key fingerprint. Unsigned plugins are still installable, but the user-facing review keeps that trust state explicit.

The `andy` CLI binary wraps these local daemon APIs over ACP stdio:

- `andy plugin list`
- `andy plugin review-local <manifestPath>`
- `andy plugin install-local <manifestPath> [--enable]`
- `andy plugin install-github <repository-url> <commit-or-version-tag> [--manifest plugin.json] [--enable]`
- `andy plugin enable <pluginId>`
- `andy plugin disable <pluginId>`
- `andy plugin remove <pluginId>`
- `andy plugin restart-crashed`
- `andy approval list`
- `andy approval approve <approvalId>`
- `andy approval deny <approvalId>`
- `andy skill list`
- `andy skill review-local <manifestPath>`
- `andy skill install-local <manifestPath> [--enable]`
- `andy skill enable|disable|remove <skillId>`
- `andy skill run <skillId> [--workflow name] [--input json]`

The CLI does not use daemon HTTP. It spawns the sibling `andy-daemon --acp` and selects state with `--home` or `ANDY_HOME`.

Policy config is durable in `.andy/policy.json`. It supports allowed capabilities, approval-required capabilities, denied plugins, approval-required channels, approval-required risk levels, explicit rules, and expiring grants scoped by plugin, capability, user, channel, or task.

## Skills

Skills are declarative workflow manifests, not executable plugin bundles. The skill registry is durable in `.andy/skills.json`, and skill workflow execution calls fully qualified plugin tools through the normal runtime path.

Security rules:

- A skill must declare every required plugin and capability.
- A skill step must use a fully qualified tool name.
- A skill cannot define executable tools; only plugins define tools.
- A skill cannot run if a required plugin is disabled or removed.
- Skill steps remain policy-checked and approval-gated at tool execution time.
- Approval-required skill runs return an approval-required daemon response instead of marking the workflow complete.
- Skill upgrades that add plugins or capabilities require review before enabling.

Plugins may bundle skills in a `skills/` directory next to `plugin.json`. Bundled skills are installed as plugin-owned skill records, but they remain declarative manifests. Disabling or removing the owning plugin must disable or remove those bundled skills, and bundled skill upgrades that add required capabilities or required plugins require review.

## First-Party System Plugins

Implemented first-party system plugins:

- `@andy/plugin-memory-markdown` stores inspectable Markdown memory inside `ANDY_PLUGIN_STORAGE_ROOT`.
- `@andy/plugin-filesystem` restricts read/list/write/delete to manifest-declared roots passed by the host.
- `@andy/plugin-shell` runs commands without shell interpolation, requires a declared `cwd` root, bounds output, and is expected to be approval-gated by policy.
- `@andy/plugin-browser` automates a local browser through Chrome DevTools Protocol. It only connects to localhost/127.0.0.1 CDP endpoints, exposes navigation/inspection/click/type/screenshot/form-submit tools, and keeps form submission, typing, screenshots, and navigation policy-gated because browser automation can exfiltrate data or act on behalf of the user.
- `@andy/plugin-codex` delegates coding work to the locally authenticated OpenAI Codex SDK/CLI flow. It is disabled by default, declares `codex.run` and `codex.thread`, and requires approval because it invokes a nested coding agent that may inspect, edit, or execute code in the configured workspace.
- `@andy/plugin-mcp-client` adapts explicit MCP stdio servers into Andy's plugin/runtime path. It is disabled by default, declares `mcp.connect`, `mcp.list_tools`, and `mcp.call_tool`, and remains approval-gated because MCP servers can expose external data and actions.
- `@andy/plugin-telegram` uses the official Telegram Bot API for polling, send, webhook setup, and update normalization.
- `@andy/plugin-whatsapp` uses the official Meta Graph API for outbound messages and webhook payload verification/normalization.
- `@andy/plugin-voice-input`, `@andy/plugin-voice-output`, `@andy/plugin-vision`, and `@andy/plugin-computer-control` expose strict capability surfaces while native capture/provider depth is added incrementally. Voice input supports explicit activation, bounded recording through platform adapters, and transcript/audio handoff. Voice output uses platform adapters (`say`, `spd-say`/`espeak`, or PowerShell `System.Speech`) and supports stopping the active speech process. Vision captures screenshots through platform adapters (`screencapture`, `gnome-screenshot`/`import`/`scrot`, or PowerShell) and prepares AI SDK image parts so multimodal LLMs can receive images directly. Computer control uses platform adapters for macOS (`osascript`), Linux (`xdotool`/`wmctrl`), and Windows (PowerShell/User32/SendKeys), and remains gated by `ANDY_ENABLE_COMPUTER_CONTROL=1` plus policy approval.
- `@andy/plugin-background-worker` persists background task requests, scheduled task records, and cancellation state inside plugin storage; privileged resumed work still re-enters core policy.
- `@andy/plugin-notifications` records notification and approval-request deliveries through a manifest-declared notification surface and best-effort macOS local notifications for `channel: "local"`.
- `@andy/plugin-swarm-orchestrator` manages bounded swarm plan/spawn/delegate/join/cancel state inside the manifest's agent-count, depth, role, and capability limits.
- `@andy/plugin-memory-persistent` stores structured persistent memory records in plugin-owned JSON storage with save/fetch/query/list/forget tools.
- `@andy/plugin-memory-semantic` stores inspectable semantic memory records with a deterministic local vector index; it does not hide memory solely inside an opaque vector database.

These plugins run through subprocess hosting, register only manifest-declared proxy tools, and have lifecycle tests for the security-sensitive paths. Capability behavior stays out of core.

## Secrets

Core exposes a secret broker interface so plugins can request only their declared secret scopes. The daemon now wires an OS-backed broker:

- macOS: Keychain through `security`.
- Linux: Secret Service through `secret-tool` when available.
- Windows: Credential Manager through PowerShell and Win32 credential APIs.

If the native store is unavailable, Andy falls back to `.andy/secrets.json` with encoded local records. The fallback file is not a substitute for platform keychain security; it exists so development and unsupported hosts can still exercise the broker contract. Secret requests remain audited and denied when the caller plugin did not declare the requested scope.

## Prompt Injection And Provenance

External content must be treated as untrusted input. Core now has provenance labels for source type, source id, trust level, and optional domain. Tool execution context can carry those labels into `AgentRuntime`.

The first provenance policy is intentionally conservative:

- untrusted provenance plus secret access is denied
- untrusted provenance plus external/write side effects requires approval
- trusted provenance keeps the normal capability policy path

This is the foundation for prompt-injection defense. It does not yet fully propagate taint through every plugin output or model message; browser, email, document, calendar, file, and messaging plugins still need to label their outputs consistently.

## Upgrade Rule

Plugin upgrades must not silently add capabilities. If the new manifest asks for more capabilities, network hosts, filesystem roots, or secret scopes, the user must approve the change before the plugin is enabled.

## Agent Client Protocol

Andy supports ACP-style stdio communication through `andy-daemon --acp`. ACP is the preferred client-agent protocol for local IDEs, controller apps, the CLI, and the desktop-hosted web console. Daemon HTTP remains only for health checks and external messaging webhooks.

ACP prompts still execute through the same `AgentKernel`, plugin runtime, policy engine, approvals, cancellation registry, and audit surfaces. ACP does not grant a client direct access to undeclared plugin capabilities.

## MCP Adapter Boundary

Andy supports MCP through a plugin adapter, not by replacing the internal plugin/runtime model.

```text
Andy agent
  -> AgentRuntime
  -> policy / approval / audit
  -> andy.mcp.client plugin
  -> explicit MCP stdio server
```

The first MCP adapter can list tools from an explicit MCP stdio command and call a named MCP tool. Every MCP operation is still an Andy tool call with declared capabilities, policy checks, approval gates, and audit events. Future work should add a durable MCP server registry, per-server capability review, dynamic fully qualified Andy tool projection, and long-lived supervised MCP server processes.
