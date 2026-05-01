import AssistantRuntime
import AssistantTypes
import Foundation
import IntegrationKit
import MemoryStore
import ModelEngine
import Observability
import PluginHost
import PluginSDK
import PolicySafety
import SwiftData
import ToolEngine
import VoiceEngine

@MainActor
public enum AssistantAppContainer {
    public static func makeOrchestrator(context: ModelContext) -> AssistantOrchestrator {
        let observability = ObservabilityStore()
        let policyEngine = BalancedPolicyEngine()
        let memoryRepository = SwiftDataMemoryRepository(
            context: context,
            observability: observability
        )
        let localProvider = LocalModelProvider()
        let cloudProvider = CloudModelProvider()
        let router = ModelRouter(
            localProvider: localProvider,
            cloudProvider: cloudProvider,
            observability: observability
        )
        let voiceProvider = AppleVoiceProvider(observability: observability)
        let plugin = FirstPartyMeetingBriefPlugin(observability: observability)
        let pluginContext = PluginContext(
            pluginID: plugin.manifest.id,
            installURL: URL(fileURLWithPath: NSHomeDirectory())
        )
        let adapters: [any ToolAdapter] =
            [
                FileToolAdapter(observability: observability),
                CalendarToolAdapter(observability: observability),
                RemindersToolAdapter(observability: observability),
                MailToolAdapter(observability: observability),
                MessagesToolAdapter(observability: observability),
            ] + plugin.makeTools(context: pluginContext)
        let toolEngine = ToolEngine(
            policyEngine: policyEngine,
            observability: observability,
            adapters: adapters
        )

        return AssistantOrchestrator(
            modelRouter: router,
            toolEngine: toolEngine,
            memoryRepository: memoryRepository,
            observability: observability,
            voiceProvider: voiceProvider,
            policyEngine: policyEngine
        )
    }

    public static func makeViewModel(context: ModelContext) -> AssistantAppViewModel {
        let orchestrator = makeOrchestrator(context: context)
        return AssistantAppViewModel(orchestrator: orchestrator)
    }
}
