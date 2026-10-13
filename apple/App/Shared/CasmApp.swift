import CasmKit
import SwiftUI

/// Entry point. `casm --seed-hosts <file.json>` writes the host list (UserDefaults) and tokens
/// (Keychain, owned by this app) and exits before any UI starts, so installs can pre-configure
/// the app without launching it. The file is `[{"name", "url", "token"}]`; it replaces the list.
@main
enum Launcher {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--seed-hosts"), i + 1 < args.count {
            exit(HostSeeder.seed(from: args[i + 1]) ? 0 : 1)
        }
        // The same list base64-encoded in the environment, for devices where a file path won't do
        // (`xcrun devicectl device process launch --environment-variables '{"CASM_SEED_HOSTS_B64": …}'`).
        if let b64 = ProcessInfo.processInfo.environment["CASM_SEED_HOSTS_B64"], let data = Data(base64Encoded: b64) {
            exit(HostSeeder.seed(data: data) ? 0 : 1)
        }
        CasmApp.main()
    }
}

enum HostSeeder {
    struct Entry: Decodable {
        var name: String
        var url: URL
        var token: String
    }

    static func seed(from path: String) -> Bool {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            FileHandle.standardError.write(Data("seed failed: can't read \(path)\n".utf8))
            return false
        }
        return seed(data: data)
    }

    static func seed(data: Data) -> Bool {
        let store = HostStore.app
        do {
            let entries = try JSONDecoder().decode([Entry].self, from: data)
            for old in store.load() { store.remove(old.id) }
            for entry in entries {
                try store.upsert(HostEntry(name: entry.name, url: entry.url), token: entry.token)
            }
            print("seeded \(entries.count) host(s): \(store.load().map(\.name).joined(separator: ", "))")
            return true
        } catch {
            FileHandle.standardError.write(Data("seed failed: \(error)\n".utf8))
            return false
        }
    }
}

struct CasmApp: App {
    @State private var app = AppModel()

    var body: some Scene {
        mainWindow
        #if os(macOS)
        MenuBarExtra {
            MenuBarContent().environment(app)
        } label: {
            MenuBarLabel().environment(app)
        }
        #endif
    }

    private var mainWindow: some Scene {
        WindowGroup(id: "main") {
            ContentView()
                .environment(app)
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 760)
        .commands {
            // ⌘N makes an agent, not a second window.
            CommandGroup(replacing: .newItem) {
                Button("New Agent…") { app.sheet = .newAgent(app.chat?.host, projectId: app.chat?.project?.id) }
                    .keyboardShortcut("n")
                Button("New Project…") { app.sheet = .newProject(nil) }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                Button("Add Host…") { app.sheet = .addHost }
            }
            CommandMenu("Agent") {
                Button("Focus Composer") { app.chat?.focusComposerRequest += 1 }
                    .keyboardShortcut("k")
                    .disabled(app.chat == nil)
                Button("Interrupt") { Task { await app.chat?.interrupt() } }
                    .keyboardShortcut(".")
                    .disabled(app.chat?.status.isBusy != true)
                Button("Reload Agent") { Task { await app.chat?.reload() } }
                    .keyboardShortcut("r")
                    .disabled(app.chat?.agent == nil)
                Divider()
                ForEach(Array(app.sidebarAgents().prefix(9).enumerated()), id: \.element.agent.id) { i, entry in
                    Button(entry.agent.name) { app.selection = .agent(host: entry.host.id, agent: entry.agent.id) }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")))
                }
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
            if case .schedules(let hostID, let agentID) = app.selection, let host = app.host(hostID) {
                NavigationStack { SchedulesView(host: host, agentId: agentID) }
                    .id("schedules-\(hostID)-\(agentID ?? "")")
            } else if let chat = app.chat {
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
                case .newProject(let host, let group): NewProjectSheet(hostID: host?.id, group: group ?? "")
                case .newAgent(let host, let projectId): NewAgentSheet(hostID: host?.id, projectId: projectId)
                case .hostInfo(let host): HostInfoSheet(host: host)
                case .projectDetails(let host, let projectId): ProjectDetailsSheet(host: host, projectId: projectId)
                }
            }
            .environment(app)
        }
        .alert(app.textPrompt?.title ?? "", isPresented: Binding(get: { app.textPrompt != nil }, set: { if !$0 { app.textPrompt = nil } }),
               presenting: app.textPrompt) { prompt in
            TextField(prompt.placeholder, text: Binding(get: { app.textPrompt?.text ?? "" }, set: { app.textPrompt?.text = $0 }))
            Button(prompt.confirm) { prompt.action(app.textPrompt?.text ?? prompt.text) }
            Button("Cancel", role: .cancel) {}
        } message: { prompt in
            if let message = prompt.message { Text(message) }
        }
        .confirmationDialog(app.confirmation?.title ?? "", isPresented: Binding(get: { app.confirmation != nil }, set: { if !$0 { app.confirmation = nil } }),
                            titleVisibility: .visible, presenting: app.confirmation) { confirmation in
            Button(confirmation.confirm, role: .destructive) { confirmation.action() }
            Button("Cancel", role: .cancel) {}
        } message: { confirmation in
            Text(confirmation.message)
        }
        .onChange(of: scenePhase) {
            // iOS suspends the socket in the background; don't wait for the backoff when we're back.
            if scenePhase == .active { app.hosts.forEach { $0.reconnectNow() } }
        }
        .onAppear { Notifier.shared.attach(app) }
        .onChange(of: scenePhase, initial: true) { Notifier.shared.appActive = scenePhase == .active }
        #if os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Notifier.shared.appActive = true
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            Notifier.shared.appActive = false
        }
        #endif
        #if DEBUG && os(macOS)
        .onAppear { DebugControl.shared.attach(app) }
        #endif
    }
}
