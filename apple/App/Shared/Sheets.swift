import CasmKit
import SwiftUI

extension AppModel {
    func createProject(on host: HostModel, _ params: CreateProjectParams) async throws {
        _ = try await host.client.createProject(params)
        await host.refresh()
    }

    /// Creates the agent and opens it.
    func createAgent(on host: HostModel, _ params: CreateAgentParams) async throws {
        let agent = try await host.client.createAgent(params)
        await host.refresh()
        selection = .agent(host: host.id, agent: agent.id)
    }
}

struct AddHostSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = "ws://"
    @State private var token = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("macbook"))
                    .accessibilityLabel("Host name")
                TextField("URL", text: $url, prompt: Text("ws://host:7373"))
                    .accessibilityLabel("Host URL")
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                SecureField("Token", text: $token, prompt: Text("casm_…"))
                    .accessibilityLabel("Token")
            } footer: {
                Text("Create a token on the server with `casm token create <name>`. It is stored in the Keychain.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle("Add Host")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("Add", action: add).disabled(!valid) }
        }
        .sheetSize(minWidth: 420)
    }

    private var parsedURL: URL? {
        guard let u = URL(string: url.trimmingCharacters(in: .whitespaces)), ["ws", "wss"].contains(u.scheme), u.host() != nil
        else { return nil }
        return u
    }

    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && parsedURL != nil && !token.isEmpty }

    private func add() {
        guard let parsedURL else { return }
        do {
            try app.addHost(name: name.trimmingCharacters(in: .whitespaces), url: parsedURL, token: token.trimmingCharacters(in: .whitespaces))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Picks among online hosts; hidden when there is only one.
private struct HostPicker: View {
    @Environment(AppModel.self) private var app
    @Binding var hostID: UUID?

    var body: some View {
        if app.hosts.count > 1 {
            Picker("Host", selection: $hostID) {
                ForEach(app.hosts) { host in
                    Text(host.name + (host.isOnline ? "" : " (offline)")).tag(Optional(host.id))
                }
            }
        }
    }
}

struct NewProjectSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var hostID: UUID?
    @State var group: String = ""
    @State private var path = ""
    @State private var name = ""
    @State private var tags = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let host = hostID.flatMap(app.host)
        Form {
            HostPicker(hostID: $hostID)
            Section {
                if let host {
                    PathField(host: host, path: $path, prompt: "/Users/me/Projects/app")
                }
            } header: {
                Text("Folder")
            } footer: {
                Text("A folder on \(host?.name ?? "the host"). It can't be changed later.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            TextField("Name", text: $name, prompt: Text(defaultName.isEmpty ? "Defaults to the folder name" : defaultName))
                .accessibilityLabel("Project name")
            HStack {
                TextField("Group", text: $group, prompt: Text("Optional"))
                    .accessibilityLabel("Group")
                if let groups = host?.groups(), !groups.isEmpty {
                    Menu("Groups") {
                        ForEach(groups, id: \.self) { g in Button(g) { group = g } }
                    }
                    .fixedSize()
                }
            }
            TextField("Tags", text: $tags, prompt: Text("Comma-separated, optional"))
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle("New Project")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create(host) } }
                    .disabled(!path.hasPrefix("/") || host?.isOnline != true || busy)
            }
        }
        .sheetSize(minWidth: 460)
        .onAppear { if hostID == nil { hostID = app.hosts.first(where: \.isOnline)?.id ?? app.hosts.first?.id } }
    }

    private var defaultName: String {
        path.split(separator: "/").last.map(String.init) ?? ""
    }

    private func create(_ host: HostModel?) async {
        guard let host else { return }
        busy = true
        defer { busy = false }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedGroup = group.trimmingCharacters(in: .whitespaces)
        let tagList = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        do {
            try await app.createProject(on: host, CreateProjectParams(
                path: path.trimmingCharacters(in: .whitespaces), name: trimmedName.isEmpty ? nil : trimmedName,
                group: trimmedGroup.isEmpty ? nil : trimmedGroup, tags: tagList.isEmpty ? nil : tagList))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// An absolute folder path on a host, with directory suggestions from `fs.search` (under the
/// typed path's parent) and, on macOS when the host is this Mac, a folder picker.
struct PathField: View {
    let host: HostModel
    @Binding var path: String
    var prompt: String
    @State private var suggestions: [String] = []
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Path", text: $path, prompt: Text(prompt))
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityLabel("Path")
                #if os(macOS)
                if host.isThisMac {
                    Button("Choose…") { picking = true }
                }
                #endif
            }
            ForEach(suggestions, id: \.self) { suggestion in
                Button {
                    path = suggestion
                } label: {
                    Label(suggestion, systemImage: "folder")
                        .font(.callout.monospaced())
                        .lineLimit(1)
                        .truncationMode(.head)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
        .task(id: path) { await suggest() }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { path = url.path(percentEncoded: false).trimmingSuffix("/") }
        }
    }

    private func suggest() async {
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled, host.isOnline else { return }
        guard path.hasPrefix("/") else {
            suggestions = []
            return
        }
        let parent = path.hasSuffix("/") ? path : (path as NSString).deletingLastPathComponent
        let base = parent.isEmpty ? "/" : parent
        let query = path.hasSuffix("/") ? "" : (path as NSString).lastPathComponent
        let entries = (try? await host.client.searchFiles(cwd: base, query: query, limit: 20).entries) ?? []
        let dirs = entries.filter { $0.kind == .dir }.prefix(6).map { (base as NSString).appendingPathComponent($0.path) }
        suggestions = dirs.filter { $0 != path.trimmingSuffix("/") }
    }
}

private extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) && count > 1 ? String(dropLast(suffix.count)) : self
    }
}

