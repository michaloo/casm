import CasmKit
import SwiftUI
import UniformTypeIdentifiers

/// Host → Group → Projects → Agents. Groups are labels on projects; ungrouped projects sit
/// directly under the host.
struct SidebarView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        List(selection: $app.selection) {
            ForEach(app.hosts) { host in
                Section {
                    if host.projects.isEmpty && host.isOnline {
                        Text("No projects").foregroundStyle(.tertiary)
                    }
                    ForEach(host.groups(includeArchived: app.showArchived), id: \.self) { group in
                        GroupNode(host: host, group: group)
                    }
                    ForEach(host.projects(inGroup: nil, includeArchived: app.showArchived)) { project in
                        ProjectNode(host: host, project: project)
                    }
                } header: {
                    HostHeader(host: host)
                        #if os(macOS)
                        // Dropping a project on the host takes it out of its group.
                        .dropDestination(for: String.self) { ids, _ in
                            dropProjects(ids, on: host, group: nil)
                        }
                        #endif
                }
            }
            #if DEBUG
            Section("Debug") {
                Label("Synthetic transcript (2,000 items)", systemImage: "speedometer")
                    .tag(Selection.synthetic)
            }
            #endif
        }
        .overlay {
            if app.hosts.isEmpty {
                ContentUnavailableView {
                    Label("No hosts", systemImage: "server.rack")
                } description: {
                    Text("Add a casm server to get started.")
                } actions: {
                    Button("Add Host…") { app.sheet = .addHost }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let error = app.hosts.compactMap(\.lastError).first {
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(2).padding(8)
            }
        }
        .toolbar {
            ToolbarItem {
                Menu("Add", systemImage: "plus") {
                    Button("New Agent…") { app.sheet = .newAgent(nil, projectId: nil) }
                    Button("New Project…") { app.sheet = .newProject(nil) }
                    Divider()
                    Button("Add Host…") { app.sheet = .addHost }
                    Divider()
                    Toggle("Show Archived", isOn: $app.showArchived)
                }
            }
        }
        .navigationTitle("casm")
        #if os(macOS)
        .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        #endif
    }

    /// Project drags carry "project:<host>:<id>"; drops only move projects within their host.
    private func dropProjects(_ payloads: [String], on host: HostModel, group: String?) -> Bool {
        let ids = payloads.compactMap { ProjectDrag.projectID(from: $0, host: host.id) }
        for id in ids {
            if let project = host.project(id), project.group != group { Task { await host.setGroup(project, group) } }
        }
        return !ids.isEmpty
    }
}

enum ProjectDrag {
    static func payload(_ project: Project, host: UUID) -> String { "project:\(host.uuidString):\(project.id)" }

    static func projectID(from payload: String, host: UUID) -> String? {
        let parts = payload.split(separator: ":", maxSplits: 2).map(String.init)
        guard parts.count == 3, parts[0] == "project", parts[1] == host.uuidString else { return nil }
        return parts[2]
    }
}

struct HostHeader: View {
    @Environment(AppModel.self) private var app
    let host: HostModel

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(host.name)
            Spacer()
            Text(stateText).font(.caption2).foregroundStyle(.tertiary)
        }
        .help(help)
        .contextMenu {
            Button("New Project…") { app.sheet = .newProject(host) }
            Button("New Agent…") { app.sheet = .newAgent(host, projectId: nil) }
            Button("Host Info…") { app.sheet = .hostInfo(host) }
            Button("Refresh") { Task { await host.refresh() } }
            Button("Reconnect Now") { host.reconnectNow() }
            Divider()
            Button("Remove Host…", role: .destructive) {
                app.confirmation = .init(title: "Remove \(host.name)?",
                                         message: "The app forgets this host and its token. Nothing changes on the server.",
                                         confirm: "Remove") { app.removeHost(host) }
            }
        }
    }

    private var color: Color {
        switch host.state {
        case .connected: .green
        case .connecting: .yellow
        case .waiting, .disconnected: .red
        }
    }

    private var stateText: String {
        switch host.state {
        case .connected: ""
        case .connecting: "connecting…"
        case .waiting: "offline"
        case .disconnected: "stopped"
        }
    }

    private var help: String {
        switch host.state {
        case .connected(let info): "\(host.entry.url.absoluteString) · \(info.name) · casm \(info.version)"
        case .waiting(let retryAt, let error):
            "\(error) — retrying \(retryAt.formatted(.relative(presentation: .named)))"
        default: host.entry.url.absoluteString
        }
    }
}

