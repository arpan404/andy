# Distribution

Andy should ship as a standalone binary for normal users. Users should not need to install Bun, Node, or any JavaScript runtime to run the released app.

## Binary Build

Build the CLI binary with:

```bash
bun run build:binary
```

The output is:

```text
dist/andy
```

Build the daemon binary with:

```bash
bun run build:daemon-binary
```

The output is:

```text
dist/andy-daemon
```

Build first-party plugin binaries with:

```bash
bun run build:plugin-binaries
```

Each subprocess plugin emits:

```text
plugins/<plugin-id>/dist/plugin
```

This uses Bun's standalone executable compiler:

```bash
bun build --compile --target=bun --outfile=../../dist/andy ./src/index.ts
```

## Release Direction

- Development uses Bun strictly.
- Release artifacts should be compiled binaries.
- First target is the local platform binary.
- Later release automation should produce per-platform binaries for macOS, Linux, and Windows.
- First-party plugin packages include a source entrypoint for development and a `binaryEntrypoint` for release.
- The subprocess host prefers `binaryEntrypoint` when the file exists and falls back to the source entrypoint with Bun for development.
- A user-facing release packages `dist/andy`, `dist/andy-daemon`, first-party plugin manifests, each plugin's compiled `dist/plugin` binary, bundled plugin skills, global first-party skills, and the built web console.

## Release Package

Create the local release bundle with:

```bash
bun run build:release
```

This runs the workspace build, compiles first-party plugin workers, compiles the CLI and daemon binaries, and writes a package under:

```text
dist/release/andy-<version>-<platform>-<arch>/
```

Package layout:

```text
bin/andy
bin/andy-daemon
plugins/<plugin>/plugin.json
plugins/<plugin>/dist/plugin
plugins/<plugin>/skills/**/skill.json
skills/<skill>/skill.json
web/index.html
web/main.js
web/styles.css
release.json
```

`release.json` records the package platform, architecture, binaries, plugin manifests, plugin binary paths, bundled skills, and global skills. Release packaging fails if a required binary, plugin manifest, plugin worker binary, global skill manifest, or web asset is missing.

## CLI Operations

The compiled `dist/andy` binary can manage a running daemon:

```bash
./dist/andy setup --home ~/.andy-runtime
./dist/andy status
./dist/andy config show
./dist/andy config set-model-provider ai-sdk.openai.default --provider openai --model gpt-4.1-mini --api-key-env OPENAI_API_KEY --enable
./dist/andy config remote telegram --enable --model-provider ai-sdk.openai.default
./dist/andy plugin list
./dist/andy plugin review-local plugins/memory-markdown/plugin.json
./dist/andy plugin install-local plugins/memory-markdown/plugin.json
./dist/andy plugin install-github https://github.com/owner/plugin.git v0.1.0
./dist/andy plugin enable andy.memory.markdown
./dist/andy skill list
./dist/andy skill review-local skills/remember/skill.json
./dist/andy skill install-local skills/remember/skill.json --enable
./dist/andy skill run andy.skills.remember --workflow save --input '{"key":"editor","value":"vim"}'
./dist/andy ask --image /path/to/screenshot.png "What is visible here?"
./dist/andy approval list
```

Use `--url http://host:port` or `ANDY_DAEMON_URL` to target a daemon that is not listening on `http://127.0.0.1:8765`.

`andy setup` can run before the daemon is already running. It creates the selected home directory and initializes `.andy/daemon.json` by invoking the sibling `andy-daemon --init` binary. Use `--force` only when intentionally recreating that config.

## Validation

Before shipping a binary:

```bash
bun run fmt
bun run check
bun run build
bun run build:binary
bun run build:daemon-binary
bun run build:plugin-binaries
bun run package:release
./dist/andy "binary smoke"
./dist/andy-daemon --status
```

To validate plugin execution without invoking Bun for plugin workers, temporarily run the daemon with `bun` unavailable on `PATH` after `bun run build:plugin-binaries`; enabled first-party plugins should still start through their `binaryEntrypoint`.
