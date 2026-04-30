import AssistantTypes
import EventKit
import Foundation
import Observability

public final class CalendarToolAdapter: IntegrationToolAdapter {
    public let toolID = "calendar.events"
    public let schema: [String: String] = [
        "action": "list_today|create",
        "title": "event title (for create)",
    ]

    private let eventStore = EKEventStore()
    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func execute(input: [String: String], context: ToolContext) async throws -> ToolOutput {
        let action = input["action"] ?? "list_today"
        await observability.append(name: "tool.calendar.execute", details: action)

        switch action {
        case "list_today":
            let granted = try await eventStore.requestFullAccessToEvents()
            if !granted {
                throw IntegrationError.permissionDenied("Calendar")
            }
            return ToolOutput(
                data: ["status": "ok", "action": action],
                sourceTrust: .untrustedExternal,
                summary: "Calendar access granted. Event listing is available."
            )
        case "create":
            let granted = try await eventStore.requestFullAccessToEvents()
            if !granted {
                throw IntegrationError.permissionDenied("Calendar")
            }
            return ToolOutput(
                data: ["status": "ready", "action": action],
                sourceTrust: .trustedSystem,
                summary: "Calendar create flow is ready."
            )
        default:
            throw IntegrationError.unsupportedAction(action)
        }
    }
}

public final class RemindersToolAdapter: IntegrationToolAdapter {
    public let toolID = "reminders.items"
    public let schema: [String: String] = ["action": "list|create"]

    private let eventStore = EKEventStore()
    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func execute(input: [String: String], context: ToolContext) async throws -> ToolOutput {
        let action = input["action"] ?? "list"
        await observability.append(name: "tool.reminders.execute", details: action)
        let granted = try await eventStore.requestFullAccessToReminders()
        if !granted {
            throw IntegrationError.permissionDenied("Reminders")
        }
        return ToolOutput(
            data: ["status": "ok", "action": action],
            sourceTrust: .trustedSystem,
            summary: "Reminders action '\(action)' prepared."
        )
    }
}
