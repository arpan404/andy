import Foundation

public enum MemoryType: String, Codable, Sendable {
    case preference
    case fact
    case relationship
    case project
    case procedure
    case episode
}

public enum MemorySensitivity: String, Codable, Sendable {
    case low
    case medium
    case high
}

public enum MemoryVisibility: String, Codable, Sendable {
    case assistant
    case userReviewRequired
    case hiddenUntilApproved
}

public struct MemorySource: Codable, Sendable, Hashable {
    public let channel: String
    public let sessionID: UUID?
    public let toolID: String?
    public let documentID: String?

    public init(
        channel: String,
        sessionID: UUID? = nil,
        toolID: String? = nil,
        documentID: String? = nil
    ) {
        self.channel = channel
        self.sessionID = sessionID
        self.toolID = toolID
        self.documentID = documentID
    }
}

public struct MemoryRecord: Codable, Sendable, Identifiable {
    public let id: UUID
    public let type: MemoryType
    public let subject: String
    public let content: String
    public let source: MemorySource
    public let confidence: Double
    public let sensitivity: MemorySensitivity
    public let visibility: MemoryVisibility
    public let createdAt: Date
    public let updatedAt: Date
    public let expiresAt: Date?

    public init(
        id: UUID = UUID(),
        type: MemoryType,
        subject: String,
        content: String,
        source: MemorySource,
        confidence: Double,
        sensitivity: MemorySensitivity,
        visibility: MemoryVisibility,
        createdAt: Date = .now,
        updatedAt: Date = .now,
        expiresAt: Date? = nil
    ) {
        self.id = id
        self.type = type
        self.subject = subject
        self.content = content
        self.source = source
        self.confidence = confidence
        self.sensitivity = sensitivity
        self.visibility = visibility
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.expiresAt = expiresAt
    }
}

public struct MemoryQuery: Sendable {
    public let visibility: MemoryVisibility?
    public let type: MemoryType?
    public let subjectContains: String?

    public init(
        visibility: MemoryVisibility? = nil,
        type: MemoryType? = nil,
        subjectContains: String? = nil
    ) {
        self.visibility = visibility
        self.type = type
        self.subjectContains = subjectContains
    }
}
