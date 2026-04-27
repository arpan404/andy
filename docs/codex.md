# Codex Integration

Andy can delegate coding tasks to OpenAI Codex through a first-party plugin:

```text
andy.codex
```

This plugin is disabled by default and marked `critical` risk because it invokes a nested local coding agent that can inspect, edit, and run commands in the configured working directory.

## Architecture

The Codex integration is a plugin, not core behavior:

```text
Andy agent
  -> policy approval
  -> andy.codex.codex.run
  -> @openai/codex-sdk
  -> locally authenticated Codex CLI/App Server flow
```

Andy does not treat a ChatGPT or Codex subscription as an OpenAI API key. The plugin uses the local Codex SDK/CLI authentication state. That means the user must have Codex available and signed in in the local environment before the plugin can run successfully.

## Tool

The plugin exposes:

```text
andy.codex.codex.run
```

Input:

```json
{
  "prompt": "Implement the requested change and run tests.",
  "cwd": "/path/to/project",
  "threadId": "optional-existing-thread"
}
```

Output:

```json
{
  "result": {},
  "threadId": "optional-next-thread"
}
```

The exact `result` shape is normalized from the Codex SDK result so Andy can audit and persist it as JSON.

## Subscription Support

OpenAI documents Codex as available through ChatGPT plans, and the Codex CLI can authenticate with a ChatGPT account. Andy's support relies on that local authentication path through the Codex SDK/CLI. If the local Codex environment is not logged in, Andy cannot use the user's subscription on its own.

## Security

- The plugin declares `codex.run` and `codex.thread` capabilities.
- Both capabilities are approval-required by default.
- The plugin is disabled by default.
- Codex work runs as a nested local agent and must be treated as high risk.
- Andy still records the plugin tool request and result through its normal audit path.
- This is not a sandbox escape hatch. The user should only enable the plugin for trusted workspaces.

## Validation

Static validation:

```bash
bun run --filter @andy/plugin-codex check
```

Release validation should confirm the plugin is packaged and seeded disabled:

```bash
bun run build:release
ANDY_HOME="$(mktemp -d)" ./dist/release/andy-*/bin/andy-daemon --status
```
