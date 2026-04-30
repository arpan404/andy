# Agent Client Protocol

Andy supports an ACP-style transport for agent-client communication through the daemon.

Normal long-running daemon mode opens a persistent local ACP listener:

```text
$ANDY_HOME/.andy/andy.sock
```

On Windows this becomes a named pipe under `\\.\pipe\`.

The daemon also keeps stdio ACP mode for IDE/app-server embedding and one-shot development fallback:

```bash
andy-daemon --acp
```

Local clients should prefer the persistent socket/pipe. Stdio mode is intended for IDEs, app-server style embedding, and fallback when no long-lived daemon is running.

## Scope

Both ACP transports use JSONL. Each request or notification is one JSON object per line. Andy currently accepts JSON-RPC 2.0-shaped messages:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocolVersion": "1" }
}
```

Responses and notifications are also written as one JSON object per line.

This is Andy's ACP compatibility layer, not a complete implementation of every Codex App Server method. The supported surface is intentionally small and maps to Andy's existing agent kernel, plugin runtime, policy, audit, and model-provider registry.

## Supported Methods

- `initialize`
- `session/new`
- `session/resume`
- `session/load`
- `session/list`
- `session/close`
- `session/prompt`

Supported notifications:

- `session/cancel`

`session/prompt` runs a prompt through Andy's own `AgentKernel`. Tool calls still go through declared plugin tools, policy checks, approval gates, audit events, and cancellation.

## Image Input

ACP prompts can include image blocks. Andy forwards image blocks to the AI SDK runner as multimodal image parts when the selected model supports image input:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "session-id",
    "prompt": [
      { "type": "text", "text": "Describe this UI." },
      { "type": "image", "mediaType": "image/png", "data": "<base64>" }
    ]
  }
}
```

## HTTP Boundary

ACP is the preferred protocol for agent-client communication.

The Andy CLI now uses ACP instead of HTTP. CLI commands first try the persistent daemon socket/pipe. If no daemon is running, they fall back to spawning the sibling `andy-daemon --acp` for one-shot commands.

The desktop-hosted web console now uses an ACP bridge. Browser JavaScript posts to the local desktop web server, and that server forwards the operation to the persistent daemon ACP socket/pipe. If no daemon is running, the bridge can fall back to one-shot stdio ACP. The browser does not call the daemon HTTP API.

The daemon HTTP server still exists for health checks and external messaging webhooks. New local agent-client integrations should use ACP unless they specifically need to receive an external platform webhook.

## Typed Andy Methods

CLI, desktop, and web-console management commands use typed Andy ACP methods.
The path-shaped `andy/request` bridge has been removed from local clients.

```text
andy.status
andy.config.get
andy.config.upsertModelProvider
andy.config.setModelProviderEnabled
andy.config.updateRemoteControl
andy.agent.run
andy.voice.turn
andy.voice.stop
andy.plugins.list
andy.plugins.reviewLocal
andy.plugins.installLocal
andy.plugins.installGithub
andy.plugins.setEnabled
andy.plugins.remove
andy.plugins.restartCrashed
andy.skills.list
andy.skills.reviewLocal
andy.skills.installLocal
andy.skills.setEnabled
andy.skills.remove
andy.skills.run
andy.approvals.list
andy.approvals.decide
andy.events.query
andy.logs.query
andy.traces.query
```

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "andy.plugins.list",
  "params": {}
}
```

Observability query example:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "andy.events.query",
  "params": {
    "query": {
      "limit": "50"
    }
  }
}
```

Typed ACP methods avoid fake HTTP semantics, provide stable method names for
client SDKs, and keep local control separate from external webhook HTTP.

## Validation

Minimum smoke:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1"}}\n' | ./dist/andy-daemon --acp
```

Expected behavior: the daemon writes a JSON response with Andy agent metadata and supported capabilities, then exits when stdin closes.
