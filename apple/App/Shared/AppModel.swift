import CasmKit
#if os(macOS)
import AppKit
#endif
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
        case addHost
        case newProject(HostModel?, group: String? = nil)
        case newAgent(HostModel?, projectId: String?)
        case hostInfo(HostModel)
        case projectDetails(HostModel, projectId: String)
        var id: String {
            switch self {
            case .addHost: "addHost"
            case .newProject: "newProject"
            case .newAgent: "newAgent"
            case .hostInfo(let host): "hostInfo-\(host.id)"
            case .projectDetails(_, let projectId): "projectDetails-\(projectId)"
            }
        }
    }
    var sheet: Sheet?

    /// A one-field prompt (rename, tags, new group), shown as an alert.
    struct TextPrompt: Identifiable {
        let id = UUID()
        var title: String
        var message: String?
        var placeholder: String = ""
        var text: String = ""
        var confirm: String = "Save"
        var action: @MainActor (String) -> Void
    }
    var textPrompt: TextPrompt?

    /// A destructive action that needs a second click.
    struct Confirmation: Identifiable {
        let id = UUID()
        var title: String
        var message: String
        var confirm: String
        var action: @MainActor () -> Void
    }
    var confirmation: Confirmation?

    /// Shows archived projects and agents in the sidebar (dimmed, with Unarchive).
    var showArchived = false

    init() {
        #if DEBUG
        seedDevHost()
        #endif
        hosts = store.load().map { HostModel(entry: $0, token: store.token(for: $0.id) ?? "") }
        for host in hosts { host.start() }
    }

    func host(_ id: UUID) -> HostModel? { hosts.first { $0.id == id } }

    /// Live agents in sidebar order (host, group, project), for ⌘1…9.
    func sidebarAgents() -> [(host: HostModel, agent: Agent)] {
        hosts.flatMap { host in
            host.pickerProjects().flatMap { project in host.agents(in: project.id).map { (host, $0) } }
        }
    }

    /// Brings the main window forward (from the menu bar extra or a notification).
    func bringToFront() {
        #if os(macOS)
        NSApp.activate()
        if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("main") == true || $0.isVisible && $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        }
        #endif
    }

    /// Running agents on any host that were created by this agent (cross-host subagents).
    /// `serverId` pins the parent to the right server when the server reports one.
    func workingSubagents(of agentID: String, on host: HostModel?) -> Int {
        let serverID = host?.info?.id
        return hosts.reduce(0) { n, h in
            n + h.agents.count { a in
                guard let p = a.parent, p.agentId == agentID, a.status.isBusy else { return false }
                return p.serverId == nil || serverID == nil || p.serverId == serverID
            }
        }
    }

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
    private var catalogs: [ProviderID: Catalog] = [:]
    /// Latest subscription limits per provider on this host (provider.limits + live notifications).
    private(set) var limits: [ProviderID: ProviderLimits] = [:]
    @ObservationIgnored private var catalogLoads: Set<ProviderID> = []
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
            // Archived ones too; the sidebar hides them unless "Show Archived" is on.
            async let projects = client.listProjects(includeArchived: true)
            async let agents = client.listAgents(includeArchived: true)
            (self.projects, self.agents) = try await (projects, agents)
            lastError = nil
            // Older servers don't have provider.limits; that's fine.
            if let all = try? await client.limits() {
                limits = Dictionary(all.map { ($0.provider, $0) }, uniquingKeysWith: { _, b in b })
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func register(_ chat: ChatModel) { chats[chat.agentId] = WeakChat(chat: chat) }
    func unregister(_ chat: ChatModel) { if chats[chat.agentId]?.chat === chat { chats[chat.agentId] = nil } }

    func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }

    func upsert(_ agent: Agent) {
        if let i = agents.firstIndex(where: { $0.id == agent.id }) { agents[i] = agent } else { agents.append(agent) }
    }

    /// Models and modes for a provider; loaded on first use and cached for the connection.
    func catalog(for provider: ProviderID) -> Catalog? {
        if catalogs[provider] == nil, isOnline, !catalogLoads.contains(provider) {
            catalogLoads.insert(provider)
            Task {
                defer { catalogLoads.remove(provider) }
                if let catalog = try? await client.catalog(provider: provider) { catalogs[provider] = catalog }
            }
        }
        return catalogs[provider]
    }

    func setStatus(_ status: AgentStatus, of agentID: String) {
        if let i = agents.firstIndex(where: { $0.id == agentID }), agents[i].status != status { agents[i].status = status }
    }

    private func handle(_ note: ServerNotification) {
        switch note {
        case .agentEvent(let agentID, let event):
            chats[agentID]?.chat?.apply(event)
        case .agentStatus(let agentID, let status):
            if let agent = agent(agentID) {
                Notifier.shared.statusChanged(host: self, agent: agent, from: agent.status, to: status)
            }
            setStatus(status, of: agentID)
        case .agentChanged(let agent):
            let pendingChanged = self.agent(agent.id)?.pending != agent.pending
            upsert(agent)
            if pendingChanged { chats[agent.id]?.chat?.refreshPendingSoon() }
        case .providerLimits(let value):
            limits[value.provider] = value
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

    /// Group labels in use, sorted. Projects are flat; a group is only a label for the sidebar.
    func groups(includeArchived: Bool = false) -> [String] {
        Set(projects.filter { includeArchived || $0.archivedAt == nil }.compactMap(\.group)).sorted {
            $0.localizedStandardCompare($1) == .orderedAscending
        }
    }

    /// Projects with this group label (`nil`: ungrouped).
    func projects(inGroup group: String?, includeArchived: Bool = false) -> [Project] {
        projects.filter { $0.group == group && (includeArchived || $0.archivedAt == nil) }
            .sorted { ($0.sort, $0.name.localizedLowercase) < ($1.sort, $1.name.localizedLowercase) }
    }

    /// All live projects, grouped first then ungrouped, for pickers.
    func pickerProjects() -> [Project] {
        groups().flatMap { projects(inGroup: $0) } + projects(inGroup: nil)
    }

    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    /// Top-level agents of a project; subagents whose caller is on this host are nested under it.
    func agents(in project: String, includeArchived: Bool = false) -> [Agent] {
        agents.filter { $0.projectId == project && (includeArchived || $0.archivedAt == nil) && !hasLocalParent($0) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func subagents(of agentID: String) -> [Agent] {
        agents.filter { $0.parent?.agentId == agentID && isLocalParent($0.parent) && $0.archivedAt == nil }
            .sorted { $0.createdAt < $1.createdAt }
    }

    private func hasLocalParent(_ agent: Agent) -> Bool {
        guard let parent = agent.parent, isLocalParent(parent) else { return false }
        return agents.contains { $0.id == parent.agentId }
    }

    /// A parent on this server (servers that don't report ids can't tell, so assume yes).
    private func isLocalParent(_ parent: AgentParent?) -> Bool {
        guard let serverID = parent?.serverId, let own = info?.id else { return true }
        return serverID == own
    }

    // MARK: Editing

    private func upsert(_ project: Project) {
        if let i = projects.firstIndex(where: { $0.id == project.id }) { projects[i] = project } else { projects.append(project) }
    }

    /// Runs an edit and reports failures in `lastError` (shown in the sidebar).
    private func edit(_ action: () async throws -> Void) async {
        do {
            try await action()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func setGroup(_ project: Project, _ group: String?) async {
        let change: UpdateProjectParams.GroupChange = group.map { .set($0) } ?? .clear
        await edit { upsert(try await client.updateProject(UpdateProjectParams(id: project.id, group: change))) }
    }

    /// Renaming a group relabels its projects.
    func renameGroup(_ old: String, to new: String) async {
        let name = new.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != old else { return }
        for project in projects where project.group == old {
            await edit { upsert(try await client.updateProject(UpdateProjectParams(id: project.id, group: .set(name)))) }
        }
    }

    func setTags(_ project: Project, _ tags: [String]) async {
        await edit { upsert(try await client.updateProject(UpdateProjectParams(id: project.id, tags: tags))) }
    }

    func setArchived(_ project: Project, _ archived: Bool) async {
        await edit { upsert(try await client.updateProject(UpdateProjectParams(id: project.id, archived: archived))) }
    }

    /// Removes the project and its agents from casm; the folder on disk is untouched.
    func delete(_ project: Project) async {
        await edit {
            try await client.deleteProject(id: project.id)
            projects.removeAll { $0.id == project.id }
            agents.removeAll { $0.projectId == project.id }
        }
    }

    func rename(_ agent: Agent, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        await edit { upsert(try await client.updateAgent(UpdateAgentParams(id: agent.id, name: name))) }
    }

    func setArchived(_ agent: Agent, _ archived: Bool) async {
        await edit { upsert(try await client.updateAgent(UpdateAgentParams(id: agent.id, archived: archived))) }
    }

    func delete(_ agent: Agent) async {
        await edit {
            try await client.deleteAgent(id: agent.id)
            agents.removeAll { $0.id == agent.id }
        }
    }

    #if os(macOS)
    /// True when the host is this Mac, so local folder pickers make sense for its paths.
    var isThisMac: Bool {
        guard let name = entry.url.host()?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1"].contains(name) || LocalAddresses.all.contains(name)
    }
    #else
    let isThisMac = false
    #endif
}

#if os(macOS)
/// This machine's IP addresses (Tailscale and LAN included).
enum LocalAddresses {
    static let all: Set<String> = {
        var out: Set<String> = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return out }
        defer { freeifaddrs(list) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            guard let addr = p.pointee.ifa_addr else { continue }
            let family = Int32(addr.pointee.sa_family)
            guard family == AF_INET || family == AF_INET6 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let len = socklen_t(family == AF_INET ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size)
            if getnameinfo(addr, len, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                out.insert(String(cString: host).split(separator: "%").first.map(String.init) ?? "")
            }
        }
        return out
    }()
}
#endif

private struct WeakChat {
    weak var chat: ChatModel?
}
