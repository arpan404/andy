import AssistantRuntime
import AssistantTypes
import Foundation
import SwiftUI

@MainActor
public final class AssistantAppViewModel: ObservableObject {
    @Published public private(set) var messages: [ConversationMessage] = []
    @Published public private(set) var pendingApprovals: [PendingApproval] = []
    @Published public private(set) var voiceState: VoiceState = .idle
    @Published public private(set) var timeline: [String] = []
    @Published public var draftInput = ""
    @Published public var onboardingComplete = false

    private let orchestrator: AssistantOrchestrator

    public init(orchestrator: AssistantOrchestrator) {
        self.orchestrator = orchestrator
    }

    public func completeOnboarding() {
        onboardingComplete = true
    }

    public func submitText() {
        let text = draftInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draftInput = ""
        Task {
            await runTurn(text: text, trust: .trustedUser)
        }
    }

    public func pushToTalkStart() {
        Task {
            voiceState = .listening
            do {
                try await orchestrator.startVoiceCapture()
                for await transcript in orchestrator.transcriptStream() {
                    timeline.append("Transcript: \(transcript)")
                }
            } catch {
                timeline.append("Voice error: \(error.localizedDescription)")
                voiceState = .idle
            }
        }
    }

    public func pushToTalkStop() {
        Task {
            await orchestrator.stopVoiceCapture()
            voiceState = .idle
        }
    }

    public func approve(actionID: UUID) {
        pendingApprovals.removeAll(where: { $0.id == actionID })
        timeline.append("Approved action \(actionID.uuidString)")
    }

    private func runTurn(text: String, trust: SourceTrust) async {
        do {
            let output = try await orchestrator.process(
                input: AssistantInput(
                    text: text,
                    sourceTrust: trust,
                    privacyLevel: .preferLocal,
                    latencyBudgetMs: 2000,
                    toolUseAllowed: true
                )
            )
            messages = orchestrator.currentMessages()
            pendingApprovals = output.pendingApprovals
            timeline.append("Assistant: \(output.assistantMessage.content)")
            if !output.toolOutputs.isEmpty {
                timeline.append("Tools: \(output.toolOutputs.map(\.summary).joined(separator: " | "))")
            }
        } catch {
            timeline.append("Turn error: \(error.localizedDescription)")
        }
    }
}
