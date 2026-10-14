import CasmKit
import Foundation
import Observation

/// The open transcript of one agent: history pages merged with live events.
@MainActor @Observable
final class ChatModel {
    /// Empty until the first message creates the agent of a new-agent chat.
    private(set) var agentId: String
    /// Set while this chat is a project's empty new-agent chat: the composer picks provider and
    /// config locally, and the first message creates the agent with them.
    private(set) var newAgent: NewAgent?
    /// Called once the first message created the agent (to select it).
    @ObservationIgnored var onCreated: ((Agent) -> Void)?
    /// Set when the app moved on to another chat; a create still in flight then doesn't take the
    /// view back, and a failed one leaves its text in the project's draft.
    @ObservationIgnored private var detached = false
    /// The first message while agent.create runs, shown as sent (and kept in `items` until the
    /// agent's own copy of it arrives).
    private(set) var firstMessage: Item?
    private static let firstMessageID = "local-first-message"

    struct NewAgent: Equatable {
        var projectId: String
        var provider: ProviderID
        var config = AgentConfig()
    }
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

    /// An empty chat for a project; sending the first message creates the agent.
    init(host: HostModel, newAgentIn projectId: String) {
        self.host = host
        agentId = ""
        let providers = host.info?.providers ?? [.claude]
        newAgent = NewAgent(projectId: projectId, provider: providers.contains(.claude) ? .claude : providers.first ?? .claude)
    }

    var agent: Agent? { newAgent == nil ? host?.agent(agentId) : nil }
    var provider: ProviderID? { newAgent?.provider ?? agent?.provider }
    var config: AgentConfig? { newAgent?.config ?? agent?.config }
    var project: Project? { (newAgent?.projectId ?? agent?.projectId).flatMap { host?.project($0) } }
    /// Where composer drafts are kept: per agent, or per project for a new-agent chat.
    var draftKey: String { Drafts.key(host: host?.id, agent: newAgent.map { "new:\($0.projectId)" } ?? agentId) }
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

    /// The window over `new` that keeps the same newest rows in view (anchored to the end) but
    /// never drops the row that was first: rows inserted above the reader (history merged after a
    /// turn) would otherwise push it out of the window and move what they're reading.
    static func windowStart(old: [Item], start: Int, new: [Item]) -> Int {
        let shown = old.count - start
        let fromEnd = max(0, new.count - max(shown, window))
        guard start < old.count, let first = new.firstIndex(where: { $0.id == old[start].id }) else { return fromEnd }
        return min(fromEnd, first)
    }

    /// Back at the bottom: shrink the window so the view only lays out recent rows again.
    func trimWindow() {
        let start = max(0, items.count - Self.window)
        if start > windowStart { windowStart = start }
    }

    // MARK: Lifecycle

    func open() {
        guard let host, newAgent == nil else { return }
        host.register(self)
        Task { await resync() }
    }

    func close() {
        detached = true
        guard let host, newAgent == nil else { return }
        host.unregister(self)
        let client = host.client, id = agentId
        Task { try? await client.unsubscribe(agentId: id) }
    }

    /// Left on screen for another chat but kept cached (and subscribed). Its next view starts at the
    /// bottom, so only the newest rows stay in the window; a very long transcript drops its oldest
    /// loaded pages (they load again on scrolling up).
    func park(keeping cap: Int = 1000) {
        if let start = historyStart, items.count > cap {
            let drop = min(items.count - cap, historyCount)
            if drop > 0 {
                setItems(Array(items.dropFirst(drop)))
                historyStart = start + drop
                historyCount -= drop
                expanded.formIntersection(index.keys)
            }
        }
        windowStart = max(0, items.count - Self.window)
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
            await refreshPending()
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
        setItems(Self.merge(Array(older) + page.items, fresh: fresh, items: items, historyCount: historyCount))
        historyStart = page.start - older.count
        historyCount = older.count + page.items.count
    }

