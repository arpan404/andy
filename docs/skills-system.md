# Skills System

## Why This Design

Anthropic’s public skills model is useful because it keeps skills simple:

- a skill is a directory
- it must include a top-level `SKILL.md`
- that file contains YAML frontmatter plus instructions
- the model sees skill metadata first and loads full instructions only when relevant

That is the right conceptual base for Andy too.

Reference sources:

- Anthropic skills repository:
  - https://github.com/anthropics/skills
- Anthropic API skills guide:
  - https://platform.claude.com/docs/en/build-with-claude/skills-guide

## What Anthropic Skills Actually Are

From Anthropic’s public docs and repository, the important ideas are:

1. A basic skill is a folder with a `SKILL.md`.
2. `SKILL.md` contains frontmatter with at least:
   - `name`
   - `description`
3. The rest of the file is instructions, examples, and guidance.
4. Skills are installed and then automatically used when relevant.
5. Metadata is exposed first; full instructions are loaded only when needed.
6. Skills are composable.
7. Skills are not the same thing as subagents.
8. In Anthropic’s implementation, skill sets can be distributed through plugins.

We should adopt the good parts of this model without copying implementation details that do not fit a macOS native app.

## Andy Skill Definition

In Andy, a skill is an installable declarative package that teaches the harness a reusable workflow.

A skill is not executable Swift code.

A skill may contain:

- instructions
- trigger descriptions
- workflow/task graph definitions
- tool allowlists
- memory hints
- examples
- optional templates and assets

## Andy Skill Directory Format

Install location:

`~/Library/Application Support/Andy/Skills/<skill-id>/`

Required files:

- `SKILL.md`
- `skill.json`

Optional files:

- `workflow.json`
- `prompt.md`
- `examples.json`
- `memory.json`
- `tests.json`
- `assets/`
- `templates/`

## `SKILL.md`

`SKILL.md` is the human-readable instruction file.

It should contain:

1. YAML frontmatter
2. plain language instructions
3. examples
4. failure boundaries
5. notes about approvals and memory

Required frontmatter:

- `name`
- `description`

Recommended frontmatter:

- `version`
- `tags`
- `triggers`
- `allowed_tools`
- `memory_policy`
- `approval_policy`

Example shape:

```md
---
name: weekly-planning
description: Prepare a weekly plan from calendar, reminders, and active projects.
version: 1
tags: [planning, productivity]
triggers:
  - weekly planning
  - plan my week
allowed_tools:
  - calendar.events
  - reminders.items
memory_policy: propose_summary
approval_policy: require_for_external_side_effects
---

# Weekly Planning

When this skill is active, review the next 7 days of calendar and reminders,
group work by priority, identify conflicts, and produce a proposed weekly plan.
```

## `skill.json`

`skill.json` is the machine-readable manifest.

It should be the canonical source for loading and validation.

Recommended fields:

- `id`
- `version`
- `display_name`
- `description`
- `entry_markdown`
- `workflow_file`
- `intent_matchers`
- `allowed_tools`
- `required_capabilities`
- `memory_policy`
- `approval_policy`

The runtime should parse `skill.json` first, then load `SKILL.md` only when the skill is a plausible match.

## Progressive Loading

This is one of the best ideas in Anthropic’s model and we should copy it.

Loading flow:

1. At startup, scan installed skill manifests only.
2. Build a lightweight registry from metadata.
3. During a turn, match user intent against metadata.
4. Load the selected skill’s `SKILL.md` and workflow only when relevant.
5. Compose multiple skills only if explicitly useful.

This keeps context and memory pressure low.

## How Skills Are Used

Skills should be invoked in three ways:

1. automatic selection by intent match
2. explicit user selection from UI
3. task template selection during onboarding or workflow setup

Once selected, the runtime should:

1. load the skill manifest
2. load `SKILL.md`
3. load the task graph definition
4. restrict tools to the skill allowlist
5. create a durable task run

## What Skills Can Do

Skills can:

- constrain which tools may be used
- define workflow steps
- define prompting strategy
- define memory extraction hints
- define output format expectations
- define approval expectations

Skills cannot:

- directly call OS APIs
- bypass policy
- write to persistent memory directly
- register native event listeners
- ship arbitrary executable code

If a capability needs any of those, it is a plugin.

## Skills vs Plugins

This boundary must remain hard.

Use a skill when:

- the capability is mostly workflow and instruction
- existing tools are enough
- there is no new native integration needed

Use a plugin when:

- a new OS or app integration is needed
- a new provider is needed
- executable custom logic is required
- a new event source or parser is needed

Rule:

Skills orchestrate.
Plugins extend capability.

## Skills vs Subagents

Anthropic separates skills from subagents, and we should too.

In Andy:

- a `skill` is reusable declarative capability
- a `subagent` is a runtime execution mode or worker strategy

A future subagent may use skills, but it is not itself a skill.

## Skill Execution Model

Skills should compile into task graphs.

A skill runtime should support:

- ordered steps
- conditional branches
- retries
- approval checkpoints
- memory proposal hooks
- final output schema

The harness should never interpret `SKILL.md` as raw executable code.

It should always resolve into structured task state.

## Skill Security Model

Skills are safer than plugins, but they still affect behavior.

So skills must still be validated.

Validation rules:

- valid manifest schema
- valid `SKILL.md` frontmatter
- allowed tool references only
- no unknown capability declarations
- no disallowed prompt directives

Skill loading should also record:

- install source
- version
- hash
- last validation timestamp

## Skill Installation

V1 install sources:

- local folder import
- signed zip import
- first-party gallery inside the app

Not in v1:

- public marketplace
- arbitrary remote fetch during runtime

Install flow:

1. user selects package
2. app validates manifest and files
3. app computes hash
4. app stores package in `Application Support`
5. app updates skill registry
6. app exposes skill in UI

## Skill Testing

Each skill package should support its own tests.

Recommended `tests.json` contents:

- sample input
- expected selected tools
- expected memory behavior
- expected approval requirements
- expected output shape

The harness should eventually provide a skill test runner that can execute these fixtures offline.

## What We Should Build

The `SkillEngine` module should own:

- skill manifest parsing
- skill registry
- skill matching
- progressive loading
- task graph compilation
- skill validation
- skill installation bookkeeping

That is the correct next step after the current harness foundation.
