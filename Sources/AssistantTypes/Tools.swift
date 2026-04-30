import Foundation

public struct ToolInvocation: Codable, Sendable, Hashable {
    public let id: UUID
    public let toolID: String
    public let input: [String: String]

    public init(id: UUID = UUID(), toolID: String, input: [String: String]) {
        self.id = id
        self.toolID = toolID
        self.input = input
    }
}

public struct ToolContext: Codable, Sendable {
    public let sessionID: UUID
    public let sourceTrust: SourceTrust

    public init(sessionID: UUID, sourceTrust: SourceTrust) {
        self.sessionID = sessionID
        self.sourceTrust = sourceTrust
    }
}

public struct ToolOutput: Codable, Sendable {
    public let data: [String: String]
    public let sourceTrust: SourceTrust
    public let summary: String

    public init(data: [String: String], sourceTrust: SourceTrust, summary: String) {
        self.data = data
        self.sourceTrust = sourceTrust
        self.summary = summary
    }
}

public protocol ToolAdapter {
    var toolID: String { get }
    var schema: [String: String] { get }
    func execute(input: [String: String], context: ToolContext) async throws -> ToolOutput
}
