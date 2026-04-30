# Development Workflow

## Project Structure

- `Apps/Desktop/Sources`  
  macOS app entrypoint and app target files.

- `Sources/AssistantTypes`  
  Shared domain contracts and interfaces.

- `Sources/Observability`  
  Event/timeline primitives.

- `Sources/PolicySafety`  
  Policy engine and approval decisions.

- `Sources/MemoryStore`  
  SwiftData models and memory repository.

- `Sources/ModelEngine`  
  Model providers and routing.

- `Sources/VoiceEngine`  
  Voice capture/transcript/speak provider interfaces and Apple implementation.

- `Sources/IntegrationKit`  
  Calendar, Reminders, Files, Mail, Messages tool adapters.

- `Sources/ToolEngine`  
  Tool registry and policy-gated execution.

- `Sources/AssistantRuntime`  
  Assistant orchestrator loop.

- `Sources/AppShell`  
  SwiftUI/AppKit shell, onboarding, panes, view models.

- `Tests/AssistantArchitectureTests`  
  Unit/integration architecture tests.

## Commands

- `make bootstrap`  
  Validate required local tooling.

- `make format`  
  Format Swift code.

- `make format-check`  
  Fail if formatting/lint style issues exist.

- `make lint`  
  Run style lint, architecture size limits, and strict compile lint.

- `make test`  
  Run Swift package tests.

- `make check`  
  Full local CI: bootstrap + lint + tests + Xcode project generation check.

- `make dev`  
  Generate/open the Xcode project for macOS app development.

## Strictness Rules

- Formatting and style: `xcrun swift-format` with repository config (`.swift-format`).
- Warnings are errors in lint pipeline.
- Concurrency strictness: `-strict-concurrency=complete` in lint compile.
- Monolith guards:
  - Max file size: 450 lines.
  - Max function size: 90 lines.
