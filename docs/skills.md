# Skills

Skills are first-class, declarative workflow packages. They are not executable plugin code and they are not loose prompt snippets.

## Boundary

Andy uses this split:

```text
core = registry, validation, policy, audit, and workflow execution boundary
plugins = executable tools and capabilities
skills = declarative workflows that compose plugin tools
```

A skill can only call tools provided by enabled plugins. Every step still flows through the normal runtime tool execution path, so policy, approvals, audit, cancellation, JSON schema validation, and plugin lifecycle checks still apply.

Skills do **not** define executable tools. A skill may define a workflow step that calls `andy.filesystem.filesystem.read` or `andy.shell.shell.execute`, but those tools must already exist in enabled plugins. This keeps all system power behind plugin manifests, plugin lifecycle, policy, and audit.

The rule is:

```text
plugins define tools
skills compose tools
core validates, runs, audits, and applies policy
```

If a product capability needs a new callable action, it must be implemented as a plugin tool first. A skill can then provide a reusable workflow over that tool.

## Manifest

Each skill declares:

- stable `id`, `name`, `version`, and `description`
- `risk`
- `requiredPlugins`
- `requiredCapabilities`
- one or more named workflows
- ordered workflow steps
- fully qualified tool names for every step
- JSON input templates for each tool call

The SDK validates that every step's inferred capability is present in `requiredCapabilities`. This prevents a skill from silently adding a shell, filesystem, messaging, memory, swarm, or notification action outside its declared review surface.

Skill manifests should reference fully qualified tool names, for example:

```text
andy.memory.markdown.memory.save
andy.shell.shell.execute
andy.filesystem.filesystem.read
```

Local tool aliases are intentionally not part of skill manifests because skills are durable packages and should not change behavior when another plugin later installs the same local tool name.

## Plugin-Bundled Skills

Plugins may ship built-in skills alongside their executable tools.

Recommended package shape:

```text
plugin package
  plugin.json
  skills/
    refactor-component/skill.json
    add-tests/skill.json
```

Plugin-bundled skills are still normal skill manifests. During plugin install, the installer should discover bundled skill manifests, validate them with `@andy/skill-sdk`, and install them into the skill registry as plugin-owned skills.

Plugin-owned skill rules:

- The skill source records the owning plugin id and plugin package source.
- The skill must not require capabilities outside the owning plugin's manifest unless the requirement is explicit and reviewed.
- If the owning plugin is disabled, its bundled skills cannot run.
- If the owning plugin is removed, its bundled skills are removed or disabled.
- If a plugin upgrade changes bundled skills to require new plugins or capabilities, the skill upgrade requires approval.
- A bundled skill still cannot define executable tools; it can only compose plugin tools.

Example:

```text
@andy/plugin-react-dev
  tools:
    react.analyze_component
    react.generate_tests

  bundled skills:
    andy.skills.react.refactor_component
    andy.skills.react.add_accessible_form
```

The `andy.skills.react.refactor_component` skill can call `react.analyze_component`, filesystem tools, and test tools if it declares those required plugins and capabilities. It cannot execute hidden code outside those plugin tools.

## Lifecycle

Skills are persisted in `.andy/skills.json` through `@andy/skill-manager`.

The daemon exposes:

- `GET /skills`
- `POST /skills/install-local`
- `POST /skills/review-local`
- `POST /skills/:id/enable`
- `POST /skills/:id/disable`
- `POST /skills/:id/remove`
- `POST /skills/:id/run`
- `POST /agent/run` with `skillIds` for skill context injection into agent planning

The CLI exposes the same surface:

```bash
andy skill list
andy skill review-local skills/remember/skill.json
andy skill install-local skills/remember/skill.json --enable
andy skill enable andy.skills.remember
andy skill disable andy.skills.remember
andy skill remove andy.skills.remember
andy skill run andy.skills.remember --workflow save --input '{"key":"editor","value":"vim"}'
andy ask --skills andy.skills.effect-ts-coding "Refactor this package"
```

## First-Party Skills

Current first-party skills:

- `andy.skills.remember`: saves approved memory through `andy.memory.markdown`.
- `andy.skills.shell-note`: runs an approval-gated shell command and records the result through Markdown memory.
- `andy.skills.effect-ts-coding`: bundled with `andy.project`, injects Effect TS coding guidance and project validation workflow.
- `andy.skills.react-coding`: bundled with `andy.project`, injects React coding guidance and project validation workflow.

Both are installed from local manifests during daemon boot. `andy.skills.remember` is enabled by default because it still uses the policy-gated memory plugin path. `andy.skills.shell-note` is disabled by default because it requires shell execution.

## Security

Skills do not bypass plugin security. A skill run fails or parks for approval when:

- a required plugin is disabled or removed
- a required capability is unavailable
- policy denies or asks for the underlying tool call
- the tool input/output schema is invalid
- the target plugin is stopped or crashed

Approval-required skill steps return an approval-required response from the daemon instead of pretending the workflow completed.

## Workflow Controls

Skill workflows support a small declarative control surface:

- `when`: skip a step unless the referenced input, variable, or previous output is truthy.
- `forEach`: repeat a step for every item in a referenced array; the current item is available as `{{item}}`.
- `continueOnError`: record an error output and continue instead of failing the workflow.
- `saveAs`: store a step output in `vars.<name>` for later template references.

These controls are data-only. They do not execute arbitrary JavaScript.
