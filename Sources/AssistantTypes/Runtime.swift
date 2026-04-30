import Foundation

public struct PendingApproval: Identifiable, Codable, Sendable {
    public let id: UUID
    public let action: ProposedAction
    public let createdAt: Date

    public init(id: UUID = UUID(), action: ProposedAction, createdAt: Date = .now) {
        self.id = id
        self.action = action
        self.createdAt = createdAt
    }
}

public struct AssistantTurnOutput: Sendable {
    public let assistantMessage: ConversationMessage
    public let pendingApprovals: [PendingApproval]
    public let toolOutputs: [ToolOutput]

    public init(
        assistantMessage: ConversationMessage,
        pendingApprovals: [PendingApproval],
        toolOutputs: [ToolOutput]
    ) {
        self.assistantMessage = assistantMessage
        self.pendingApprovals = pendingApprovals
        self.toolOutputs = toolOutputs
    }
}
