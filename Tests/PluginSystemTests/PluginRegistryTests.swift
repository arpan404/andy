import Foundation
import Observability
import PluginHost
import Testing
import ToolEngine

@Test
@MainActor
func registersFirstPartyPluginTools() async throws {
    let observability = ObservabilityStore()
    let registry = PluginRegistry(observability: observability)
    let plugin = FirstPartyMeetingBriefPlugin(observability: observability)
    let installURL = URL(fileURLWithPath: "/tmp/andy-example-plugin")

    try await registry.register(provider: plugin, installURL: installURL)

    let manifests = registry.allManifests()
    let adapters = registry.allToolAdapters()

    #expect(manifests.count == 1)
    #expect(manifests.first?.id == "com.andy.meeting-brief")
    #expect(adapters.count == 1)
    #expect(adapters.first?.toolID == "meeting.brief.generate")
}
