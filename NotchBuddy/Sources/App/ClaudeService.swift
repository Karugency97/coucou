import Foundation
import Security
import UniformTypeIdentifiers

// MARK: - Keychain helpers

enum Keychain {
    static let service = "fr.louisraille.NotchBuddy"

    static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }
        // Delete existing item first (update pattern)
        let lookup: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(lookup as CFDictionary)
        // Add with strictest access control:
        // WhenUnlockedThisDeviceOnly = accessible only while Mac is unlocked,
        // never synced to iCloud, never migrated to another device.
        let item: [String: Any] = [
            kSecClass as String:            kSecClassGenericPassword,
            kSecAttrService as String:      service,
            kSecAttrAccount as String:      key,
            kSecValueData as String:        data,
            kSecAttrAccessible as String:   kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: kCFBooleanFalse!,
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func load(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Keychain cache (reads each key ONCE at launch; all subsequent access via dict)

final class KeychainStore: @unchecked Sendable {
    static let shared = KeychainStore()
    private var cache: [String: String] = [:]
    private let lock = NSLock()

    private static let allKeys = [
        "anthropic-api-key",
        "google-api-key",
        "openai-api-key",
        "resend-api-key", "resend-from",
        "n8n-url", "n8n-api-key",
        "vercel-token",
        "github-token",
        "stripe-api-key",
        "calcom-api-key",
        "notion-api-key",
        "openclaw-gateway-url", "openclaw-gateway-token",
    ]

    private init() {
        // Called once, on main thread (AppDelegate triggers shared at launch).
        for key in Self.allKeys {
            if let v = Keychain.load(key: key) { cache[key] = v }
        }
    }

    /// Thread-safe read — never touches the Keychain.
    func get(_ key: String) -> String? {
        lock.withLock { cache[key] }
    }

    /// Updates cache + persists to Keychain.
    func set(_ key: String, value: String) {
        lock.withLock { cache[key] = value }
        Keychain.save(key: key, value: value)
    }

    /// Removes from cache + Keychain only if the key was previously set.
    func remove(_ key: String) {
        let had = lock.withLock { () -> Bool in
            let exists = cache[key] != nil
            cache[key] = nil
            return exists
        }
        if had { Keychain.delete(key: key) }
    }
}

// MARK: - Claude API

@MainActor
final class ClaudeService {
    static let shared = ClaudeService()

    private let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    private let anthropicVersion = "2023-06-01"

    // MARK: - Model list

    /// Fetches available models from the Anthropic API in the order the API returns them
    /// (newest first). Returns an empty array on any error — callers fall back to a static list.
    static func fetchModels(apiKey: String) async -> [(id: String, label: String)] {
        guard let url = URL(string: "https://api.anthropic.com/v1/models?limit=100") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["data"] as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let id = item["id"] as? String,
                  let name = item["display_name"] as? String else { return nil }
            return (id: id, label: name)
        }
    }

    /// Fetches Gemini models via the OpenAI-compatible endpoint.
    /// Strips the "models/" prefix that the API sometimes returns and filters non-chat models.
    static func fetchGoogleModels(apiKey: String) async -> [(id: String, label: String)] {
        guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/openai/models") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["data"] as? [[String: Any]] else { return [] }
        let excluded = ["embed", "imagen", "veo", "aqa", "tts", "audio", "live"]
        return items.compactMap { item in
            guard let raw = item["id"] as? String else { return nil }
            let id = raw.hasPrefix("models/") ? String(raw.dropFirst(7)) : raw
            let lower = id.lowercased()
            guard !excluded.contains(where: { lower.contains($0) }) else { return nil }
            return (id: id, label: id)
        }
    }

    // MARK: - OpenClaw (through openclaw-bridge's local chat socket)

    nonisolated static let openClawChatSocket = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/NotchBuddy/openclaw-chat.sock").path

    /// Sends one JSON request line to openclaw-bridge and calls `onEvent` for each JSON line it answers,
    /// until the bridge closes the connection. Blocking — call off the main thread.
    nonisolated static func openClawBridge(_ request: [String: Any], onEvent: ([String: Any]) -> Void) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw bridgeError("socket() failed") }
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let path = Array(openClawChatSocket.utf8CString)
        guard path.count <= MemoryLayout.size(ofValue: addr.sun_path) else { throw bridgeError("Socket path too long") }
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: path.map { UInt8(bitPattern: $0) }) }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
            }
        }
        guard ok else { throw bridgeError("OpenClaw bridge not running — start openclaw-bridge (node bridge.mjs).") }
        var line = try JSONSerialization.data(withJSONObject: request)
        line.append(UInt8(ascii: "\n"))
        _ = line.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }

        var pending = Data()
        var buf = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = recv(fd, &buf, buf.count, 0)
            if n <= 0 { break }
            pending.append(contentsOf: buf[0..<n])
            while let nl = pending.firstIndex(of: UInt8(ascii: "\n")) {
                let chunk = pending[pending.startIndex..<nl]
                pending.removeSubrange(pending.startIndex...nl)
                if let obj = try? JSONSerialization.jsonObject(with: chunk) as? [String: Any] { onEvent(obj) }
            }
        }
    }

    /// The Gateway's web Control UI (ws(s):// URL from Settings → http(s)://).
    static var openClawWebURL: URL? {
        guard var s = KeychainStore.shared.get("openclaw-gateway-url")?
            .trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if s.hasPrefix("wss://") { s = "https://" + s.dropFirst(6) } else if s.hasPrefix("ws://") { s = "http://" + s.dropFirst(5) }
        return URL(string: s)
    }

    nonisolated private static func bridgeError(_ message: String) -> NSError {
        NSError(domain: "OpenClaw", code: 0, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// Lists the Gateway's agents (default agent first) through the bridge.
    static func fetchOpenClawModels() async -> [(id: String, label: String)] {
        await Task.detached {
            var ids: [String] = []
            try? openClawBridge(["op": "agents"]) { event in
                guard let agents = event["agents"] as? [String] else { return }
                let def = event["defaultId"] as? String ?? ""
                ids = agents.filter { $0 == def } + agents.filter { $0 != def }
            }
            return ids.map { (id: $0, label: $0) }
        }.value
    }

    /// Notch chat with an OpenClaw agent: persistent `agent:<id>:coucou` session on the Gateway,
    /// streamed into one assistant bubble. No local history — the Gateway keeps it (/new resets).
    func chatOpenClaw(query: String, context: PromptContext?, state: AppState) async {
        let agentId = state.openClawChatModel
        // /new, /reset: the bridge switches this agent to a fresh session — clear the bubble too.
        if query.range(of: #"^/(new|reset)\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            let ok = await Task.detached { (try? Self.openClawBridge(["op": "send", "agentId": agentId, "message": "/new"]) { _ in }) != nil }.value
            guard ok else { await showError("OpenClaw bridge not running.", state: state); return }
            state.chatHistory = [ChatMessage(role: .assistant, content: "New conversation started.")]
            state.stateOverride = nil
            state.view = .prompt
            return
        }
        var message = query
        var file: (mime: String, name: String, base64: String)?
        switch context {
        case .window(let app, let title, let url)?:
            message = "Context — App: \(app), Window: \(title)" + (url.map { ", URL: \($0)" } ?? "") + "\n\n" + query
        case .file(let name, let fileURL)?:
            guard let fileURL, let data = try? Data(contentsOf: fileURL) else {
                await showError("Can't read \(name).", state: state); return
            }
            guard data.count <= 15_000_000 else {
                await showError("\(name) is too large (15 MB max).", state: state); return
            }
            let mime = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            file = (mime, name, data.base64EncodedString())
        case nil:
            break
        }
        // Sent once: the Gateway session keeps the file / window context for the next turns.
        if context != nil { state.promptContext = nil }
        openClawBubble = nil
        do {
            try await Task.detached { [message, file] in
                var request: [String: Any] = ["op": "send", "agentId": agentId, "message": message]
                if let file {
                    request["attachments"] = [[
                        "type": file.mime.hasPrefix("image/") ? "image" : "file",
                        "mimeType": file.mime, "fileName": file.name, "content": file.base64,
                    ]]
                }
                try Self.openClawBridge(request) { event in
                    let type = event["type"] as? String ?? ""
                    let text = event["text"] as? String ?? event["message"] as? String ?? ""
                    // main.async keeps events in order (a Task per event would not)
                    DispatchQueue.main.async { MainActor.assumeIsolated { self.applyOpenClawEvent(type, text, state: state) } }
                }
            }.value
        } catch {
            await showError(error.localizedDescription, state: state)
        }
    }

    private var openClawBubble: UUID?

    /// Replaces the notch chat with the agent's `agent:<id>:coucou` transcript (last 30 text turns).
    func loadOpenClawHistory(state: AppState) async {
        let agentId = state.openClawChatModel
        let turns: [(role: String, text: String)] = await Task.detached {
            var out: [(role: String, text: String)] = []
            try? Self.openClawBridge(["op": "history", "agentId": agentId]) { event in
                for m in event["messages"] as? [[String: Any]] ?? [] {
                    if let role = m["role"] as? String, let text = m["text"] as? String { out.append((role, text)) }
                }
            }
            return out
        }.value
        // The user may have switched agent/provider or sent a message while we were loading.
        guard state.chatProvider == .openclaw, state.openClawChatModel == agentId, state.stateOverride == nil else { return }
        state.chatHistory = turns.map { ChatMessage(role: $0.role == "user" ? .user : .assistant, content: $0.text) }
    }

    /// Stops the agent's running reply; the bridge then sends the partial text as final.
    func stopOpenClaw(state: AppState) {
        let agentId = state.openClawChatModel
        Task.detached { try? Self.openClawBridge(["op": "abort", "agentId": agentId]) { _ in } }
    }

    private func applyOpenClawEvent(_ type: String, _ raw: String, state: AppState) {
        switch type {
        case "delta", "final":
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if let id = openClawBubble, let i = state.chatHistory.firstIndex(where: { $0.id == id }) {
                state.chatHistory[i].content = text
            } else {
                let msg = ChatMessage(role: .assistant, content: text)
                openClawBubble = msg.id
                state.chatHistory.append(msg)
            }
            if type == "final" {
                state.stateOverride = nil
                state.view = .prompt
                NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.happy)
            }
        case "error":
            state.stateOverride = .error
            state.noteMessage = raw.isEmpty ? "OpenClaw error" : raw
            state.view = .note
        default:
            break
        }
    }

    /// Fetches chat models from the OpenAI API, sorted newest-first by creation date.
    /// Excludes non-chat model families.
    static func fetchOpenAIModels(apiKey: String) async -> [(id: String, label: String)] {
        guard let url = URL(string: "https://api.openai.com/v1/models") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["data"] as? [[String: Any]] else { return [] }
        let excluded = ["embed", "tts", "whisper", "dall-e", "audio", "realtime", "moderat",
                        "codex", "computer-use", "transcribe", "image", "sora",
                        "babbage", "davinci", "instruct"]
        return items
            .compactMap { item -> (id: String, created: Int)? in
                guard let id = item["id"] as? String else { return nil }
                let lower = id.lowercased()
                guard !excluded.contains(where: { lower.contains($0) }) else { return nil }
                return (id: id, created: item["created"] as? Int ?? 0)
            }
            .sorted { $0.created > $1.created }
            .map { (id: $0.id, label: $0.id) }
    }

    /// Chosen in Settings; falls back to the default when the field is left empty.
    private var model: String {
        let m = AppState.shared.claudeModel.trimmingCharacters(in: .whitespacesAndNewlines)
        return m.isEmpty ? AppState.defaultClaudeModel : m
    }

    var apiKey: String? { KeychainStore.shared.get("anthropic-api-key") }

    // Multi-turn conversation messages (for API)
    private var conversationMessages: [[String: Any]] = []

    func clearConversation() {
        conversationMessages = []
    }

    private let systemPrompt = """
    You are Mochi, Louis's personal AI assistant embedded in the notch of his Mac. \
    You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
    Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
    No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.
    """

    private let webSearchTools: [[String: Any]] = [
        ["type": "web_search_20250305", "name": "web_search", "max_uses": 5]
    ]

    // MARK: - Chat (multi-turn, natural text + web search)

    func chat(query: String, context: PromptContext?, state: AppState) async {
        if state.chatProvider == .openclaw {
            await chatOpenClaw(query: query, context: context, state: state)
            return
        }
        guard state.chatProvider == .anthropic else {
            await chatOpenAICompatible(query: query, context: context, state: state)
            return
        }
        guard let key = apiKey, !key.isEmpty else {
            await showError("API key missing. Open settings.", state: state)
            return
        }

        // Build user content for this turn
        var userContent: [[String: Any]] = []

        // Add file/window context on first message only
        if conversationMessages.isEmpty, let context = context {
            switch context {
            case .window(let app, let title, let url):
                var text = "Context — App: \(app), Window: \(title)"
                if let url = url { text += ", URL: \(url)" }
                userContent.append(["type": "text", "text": text])
            case .file(let name, let fileURL):
                if let fileURL = fileURL, let block = readFileAsBlock(url: fileURL) {
                    userContent.append(block)
                }
                userContent.append(["type": "text", "text": "File: \(name)"])
            }
        }
        userContent.append(["type": "text", "text": query])

        conversationMessages.append(["role": "user", "content": userContent])

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 4096,
            "tools": webSearchTools,
            "system": systemPrompt,
            "messages": conversationMessages,
        ]

        do {
            let data = try await callAPI(body: body, key: key, beta: "web-search-2025-03-05")
            await handleChatResult(data, state: state)
        } catch {
            conversationMessages.removeLast()
            await showError(error.localizedDescription, state: state)
        }
    }

    // MARK: - OpenAI-compatible chat (Google Gemini / OpenAI)

    func chatOpenAICompatible(query: String, context: PromptContext?, state: AppState) async {
        let provider = state.chatProvider
        guard provider != .anthropic else { return }
        guard let key = KeychainStore.shared.get(provider.keychainKey), !key.isEmpty else {
            await showError("\(provider.displayName) API key missing. Configure it in Settings.", state: state)
            return
        }

        let baseURL: String
        switch provider {
        case .google:  baseURL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        case .openai:  baseURL = "https://api.openai.com/v1/chat/completions"
        case .anthropic, .openclaw: return
        }
        guard let url = URL(string: baseURL) else { return }

        // Build messages: system + conversation history + new user turn
        var msgs: [[String: Any]] = [["role": "system", "content": systemPrompt]]
        for m in conversationMessages {
            // Remap Anthropic content arrays to plain strings for OpenAI compat
            var simplified = m
            if let content = m["content"] as? [[String: Any]],
               let textBlock = content.first(where: { ($0["type"] as? String) == "text" }),
               let text = textBlock["text"] as? String {
                simplified["content"] = text
            }
            msgs.append(simplified)
        }
        // Add user message (plain text for OpenAI compat)
        var userText = query
        if conversationMessages.isEmpty, let ctx = context {
            switch ctx {
            case .window(let app, let title, let url):
                var prefix = "Context — App: \(app), Window: \(title)"
                if let u = url { prefix += ", URL: \(u)" }
                userText = prefix + "\n\n" + query
            case .file(let name, _):
                userText = "File: \(name)\n\n" + query
            }
        }
        msgs.append(["role": "user", "content": userText])
        conversationMessages.append(["role": "user", "content": userText])

        let body: [String: Any] = [
            "model": state.activeChatModel,
            "max_tokens": 4096,
            "messages": msgs,
        ]

        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let err = (json["error"] as? [String: Any])?["message"] as? String {
                    throw NSError(domain: "ChatAPI", code: 0, userInfo: [NSLocalizedDescriptionKey: err])
                }
                throw NSError(domain: "ChatAPI", code: 0, userInfo: [NSLocalizedDescriptionKey: "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"])
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let choices = json["choices"] as? [[String: Any]],
                  let message = choices.first?["message"] as? [String: Any],
                  let content = message["content"] as? String else {
                throw NSError(domain: "ChatAPI", code: 0, userInfo: [NSLocalizedDescriptionKey: "Unexpected response format"])
            }
            let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
            conversationMessages.append(["role": "assistant", "content": trimmed])
            await MainActor.run {
                state.chatHistory.append(ChatMessage(role: .assistant, content: trimmed))
                state.stateOverride = nil
                state.view = .prompt
                NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.happy)
            }
        } catch {
            conversationMessages.removeLast()
            await showError(error.localizedDescription, state: state)
        }
    }

    // MARK: - Structured search (M8 — window attach + web search)

    func search(query: String, context: PromptContext?, state: AppState) async {
        guard let key = apiKey, !key.isEmpty else {
            await showError("Anthropic API key missing. Open settings to configure it.", state: state)
            return
        }

        var userContent: [[String: Any]] = []
        switch context {
        case .window(let appName, let title, let url):
            var text = "App: \(appName)\nWindow title: \(title)"
            if let url = url { text += "\nURL: \(url)" }
            text += "\n\nRequest: \(query)"
            userContent.append(["type": "text", "text": text])
        case .file(let name, let fileURL):
            if let fileURL = fileURL, let fileBlock = readFileAsBlock(url: fileURL) {
                userContent.append(fileBlock)
            }
            userContent.append(["type": "text", "text": "File: \(name)\n\nRequest: \(query)"])
        case nil:
            userContent.append(["type": "text", "text": query])
        }

        let system = """
        You are an assistant built into the notch of a Mac. Reply in English, short and precise.
        Reply ONLY with valid JSON in this exact format:
        {"title":"...","items":[{"label":"...","detail":"...","url":"..."}],"note":"..."}
        Maximum 3 items. "url" is optional. "note" is optional.
        """

        let tools: [[String: Any]] = [
            ["type": "web_search_20250305", "name": "web_search", "max_uses": 3]
        ]

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 1024,
            "tools": tools,
            "system": system,
            "messages": [["role": "user", "content": userContent]],
        ]

        do {
            let result = try await callAPI(body: body, key: key, beta: "web-search-2025-03-05")
            await handleResult(result, state: state)
        } catch {
            await showError(error.localizedDescription, state: state)
        }
    }

    // MARK: - API call

    private func callAPI(body: [String: Any], key: String, beta: String? = nil) async throws -> Data {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue(anthropicVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let beta { request.setValue(beta, forHTTPHeaderField: "anthropic-beta") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 45

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            // Parse Anthropic error format: {"type":"error","error":{"type":"…","message":"…"}}
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let err = json["error"] as? [String: Any],
               let errType = err["type"] as? String,
               let errMsg = err["message"] as? String {
                if errType == "not_found_error" {
                    let id = AppState.shared.claudeModel
                    throw NSError(domain: "Claude", code: 0,
                        userInfo: [NSLocalizedDescriptionKey:
                            "Model not found: \(id). Pick another one in Settings."])
                }
                throw NSError(domain: "Claude", code: 0,
                    userInfo: [NSLocalizedDescriptionKey: errMsg])
            }
            let msg = String(data: data, encoding: .utf8) ?? "unknown error"
            throw NSError(domain: "Claude", code: 0, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        return data
    }

    // MARK: - Chat result handler

    private func handleChatResult(_ data: Data, state: AppState) async {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]] else {
            await showError("Unexpected API response.", state: state)
            return
        }

        // Store full content (includes tool_use/tool_result blocks) for correct multi-turn context
        conversationMessages.append(["role": "assistant", "content": content])

        guard let textBlock = content.first(where: { $0["type"] as? String == "text" }),
              let text = textBlock["text"] as? String, !text.isEmpty else {
            await showError("No response text.", state: state)
            return
        }

        // Add to display history
        state.chatHistory.append(ChatMessage(role: .assistant, content: text.trimmingCharacters(in: .whitespacesAndNewlines)))

        state.stateOverride = nil
        state.view = .prompt
        NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.happy)
    }

    // MARK: - Structured result handler

    private func handleResult(_ data: Data, state: AppState) async {
        // Extract text from Anthropic response (may contain tool_use / web_search_tool_result blocks)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]],
              let textBlock = content.first(where: { $0["type"] as? String == "text" }),
              let text = textBlock["text"] as? String else {
            await showError("Unexpected API response.", state: state)
            return
        }

        // Strip markdown code fences if present, then extract JSON object
        let cleanText: String
        if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}") {
            cleanText = String(text[start...end])
        } else {
            cleanText = text
        }

        // Try to parse as our JSON format
        if let resultData = cleanText.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any] {
            let title  = parsed["title"] as? String ?? "Result"
            let note   = parsed["note"] as? String
            var items: [ResultItem] = []
            if let rawItems = parsed["items"] as? [[String: Any]] {
                for item in rawItems.prefix(3) {
                    items.append(ResultItem(
                        label:  item["label"]  as? String ?? "",
                        detail: item["detail"] as? String ?? "",
                        url:    item["url"]    as? String
                    ))
                }
            }
            state.searchResult = SearchResult(title: title, items: items, note: note)
        } else {
            // Fallback: show raw text in 3-line chunks
            let lines = cleanText.components(separatedBy: "\n").filter { !$0.isEmpty }.prefix(3)
            state.searchResult = SearchResult(
                title: "Claude's response",
                items: lines.map { ResultItem(label: $0, detail: "", url: nil) },
                note: nil
            )
        }

        state.stateOverride = nil
        state.view = .result
        NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.proud)
    }

    private func showError(_ message: String, state: AppState) async {
        state.stateOverride = .error
        state.noteMessage = message
        state.view = .note
    }

    // MARK: - File content block builder

    private func readFileAsBlock(url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let ext = url.pathExtension.lowercased()
        let base64 = data.base64EncodedString()

        if ext == "pdf" {
            return ["type": "document", "source": ["type": "base64", "media_type": "application/pdf", "data": base64]]
        } else if ["jpg", "jpeg"].contains(ext) {
            return ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": base64]]
        } else if ext == "png" {
            return ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": base64]]
        } else if ext == "gif" {
            return ["type": "image", "source": ["type": "base64", "media_type": "image/gif", "data": base64]]
        } else if ext == "webp" {
            return ["type": "image", "source": ["type": "base64", "media_type": "image/webp", "data": base64]]
        } else {
            // Text/code — inline as text if <= 200 KB
            guard data.count <= 200_000,
                  let text = String(data: data, encoding: .utf8) else { return nil }
            return ["type": "text", "text": "File contents:\n\(text)"]
        }
    }
}