    /// Live-only items (local notices, the running turn not yet in the session file) stay right
    /// after the item they followed. One that followed nothing loaded came in live before any
    /// history (opening a chat mid-turn), so it is newer than the page and goes at the end.
    static func merge(_ history: [Item], fresh: Set<String>, items: [Item], historyCount: Int) -> [Item] {
        var merged = history
        var previous: String?
        for (i, item) in items.enumerated() {
            defer { previous = item.id }
            guard i >= historyCount, !fresh.contains(item.id) else { continue }
            if let previous, let at = merged.firstIndex(where: { $0.id == previous }) {
                merged.insert(item, at: at + 1)
            } else {
                merged.append(item)
            }
        }
        return merged
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
            Drafts.shared.clearAnswers(requestId)
        case .toolOutput(let itemId, let text):
            if let i = index[itemId], case .tool(var call) = items[i] {
                call.output = (call.output ?? "") + text
                items[i] = .tool(call)
            }
        case .usage(let usage):
            self.usage = usage
        case .turnEnded(_, let outcome, let error, let limit):
            draft = nil
            permissions = []
            questions = []
            if let limit {
                self.limit = limit
            } else if outcome == .completed {
                self.limit = nil
            }
            if outcome == .failed && limit == nil { upsert(.notice(id: "failed-\(UUID().uuidString)", text: "Turn failed: \(error ?? "unknown error")")) }
            // History can hold items that never arrived live (e.g. the interrupt marker).
            Task { try? await loadLatest() }
        case .unknown:
            break
        }
    }

    private func upsert(_ item: Item) {
        if case .user(let id, _, _) = item, id != Self.firstMessageID, index[Self.firstMessageID] != nil {
            setItems(items.filter { $0.id != Self.firstMessageID })
        }
        if let i = index[item.id] {
            items[i] = item
        } else {
            expandIfShell(item)
            index[item.id] = items.count
            items.append(item)
        }
    }

    /// "!" commands (casm's "shell" tool items) start expanded: their output is the point. The
    /// user can still collapse them; that sticks because only new items are expanded.
    private func expandIfShell(_ item: Item) {
        // The user's own "!" commands are marked origin: user; the agent's tool calls stay collapsed.
        if case .tool(let call) = item, call.isUserCommand { expanded.insert(call.id) }
    }

    /// The item rendered just above this one, for spacing.
    func previous(of item: Item) -> Item? {
        guard let i = index[item.id], i > windowStart, i - 1 < items.count else { return nil }
        return items[i - 1]
    }

    private func setItems(_ new: [Item]) {
        // The agent's copy of the first message replaces the local one.
        var new = new
        if new.contains(where: { if case .user(let id, _, _) = $0 { id != Self.firstMessageID } else { false } }) {
            new.removeAll { $0.id == Self.firstMessageID }
        }
        for item in new where index[item.id] == nil { expandIfShell(item) }
        windowStart = Self.windowStart(old: items, start: windowStart, new: new)
        items = new
        index = Dictionary(new.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    // MARK: Actions

    /// Returns false when sending failed, so the composer can keep the draft.
    @discardableResult
    func send(_ text: String, images: [ImageData] = []) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let host, !text.isEmpty || !images.isEmpty else { return false }
        if newAgent != nil { return await create(text, images: images) }
        do {
            let result = try await host.client.send(agentId: agentId, text: text, images: images)
            // Queued and deferred messages show in the pending strip above the composer.
            if result.queued || result.deferredUntil != nil || result.pendingId != nil { await refreshPending() }
            scrollToBottomRequest += 1
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Creates the new agent with the first message as its prompt, then becomes its chat: the
    /// same model (and composer) stays on screen, subscribed to the agent's first turn.
    private func create(_ text: String, images: [ImageData]) async -> Bool {
        // A second send while the first create is in flight would create a second agent into this chat.
        guard let host, let new = newAgent, firstMessage == nil else { return false }
        var params = CreateAgentParams(projectId: new.projectId, provider: new.provider, name: Self.agentName(from: text),
                                       config: new.config, prompt: text.isEmpty ? nil : text)
        if !images.isEmpty { params.images = images }
        firstMessage = .user(id: Self.firstMessageID, text: text, images: images)
        defer { firstMessage = nil }
        do {
            let agent = try await host.client.createAgent(params)
            host.upsert(agent)
            agentId = agent.id
            newAgent = nil
            error = nil
            if let firstMessage { upsert(firstMessage) }
            // Left meanwhile: the agent runs and is in the sidebar; don't pull the user back.
            guard !detached else { return true }
            open()
            onCreated?(agent)
            return true
        } catch {
            self.error = error.localizedDescription
            if detached { Drafts.shared.save(draftKey, text: text, images: images) }
            return false
        }
    }

    /// A name for an agent started from its first message: the first line, whitespace collapsed,
    /// cut at a word boundary to about 40 characters. Nil (the server's default) without text.
    static func agentName(from text: String, limit: Int = 40) -> String? {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.allSatisfy(\.isWhitespace) } ?? ""
        let words = line.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return nil }
        var name = ""
        for word in words {
            let next = name.isEmpty ? String(word) : name + " " + word
            if next.count > limit {
                // One long word: cut it rather than return nothing.
                return (name.isEmpty ? String(word.prefix(limit)) : name) + "…"
            }
            name = next
        }
        return name
    }

    /// Picks the new agent's provider; model, effort and mode ids belong to one provider, so
    /// they start over with its defaults.
    func setProvider(_ provider: ProviderID) {
        guard newAgent != nil, newAgent?.provider != provider else { return }
        newAgent?.provider = provider
        newAgent?.config = AgentConfig()
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

    // MARK: Pending messages and limits (B2)

    /// Messages the server will send later (queued behind a turn, waiting for a limit, scheduled).
    private(set) var pending: [PendingMessage] = []
    /// The last turn failed on a usage limit (cleared by a completed turn).
    private(set) var limit: TurnLimit?
    /// Text the composer should take over (Edit on a pending message).
    var composerTakeover: String?

    func refreshPending() async {
        guard let host else { return }
        if let list = try? await host.client.pending(agentId: agentId) { pending = list }
    }

    /// Coalesces bursts of agent.changed notifications.
    @ObservationIgnored private var pendingRefresh: Task<Void, Never>?
    func refreshPendingSoon() {
        pendingRefresh?.cancel()
        pendingRefresh = Task {
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await refreshPending()
        }
    }

    func cancelPending(_ message: PendingMessage?) async {
        await perform { _ = try await $0.cancelPending(agentId: self.agentId, messageId: message?.id) }
        await refreshPending()
    }

    /// Sends a pending message now: into the running turn (steer) if busy, else as the next turn.
    func sendPendingNow(_ message: PendingMessage) async {
        guard let host else { return }
        do {
            // 0 means it was sent meanwhile.
            guard try await host.client.cancelPending(agentId: agentId, messageId: message.id) > 0 else {
                await refreshPending()
                return
            }
            try await host.client.send(agentId: agentId, text: message.text, whenBusy: status.isBusy ? .steer : nil)
            scrollToBottomRequest += 1
        } catch {
            self.error = error.localizedDescription
        }
        await refreshPending()
    }

    /// Sends a failed message again; it leaves the pending list (queued again if the agent is busy).
    func retryPending(_ message: PendingMessage) async {
        await perform { _ = try await $0.retryPending(agentId: self.agentId, messageId: message.id) }
        scrollToBottomRequest += 1
        await refreshPending()
    }

    /// Takes a pending message back into the composer to change it.
    func editPending(_ message: PendingMessage) async {
        guard let host else { return }
        do {
            let cancelled = try await host.client.cancelPending(agentId: agentId, messageId: message.id)
            // 0 means it was sent meanwhile; don't duplicate it.
            if cancelled > 0 { composerTakeover = message.text }
        } catch {
            self.error = error.localizedDescription
        }
        await refreshPending()
    }

    // MARK: Composer data

    /// Slash commands and skills; loaded once per open chat.
    private(set) var commands: [SlashCommand] = []
    /// One shared load, so callers that arrive while it runs wait for the same result.
    @ObservationIgnored private var commandsLoad: Task<Void, Never>?
    /// Why the last commands load failed (m3), shown in the "/" list.
    private(set) var commandsError: String?

    func loadCommands() async {
        guard let host else { return }
        if commandsLoad == nil {
            let client = host.client, id = agentId
            commandsLoad = Task {
                do {
                    commands = try await client.commands(agentId: id)
                    commandsError = nil
                } catch {
                    commandsError = error.localizedDescription
                    commandsLoad = nil
                }
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
        await resolveCard(request.id) { try await $0.respondPermission(agentId: self.agentId, requestId: request.id, decision: decision) }
    }

    /// `answers == nil` dismisses the question.
    func answer(_ request: QuestionRequest, _ answers: [String: AnswerValue]?) async {
        await resolveCard(request.id) { try await $0.answerQuestion(agentId: self.agentId, requestId: request.id, answers: answers) }
    }

    /// M8: answers a permission or question card. The card goes away when the answer lands, and
    /// also when the server no longer has the request (answered from another client, or the turn
    /// ended): then a notice says so instead of leaving a card that can never be answered.
    private func resolveCard(_ requestId: String, _ action: (RPCClient) async throws -> Void) async {
        guard let host else { return }
        do {
            try await action(host.client)
            error = nil
            removeCard(requestId)
        } catch RPCError.server(1001, _) {
            removeCard(requestId)
            upsert(.notice(id: "resolved-\(requestId)", text: "Answered elsewhere"))
        } catch {
            // Kept, so the user can try again (the answer draft is kept too).
            self.error = error.localizedDescription
        }
    }

    private func removeCard(_ requestId: String) {
        permissions.removeAll { $0.id == requestId }
        questions.removeAll { $0.id == requestId }
        Drafts.shared.clearAnswers(requestId)
    }

    /// Merges a config change on the server ("" clears a field). The server applies it when the
    /// session is next opened: right away if idle, after the turn otherwise.
    func updateConfig(_ patch: AgentConfig) async {
        if var new = newAgent {
            // Not created yet: keep the choice for agent.create.
            func merge(_ value: String?, into field: inout String?) { if let value { field = value.isEmpty ? nil : value } }
            merge(patch.model, into: &new.config.model)
            merge(patch.mode, into: &new.config.mode)
            merge(patch.effort, into: &new.config.effort)
            newAgent = new
            return
        }
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
