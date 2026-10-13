import CasmKit
import SwiftUI

@main
struct CasmApp: App {
    @State private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(app)
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 760)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Agent…") { app.sheet = .newAgent(nil, projectId: nil) }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                Button("New Project…") { app.sheet = .newProject(nil) }
                Button("Add Host…") { app.sheet = .addHost }
            }
            #if DEBUG
            CommandMenu("Debug") {
                Button("Open Synthetic Transcript (2,000 items)") { app.selection = .synthetic }
                Button("Run Scroll Benchmark") { DebugControl.shared.run(["cmd": "bench"]) }
            }
            #endif
        }
        #endif
    }
}

struct ContentView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var app = app
        NavigationSplitView {
            SidebarView()
        } detail: {
            if let chat = app.chat {
                ChatView(chat: chat)
                    .id(ObjectIdentifier(chat))
            } else {
                ContentUnavailableView("No agent selected", systemImage: "bubble.left.and.text.bubble.right",
                                       description: Text("Pick an agent in the sidebar or create one."))
            }
        }
        .sheet(item: $app.sheet) { sheet in
            NavigationStack {
                switch sheet {
                case .addHost: AddHostSheet()
                case .newProject(let host): NewProjectSheet(hostID: host?.id)
                case .newAgent(let host, let projectId): NewAgentSheet(hostID: host?.id, projectId: projectId)
                }
            }
            .environment(app)
        }
        .onChange(of: scenePhase) {
            // iOS suspends the socket in the background; don't wait for the backoff when we're back.
            if scenePhase == .active { app.hosts.forEach { $0.reconnectNow() } }
        }
        #if DEBUG && os(macOS)
        .onAppear { DebugControl.shared.attach(app) }
        #endif
    }
}
