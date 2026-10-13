import CasmKit
import Foundation
import Observation

enum Selection: Hashable {
    case agent(host: UUID, agent: String)
    #if DEBUG
    case synthetic
    #endif
}

@MainActor @Observable
final class AppModel {
    private let store = HostStore()
    private(set) var hosts: [HostModel] = []
    var selection: Selection? {
        didSet { if selection != oldValue { selectionChanged() } }
    }
    /// The chat for the selected agent, kept while it is open so it can be re-subscribed on reconnect.
    private(set) var chat: ChatModel?

    enum Sheet: Identifiable {
        case addHost, newProject(HostModel?), newAgent(HostModel?, projectId: String?)
        var id: String {
            switch self {
            case .addHost: "addHost"
            case .newProject: "newProject"
            case .newAgent: "newAgent"
            }
        }
    }
    var sheet: Sheet?

    init() {
        #if DEBUG
        seedDevHost()
        #endif
        hosts = store.load().map { HostModel(entry: $0, token: store.token(for: $0.id) ?? "") }
        for host in hosts { host.start() }
    }

    func host(_ id: UUID) -> HostModel? { hosts.first { $0.id == id } }

    func addHost(name: String, url: URL, token: String) throws {
        let entry = HostEntry(name: name, url: url)
        try store.upsert(entry, token: token)
        let host = HostModel(entry: entry, token: token)
        hosts.append(host)
        host.start()
    }

    func removeHost(_ host: HostModel) {
        if case .agent(host.id, _) = selection { selection = nil }
        host.stop()
        store.remove(host.id)
        hosts.removeAll { $0.id == host.id }
    }

    private func selectionChanged() {
        chat?.close()
        chat = nil
        switch selection {
        case .agent(let hostID, let agentID):
            guard let host = host(hostID) else { return }
            let chat = ChatModel(host: host, agentId: agentID)
            self.chat = chat
            chat.open()
        #if DEBUG
        case .synthetic:
            chat = ChatModel.synthetic()
        #endif
        case nil:
            break
        }
    }

    #if DEBUG
    /// `CASM_DEV_URL` + `CASM_DEV_TOKEN` add a host on first launch, so test runs don't need the sheet.
    private func seedDevHost() {
        let env = ProcessInfo.processInfo.environment
        guard store.load().isEmpty, let raw = env["CASM_DEV_URL"], let url = URL(string: raw),
              let token = env["CASM_DEV_TOKEN"] else { return }
        try? store.upsert(HostEntry(name: env["CASM_DEV_NAME"] ?? "local", url: url), token: token)
    }
    #endif
}

/// One server connection with its projects and agents.
@MainActor @Observable
final class HostModel: Identifiable {
    let entry: HostEntry
    let client: RPCClient
    private(set) var state: ConnectionState = .disconnected
    private(set) var info: ServerInfo?
    private(set) var projects: [Project] = []
    private(set) var agents: [Agent] = []
    var lastError: String?

    /// Open chats get this host's live events and are re-synced on reconnect.
    @ObservationIgnored private var chats: [String: WeakChat] = [:]
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []

    nonisolated var id: UUID { entry.id }
    var name: String { entry.name }
    var isOnline: Bool { state.isConnected }

    init(entry: HostEntry, token: String) {
        self.entry = entry
        client = RPCClient(url: entry.url, token: token)
    }

    func start() {
        let states = client.states, notifications = client.notifications
        tasks.append(Task { [weak self] in
            for await state in states {
                guard let self else { return }
                self.state = state
                if case .connected(let info) = state {
                    self.info = info
                    await self.resync()
                }
            }
        })
        tasks.append(Task { [weak self] in
            for await note in notifications {
                self?.handle(note)
            }
        })
        Task { await client.start() }
    }

    func stop() {
        tasks.forEach { $0.cancel() }
        Task { await client.stop() }
    }

    func reconnectNow() {
        Task { await client.reconnectNow() }
    }

    /// Re-fetches the lists and re-subscribes open chats (after every (re)connect).
    func resync() async {
        await refresh()
        for chat in chats.values.compactMap(\.chat) { await chat.resync() }
    }

    func refresh() async {
        do {
            async let projects = client.listProjects()
            async let agents = client.listAgents()
            (self.projects, self.agents) = try await (projects, agents)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func register(_ chat: ChatModel) { chats[chat.agentId] = WeakChat(chat: chat) }
    func unregister(_ chat: ChatModel) { if chats[chat.agentId]?.chat === chat { chats[chat.agentId] = nil } }

    func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }

    func setStatus(_ status: AgentStatus, of agentID: String) {
        if let i = agents.firstIndex(where: { $0.id == agentID }), agents[i].status != status { agents[i].status = status }
    }

    private func handle(_ note: ServerNotification) {
        switch note {
        case .agentEvent(let agentID, let event):
            chats[agentID]?.chat?.apply(event)
        case .agentStatus(let agentID, let status):
            setStatus(status, of: agentID)
        case .agentChanged(let agent):
            if let i = agents.firstIndex(where: { $0.id == agent.id }) { agents[i] = agent } else { agents.append(agent) }
        case .agentRemoved(let agentID):
            agents.removeAll { $0.id == agentID }
        case .projectChanged(let project):
            if let i = projects.firstIndex(where: { $0.id == project.id }) { projects[i] = project } else { projects.append(project) }
        case .projectRemoved(let projectID):
            projects.removeAll { $0.id == projectID }
        case .unknown:
            break
        }
    }

    // MARK: Tree

    func childProjects(of parent: String?) -> [Project] {
        projects.filter { $0.parentId == parent && $0.archivedAt == nil }
            .sorted { ($0.sort, $0.name.localizedLowercase) < ($1.sort, $1.name.localizedLowercase) }
    }

    func agents(in project: String) -> [Agent] {
        agents.filter { $0.projectId == project && $0.archivedAt == nil }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Projects in tree order with their depth, for pickers.
    func flatProjects() -> [(project: Project, depth: Int)] {
        var out: [(Project, Int)] = []
        func walk(_ parent: String?, _ depth: Int) {
            for p in childProjects(of: parent) {
                out.append((p, depth))
                walk(p.id, depth + 1)
            }
        }
        walk(nil, 0)
        return out
    }
}

private struct WeakChat {
    weak var chat: ChatModel?
}
