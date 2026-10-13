import CasmKit
import Foundation
import Observation

/// The open transcript of one agent: history pages merged with live events.
@MainActor @Observable
final class ChatModel {
    let agentId: String
    /// Nil for the debug synthetic transcript.
    private(set) weak var host: HostModel?

    private(set) var items: [Item] = []
    @ObservationIgnored private var index: [String: Int] = [:]
    /// Index of `items[0]` in the full transcript, once the first page has loaded.
    private(set) var historyStart: Int?
    /// How many of `items` (from the front) came from history; the rest arrived live.
    @ObservationIgnored private var historyCount = 0
    private(set) var draft: Draft?
    private(set) var permissions: [PermissionRequest] = []
    private(set) var questions: [QuestionRequest] = []
    /// Latest context/cost report of the live session.
    private(set) var usage: Usage?
    private(set) var loading = false
    private(set) var loadingOlder = false
    var error: String?
    /// Expanded tool and reasoning rows; kept here so lazy rows remember it when recycled.
    var expanded: Set<String> = []
    /// Bumped when the view should jump to the bottom (first load, own message).
    private(set) var scrollToBottomRequest = 0

    struct Draft: Equatable {
        var kind: DeltaKind
        var text: String
    }

    static let pageSize = 100
    /// Rows rendered when (re)entering the bottom of the transcript, and how many more each
    /// scroll to the top reveals. Everything loaded stays in `items`; only the window is rendered.
    static let window = Exp.noWindow ? Int.max / 2 : Exp.int("CASM_WINDOW") ?? 60
    static let windowStep = Exp.int("CASM_STEP") ?? 40

    /// Index into `items` of the first rendered row.
    private(set) var windowStart = 0
    var visibleItems: ArraySlice<Item> { items[min(windowStart, items.count)...] }

    init(host: HostModel?, agentId: String) {
        self.host = host
        self.agentId = agentId
    }

    var agent: Agent? { host?.agent(agentId) }
    var status: AgentStatus { agent?.status ?? .idle }
    var canLoadOlder: Bool { windowStart > 0 || (historyStart ?? 0) > 0 }

    /// Called when the top of the rendered window scrolls into view: reveal more loaded rows,
    /// or fetch the previous history page once all loaded rows are shown.
    func revealOlder() async {
        if windowStart > 0 {
            windowStart = max(0, windowStart - Self.windowStep)
        } else {
            await loadOlder()
        }
    }

    /// Back at the bottom: shrink the window so the view only lays out recent rows again.
    func trimWindow() {
        let start = max(0, items.count - Self.window)
        if start > windowStart { windowStart = start }
    }

    // MARK: Lifecycle

    func open() {
        guard let host else { return }
        host.register(self)
        Task { await resync() }
    }

    func close() {
        guard let host else { return }
        host.unregister(self)
        let client = host.client, id = agentId
        Task { try? await client.unsubscribe(agentId: id) }
    }

