import Foundation

public enum ActorRole: String, Codable, Sendable {
    case system
    case user
    case assistant
    case tool
}

public enum SourceTrust: String, Codable, Sendable {
    case trustedUser
    case trustedSystem
    case untrustedExternal
}

public struct ConversationMessage: Codable, Sendable, Identifiable, Hashable {
    public let id: UUID
    public let role: ActorRole
    public let content: String
    public let sourceTrust: SourceTrust
    public let createdAt: Date

    public init(
        id: UUID = UUID(),
        role: ActorRole,
        content: String,
        sourceTrust: SourceTrust,
        createdAt: Date = .now
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.sourceTrust = sourceTrust
        self.createdAt = createdAt
    }
}

public enum VoiceState: String, Codable, Sendable {
    case idle
    case listening
    case transcribing
    case speaking
}
