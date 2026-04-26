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
- secret scopes when credentials are needed

## Runtime Enforcement

- Reject tools that request undeclared capabilities.
- Check policy on every tool call.
- Expose only approved APIs to plugin context.
- Keep scratch work in the virtual filesystem by default.
- Require scoped roots for real filesystem access.
- Require allowlisted hosts for network access.
- Require secret broker access for credentials.
- Audit install and execution lifecycle events.

## Execution Levels

- `metadata`: inspect manifest without executing code.
- `trusted-in-process`: first-party development only.
- `subprocess`: default target for installed plugins.
- `worker`: restricted JS worker with limited APIs.
- `container`: stronger isolation for high-risk plugins later.
- `remote`: isolated remote execution later.

## Upgrade Rule

Plugin upgrades must not silently add capabilities. If the new manifest asks for more capabilities, network hosts, filesystem roots, or secret scopes, the user must approve the change before the plugin is enabled.
