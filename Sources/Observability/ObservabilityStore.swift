import AssistantTypes
import Foundation

public struct EventLogRecord: Identifiable, Sendable {
    public let id: UUID
    public let name: String
    public let details: String
    public let timestamp: Date

    public init(id: UUID = UUID(), name: String, details: String, timestamp: Date = .now) {
        self.id = id
        self.name = name
        self.details = details
        self.timestamp = timestamp
    }
}

public actor ObservabilityStore {
    private var events: [EventLogRecord] = []

    public init() {}

    public func append(name: String, details: String) {
        events.append(EventLogRecord(name: name, details: details))
    }

    public func recent(limit: Int = 200) -> [EventLogRecord] {
        Array(events.suffix(limit))
    }
}
