import AVFoundation
import SwiftUI

/// Reads assistant replies aloud with the OpenClaw Gateway's TTS voice (tts.speak via openclaw-bridge,
/// e.g. ElevenLabs). One message at a time; tapping the playing message again stops it.
@MainActor
final class OpenClawSpeaker: NSObject, ObservableObject, AVAudioPlayerDelegate {
    static let shared = OpenClawSpeaker()

    /// Message being synthesized or played.
    @Published private(set) var activeId: UUID?
    private var player: AVAudioPlayer?

    func toggle(_ message: ChatMessage) {
        let wasActive = activeId == message.id
        stop()
        guard !wasActive else { return }
        activeId = message.id
        let id = message.id, text = message.content
        Task.detached {
            var audio: Data?
            var failure: String?
            do {
                try ClaudeService.openClawBridge(["op": "speak", "text": text]) { event in
                    if let b64 = event["base64"] as? String { audio = Data(base64Encoded: b64) }
                    else if let message = event["message"] as? String { failure = message }
                }
            } catch {
                failure = error.localizedDescription
            }
            let result = audio, error = failure
            await MainActor.run { self.play(id: id, audio: result, error: error) }
        }
    }

    func stop() {
        player?.stop()
        player = nil
        activeId = nil
    }

    private func play(id: UUID, audio: Data?, error: String?) {
        guard activeId == id else { return }  // stopped or replaced while synthesizing
        guard let audio, let player = try? AVAudioPlayer(data: audio) else {
            appendAppLog("nb.log", "OpenClaw TTS failed: \(error ?? "unreadable audio")")
            activeId = nil
            NSSound.beep()
            return
        }
        player.delegate = self
        self.player = player
        player.play()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finished = ObjectIdentifier(player)
        Task { @MainActor in
            if let current = self.player, ObjectIdentifier(current) == finished { self.player = nil; self.activeId = nil }
        }
    }
}

/// 🔊 under an assistant reply in the OpenClaw chat.
struct SpeakButton: View {
    let message: ChatMessage
    @ObservedObject private var speaker = OpenClawSpeaker.shared

    var body: some View {
        let active = speaker.activeId == message.id
        Button { speaker.toggle(message) } label: {
            Image(systemName: active ? "stop.circle" : "speaker.wave.2")
                .font(.system(size: 10))
                .foregroundColor(Color(hex: active ? "#F1F2F4" : "#6B7079"))
        }
        .buttonStyle(.plain)
        .help(active ? "Stop" : "Read aloud")
    }
}

/// Records a voice message for the OpenClaw chat (AAC .m4a, 2 min max). It is sent as an audio
/// attachment; the Gateway transcribes it (tools.media.audio → ElevenLabs Scribe) before the agent reads it.
@MainActor
final class OpenClawDictation: ObservableObject {
    static let shared = OpenClawDictation()

    @Published private(set) var isRecording = false
    private var recorder: AVAudioRecorder?
    private let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("coucou-voice.m4a")

    func toggle(state: AppState) {
        if isRecording { finish(state: state) } else { start(state: state) }
    }

    private func start(state: AppState) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            Task { @MainActor in
                guard granted else {
                    state.noteMessage = "Microphone access denied — System Settings → Privacy & Security → Microphone."
                    state.view = .note
                    return
                }
                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 16_000,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
                ]
                guard let recorder = try? AVAudioRecorder(url: self.fileURL, settings: settings),
                      recorder.record(forDuration: 120) else { NSSound.beep(); return }
                self.recorder = recorder
                self.isRecording = true
            }
        }
    }

    private func finish(state: AppState) {
        recorder?.stop()
        recorder = nil
        isRecording = false
        guard let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else { return }
        state.chatHistory.append(ChatMessage(role: .user, content: "🎤 Voice message"))
        state.stateOverride = .thinking
        let url = fileURL
        Task {
            await ClaudeService.shared.chatOpenClaw(query: "", context: .file(name: "voice.m4a", fileURL: url), state: state)
        }
    }
}

/// 🎤 in the OpenClaw chat input: tap to record, tap again to send.
struct MicButton: View {
    @ObservedObject var state: AppState
    @ObservedObject private var dictation = OpenClawDictation.shared

    var body: some View {
        Button { dictation.toggle(state: state) } label: {
            Image(systemName: dictation.isRecording ? "stop.circle.fill" : "mic")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color(hex: dictation.isRecording ? "#F4505E" : "#8E939C"))
        }
        .buttonStyle(.plain)
        .help(dictation.isRecording ? "Send voice message" : "Dictate (ElevenLabs Scribe)")
    }
}
