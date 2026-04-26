# Plugin Security

Andy treats plugins as untrusted code. The manifest is the plugin's maximum allowed capability envelope, not a permission grant.

## Install Flow

```text
GitHub or marketplace source
  -> fetch manifest
  -> validate manifest
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

## Runtime Enforcement

- Reject tools that request undeclared capabilities.
- Check policy on every tool call.
- Expose only approved APIs to plugin context.
- Treat host APIs as syscalls: first check the caller plugin declared the requested capability, then forward through policy-gated tools.
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
- Prefer Markdown memory as the inspectable source of truth; treat vector or database-backed memory as indexes or alternate providers selected by the user.

## Execution Levels

- `metadata`: inspect manifest without executing code.
- `trusted-in-process`: first-party development only.
- `subprocess`: default target for installed plugins.
- `worker`: restricted JS worker with limited APIs.
- `container`: stronger isolation for high-risk plugins later.
- `remote`: isolated remote execution later.

## Upgrade Rule

Plugin upgrades must not silently add capabilities. If the new manifest asks for more capabilities, network hosts, filesystem roots, or secret scopes, the user must approve the change before the plugin is enabled.
