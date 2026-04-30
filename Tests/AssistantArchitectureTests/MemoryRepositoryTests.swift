import AssistantTypes
import Foundation
import MemoryStore
import Testing

@Test
func reviewGatedMemoryFlow() async throws {
    let repository = InMemoryMemoryRepository()
    let record = MemoryRecord(
        type: .preference,
        subject: "Music taste",
        content: "User prefers instrumental focus music while coding.",
        source: MemorySource(channel: "chat", sessionID: UUID()),
        confidence: 0.7,
        sensitivity: .low,
        visibility: .userReviewRequired
    )

    try await repository.propose(record: record)
    let pending = try await repository.query(filters: MemoryQuery(visibility: .userReviewRequired))
    #expect(pending.count == 1)

    try await repository.approve(id: record.id)
    let approved = try await repository.query(filters: MemoryQuery(visibility: .assistant))
    #expect(approved.count == 1)
}
