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

This uses Bun's standalone executable compiler:

```bash
bun build --compile --target=bun --outfile=../../dist/andy ./src/index.ts
```

## Release Direction

- Development uses Bun strictly.
- Release artifacts should be compiled binaries.
- First target is the local platform binary.
- Later release automation should produce per-platform binaries for macOS, Linux, and Windows.
- Plugin packages are still source/package artifacts loaded by Andy; the main user-facing daemon/CLI should be a binary.
- Current subprocess plugins are launched with Bun by the plugin host. To fully remove the runtime requirement for plugin execution too, first-party plugins need to be compiled to binaries or loaded through an embedded worker/host path. The main Andy CLI/daemon binaries themselves do not require users to invoke Bun.

## Validation

Before shipping a binary:

```bash
bun run fmt
bun run check
bun run build
bun run build:binary
bun run build:daemon-binary
./dist/andy "binary smoke"
./dist/andy-daemon --status
```
