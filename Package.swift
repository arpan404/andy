// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AndyAssistant",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "AssistantTypes", targets: ["AssistantTypes"]),
        .library(name: "Observability", targets: ["Observability"]),
        .library(name: "PolicySafety", targets: ["PolicySafety"]),
        .library(name: "MemoryStore", targets: ["MemoryStore"]),
        .library(name: "ModelEngine", targets: ["ModelEngine"]),
        .library(name: "VoiceEngine", targets: ["VoiceEngine"]),
        .library(name: "IntegrationKit", targets: ["IntegrationKit"]),
        .library(name: "ToolEngine", targets: ["ToolEngine"]),
        .library(name: "PluginSDK", targets: ["PluginSDK"]),
        .library(name: "PluginHost", targets: ["PluginHost"]),
        .library(name: "AssistantRuntime", targets: ["AssistantRuntime"]),
        .library(name: "AppShell", targets: ["AppShell"]),
    ],
    targets: [
        .target(name: "AssistantTypes"),
        .target(
            name: "Observability",
            dependencies: ["AssistantTypes"]
        ),
        .target(
            name: "PolicySafety",
            dependencies: ["AssistantTypes"]
        ),
        .target(
            name: "MemoryStore",
            dependencies: ["AssistantTypes", "Observability"]
        ),
        .target(
            name: "ModelEngine",
            dependencies: ["AssistantTypes", "Observability"]
        ),
        .target(
            name: "VoiceEngine",
            dependencies: ["AssistantTypes", "Observability"]
        ),
        .target(
            name: "IntegrationKit",
            dependencies: ["AssistantTypes", "Observability"]
        ),
        .target(
            name: "ToolEngine",
            dependencies: [
                "AssistantTypes",
                "IntegrationKit",
                "Observability",
                "PolicySafety",
            ]
        ),
        .target(
            name: "PluginSDK",
            dependencies: [
                "AssistantTypes",
            ]
        ),
        .target(
            name: "PluginHost",
            dependencies: [
                "AssistantTypes",
                "Observability",
                "PluginSDK",
                "ToolEngine",
            ]
        ),
        .target(
            name: "AssistantRuntime",
            dependencies: [
                "AssistantTypes",
                "MemoryStore",
                "ModelEngine",
                "Observability",
                "PolicySafety",
                "PluginHost",
                "ToolEngine",
                "VoiceEngine",
            ]
        ),
        .target(
            name: "AppShell",
            dependencies: [
                "AssistantRuntime",
                "AssistantTypes",
                "IntegrationKit",
                "MemoryStore",
                "ModelEngine",
                "Observability",
                "PolicySafety",
                "PluginHost",
                "ToolEngine",
                "VoiceEngine",
            ]
        ),
        .testTarget(
            name: "AssistantArchitectureTests",
            dependencies: [
                "AssistantTypes",
                "MemoryStore",
                "ModelEngine",
                "PolicySafety",
                "ToolEngine",
            ]
        ),
        .testTarget(
            name: "PluginSystemTests",
            dependencies: [
                "AssistantTypes",
                "Observability",
                "PluginHost",
                "PluginSDK",
                "ToolEngine",
            ]
        ),
    ]
)
