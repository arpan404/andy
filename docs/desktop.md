# Desktop Controller

Andy ships a lightweight desktop controller binary as `andy-desktop`.

The desktop controller is an app surface, not a product capability provider. It starts and stops local Andy processes and opens the web console, but it does not bypass plugins, policy, approvals, audit, or daemon APIs.

## Responsibilities

- Start the packaged daemon with `ANDY_HOME`.
- Start a local static web-console process.
- Open the web console in the default browser.
- Report daemon and web process status.
- Stop or restart managed processes.

## Commands

```bash
andy-desktop start --home ~/.andy-home
andy-desktop status --home ~/.andy-home
andy-desktop open --home ~/.andy-home
andy-desktop restart --home ~/.andy-home
andy-desktop stop --home ~/.andy-home
```

Options:

- `--home <path>` chooses the Andy home directory.
- `--web-port <port>` chooses the local web console port. Default: `8790`.
- `--daemon-url <url>` records the daemon URL used by the console. Default: `http://127.0.0.1:8765`.
- `--no-open` starts processes without opening the browser.

## Runtime Layout

In a release bundle, `andy-desktop` expects:

```text
bin/andy
bin/andy-daemon
bin/andy-desktop
web/
plugins/
skills/
release.json
```

The controller detects `release.json` next to `bin/` and starts sibling release binaries. In a source workspace, it starts the daemon through Bun workspace scripts and serves built web assets from `apps/web/dist`.

## State

The controller stores process state in:

```text
$ANDY_HOME/.andy/desktop.json
```

Logs are written to:

```text
$ANDY_HOME/.andy/logs/daemon.log
$ANDY_HOME/.andy/logs/web.log
```

## Security Boundary

The desktop controller is only a local launcher and web-console host. Feature actions still flow through:

```text
web console -> daemon HTTP API -> policy/approval/audit -> plugin runtime
```

The controller must not implement filesystem, shell, computer-control, messaging, memory, voice, or vision behavior directly.
