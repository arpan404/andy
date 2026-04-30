import AssistantTypes
import Foundation

public struct VoiceCaptureConfiguration: Sendable {
    public let localeIdentifier: String

    public init(localeIdentifier: String = "en-US") {
        self.localeIdentifier = localeIdentifier
    }
}

public protocol VoiceProvider: Sendable {
    func startCapture(config: VoiceCaptureConfiguration) async throws
    func stopCapture() async
    func streamTranscripts() -> AsyncStream<String>
    func speak(_ text: String) async
}