    /// Subscribes first so no live event falls between the history read and the subscription,
    /// then merges the newest history page under whatever the in-flight turn already delivered.
    func resync() async {
        guard let host, host.isOnline else { return }
        loading = items.isEmpty
        defer { loading = false }
        do {
            let sub = try await host.client.subscribe(agentId: agentId)
            host.setStatus(sub.status, of: agentId)
            draft = nil
            permissions = sub.permissions
            questions = sub.questions
            for event in sub.turn { apply(event) }
            let first = historyStart == nil
            try await loadLatest()
            if let usage = try? await host.client.usage(agentId: agentId) { self.usage = usage }
            // Slow on the server (seconds); start early so "/" has them ready.
            Task { await loadCommands() }
            if first { scrollToBottomRequest += 1 }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Reloads the newest page and merges it: already loaded older pages stay in front,
    /// the page replaces what it covers, and live-only items stay after it.
    private func loadLatest() async throws {
        guard let host else { return }
        let page = try await host.client.history(agentId: agentId, limit: Self.pageSize)
        let fresh = Set(page.items.map(\.id))
        var older: ArraySlice<Item> = []
        // Only when the loaded history reaches this page; with a gap, start over from this page.
        if let start = historyStart, start < page.start, start + historyCount >= page.start {
            older = items.prefix(page.start - start)
        }
        // Live-only items (local notices, items not yet flushed to the session file) stay right
        // after the item they followed.
        var merged = Array(older) + page.items
        var previous: String?
        for (i, item) in items.enumerated() {
            defer { previous = item.id }
            guard i >= historyCount, !fresh.contains(item.id) else { continue }
            if previous == nil {
                merged.insert(item, at: 0)
            } else if let at = merged.firstIndex(where: { $0.id == previous }) {
                merged.insert(item, at: at + 1)
            } else {
                merged.append(item)
            }
        }
        setItems(merged)
        historyStart = page.start - older.count
        historyCount = older.count + page.items.count
    }

    func loadOlder() async {
        guard let host, let start = historyStart, start > 0, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await host.client.history(agentId: agentId, before: start, limit: Self.pageSize)
            let existing = Set(items.map(\.id))
            let added = page.items.filter { !existing.contains($0.id) }
            setItems(added + items)
            historyStart = page.start
            historyCount += added.count
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Live events

    func apply(_ event: AgentEvent) {
        switch event {
        case .turnStarted:
            draft = nil
        case .item(let item):
            upsert(item)
            if case .assistant = item { draft = nil }
            if case .reasoning = item { draft = nil }
        case .delta(let kind, let text):
            if draft?.kind == kind { draft!.text += text } else { draft = Draft(kind: kind, text: text) }
        case .permission(let request):
            if !permissions.contains(where: { $0.id == request.id }) { permissions.append(request) }
        case .permissionResolved(let requestId):
            permissions.removeAll { $0.id == requestId }
        case .question(let request):
            if !questions.contains(where: { $0.id == request.id }) { questions.append(request) }
        case .questionResolved(let requestId):
            questions.removeAll { $0.id == requestId }
        case .toolOutput(let itemId, let text):
            if let i = index[itemId], case .tool(var call) = items[i] {
                call.output = (call.output ?? "") + text
                items[i] = .tool(call)
            }
        case .usage(let usage):
            self.usage = usage
        case .turnEnded(_, let outcome, let error):
            draft = nil
            permissions = []
            questions = []
            if outcome == .failed { upsert(.notice(id: "failed-\(UUID().uuidString)", text: "Turn failed: \(error ?? "unknown error")")) }
            // History can hold items that never arrived live (e.g. the interrupt marker).
            Task { try? await loadLatest() }
        case .unknown:
            break
        }
    }

    private func upsert(_ item: Item) {
        if let i = index[item.id] {
            items[i] = item
        } else {
            index[item.id] = items.count
            items.append(item)
        }
    }

    private func setItems(_ new: [Item]) {
        // Keep the same newest rows in view: the window is anchored to the end.
        let shown = items.count - windowStart
        items = new
        windowStart = max(0, new.count - max(shown, Self.window))
        index = Dictionary(new.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    // MARK: Actions

    /// Returns false when sending failed, so the composer can keep the draft.
    @discardableResult
    func send(_ text: String, images: [ImageData] = []) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let host, !text.isEmpty || !images.isEmpty else { return false }
        do {
            let result = try await host.client.send(agentId: agentId, text: text, images: images)
            if result.queued { upsert(.notice(id: "queued-\(UUID().uuidString)", text: "Queued: runs after the current turn.")) }
            scrollToBottomRequest += 1
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// "!command": runs in the agent's cwd as its own turn. The server refuses it while a turn runs.
    @discardableResult
    func shell(_ command: String) async -> Bool {
        let command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let host, !command.isEmpty else { return false }
        do {
            try await host.client.shell(agentId: agentId, command: command)
            scrollToBottomRequest += 1
            return true
        } catch RPCError.server(1002, _) {
            error = "The agent is busy; run the command when it is idle."
            return false
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    // MARK: Composer data

    /// Slash commands and skills; loaded once per open chat.
    private(set) var commands: [SlashCommand] = []
    /// One shared load, so callers that arrive while it runs wait for the same result.
    @ObservationIgnored private var commandsLoad: Task<Void, Never>?

    func loadCommands() async {
        guard let host else { return }
        if commandsLoad == nil {
            let client = host.client, id = agentId
            commandsLoad = Task {
                do { commands = try await client.commands(agentId: id) } catch { commandsLoad = nil }
            }
        }
        await commandsLoad?.value
    }

    /// Files and directories under the agent's cwd for "@" mentions.
    func searchFiles(_ query: String) async -> [FileEntry] {
        guard let host else { return [] }
        return (try? await host.client.searchFiles(agentId: agentId, query: query, limit: 30).entries) ?? []
    }

    /// Bumped by ⌘K so the composer takes focus.
    var focusComposerRequest = 0

    func interrupt() async {
        await perform { try await $0.interrupt(agentId: self.agentId) }
    }

    func reload() async {
        await perform { try await $0.reload(agentId: self.agentId) }
        upsert(.notice(id: "reload-\(UUID().uuidString)", text: "Reloaded: the next message starts a new process on the same session."))
    }

    /// The old session stays in the provider's store, but casm no longer points at it.
    func restart() async {
        await perform { try await $0.restart(agentId: self.agentId) }
        guard error == nil else { return }
        setItems([.notice(id: "restart-\(UUID().uuidString)", text: "Restarted: the next message starts a new session.")])
        historyStart = 0
        historyCount = 0
        draft = nil
        permissions = []
        questions = []
    }

    func respond(to request: PermissionRequest, _ decision: PermissionDecision) async {
        await perform { try await $0.respondPermission(agentId: self.agentId, requestId: request.id, decision: decision) }
        if error == nil { permissions.removeAll { $0.id == request.id } }
    }

    /// `answers == nil` dismisses the question.
    func answer(_ request: QuestionRequest, _ answers: [String: AnswerValue]?) async {
        await perform { try await $0.answerQuestion(agentId: self.agentId, requestId: request.id, answers: answers) }
        if error == nil { questions.removeAll { $0.id == request.id } }
    }

    /// Merges a config change on the server ("" clears a field). The server applies it when the
    /// session is next opened: right away if idle, after the turn otherwise.
    func updateConfig(_ patch: AgentConfig) async {
        guard let host else { return }
        do {
            host.upsert(try await host.client.updateAgent(UpdateAgentParams(id: agentId, config: patch)))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func perform(_ action: (RPCClient) async throws -> Void) async {
        guard let host else { return }
        do {
            try await action(host.client)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    #if DEBUG
    static func synthetic(count: Int = 2000) -> ChatModel {
        let chat = ChatModel(host: nil, agentId: "synthetic")
        chat.setItems(SyntheticTranscript.items(count: count))
        chat.historyStart = 0
        chat.historyCount = count
        chat.scrollToBottomRequest += 1
        return chat
    }
    #endif
}
