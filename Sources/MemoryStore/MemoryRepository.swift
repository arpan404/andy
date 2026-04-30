import AssistantTypes
import Foundation
import Observability
import SwiftData

public protocol MemoryRepository {
    func propose(record: MemoryRecord) async throws
    func approve(id: UUID) async throws
    func reject(id: UUID) async throws
    func query(filters: MemoryQuery) async throws -> [MemoryRecord]
}

public actor InMemoryMemoryRepository: MemoryRepository {
    private var records: [UUID: MemoryRecord] = [:]

    public init() {}

    public func propose(record: MemoryRecord) async throws {
        records[record.id] = record
    }

    public func approve(id: UUID) async throws {
        guard var record = records[id] else { return }
        record = MemoryRecord(
            id: record.id,
            type: record.type,
            subject: record.subject,
            content: record.content,
            source: record.source,
            confidence: record.confidence,
            sensitivity: record.sensitivity,
            visibility: .assistant,
            createdAt: record.createdAt,
            updatedAt: .now,
            expiresAt: record.expiresAt
        )
        records[id] = record
    }

    public func reject(id: UUID) async throws {
        records.removeValue(forKey: id)
    }

    public func query(filters: MemoryQuery) async throws -> [MemoryRecord] {
        records.values.filter { record in
            if let visibility = filters.visibility, record.visibility != visibility {
                return false
            }
            if let type = filters.type, record.type != type {
                return false
            }
            if let subjectContains = filters.subjectContains,
               !record.subject.localizedCaseInsensitiveContains(subjectContains) {
                return false
            }
            return true
        }
        .sorted(by: { $0.updatedAt > $1.updatedAt })
    }
}

@MainActor
public final class SwiftDataMemoryRepository: MemoryRepository {
    private let context: ModelContext
    private let observability: ObservabilityStore

    public init(context: ModelContext, observability: ObservabilityStore) {
        self.context = context
        self.observability = observability
    }

    public func propose(record: MemoryRecord) async throws {
        let entity = MemoryEntity(
            id: record.id,
            typeRaw: record.type.rawValue,
            subject: record.subject,
            content: record.content,
            sourceChannel: record.source.channel,
            sourceSessionID: record.source.sessionID,
            sourceToolID: record.source.toolID,
            sourceDocumentID: record.source.documentID,
            confidence: record.confidence,
            sensitivityRaw: record.sensitivity.rawValue,
            visibilityRaw: record.visibility.rawValue,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            expiresAt: record.expiresAt
        )
        context.insert(entity)
        try context.save()
        await observability.append(name: "memory.proposed", details: record.subject)
    }

    public func approve(id: UUID) async throws {
        let descriptor = FetchDescriptor<MemoryEntity>(
            predicate: #Predicate<MemoryEntity> { $0.id == id }
        )
        guard let entity = try context.fetch(descriptor).first else { return }
        entity.visibilityRaw = MemoryVisibility.assistant.rawValue
        entity.updatedAt = .now
        try context.save()
        await observability.append(name: "memory.approved", details: entity.subject)
    }

    public func reject(id: UUID) async throws {
        let descriptor = FetchDescriptor<MemoryEntity>(
            predicate: #Predicate<MemoryEntity> { $0.id == id }
        )
        guard let entity = try context.fetch(descriptor).first else { return }
        context.delete(entity)
        try context.save()
        await observability.append(name: "memory.rejected", details: entity.subject)
    }

    public func query(filters: MemoryQuery) async throws -> [MemoryRecord] {
        let descriptor = FetchDescriptor<MemoryEntity>()
        let entities = try context.fetch(descriptor)

        return entities.compactMap(Self.mapEntity)
            .filter { record in
                if let visibility = filters.visibility, record.visibility != visibility {
                    return false
                }
                if let type = filters.type, record.type != type {
                    return false
                }
                if let subjectContains = filters.subjectContains,
                   !record.subject.localizedCaseInsensitiveContains(subjectContains) {
                    return false
                }
                return true
            }
            .sorted(by: { $0.updatedAt > $1.updatedAt })
    }

    private static func mapEntity(_ entity: MemoryEntity) -> MemoryRecord? {
        guard
            let type = MemoryType(rawValue: entity.typeRaw),
            let sensitivity = MemorySensitivity(rawValue: entity.sensitivityRaw),
            let visibility = MemoryVisibility(rawValue: entity.visibilityRaw)
        else {
            return nil
        }

        return MemoryRecord(
            id: entity.id,
            type: type,
            subject: entity.subject,
            content: entity.content,
            source: MemorySource(
                channel: entity.sourceChannel,
                sessionID: entity.sourceSessionID,
                toolID: entity.sourceToolID,
                documentID: entity.sourceDocumentID
            ),
            confidence: entity.confidence,
            sensitivity: sensitivity,
            visibility: visibility,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
            expiresAt: entity.expiresAt
        )
    }
}
