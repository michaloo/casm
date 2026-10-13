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

    init(host: HostModel?, agentId: String) {
        self.host = host
        self.agentId = agentId
    }

    var agent: Agent? { host?.agent(agentId) }
    var status: AgentStatus { agent?.status ?? .idle }
    var canLoadOlder: Bool { (historyStart ?? 0) > 0 }

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
            for event in sub.turn { apply(event) }
            let first = historyStart == nil
            try await loadLatest()
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
        let live = items.dropFirst(historyCount).filter { !fresh.contains($0.id) }
        setItems(Array(older) + page.items + live)
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
        case .turnEnded(_, let outcome, let error):
            draft = nil
            permissions = []
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
        items = new
        index = Dictionary(new.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    // MARK: Actions

    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let host, !text.isEmpty else { return }
        do {
            let result = try await host.client.send(agentId: agentId, text: text)
            if result.queued { upsert(.notice(id: "queued-\(UUID().uuidString)", text: "Queued: runs after the current turn.")) }
            scrollToBottomRequest += 1
        } catch {
            self.error = error.localizedDescription
        }
    }

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
    }

    func respond(to request: PermissionRequest, _ decision: PermissionDecision) async {
        await perform { try await $0.respondPermission(agentId: self.agentId, requestId: request.id, decision: decision) }
        if error == nil { permissions.removeAll { $0.id == request.id } }
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
