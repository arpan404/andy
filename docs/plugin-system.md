# Plugin System

## Purpose

Plugins exist for capabilities that cannot be expressed as declarative skills.

In Andy, plugins are installable executable extensions that add new capability to the harness without changing core app code.

Plugins are not the same as skills.

## What Plugins May Add

Plugins may provide:

- tools
- providers
- event sources
- artifact processors
- memory extractors

Examples:

- a browser automation helper
- a PDF form parser
- an OCR engine wrapper
- a custom local embedding engine
- a third-party app integration

## What Plugins Must Not Own

Plugins must not own:

- policy
- approval decisions
- persistent memory storage
- global runtime orchestration
- arbitrary app UI injection

Core rule:

Plugins contribute capability.
The harness decides whether that capability runs.

## Isolation Model

For macOS, plugins should be isolated out of process.

Recommended transport:

- runtime <-> plugin helper via XPC

Why:

- native macOS boundary
- better crash isolation
- permission containment
- clear lifecycle supervision

Avoid:

- in-process dynamic loading for untrusted plugins
- arbitrary script execution inside the main app process

## Plugin Package Format

Install location:

`~/Library/Application Support/Andy/Plugins/<plugin-id>/`

Required contents:

- `plugin.json`
- helper executable

Optional contents:

- `Resources/`
- `Skills/`
- `schemas/`
- `signature.json`

## `plugin.json`

Recommended fields:

- `id`
- `version`
- `display_name`
- `description`
- `entry_executable`
- `capabilities`
- `tools`
- `providers`
- `event_sources`
- `required_permissions`
- `bundled_skills`

Example capability categories:

- `tool-provider`
- `model-provider`
- `speech-provider`
- `artifact-processor`
- `event-source`

## Registration Model

Plugin startup flow:

1. app scans installed plugin manifests
2. plugin host validates package
3. plugin helper is started on demand
4. helper registers tools/providers/events with the host
5. host exposes these through the same internal interfaces used by built-in modules

The runtime should not care whether a tool is first-party or plugin-backed.

It should only see a validated capability descriptor.

## Plugin Tools

Plugin-contributed tools must look exactly like built-in tools.

They need:

- stable ID
- description
- input schema
- output schema
- risk metadata
- source trust behavior

This lets the existing `ToolEngine` and `PolicySafety` modules stay in control.

## Plugin Providers

Plugins may contribute providers for:

- model inference
- STT
- TTS
- embeddings

Provider plugins should register against the same protocols as first-party providers.

This keeps provider routing centralized in `ModelEngine` and future media engines.

## Bundled Skills

A plugin may bundle skills.

This is a useful pattern and mirrors Anthropic’s public distribution model where plugins can distribute skill sets.

Rule:

- plugin bundles skill packages
- skill packages still load through `SkillEngine`
- bundled skills do not get elevated privileges because they came from a plugin

## Security Model

Plugin validation should include:

- manifest schema validation
- executable presence
- code signature or package signature validation
- hash recording
- permission declaration review

Runtime controls must include:

- XPC boundary
- lifecycle supervision
- timeout handling
- crash reporting
- tool-call level policy enforcement

Plugins should never be trusted only because they are installed.

## Lifecycle

The future `PluginHost` module should own:

- discovery
- validation
- registration
- process launch
- health monitoring
- restart policy
- capability teardown

## What We Should Build

V1 plugin system should support:

- first-party plugin helpers
- local install
- manifest validation
- XPC registration
- tool/provider contribution
- bundled skills

Later:

- signatures
- permission UI
- update management
- external marketplace
