import AssistantTypes
import Foundation
import Observability
import PluginSDK

public struct FirstPartyMeetingBriefPlugin: PluginToolProvider {
    public let manifest: PluginManifest
    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
        self.manifest = PluginManifest(
            id: "com.andy.meeting-brief",
            version: "0.1.0",
            displayName: "Meeting Brief",
            description: "Provides a tool for generating compact meeting brief notes.",
            entryExecutable: "MeetingBriefHelper",
            capabilities: [.toolProvider],
            tools: [
                PluginToolDescriptor(
                    id: "meeting.brief.generate",
                    description: "Create a structured meeting brief from a meeting topic.",
                    inputSchema: [
                        "topic": "meeting topic",
                        "attendees": "comma-separated attendee names",
                    ],
                    outputSchema: [
                        "brief": "generated briefing text"
                    ],
                    risk: .readOnly,
                    sourceTrust: .trustedSystem
                )
            ],
            bundledSkills: ["meeting-brief"]
        )
    }

    public func makeTools(context: PluginContext) -> [any ToolAdapter] {
        [MeetingBriefToolAdapter(observability: observability)]
    }
}

public struct MeetingBriefToolAdapter: ToolAdapter {
    public let toolID = "meeting.brief.generate"
    public let schema: [String: String] = [
        "topic": "meeting topic",
        "attendees": "comma-separated attendee names",
    ]

    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func execute(
        input: [String: String],
        context: ToolContext
    ) async throws -> ToolOutput {
        let topic = input["topic"] ?? "General sync"
        let attendees = input["attendees"] ?? "Unknown attendees"
        await observability.append(
            name: "tool.meeting-brief.execute",
            details: topic
        )

        return ToolOutput(
            data: [
                "brief": "Topic: \(topic). Attendees: \(attendees). Focus on decisions, blockers, and next steps."
            ],
            sourceTrust: .trustedSystem,
            summary: "Meeting brief prepared for \(topic)."
        )
    }
}
