import AssistantTypes
import Foundation
import Observability

public protocol IntegrationToolAdapter: ToolAdapter {}

public enum IntegrationError: LocalizedError {
    case unsupportedAction(String)
    case permissionDenied(String)

    public var errorDescription: String? {
        switch self {
        case let .unsupportedAction(action):
            return "Unsupported integration action: \(action)"
        case let .permissionDenied(scope):
            return "Permission denied for: \(scope)"
        }
    }
}

public struct FileToolAdapter: IntegrationToolAdapter {
    public let toolID = "files.readWrite"
    public let schema: [String: String] = [
        "action": "list|read|write",
        "path": "absolute path",
    ]
    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func execute(input: [String: String], context: ToolContext) async throws -> ToolOutput {
        let action = input["action"] ?? "list"
        let path = input["path"] ?? NSHomeDirectory()
        await observability.append(name: "tool.files.execute", details: "\(action) \(path)")
        return ToolOutput(
            data: [
                "action": action,
                "path": path,
                "status": "stubbed-v1",
            ],
            sourceTrust: .trustedSystem,
            summary: "Files action '\(action)' prepared."
        )
    }
}
