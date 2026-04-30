import AssistantTypes
import Foundation

public protocol PolicyEngine: Sendable {
    func evaluate(action: ProposedAction, context: SafetyContext) -> PolicyDecision
}

public struct BalancedPolicyEngine: PolicyEngine {
    public init() {}

    public func evaluate(action: ProposedAction, context: SafetyContext) -> PolicyDecision {
        if action.sourceTrust == .untrustedExternal, action.risk != .readOnly {
            return .requireApproval(reason: "Untrusted content requested a side-effect action.")
        }

        if context.hasSensitiveContent, action.risk == .highImpactWrite {
            return .deny(reason: "Sensitive content cannot be sent through high-impact actions.")
        }

        switch action.risk {
        case .readOnly:
            return .allow
        case .lowImpactWrite:
            if context.trustedToolIDs.contains(action.toolID) {
                return .allow
            }
            return .requireApproval(reason: "Low-impact write needs confirmation for untrusted tools.")
        case .highImpactWrite:
            return .requireApproval(reason: "High-impact side effects always require explicit approval.")
        }
    }
}
