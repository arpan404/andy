import AssistantRuntime
import AssistantTypes
import IntegrationKit
import MemoryStore
import ModelEngine
import Observability
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
        let adapters: [any ToolAdapter] = [
            FileToolAdapter(observability: observability),
            CalendarToolAdapter(observability: observability),
            RemindersToolAdapter(observability: observability),
            MailToolAdapter(observability: observability),
            MessagesToolAdapter(observability: observability),
        ]
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
