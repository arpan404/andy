# Observability

Andy records operational history through the trusted core event bus, audit sink, and trace manager. Observability is a read-only surface over those records; it does not grant plugins or agents new capabilities.

## Architecture Boundary

```text
runtime action
  -> audit event / trace event
  -> core event bus
  -> daemon state persistence
  -> daemon ACP, CLI, desktop ACP bridge, web console
```

The core owns event capture and replay. Apps only query filtered views. Plugins cannot write trusted observability records directly except by executing through the normal runtime, policy, approval, and audit path.

## ACP API

Observability is exposed through typed ACP methods:

- `andy.events.query`
- `andy.logs.query`
- `andy.traces.query`

Supported event/log filters:

- `limit`
- `fromSequence`
- `type`
- `traceId`
- `sessionId`

Supported trace filters:

- `limit`
- `traceId`
- `parentTraceId`
- `name`

`/logs` is an alias for the event timeline and exists for user-facing CLI language.

## CLI

```bash
andy events --limit 100
andy events --type tool.requested
andy logs --trace-id <trace-id>
andy traces --limit 50
```

The CLI returns JSON from daemon ACP. It intentionally does not read state files directly, so the daemon remains the single local authority for hydrated runtime state.

## Web Console

The web console shows:

- daemon counters
- latest event timeline
- trace contexts
- plugin and skill lifecycle state
- approvals

Timeline events are grouped visually by type:

- policy and approval events are warning-colored
- tool and secret events are high-attention
- other lifecycle events are calm

## Security

Observability can expose sensitive metadata such as tool names, plugin ids, message ids, and secret scopes. It must not expose raw secret values. Future remote or multi-user deployments should protect these views with local auth or a user session boundary.

Events and traces are persisted through the core state snapshot and are suitable for debugging, safety review, and answering why Andy took an action.