/// A group label with its projects. Projects can be dragged onto it (macOS).
struct GroupNode: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    let group: String
    @State private var expanded = true

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(host.projects(inGroup: group, includeArchived: app.showArchived)) { project in
                ProjectNode(host: host, project: project)
            }
        } label: {
            Label(group, systemImage: "square.stack.3d.up")
                .foregroundStyle(.secondary)
                .contextMenu {
                    Button("Rename Group…") {
                        app.textPrompt = .init(title: "Rename Group", message: "All projects in \u{201C}\(group)\u{201D} move to the new name.",
                                               placeholder: "Group name", text: group, confirm: "Rename") { name in
                            Task { await host.renameGroup(group, to: name) }
                        }
                    }
                    Button("New Project in Group…") { app.sheet = .newProject(host, group: group) }
                }
                #if os(macOS)
                .dropDestination(for: String.self) { ids, _ in
                    let projectIDs = ids.compactMap { ProjectDrag.projectID(from: $0, host: host.id) }
                    for id in projectIDs {
                        if let project = host.project(id), project.group != group { Task { await host.setGroup(project, group) } }
                    }
                    return !projectIDs.isEmpty
                }
                #endif
        }
    }
}

struct ProjectNode: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    let project: Project
    @State private var expanded = true
    @State private var hovering = false

    var body: some View {
        let agents = host.agents(in: project.id, includeArchived: app.showArchived)
        if agents.isEmpty {
            label
        } else {
            DisclosureGroup(isExpanded: $expanded) {
                ForEach(agents) { agent in
                    AgentNode(host: host, agent: agent)
                }
            } label: {
                label
            }
        }
    }

    private var archived: Bool { project.archivedAt != nil }

    private var label: some View {
        HStack(spacing: 4) {
            Label(project.name, systemImage: archived ? "archivebox" : "folder")
                .opacity(archived ? 0.5 : 1)
            if !project.tags.isEmpty {
                Text(project.tags.joined(separator: " · ")).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Group {
                Button("Details of \(project.name)", systemImage: "info.circle") {
                    app.sheet = .projectDetails(host, projectId: project.id)
                }
                .help("AGENTS.md and memories")
                Button("New Agent in \(project.name)", systemImage: "plus") {
                    app.sheet = .newAgent(host, projectId: project.id)
                }
                .help("New agent in \(project.name)")
                .disabled(archived)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            #if os(macOS)
            // Shown on hover so the tree stays quiet; still reachable via the context menu.
            .opacity(hovering ? 1 : 0)
            #endif
        }
        #if os(macOS)
        .onHover { hovering = $0 }
        .draggable(ProjectDrag.payload(project, host: host.id))
        #endif
        .help(project.path)
        .contextMenu { menu }
    }

    @ViewBuilder private var menu: some View {
        Button("New Agent…") { app.sheet = .newAgent(host, projectId: project.id) }
        Button("Project Details…") { app.sheet = .projectDetails(host, projectId: project.id) }
        Menu("Group") {
            ForEach(host.groups(), id: \.self) { group in
                Button {
                    Task { await host.setGroup(project, group) }
                } label: {
                    if project.group == group { Label(group, systemImage: "checkmark") } else { Text(group) }
                }
            }
            if !host.groups().isEmpty { Divider() }
            Button("New Group…") {
                app.textPrompt = .init(title: "New Group", message: "Move \u{201C}\(project.name)\u{201D} to a new group.",
                                       placeholder: "Group name", confirm: "Move") { name in
                    let name = name.trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty { Task { await host.setGroup(project, name) } }
                }
            }
            if project.group != nil {
                Button("Remove from Group") { Task { await host.setGroup(project, nil) } }
            }
        }
        Button("Edit Tags…") {
            app.textPrompt = .init(title: "Tags for \(project.name)", message: "Comma-separated.", placeholder: "work, client",
                                   text: project.tags.joined(separator: ", ")) { text in
                let tags = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                Task { await host.setTags(project, tags) }
            }
        }
        Button("Copy Path") { Clipboard.copy(project.path) }
        Divider()
        Button(archived ? "Unarchive" : "Archive") { Task { await host.setArchived(project, !archived) } }
        Button("Delete Project…", role: .destructive) {
            let count = host.agents.filter { $0.projectId == project.id }.count
            app.confirmation = .init(
                title: "Delete \u{201C}\(project.name)\u{201D}?",
                message: "Removes the project\(count > 0 ? " and its \(count) agent\(count == 1 ? "" : "s")" : "") from casm. The folder \(project.path) and the agents' transcripts on disk are not touched.",
                confirm: "Delete") {
                    if case .agent(host.id, let agentID) = app.selection, host.agent(agentID)?.projectId == project.id { app.selection = nil }
                    Task { await host.delete(project) }
                }
        }
    }
}

/// An agent with the subagents it created nested below it.
struct AgentNode: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    let agent: Agent
    var depth = 0
    @State private var expanded = true

    var body: some View {
        let children = host.subagents(of: agent.id)
        #if os(iOS)
        // On iOS tapping a disclosure row toggles it instead of opening the agent, so subagents
        // are listed below their caller, indented, without a disclosure.
        row.padding(.leading, CGFloat(depth) * 18)
        ForEach(children) { AgentNode(host: host, agent: $0, depth: depth + 1) }
        #else
        if children.isEmpty {
            row
        } else {
            DisclosureGroup(isExpanded: $expanded) {
                ForEach(children) { AgentNode(host: host, agent: $0) }
            } label: {
                row
            }
        }
        #endif
    }

    private var row: some View {
        AgentRow(agent: agent, online: host.isOnline)
            .tag(Selection.agent(host: host.id, agent: agent.id))
            .contextMenu { AgentMenu(host: host, agent: agent) }
    }
}

