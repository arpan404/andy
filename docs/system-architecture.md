# System Architecture

## Product Shape

Andy is a single macOS app with an embedded assistant runtime.

There is no separate CLI service in v1.
There is no ACP transport inside the app in v1.

The desktop app owns:

- chat UI
- voice entry
- onboarding
- approvals
- timeline
- memory review

The runtime inside the app owns:

- model calls
- tool planning and execution
- memory reads and writes
- task execution
- policy enforcement
- observability

## Primary System Primitives

The system is built from these primitives:

1. `providers`
2. `tools`
3. `skills`
4. `plugins`
5. `memory`
6. `tasks`
7. `policy`
8. `observability`

These should stay separate.

If these boundaries blur, the system will become hard to reason about.

## Module Map

Current modules:

- `AssistantTypes`
- `Observability`
- `PolicySafety`
- `MemoryStore`
- `ModelEngine`
- `VoiceEngine`
- `IntegrationKit`
- `ToolEngine`
- `AssistantRuntime`
- `AppShell`

Modules we still need:

- `SkillEngine`
- `PluginHost`
- `TaskEngine`
- `ArtifactStore`

## Runtime Flow

Every assistant action should flow through the same path:

1. user input arrives from text or voice
2. runtime builds session context
3. runtime loads approved memory and active task state
4. runtime selects model/provider
5. model returns text and optional tool intentions
6. runtime turns intentions into typed tool invocations
7. policy evaluates each invocation
8. denied actions stop
9. approval-required actions enter queue
10. allowed actions execute through the tool engine
11. outputs are normalized and logged
12. memory proposals are generated if useful
13. response and events are persisted

No capability should bypass this path.

## Providers

Providers are infrastructure engines, not user-facing features.

Provider categories:

- `model`
- `speech-to-text`
- `text-to-speech`
- `embedding`

Rules:

- providers are always behind protocols
- provider routing happens in one place
- local and cloud providers share a common contract
- provider choice is driven by privacy, latency, and task complexity

## Tools

Tools are the smallest executable unit.

A tool must have:

- stable ID
- description
- input schema
- output schema
- risk class
- provenance handling

Examples:

- `calendar.events`
- `reminders.items`
- `files.readWrite`
- `mail.compose`
- `messages.send`

Rules:

- every host integration is exposed as tools
- every tool call is logged
- every tool call goes through policy
- tool outputs may generate memory proposals

## Skills

Skills are installable declarative capability packs.

They are not native code.

They contain:

- activation metadata
- instructions
- workflow definitions
- tool constraints
- examples
- optional helper assets

Skills are how Andy learns reusable workflows without changing the harness.

Examples:

- inbox triage
- meeting brief
- weekly planning
- file organization
- travel planning

Skills should compile into tasks.

## Plugins

Plugins are installable executable extensions.

Plugins are needed when declarative skills are not enough.

Plugins may contribute:

- tools
- providers
- event sources
- artifact handlers
- memory extractors

Rules:

- plugins do not bypass policy
- plugins do not own memory persistence
- plugins do not directly change the app UI
- plugins should run out of process

For macOS, the preferred boundary is:

- app runtime <-> plugin helper via XPC

## Memory

Memory is split into four layers:

1. `session memory`
2. `working memory`
3. `memory proposals`
4. `approved persistent memory`

Persistent memory records must include:

- type
- subject
- content
- provenance
- confidence
- sensitivity
- visibility
- timestamps
- optional expiry

Approved memory is available to future runs.
Proposed memory must be reviewed before promotion.

## Tasks

Tasks are durable assistant executions.

A task can:

- span many tool calls
- wait for approval
- resume later
- run in background
- produce artifacts
- propose memory

Skills should compile into task graphs rather than directly running tool loops.

## Policy

Policy is central, never plugin-specific.

Policy must evaluate:

- risk class
- source trust
- target system
- sensitivity
- side-effect level

Default profile:

- read-only: allow
- low-impact writes: allow or ask depending on trust
- high-impact writes: explicit approval

## Observability

Observability must be first-class.

The harness should record:

- user turns
- provider decisions
- tool invocations
- policy decisions
- approvals
- memory proposals
- task state changes
- plugin failures

The macOS app should surface:

- recent activity
- approval queue
- memory review
- task status

## Persistence

SwiftData is the default local persistence layer.

Persistent domains:

- sessions
- messages
- task runs
- task steps
- approvals
- events
- traces
- memory proposals
- approved memory
- artifacts

## What We Are Building First

V1 harness priorities:

1. stable tool runtime
2. stable policy and approvals
3. stable memory model
4. installable skills
5. first-party Apple integration tools
6. background task support
7. plugin isolation layer
