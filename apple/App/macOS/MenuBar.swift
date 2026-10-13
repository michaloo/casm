import CasmKit
import SwiftUI

/// Menu bar extra: how many agents are running, waiting and idle across hosts. Waiting agents
/// are listed first; choosing one opens it.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        // M1: statuses from offline hosts are stale, so they don't count.
        let all = app.hosts.filter(\.isOnline).flatMap { host in host.agents.filter { $0.archivedAt == nil }.map { (host, $0) } }
        let offline = app.hosts.filter { !$0.isOnline }
        let waiting = all.filter { $0.1.status == .waiting }
        let running = all.filter { $0.1.status == .running }
        let idle = all.filter { $0.1.status == .idle }
        Text("\(running.count) working · \(waiting.count) need you · \(idle.count) idle")
        if !offline.isEmpty {
            Text("Offline: " + offline.map(\.name).joined(separator: ", "))
        }
        if !waiting.isEmpty {
            Section("Needs you") { rows(waiting) }
        }
        if !running.isEmpty {
            Section("Working") { rows(running) }
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

    /// Menu bar extra labels ignore SwiftUI sizing (a resizable Image came out at the SVG's
    /// 784 pt), so hand over an NSImage that already has menu bar size and is a template.
    static let glyph: NSImage = {
        let image = (NSImage(named: "MenuBarGlyph")?.copy() as? NSImage) ?? NSImage()
        image.size = NSSize(width: 16, height: 16)
        image.isTemplate = true
        return image
    }()

    /// The casm glyph (a template image, so it follows the menu bar's colour) with the number of
    /// agents that need you, or else the number running.
    var body: some View {
        let agents = app.hosts.filter(\.isOnline).flatMap(\.agents).filter { $0.archivedAt == nil }
        let waiting = agents.count { $0.status == .waiting }
        let running = agents.count { $0.status == .running }
        HStack(spacing: 3) {
            Image(nsImage: Self.glyph)
            if waiting > 0 {
                Text("\(waiting) need you")
            } else if running > 0 {
                Text("\(running)")
            }
        }
        .accessibilityLabel("casm: \(running) working, \(waiting) need you")
    }
}
