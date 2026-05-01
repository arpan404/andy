# Harness Architecture

## Goal

The harness is the execution core of Andy.

It should answer one question cleanly:

How does the app take user intent, decide what to do, call capabilities safely, remember useful things, and stay extensible without turning into a monolith?

This document locks the actual architecture.

## Core Decision

The harness should have **six primary primitives**:

1. `providers`
2. `tools`
3. `skills`
4. `plugins`
5. `memory`
6. `tasks`

Everything else exists to support those primitives:

- `policy`
- `approvals`
- `observability`
- `artifacts`
- `scheduler`

## What Each Primitive Means

### Providers

Providers are engines Andy depends on for reasoning or media.

Examples:

- LLM providers
- speech-to-text providers
- text-to-speech providers
- embedding providers

Providers are not user-facing actions. They are infrastructure.

They live behind stable protocols and can be local or cloud.

Examples in the current codebase:

- `ModelEngine`
- `VoiceEngine`

### Tools

Tools are the smallest executable capability the assistant can call.

Examples:

- create a calendar event
- read a file
- draft a mail message
- send a message
- search reminders

Rules:

- every external action must be a tool call
- every tool has a stable ID
- every tool has input and output schema
- every tool has risk metadata
- every tool call is logged
- every tool call goes through policy before execution

The current `ToolEngine` is the right nucleus for this.

### Skills

Skills are **installable declarative packages**.

They are not arbitrary native code.

A skill should describe:

- when it applies
- which tools it may use
- the workflow it follows
- prompt templates
- memory hints
- approval expectations

Skills are how Andy becomes better at tasks without changing core code.

Examples:

- “book a dinner reservation”
- “weekly planning”
- “triage inbox”
- “prepare meeting brief”
- “capture and organize notes”

Skills should compile into durable tasks, not directly execute host code.

### Plugins

Plugins are **installable code extensions**.

They exist when a declarative skill is not enough.

Plugins may add:

- new tools
- new providers
- new event sources
- new memory extractors
- new artifact handlers

Plugins should not own policy, memory, or approval logic. They provide capabilities; the harness decides whether those capabilities may run.

For macOS, plugins should be isolated helpers, not in-process dynamic code loading.

Recommended transport:

- app runtime <-> plugin helper via XPC

This is the right Mac-native boundary.

### Memory

Memory is not one thing. It should be split into four layers:

1. `session memory`
2. `working memory`
3. `proposed long-term memory`
4. `approved persistent memory`

Meanings:

- `session memory`: current conversation turns
- `working memory`: task-scoped scratch state and intermediate findings
- `proposed long-term memory`: candidate memories waiting for review
- `approved persistent memory`: trusted memory available across sessions

Persistent memory must always have:

- provenance
- confidence
- sensitivity
- visibility
- timestamps
- optional expiry

The current `MemoryStore` shape is directionally correct.

### Tasks

Tasks are durable executions.

A task is not just a message-response loop. It is a stateful workflow that may:

- span multiple tool calls
- pause for approval
- resume later
- run in background
- produce artifacts
- write proposed memory

Skills should compile into tasks.

The assistant runtime should create tasks for:

- agent runs
- scheduled workflows
- voice commands that require follow-through

## What We Should Not Confuse

### Skill vs Plugin

This needs to stay sharp.

`skill`:

- declarative
- installable
- no host-native code
- references tools
- compiles to task graphs

`plugin`:

- executable code
- installable
- isolated helper process
- provides tools/providers/events

Rule:

If something can be expressed as workflow + prompts + tool constraints, it is a skill.

If something needs new executable capability, system API integration, or custom logic, it is a plugin.

### Tool vs Skill

`tool`:

- one atomic capability

`skill`:

- a reusable strategy that orchestrates tools

### Memory vs Artifact

`memory`:

- small structured knowledge useful later

`artifact`:

- file, note, transcript, document, attachment, export, report

Artifacts can generate memory proposals, but they are not memory themselves.

## Recommended Harness Layers

### 1. App Shell

Owns:

- SwiftUI/AppKit UI
- onboarding
- permissions
- hotkey and push-to-talk entrypoints
- approval UX
- timeline and memory review panes

Should not own:

- business logic for tools
- provider routing
- policy decisions

### 2. Assistant Runtime

Owns:

- turn orchestration
- task creation
- tool call planning/execution coordination
- interaction with memory, policy, providers, and observability

