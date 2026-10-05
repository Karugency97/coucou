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
