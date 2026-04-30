import Foundation
import SwiftData

@Model
public final class MemoryEntity {
    @Attribute(.unique) public var id: UUID
    public var typeRaw: String
    public var subject: String
    public var content: String
    public var sourceChannel: String
    public var sourceSessionID: UUID?
    public var sourceToolID: String?
    public var sourceDocumentID: String?
    public var confidence: Double
    public var sensitivityRaw: String
    public var visibilityRaw: String
    public var createdAt: Date
    public var updatedAt: Date
    public var expiresAt: Date?

    public init(
        id: UUID,
        typeRaw: String,
        subject: String,
        content: String,
        sourceChannel: String,
        sourceSessionID: UUID?,
        sourceToolID: String?,
        sourceDocumentID: String?,
        confidence: Double,
        sensitivityRaw: String,
        visibilityRaw: String,
        createdAt: Date,
        updatedAt: Date,
        expiresAt: Date?
    ) {
        self.id = id
        self.typeRaw = typeRaw
        self.subject = subject
        self.content = content
        self.sourceChannel = sourceChannel
        self.sourceSessionID = sourceSessionID
        self.sourceToolID = sourceToolID
        self.sourceDocumentID = sourceDocumentID
        self.confidence = confidence
        self.sensitivityRaw = sensitivityRaw
        self.visibilityRaw = visibilityRaw
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.expiresAt = expiresAt
    }
}
