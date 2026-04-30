import AssistantTypes
import PolicySafety
import Testing

@Test
func highImpactExternalActionRequiresApproval() {
    let engine = BalancedPolicyEngine()
    let action = ProposedAction(
        toolID: "messages.send",
        risk: .highImpactWrite,
        sourceTrust: .untrustedExternal,
        details: "Send external message"
    )
    let context = SafetyContext(trustedToolIDs: [], hasSensitiveContent: false)
    let decision = engine.evaluate(action: action, context: context)

    switch decision {
    case .requireApproval:
        #expect(Bool(true))
    default:
        Issue.record("Expected approval requirement.")
    }
}
