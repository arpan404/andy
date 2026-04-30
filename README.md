# Andy Mac Assistant (Swift)

Single macOS assistant app architecture.  
No separate CLI runtime, no ACP transport; assistant runtime is embedded in app process.

## Modules

- `AssistantTypes` — shared domain/contracts
- `Observability` — event timeline storage
- `PolicySafety` — balanced policy and approval decisions
- `MemoryStore` — SwiftData entities and review-gated repository
- `ModelEngine` — local/cloud providers and router
- `VoiceEngine` — pluggable voice provider with Apple implementation
- `IntegrationKit` — Calendar, Reminders, Files, Mail, Messages adapters
- `ToolEngine` — adapter registry + policy-gated execution
- `AssistantRuntime` — orchestrator loop
- `AppShell` — SwiftUI/AppKit macOS UI shell

## Build and test

```bash
swift build
swift test
```

## Generate/open macOS app project

```bash
./scripts/generate-xcodeproj.sh
open Apps/AndyApps.xcodeproj
```
