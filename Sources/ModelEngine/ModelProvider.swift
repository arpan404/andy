import AssistantTypes
import Foundation

public protocol ModelProvider: Sendable {
    var providerID: String { get }
    func generate(request: ModelRequest) async throws -> ModelResponse
    func stream(request: ModelRequest) -> AsyncThrowingStream<ModelChunk, Error>
}

public struct LocalModelProvider: ModelProvider {
    public let providerID = "local.apple"

    public init() {}

    public func generate(request: ModelRequest) async throws -> ModelResponse {
        let prompt = request.messages.last?.content ?? ""
        let text = "Local response: \(prompt)"
        return ModelResponse(text: text)
    }

    public func stream(request: ModelRequest) -> AsyncThrowingStream<ModelChunk, Error> {
        let prompt = request.messages.last?.content ?? ""
        return AsyncThrowingStream { continuation in
            continuation.yield(ModelChunk(textDelta: "Local response: ", isFinal: false))
            continuation.yield(ModelChunk(textDelta: prompt, isFinal: true))
            continuation.finish()
        }
    }
}

public struct CloudModelProvider: ModelProvider {
    public let providerID = "cloud.default"

    public init() {}

    public func generate(request: ModelRequest) async throws -> ModelResponse {
        let prompt = request.messages.last?.content ?? ""
        let text = "Cloud response: \(prompt)"
        return ModelResponse(text: text)
    }

    public func stream(request: ModelRequest) -> AsyncThrowingStream<ModelChunk, Error> {
        let prompt = request.messages.last?.content ?? ""
        return AsyncThrowingStream { continuation in
            continuation.yield(ModelChunk(textDelta: "Cloud response: ", isFinal: false))
            continuation.yield(ModelChunk(textDelta: prompt, isFinal: true))
            continuation.finish()
        }
    }
}