This is the central brain.

### 3. Provider Layer

Owns:

- model routing
- STT/TTS routing
- local/cloud provider abstraction

No UI logic here.

### 4. Tool Layer

Owns:

- tool registry
- tool descriptors
- execution dispatch
- result normalization

Tools can be built-in or plugin-backed, but they look identical to runtime.

### 5. Policy and Approval Layer

Owns:

- risk classification
- source trust handling
- approval requirements
- denial rules
- secret exfiltration checks

This layer must sit in front of every tool call.

### 6. Memory Layer

Owns:

- session context retrieval
- proposed memory writes
- review queue
- persistent memory querying

### 7. Plugin Host Layer

Owns:

- plugin discovery
- plugin lifecycle
- XPC communication
- capability registration
- crash isolation

### 8. Scheduler / Task Engine

Owns:

- durable task runs
- background execution
- pause/resume
- retries
- triggers

## Required Features For V1 Harness

These are the features the harness must have, not optional polish.

### Must Have

- model provider abstraction
- voice provider abstraction
- tool registry with schemas
- policy gating before execution
- approval queue
- session memory
- proposed and approved persistent memory
- observability event log
- durable task model for at least foreground agent runs
- installable skills
- built-in tool adapters for first-party Apple integrations

### Should Have In V1

- installable plugin helpers
- plugin capability manifest
- background task resume
- artifact storage and linking
- memory extraction hooks

### Not Required For Initial V1

- arbitrary UI contributed by plugins
- distributed remote agent runtime
- multi-device sync
- third-party marketplace

## Actual Installable Formats

### Skill Package Format

Store under:

`~/Library/Application Support/Andy/Skills/<skill-id>/`

Contents:

- `skill.json`
- `prompt.md`
- `workflow.json`
- `examples.json`
- `tests.json`

Recommended manifest fields:

- `id`
- `version`
- `name`
- `description`
- `intentMatchers`
- `requiredTools`
- `memoryPolicy`
- `approvalPolicy`
- `workflowEntry`

Important rule:

Skills can reference tools, but cannot directly reach platform APIs.

### Plugin Package Format

Store under:

`~/Library/Application Support/Andy/Plugins/<plugin-id>/`

Contents:

- `plugin.json`
- helper executable
- resources directory
- optional bundled skills
- signature metadata

Recommended manifest fields:

- `id`
- `version`
- `name`
- `capabilities`
- `exposedTools`
- `eventSources`
- `providerKinds`
- `requiredPermissions`
- `bundledSkills`

Important rule:

Plugins register capabilities. They do not bypass runtime policy.

## Actual Memory Model

Persistent memory should have three stores:

1. `memory_records`
2. `memory_proposals`
3. `memory_links`

Meaning:

- `memory_records`: approved long-term memory
- `memory_proposals`: queued, review-gated candidate memory
- `memory_links`: relation to sessions, artifacts, tasks, and tools

Recommended memory types:

- `preference`
- `fact`
- `relationship`
- `project`
- `procedure`
- `episode`

This matches the current domain model and should stay.

## Actual Tool Call Flow

The harness should execute tools in this order:

1. user input arrives
2. runtime builds task/turn context
3. runtime asks model for response or tool plan
4. runtime turns proposed action into `ToolInvocation`
5. policy engine evaluates invocation
6. if denied: stop and explain
7. if approval required: queue approval
8. if allowed: execute via tool engine
9. normalize output
10. write observability event
11. optionally generate memory proposal
12. continue task

This flow must be universal.

No tool should bypass it.

## Recommended Module Additions To Current Repo

The current repo already has good seeds for:

- `AssistantRuntime`
- `ModelEngine`
- `VoiceEngine`
- `ToolEngine`
- `MemoryStore`
- `PolicySafety`
- `Observability`
- `IntegrationKit`
- `AppShell`

Two modules are still missing and should be added next:

- `SkillEngine`
- `PluginHost`

After that, add:

- `TaskEngine`
- `ArtifactStore`

## Final Recommendation

The actual harness should be:

- `runtime-centric`
- `tool-driven`
- `skill-extensible`
- `plugin-isolated`
- `memory-reviewed`
- `policy-first`

If you keep those six properties, the system stays scalable.

If you blur `skills`, `plugins`, and `tools` together, the harness will decay fast.
