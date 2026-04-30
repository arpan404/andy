import AVFoundation
import Foundation
import Observability
import Speech

public final class AppleVoiceProvider: NSObject, @unchecked Sendable {
    private let synthesizer = AVSpeechSynthesizer()
    private let observability: ObservabilityStore
    private let transcriptStream: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation

    public init(observability: ObservabilityStore) {
        self.observability = observability
        let stream = TranscriptStreamBuilder.make()
        self.transcriptStream = stream.stream
        self.continuation = stream.continuation
        super.init()
    }
}

extension AppleVoiceProvider: VoiceProvider {
    public func startCapture(config: VoiceCaptureConfiguration) async throws {
        // V1: permission and transcription stream are pluggable. This path logs the intent
        // and emits a placeholder transcript event until streaming STT is fully wired.
        await observability.append(name: "voice.capture.start", details: config.localeIdentifier)
        continuation.yield("Listening…")
    }

    public func stopCapture() async {
        await observability.append(name: "voice.capture.stop", details: "stopped")
    }

    public func streamTranscripts() -> AsyncStream<String> {
        transcriptStream
    }

    public func speak(_ text: String) async {
        let utterance = AVSpeechUtterance(string: text)
        synthesizer.speak(utterance)
        await observability.append(name: "voice.speak", details: text)
    }
}

private struct TranscriptStreamBuilder {
    let stream: AsyncStream<String>
    let continuation: AsyncStream<String>.Continuation

    static func make() -> TranscriptStreamBuilder {
        var localContinuation: AsyncStream<String>.Continuation?
        let stream = AsyncStream<String> { continuation in
            localContinuation = continuation
        }
        guard let continuation = localContinuation else {
            fatalError("Unable to initialize transcript stream continuation.")
        }
        return TranscriptStreamBuilder(stream: stream, continuation: continuation)
    }
}