/// Rename, archive and delete an agent (sidebar context menu and the chat's More menu).
/// Agents stay in the project they were created in.
struct AgentMenu: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    let agent: Agent

    var body: some View {
        Button("Rename…") {
            app.textPrompt = .init(title: "Rename Agent", placeholder: "Name", text: agent.name, confirm: "Rename") { name in
                Task { await host.rename(agent, to: name) }
            }
        }
        Button("Copy Agent ID") { Clipboard.copy(agent.id) }
        Divider()
        Button(agent.archivedAt == nil ? "Archive" : "Unarchive") { Task { await host.setArchived(agent, agent.archivedAt == nil) } }
        Button("Delete Agent…", role: .destructive) {
            app.confirmation = .init(
                title: "Delete \u{201C}\(agent.name)\u{201D}?",
                message: "Removes the agent from casm and stops it if it's running. Its transcript stays in the provider's own store.",
                confirm: "Delete") {
                    if case .agent(host.id, agent.id) = app.selection { app.selection = nil }
                    Task { await host.delete(agent) }
                }
        }
    }
}

enum Clipboard {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

struct AgentRow: View {
    let agent: Agent
    /// M1: an offline host's agents are dimmed and show no (stale) status.
    var online = true

    var body: some View {
        HStack(spacing: 6) {
            Label {
                Text(agent.name).lineLimit(1)
            } icon: {
                ProviderIcon(provider: agent.provider)
            }
            .opacity(agent.archivedAt == nil && online ? 1 : 0.5)
            Spacer(minLength: 4)
            if online && agent.status != .idle { StatusBadge(status: agent.status) }
        }
        .help("\(agent.provider.rawValue) · \(agent.config.model ?? "default model") · \(agent.cwd)")
    }
}

/// The bundle holding this code (the app, or the snapshot test bundle).
private final class BundleToken {}

/// The coding agent behind an agent: its own mark (template image), Claude in its orange.
/// Marks: App/Shared/Providers.xcassets.
struct ProviderIcon: View {
    let provider: ProviderID
    var size: CGFloat = 15

    var body: some View {
        switch provider {
        case .claude: mark("provider-claude").foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
        case .codex: mark("provider-codex").foregroundStyle(.primary)
        case .pi: mark("provider-pi").foregroundStyle(.primary)
        case .opencode: mark("provider-opencode").foregroundStyle(.primary)
        case .unknown: Image(systemName: "cpu").foregroundStyle(.secondary)
        }
    }

    private func mark(_ name: String) -> some View {
        Image(name, bundle: Bundle(for: BundleToken.self))
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel(provider.rawValue)
    }
}
