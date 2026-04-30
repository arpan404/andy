import AssistantTypes
import ModelEngine
import Observability
import Testing

@Test
func localOnlyPrivacyUsesLocalProvider() async throws {
    let router = ModelRouter(
        localProvider: LocalModelProvider(),
        cloudProvider: CloudModelProvider(),
        observability: ObservabilityStore()
    )
    let request = ModelRequest(
        messages: [ConversationMessage(role: .user, content: "hello", sourceTrust: .trustedUser)],
        privacyLevel: .localOnly,
        latencyBudgetMs: 1000,
        toolUseAllowed: true
    )

    let response = try await router.generate(request: request)
    #expect(response.text.contains("Local response"))
}
