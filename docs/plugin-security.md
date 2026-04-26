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
- Plugins must not create their own hidden messaging path around the communication bridge.

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

Plugin packages installed from a reviewed plan are materialized disabled by default. Enabling remains a separate lifecycle step so install, review, enable, and runtime execution stay distinct audit points.

## First-Party System Plugins

Implemented first-party system plugins:

- `@andy/plugin-memory-markdown` stores inspectable Markdown memory inside `ANDY_PLUGIN_STORAGE_ROOT`.
- `@andy/plugin-filesystem` restricts read/list/write/delete to manifest-declared roots passed by the host.
- `@andy/plugin-shell` runs commands without shell interpolation, requires a declared `cwd` root, bounds output, and is expected to be approval-gated by policy.
- `@andy/plugin-telegram` uses the official Telegram Bot API for polling, send, webhook setup, and update normalization.
- `@andy/plugin-whatsapp` uses the official Meta Graph API for outbound messages and webhook payload verification/normalization.
- `@andy/plugin-voice-input`, `@andy/plugin-voice-output`, `@andy/plugin-vision`, and `@andy/plugin-computer-control` expose strict capability surfaces while native capture/provider depth is added incrementally.

These plugins run through subprocess hosting, register only manifest-declared proxy tools, and have lifecycle tests for the security-sensitive paths. Capability behavior stays out of core.

## Upgrade Rule

Plugin upgrades must not silently add capabilities. If the new manifest asks for more capabilities, network hosts, filesystem roots, or secret scopes, the user must approve the change before the plugin is enabled.
