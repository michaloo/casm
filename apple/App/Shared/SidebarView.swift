import CasmKit
import SwiftUI

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
                    ForEach(host.childProjects(of: nil)) { project in
                        ProjectNode(host: host, project: project)
                    }
                } header: {
                    HostHeader(host: host)
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
        .toolbar {
            ToolbarItem {
                Menu("Add", systemImage: "plus") {
                    Button("New Agent…") { app.sheet = .newAgent(nil, projectId: nil) }
                    Button("New Project…") { app.sheet = .newProject(nil) }
                    Divider()
                    Button("Add Host…") { app.sheet = .addHost }
                }
            }
        }
        #if os(macOS)
        .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        #endif
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
            Button("Refresh") { Task { await host.refresh() } }
            Button("Reconnect Now") { host.reconnectNow() }
            Divider()
            Button("Remove Host", role: .destructive) { app.removeHost(host) }
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
        case .connected(let info): "\(host.entry.url.absoluteString) · casm \(info.version)"
        case .waiting(let retryAt, let error):
            "\(error) — retrying \(retryAt.formatted(.relative(presentation: .named)))"
        default: host.entry.url.absoluteString
        }
    }
}

struct ProjectNode: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    let project: Project
    @State private var expanded = true

    var body: some View {
        if host.childProjects(of: project.id).isEmpty && host.agents(in: project.id).isEmpty {
            label
        } else {
            DisclosureGroup(isExpanded: $expanded) {
            ForEach(host.childProjects(of: project.id)) { child in
                ProjectNode(host: host, project: child)
            }
            ForEach(host.agents(in: project.id)) { agent in
                AgentNode(host: host, agent: agent)
            }
            } label: {
                label
            }
        }
    }

    private var label: some View {
        Label(project.name, systemImage: "folder")
            .help(project.path ?? "")
            .contextMenu {
                Button("New Agent…") { app.sheet = .newAgent(host, projectId: project.id) }
                Button("New Project…") { app.sheet = .newProject(host) }
            }
    }
}

/// An agent with the subagents it created nested below it.
struct AgentNode: View {
    let host: HostModel
    let agent: Agent
    @State private var expanded = true

    var body: some View {
        let children = host.subagents(of: agent.id)
        if children.isEmpty {
            row
        } else {
            DisclosureGroup(isExpanded: $expanded) {
                ForEach(children) { AgentNode(host: host, agent: $0) }
            } label: {
                row
            }
        }
    }

    private var row: some View {
        AgentRow(agent: agent).tag(Selection.agent(host: host.id, agent: agent.id))
    }
}

struct AgentRow: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 6) {
            Label {
                Text(agent.name).lineLimit(1)
            } icon: {
                Image(systemName: "sparkle")
            }
            Spacer(minLength: 4)
            if agent.status != .idle { StatusBadge(status: agent.status) }
        }
        .help("\(agent.provider.rawValue) · \(agent.config.model ?? "default model") · \(agent.cwd)")
    }
}
