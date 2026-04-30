import Foundation

public enum PrivacyLevel: String, Codable, Sendable {
    case localOnly
    case preferLocal
    case allowCloud
}

public struct AssistantInput: Codable, Sendable {
    public let text: String
    public let sourceTrust: SourceTrust
    public let privacyLevel: PrivacyLevel
    public let latencyBudgetMs: Int
    public let toolUseAllowed: Bool

    public init(
        text: String,
        sourceTrust: SourceTrust = .trustedUser,
        privacyLevel: PrivacyLevel = .preferLocal,
        latencyBudgetMs: Int = 2000,
        toolUseAllowed: Bool = true
    ) {
        self.text = text
        self.sourceTrust = sourceTrust
        self.privacyLevel = privacyLevel
        self.latencyBudgetMs = latencyBudgetMs
        self.toolUseAllowed = toolUseAllowed
    }
}

public struct ModelRequest: Codable, Sendable {
    public let messages: [ConversationMessage]
    public let privacyLevel: PrivacyLevel
    public let latencyBudgetMs: Int
    public let toolUseAllowed: Bool

    public init(
        messages: [ConversationMessage],
        privacyLevel: PrivacyLevel,
        latencyBudgetMs: Int,
        toolUseAllowed: Bool
    ) {
        self.messages = messages
        self.privacyLevel = privacyLevel
        self.latencyBudgetMs = latencyBudgetMs
        self.toolUseAllowed = toolUseAllowed
    }
}

public struct ModelChunk: Codable, Sendable {
    public let textDelta: String
    public let isFinal: Bool

    public init(textDelta: String, isFinal: Bool) {
        self.textDelta = textDelta
        self.isFinal = isFinal
    }
}

public struct ModelResponse: Codable, Sendable {
    public let text: String
    public let toolInvocations: [ToolInvocation]

    public init(text: String, toolInvocations: [ToolInvocation] = []) {
        self.text = text
        self.toolInvocations = toolInvocations
    }
}
