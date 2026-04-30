# Voice

Voice is plugin-owned system capability. Core and app surfaces only route requests through daemon APIs; microphone capture and speech output stay in `andy.voice.input` and `andy.voice.output`.

## Architecture

```text
web/cli/desktop
  -> daemon /voice/turn
  -> andy.voice.input voice.transcribe
  -> agent run
  -> andy.voice.output voice.speak
```

The daemon does not read the microphone directly and does not speak directly. It invokes declared plugin tools through the normal runtime, policy, approval, and audit boundary.

## Voice Input

`andy.voice.input` exposes:

- `voice.listen`: arms explicit activation metadata. It does not start ambient listening.
- `voice.record`: captures microphone audio for a bounded duration through platform adapters.
- `voice.transcribe`: normalizes provided transcript text, transcript files, or approved audio-file handoff.

Recording backends:

- macOS: `ffmpeg` with AVFoundation, or `sox`.
- Linux: `ffmpeg` with PulseAudio, `arecord`, or `parecord`.
- Windows: `ffmpeg` with DirectShow.

Andy does not ship an always-listening mode. Voice activation must be explicit, such as manual or push-to-talk.

Audio-file transcription currently returns a provider-required handoff unless transcript text or `transcriptPath` is supplied. A future STT provider plugin should implement real speech-to-text behind the same capability boundary.

## Deferred STT Work

Real audio-file speech-to-text is intentionally deferred. We need to test microphone capture on macOS, Linux, and Windows hardware, then add a provider plugin for transcription instead of baking STT into core or the daemon.

Open follow-up:

- Validate `voice.record` with real microphones on each platform.
- Add an STT provider plugin that can consume `audioPath` and return transcript text.
- Wire `/voice/turn` to use that STT provider when only `audioPath` is supplied.
- Add release smoke tests that avoid requiring live microphones by using transcript fixtures.

## Voice Output

`andy.voice.output` exposes:

- `voice.speak`: speaks text through the current platform adapter.
- `voice.stop`: terminates the active plugin-owned speech process.

Speech backends:

- macOS: `say`.
- Linux: `spd-say` or `espeak`.
- Windows: PowerShell `System.Speech`.

## Daemon And CLI

Daemon endpoints:

- `POST /voice/turn`
- `POST /voice/stop`

CLI:

```bash
andy voice turn "Summarize current Andy status"
andy voice turn --transcript /path/to/transcript.txt --no-speak
andy voice stop
```

`/voice/turn` accepts:

- `text`
- `audioPath`
- `transcriptPath`
- `skillIds`
- `modelProviderId`
- `voice`
- `speak`

If `speak` is true, the agent response is routed through `andy.voice.output.voice.speak`.

## Security

- `microphone.read` and `voice.record` are high-risk and approval-gated.
- `voice.speak` is explicit and cancellable.
- Voice turns still run through model-provider config, runtime policy, tool validation, and audit.
- Voice plugins may use platform command adapters, but they must not gain broad filesystem, shell, network, or secret access outside their manifest.
