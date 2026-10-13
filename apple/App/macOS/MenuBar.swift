import CasmKit
import SwiftUI

/// Menu bar extra: how many agents are running, waiting and idle across hosts. Waiting agents
/// are listed first; choosing one opens it.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let all = app.hosts.flatMap { host in host.agents.filter { $0.archivedAt == nil }.map { (host, $0) } }
        let waiting = all.filter { $0.1.status == .waiting }
        let running = all.filter { $0.1.status == .running }
        let idle = all.filter { $0.1.status == .idle }
        Text("\(running.count) running · \(waiting.count) waiting · \(idle.count) idle")
        if !waiting.isEmpty {
            Section("Needs you") { rows(waiting) }
        }
        if !running.isEmpty {
            Section("Running") { rows(running) }
        }
        if !idle.isEmpty {
            Section("Idle") { rows(Array(idle.prefix(12))) }
        }
        Divider()
        Button("Open casm") { app.bringToFront() }
        Button("Quit casm") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func rows(_ agents: [(HostModel, Agent)]) -> some View {
        ForEach(agents, id: \.1.id) { host, agent in
            Button("\(agent.name) — \(host.name)") {
                app.selection = .agent(host: host.id, agent: agent.id)
                app.bringToFront()
            }
        }
    }
}

struct MenuBarLabel: View {
    @Environment(AppModel.self) private var app

    /// The casm glyph (a template image, so it follows the menu bar's colour) with the number of
    /// agents that need you, or else the number running.
    var body: some View {
        let agents = app.hosts.flatMap(\.agents).filter { $0.archivedAt == nil }
        let waiting = agents.count { $0.status == .waiting }
        let running = agents.count { $0.status == .running }
        HStack(spacing: 3) {
            Image("MenuBarGlyph")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 16, height: 16)
            if waiting > 0 {
                Text("\(waiting) waiting")
            } else if running > 0 {
                Text("\(running)")
            }
        }
        .accessibilityLabel("casm: \(running) running, \(waiting) waiting")
    }
}
