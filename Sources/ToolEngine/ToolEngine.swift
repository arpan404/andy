import AssistantTypes
import Foundation
import IntegrationKit
import Observability
import PolicySafety

public enum ToolExecutionResult: Sendable {
    case executed(ToolOutput)
    case approvalRequired(PendingApproval)
}

public final class ToolEngine: @unchecked Sendable {
    private let policyEngine: any PolicyEngine
    private let observability: ObservabilityStore
    private var adapters: [String: any ToolAdapter]

    public init(
        policyEngine: any PolicyEngine,
        observability: ObservabilityStore,
        adapters: [any ToolAdapter]
    ) {
        self.policyEngine = policyEngine
        self.observability = observability
        var mapped: [String: any ToolAdapter] = [:]
        for adapter in adapters {
            mapped[adapter.toolID] = adapter
        }
        self.adapters = mapped
    }

    public func register(_ adapter: any ToolAdapter) {
        adapters[adapter.toolID] = adapter
    }

    public func availableTools() -> [String] {
        adapters.keys.sorted()
    }

    public func execute(
        invocation: ToolInvocation,
        context: ToolContext,
        safetyContext: SafetyContext
    ) async throws -> ToolExecutionResult {
        guard let adapter = adapters[invocation.toolID] else {
            throw ToolEngineError.toolNotFound(invocation.toolID)
        }

        let proposedAction = ProposedAction(
            toolID: invocation.toolID,
            risk: Self.risk(for: invocation.toolID),
            sourceTrust: context.sourceTrust,
            details: "Executing \(invocation.toolID)"
        )

        let decision = policyEngine.evaluate(action: proposedAction, context: safetyContext)
        switch decision {
        case .allow:
            let output = try await adapter.execute(input: invocation.input, context: context)
            await observability.append(name: "tool.execute", details: invocation.toolID)
            return .executed(output)
        case let .requireApproval(reason):
            await observability.append(name: "tool.approval.required", details: reason)
            return .approvalRequired(PendingApproval(action: proposedAction))
        case let .deny(reason):
            await observability.append(name: "tool.denied", details: reason)
            throw ToolEngineError.actionDenied(reason)
        }
    }

    private static func risk(for toolID: String) -> ActionRisk {
        if toolID.contains("messages.send") || toolID.contains("mail.compose") {
            return .highImpactWrite
        }
        if toolID.contains("files") || toolID.contains("calendar") || toolID.contains("reminders") {
            return .lowImpactWrite
        }
        return .readOnly
    }
}

public enum ToolEngineError: LocalizedError {
    case toolNotFound(String)
    case actionDenied(String)

    public var errorDescription: String? {
        switch self {
        case let .toolNotFound(toolID):
            return "Tool not found: \(toolID)"
        case let .actionDenied(reason):
            return "Action denied: \(reason)"
        }
    }
}
