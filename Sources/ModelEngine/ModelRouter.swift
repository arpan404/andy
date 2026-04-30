import AssistantTypes
import Foundation
import Observability

public protocol ModelRouting: Sendable {
    func generate(request: ModelRequest) async throws -> ModelResponse
    func stream(request: ModelRequest) -> AsyncThrowingStream<ModelChunk, Error>
}

public struct ModelRouterConfiguration: Sendable {
    public var preferCloudIfLatencyBudgetAboveMs: Int

    public init(preferCloudIfLatencyBudgetAboveMs: Int = 2200) {
        self.preferCloudIfLatencyBudgetAboveMs = preferCloudIfLatencyBudgetAboveMs
    }
}

public final class ModelRouter: ModelRouting, @unchecked Sendable {
    private let localProvider: any ModelProvider
    private let cloudProvider: any ModelProvider
    private let observability: ObservabilityStore
    private let configuration: ModelRouterConfiguration

    public init(
        localProvider: any ModelProvider,
        cloudProvider: any ModelProvider,
        observability: ObservabilityStore,
        configuration: ModelRouterConfiguration = .init()
    ) {
        self.localProvider = localProvider
        self.cloudProvider = cloudProvider
        self.observability = observability
        self.configuration = configuration
    }

    public func generate(request: ModelRequest) async throws -> ModelResponse {
        let provider = selectProvider(for: request)
        await observability.append(name: "model.generate", details: provider.providerID)
        return try await provider.generate(request: request)
    }

    public func stream(request: ModelRequest) -> AsyncThrowingStream<ModelChunk, Error> {
        let provider = selectProvider(for: request)
        Task { await observability.append(name: "model.stream", details: provider.providerID) }
        return provider.stream(request: request)
    }

    private func selectProvider(for request: ModelRequest) -> any ModelProvider {
        switch request.privacyLevel {
        case .localOnly:
            return localProvider
        case .allowCloud:
            return cloudProvider
        case .preferLocal:
            let isComplex = request.messages.count > 10 || request.latencyBudgetMs > configuration.preferCloudIfLatencyBudgetAboveMs
            return isComplex ? cloudProvider : localProvider
        }
    }
}
