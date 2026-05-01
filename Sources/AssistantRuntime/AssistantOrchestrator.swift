import AssistantTypes
import Foundation
import MemoryStore
import ModelEngine
import Observability
import PolicySafety
import ToolEngine
import VoiceEngine

public final class AssistantOrchestrator: @unchecked Sendable {
    private let modelRouter: any ModelRouting
    private let toolEngine: ToolEngine
    private let memoryRepository: any MemoryRepository
    private let observability: ObservabilityStore
    private let voiceProvider: any VoiceProvider
    private let policyEngine: any PolicyEngine

    private var sessionID = UUID()
    private var messages: [ConversationMessage] = []

    public init(
        modelRouter: any ModelRouting,
        toolEngine: ToolEngine,
        memoryRepository: any MemoryRepository,
        observability: ObservabilityStore,
        voiceProvider: any VoiceProvider,
        policyEngine: any PolicyEngine
    ) {
        self.modelRouter = modelRouter
        self.toolEngine = toolEngine
        self.memoryRepository = memoryRepository
        self.observability = observability
        self.voiceProvider = voiceProvider
        self.policyEngine = policyEngine
    }

    public func currentMessages() -> [ConversationMessage] {
        messages
    }

    public func startVoiceCapture() async throws {
        try await voiceProvider.startCapture(config: VoiceCaptureConfiguration())
    }

    public func stopVoiceCapture() async {
        await voiceProvider.stopCapture()
    }

    public func transcriptStream() -> AsyncStream<String> {
        voiceProvider.streamTranscripts()
    }

    public func process(input: AssistantInput) async throws -> AssistantTurnOutput {
        let userMessage = ConversationMessage(
            role: .user,
            content: input.text,
            sourceTrust: input.sourceTrust
        )
        messages.append(userMessage)
        await observability.append(name: "assistant.input", details: input.text)

        let modelRequest = ModelRequest(
            messages: messages,
            privacyLevel: input.privacyLevel,
            latencyBudgetMs: input.latencyBudgetMs,
            toolUseAllowed: input.toolUseAllowed
        )

        let modelResponse = try await modelRouter.generate(request: modelRequest)
        let toolResult = try await executeToolInvocations(
            invocations: modelResponse.toolInvocations,
            sourceTrust: input.sourceTrust
        )

        let assistantMessage = ConversationMessage(
            role: .assistant,
            content: modelResponse.text,
            sourceTrust: .trustedSystem
        )
        messages.append(assistantMessage)
        await voiceProvider.speak(modelResponse.text)

        if let proposed = buildMemoryProposal(from: modelResponse.text) {
            try await memoryRepository.propose(record: proposed)
        }

        await observability.append(name: "assistant.output", details: modelResponse.text)
        _ = policyEngine  // retained as core dependency for future policy-aware prompting.
        return AssistantTurnOutput(
            assistantMessage: assistantMessage,
            pendingApprovals: toolResult.pendingApprovals,
            toolOutputs: toolResult.outputs
        )
    }

    public func streamResponse(input: AssistantInput) -> AsyncThrowingStream<ModelChunk, Error> {
        let userMessage = ConversationMessage(
            role: .user,
            content: input.text,
            sourceTrust: input.sourceTrust
        )
        messages.append(userMessage)
        let modelRequest = ModelRequest(
            messages: messages,
            privacyLevel: input.privacyLevel,
            latencyBudgetMs: input.latencyBudgetMs,
            toolUseAllowed: input.toolUseAllowed
        )
        return modelRouter.stream(request: modelRequest)
    }

    private func executeToolInvocations(
        invocations: [ToolInvocation],
        sourceTrust: SourceTrust
    ) async throws -> (outputs: [ToolOutput], pendingApprovals: [PendingApproval]) {
        let context = ToolContext(sessionID: sessionID, sourceTrust: sourceTrust)
        let safetyContext = SafetyContext(
            trustedToolIDs: ["files.readWrite", "calendar.events", "reminders.items"],
            hasSensitiveContent: false
        )
        var outputs: [ToolOutput] = []
        var pending: [PendingApproval] = []

        for invocation in invocations {
            let result = try await toolEngine.execute(
                invocation: invocation,
                context: context,
                safetyContext: safetyContext
            )
            switch result {
            case .executed(let output):
                outputs.append(output)
            case .approvalRequired(let approval):
                pending.append(approval)
            }
        }
        return (outputs, pending)
    }

    private func buildMemoryProposal(from text: String) -> MemoryRecord? {
        guard text.count > 20 else { return nil }
        return MemoryRecord(
            type: .episode,
            subject: "Conversation summary",
            content: text,
            source: MemorySource(channel: "assistant", sessionID: sessionID),
            confidence: 0.65,
            sensitivity: .medium,
            visibility: .userReviewRequired
        )
    }
}
