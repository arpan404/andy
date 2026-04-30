import Foundation

public enum ActionRisk: String, Codable, Sendable {
    case readOnly
    case lowImpactWrite
    case highImpactWrite
}

public struct ProposedAction: Codable, Sendable {
    public let actionID: UUID
    public let toolID: String
    public let risk: ActionRisk
    public let sourceTrust: SourceTrust
    public let details: String

    public init(
        actionID: UUID = UUID(),
        toolID: String,
        risk: ActionRisk,
        sourceTrust: SourceTrust,
        details: String
    ) {
        self.actionID = actionID
        self.toolID = toolID
        self.risk = risk
        self.sourceTrust = sourceTrust
        self.details = details
    }
}

public struct SafetyContext: Codable, Sendable {
    public let trustedToolIDs: Set<String>
    public let hasSensitiveContent: Bool

    public init(trustedToolIDs: Set<String>, hasSensitiveContent: Bool) {
        self.trustedToolIDs = trustedToolIDs
        self.hasSensitiveContent = hasSensitiveContent
    }
}

public enum PolicyDecision: Codable, Sendable, Equatable {
    case allow
    case requireApproval(reason: String)
    case deny(reason: String)
}

public enum SafetyProfile: String, Codable, Sendable {
    case safe
    case balanced
    case power
}