struct NewAgentSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var hostID: UUID?
    @State var projectId: String?
    @State private var provider: ProviderID = .claude
    @State private var name = ""
    /// Empty means the provider's default.
    @State private var model = ""
    @State private var effort = ""
    @State private var mode = "default"
    @State private var prompt = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let host = hostID.flatMap(app.host)
        let project = projectId.flatMap { host?.project($0) }
        Form {
            HostPicker(hostID: $hostID)
            Picker("Project", selection: $projectId) {
                if projectId == nil { Text("Choose…").tag(String?.none) }
                ForEach(host?.pickerProjects() ?? []) { p in
                    Text(p.group.map { "\($0) › \(p.name)" } ?? p.name).tag(Optional(p.id))
                }
            }
            if let project {
                // Agents always work in their project's folder.
                LabeledContent("Folder") {
                    Text(project.path).font(.callout.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            Picker("Provider", selection: $provider) {
                ForEach(host?.info?.providers ?? [.claude], id: \.self) { Text($0.rawValue).tag($0) }
            }
            TextField("Name", text: $name, prompt: Text("Optional"))
                .accessibilityLabel("Agent name")
            let catalog = host?.catalog(for: provider)
            Picker("Model", selection: $model) {
                Text("Default").tag("")
                ForEach(catalog?.models ?? []) { Text($0.displayName).tag($0.id) }
            }
            if let efforts = catalog?.models.first(where: { $0.id == model })?.efforts, !efforts.isEmpty {
                Picker("Effort", selection: $effort) {
                    Text("Default").tag("")
                    ForEach(efforts, id: \.self) { Text($0).tag($0) }
                }
            }
            Picker("Mode", selection: $mode) {
                ForEach(catalog?.modes ?? [ModeInfo(id: "default")]) { Text($0.displayName).tag($0.id) }
            }
            Section("First prompt") {
                TextEditor(text: $prompt)
                    .font(.body)
                    .frame(minHeight: 100)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle("New Agent")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create(host, project) } }
                    .disabled(projectId == nil || host?.isOnline != true || busy)
            }
        }
        .sheetSize(minWidth: 460, minHeight: 520)
        .onAppear { if hostID == nil { hostID = app.hosts.first(where: \.isOnline)?.id ?? app.hosts.first?.id } }
    }

    private func create(_ host: HostModel?, _ project: Project?) async {
        guard let host, let project else { return }
        busy = true
        defer { busy = false }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let efforts = host.catalog(for: provider)?.models.first { $0.id == model }?.efforts ?? []
        let config = AgentConfig(model: model.isEmpty ? nil : model,
                                 mode: mode, effort: efforts.contains(effort) ? effort : nil)
        do {
            try await app.createAgent(on: host, CreateAgentParams(
                projectId: project.id, provider: provider, name: trimmedName.isEmpty ? nil : trimmedName,
                config: config, prompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A host's server identity and its peers. Read-only: peers are configured on the server
/// (`casm peer add`), never from the app.
struct HostInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let host: HostModel
    @State private var peers: [Peer]?
    @State private var error: String?

    var body: some View {
        Form {
            Section("Connection") {
                LabeledContent("Name in this app", value: host.name)
                LabeledContent("URL", value: host.entry.url.absoluteString)
                LabeledContent("State", value: host.isOnline ? "Connected" : "Offline")
            }
            if let info = host.info {
                Section("Server") {
                    LabeledContent("Name", value: info.name)
                    LabeledContent("Version", value: "casm \(info.version) · protocol \(info.protocol)")
                    if let id = info.id {
                        LabeledContent("Server ID") {
                            HStack {
                                Text(id).font(.callout.monospaced()).textSelection(.enabled)
                                Button("Copy", systemImage: "doc.on.doc") { Clipboard.copy(id) }.labelStyle(.iconOnly)
                            }
                        }
                    }
                    LabeledContent("Providers", value: info.providers.map(\.rawValue).joined(separator: ", "))
                }
            }
            Section {
                if let peers {
                    if peers.isEmpty {
                        Text("No peers").foregroundStyle(.secondary)
                    }
                    ForEach(peers) { peer in
                        HStack {
                            Circle().fill(peer.reachable == true ? Color.green : peer.reachable == false ? .red : .secondary)
                                .frame(width: 7, height: 7)
                            VStack(alignment: .leading) {
                                Text(peer.name)
                                Text(peer.url).font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            } header: {
                Text("Peers")
            } footer: {
                Text("Servers this host's agents can call. Set up on the server with `casm peer add`; read-only here.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(host.name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .sheetSize(minWidth: 460, minHeight: 420)
        .task {
            do { peers = try await host.client.peers(probe: true) } catch { self.error = error.localizedDescription }
        }
    }
}

extension View {
    /// A minimum size for sheets on macOS, where they'd otherwise shrink to fit. On iOS sheets
    /// already fill the screen, and a fixed width would push them past an iPhone's edges.
    func sheetSize(minWidth: CGFloat, minHeight: CGFloat? = nil) -> some View {
        #if os(macOS)
        frame(minWidth: minWidth, minHeight: minHeight)
        #else
        self
        #endif
    }
}
