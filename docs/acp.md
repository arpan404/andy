# Agent Client Protocol

Andy supports an ACP-style stdio transport for agent-client communication through the daemon:

```bash
andy-daemon --acp
```

This mode is intended for IDEs, desktop controllers, and other clients that need a bidirectional session protocol without using Andy's local HTTP API.

## Scope

The ACP mode is a JSONL stdio server. Each request or notification is one JSON object per line. Andy currently accepts JSON-RPC 2.0-shaped messages:

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

The HTTP server still exists for local web console/admin operations, messaging webhooks, approvals, and transitional tooling. It should not grow into the primary agent-client protocol. New agent-client integrations should use ACP unless they specifically need a webhook or browser-based local admin surface.

## Validation

Minimum smoke:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1"}}\n' | ./dist/andy-daemon --acp
```

Expected behavior: the daemon writes a JSON response with Andy agent metadata and supported capabilities, then exits when stdin closes.
