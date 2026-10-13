import CasmKit
import SwiftUI

extension AppModel {
    func createProject(on host: HostModel, name: String, path: String?, parentId: String?) async throws {
        _ = try await host.client.createProject(CreateProjectParams(name: name, parentId: parentId, path: path))
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
                TextField("URL", text: $url, prompt: Text("ws://host:7373"))
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                SecureField("Token", text: $token, prompt: Text("casm_…"))
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
        .frame(minWidth: 420)
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
    @State private var name = ""
    @State private var path = ""
    @State private var parentId: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let host = hostID.flatMap(app.host)
        Form {
            HostPicker(hostID: $hostID)
            TextField("Name", text: $name)
            TextField("Path", text: $path, prompt: Text("Optional; inherited from the parent"))
                .autocorrectionDisabled()
            Picker("Parent", selection: $parentId) {
                Text("None").tag(String?.none)
                ForEach(host?.flatProjects() ?? [], id: \.project.id) { entry in
                    Text(String(repeating: "    ", count: entry.depth) + entry.project.name).tag(Optional(entry.project.id))
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle("New Project")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create(host) } }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || host?.isOnline != true || busy)
            }
        }
        .frame(minWidth: 420)
        .onAppear { if hostID == nil { hostID = app.hosts.first(where: \.isOnline)?.id ?? app.hosts.first?.id } }
    }

    private func create(_ host: HostModel?) async {
        guard let host else { return }
        busy = true
        defer { busy = false }
        do {
            let trimmed = path.trimmingCharacters(in: .whitespaces)
            try await app.createProject(on: host, name: name.trimmingCharacters(in: .whitespaces),
                                        path: trimmed.isEmpty ? nil : trimmed, parentId: parentId)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
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
        Form {
            HostPicker(hostID: $hostID)
            Picker("Project", selection: $projectId) {
                if projectId == nil { Text("Choose…").tag(String?.none) }
                ForEach(host?.flatProjects() ?? [], id: \.project.id) { entry in
                    Text(String(repeating: "    ", count: entry.depth) + entry.project.name).tag(Optional(entry.project.id))
                }
            }
            Picker("Provider", selection: $provider) {
                ForEach(host?.info?.providers ?? [.claude], id: \.self) { Text($0.rawValue).tag($0) }
            }
            TextField("Name", text: $name, prompt: Text("Optional"))
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
                Button("Create") { Task { await create(host) } }
                    .disabled(projectId == nil || host?.isOnline != true || busy)
            }
        }
        .frame(minWidth: 460, minHeight: 460)
        .onAppear { if hostID == nil { hostID = app.hosts.first(where: \.isOnline)?.id ?? app.hosts.first?.id } }
    }

    private func create(_ host: HostModel?) async {
        guard let host, let projectId else { return }
        busy = true
        defer { busy = false }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let efforts = host.catalog(for: provider)?.models.first { $0.id == model }?.efforts ?? []
        let config = AgentConfig(model: model.isEmpty ? nil : model,
                                 mode: mode, effort: efforts.contains(effort) ? effort : nil)
        do {
            try await app.createAgent(on: host, CreateAgentParams(
                projectId: projectId, provider: provider, name: trimmedName.isEmpty ? nil : trimmedName,
                config: config, prompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
