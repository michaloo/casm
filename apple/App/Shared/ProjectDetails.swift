import CasmKit
import SwiftUI

/// A project's AGENTS.md (editable) and the memories its coding agents keep for it (read-only).
struct ProjectDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let host: HostModel
    let projectId: String

    enum Tab: Hashable { case agentsMd, memories }
    @State private var tab: Tab = .agentsMd

    @State private var file: AgentsMd?
    /// The editor's text; nil while there is no file and the user hasn't chosen to create one.
    @State private var draft: String?
    @State private var memories: [AgentMemories]?
    @State private var saving = false
    @State private var error: String?
    /// M2: Done with unsaved edits asks first.
    @State private var confirmDiscard = false
    /// M2: the file changed on the host since it was loaded; holds the host's version.
    @State private var conflict: AgentsMd?

    private var project: Project? { host.project(projectId) }
    private var dirty: Bool { draft != nil && draft != file?.content }

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker("Section", selection: $tab) {
                Text("AGENTS.md").tag(Tab.agentsMd)
                Text(memories.map { "Memories (\($0.reduce(0) { $0 + $1.entries.count }))" } ?? "Memories").tag(Tab.memories)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal)
            .padding(.bottom, 10)
            Divider()
            switch tab {
            case .agentsMd: agentsMdPane
            case .memories: memoriesPane
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(.red).padding(8)
            }
        }
        .navigationTitle(project?.name ?? "Project")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { if dirty { confirmDiscard = true } else { dismiss() } }
            }
            if tab == .agentsMd && draft != nil {
                ToolbarItem(placement: .confirmationAction) {
                    Button(file?.content == nil ? "Create" : "Save") { Task { await save(force: false) } }
                        .disabled(!dirty || saving)
                        .keyboardShortcut("s")
                }
            }
        }
        .sheetSize(minWidth: 680, minHeight: 600)
        .task { await load() }
        .interactiveDismissDisabled(dirty)
        .confirmationDialog("Discard your changes to AGENTS.md?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Save") { Task { if await save(force: false) { dismiss() } } }
            Button("Discard Changes", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
        .alert("AGENTS.md changed on the host", isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } })) {
            Button("Overwrite with Mine", role: .destructive) { Task { await save(force: true) } }
            Button("Use the Host's Version") {
                file = conflict
                draft = conflict?.content
                conflict = nil
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Someone (or an agent) edited it after you opened it. Saving now would replace their changes.")
        }
    }

    @ViewBuilder private var header: some View {
        if let project {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                    Text(project.path).font(.callout.monospaced()).textSelection(.enabled).lineLimit(1).truncationMode(.head)
                    Button("Copy Path", systemImage: "doc.on.doc") { Clipboard.copy(project.path) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                }
                .foregroundStyle(.secondary)
                let labels = [project.group.map { "Group: \($0)" }, project.tags.isEmpty ? nil : "Tags: " + project.tags.joined(separator: ", ")]
                    .compactMap { $0 }
                if !labels.isEmpty {
                    Text(labels.joined(separator: "  ·  ")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    // MARK: AGENTS.md

    @ViewBuilder private var agentsMdPane: some View {
        if file == nil && error == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let file, draft == nil, file.content == nil {
            ContentUnavailableView {
                Label("No AGENTS.md", systemImage: "doc.text")
            } description: {
                Text("Instructions every agent in this project reads.\n\(file.path)")
            } actions: {
                Button("Create AGENTS.md") { draft = "# \(project?.name ?? "Project")\n\n" }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(file?.path ?? "").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                    Spacer()
                    if dirty {
                        Text(file?.content == nil ? "Not created yet" : "Edited").font(.caption).foregroundStyle(.orange)
                        Button("Revert") { draft = file?.content }
                            .disabled(file?.content == nil)
                            .controlSize(.small)
                    }
                }
                TextEditor(text: Binding(get: { draft ?? "" }, set: { draft = $0 }))
                    .font(.body.monospaced())
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            }
            .padding()
        }
    }

    // MARK: Memories

    @ViewBuilder private var memoriesPane: some View {
        if let memories {
            if memories.isEmpty {
                ContentUnavailableView("No memories", systemImage: "brain",
                                       description: Text("None of this host's coding agents has stored memories for this folder."))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ForEach(Array(memories.enumerated()), id: \.offset) { _, group in
                            MemoryGroupView(group: group)
                        }
                        Text("Memories are read-only here; the agents manage them.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding()
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Loading and saving

    private func load() async {
        do {
            async let md = host.client.agentsMd(projectId: projectId)
            async let mem = host.client.memories(projectId: projectId)
            let (loadedFile, loadedMemories) = try await (md, mem)
            file = loadedFile
            draft = loadedFile.content
            memories = loadedMemories
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Saves the draft. Unless `force`, first checks that the file still matches what was loaded
    /// (the protocol has no versioned write, so this narrows the window rather than closing it).
    @discardableResult
    private func save(force: Bool) async -> Bool {
        guard let text = draft else { return false }
        saving = true
        defer { saving = false }
        do {
            if !force {
                let current = try await host.client.agentsMd(projectId: projectId)
                if current.content != file?.content {
                    conflict = current
                    return false
                }
            }
            let saved = try await host.client.setAgentsMd(projectId: projectId, content: text)
            file = saved
            draft = saved.content
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

/// One coding agent's memories: who keeps them, how far they reach, where they live.
struct MemoryGroupView: View {
    let group: AgentMemories

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ProviderIcon(provider: group.provider)
                Text(Self.providerName(group.provider)).font(.headline)
                Text(scopeLabel)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(scopeColor.opacity(0.15), in: Capsule())
                    .foregroundStyle(scopeColor)
                    .help(scopeHelp)
                Spacer()
            }
            HStack(spacing: 4) {
                Text(group.location).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.head).textSelection(.enabled)
                Button("Copy Location", systemImage: "doc.on.doc") { Clipboard.copy(group.location) }
                    .labelStyle(.iconOnly).buttonStyle(.borderless).font(.caption)
            }
            ForEach(group.entries) { entry in
                MemoryEntryRow(entry: entry)
            }
        }
    }

    private var scopeLabel: String {
        switch group.scope {
        case .project: "This project"
        case .global: "All folders"
        case .unknown(let raw): raw
        }
    }

    private var scopeHelp: String {
        switch group.scope {
        case .project: "Stored for this folder only"
        case .global: "Global: applies to every folder this agent works in"
        case .unknown(let raw): raw
        }
    }

    private var scopeColor: Color { group.scope == .global ? .orange : .blue }

    static func providerName(_ provider: ProviderID) -> String {
        switch provider {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .pi: "pi"
        case .opencode: "OpenCode"
        case .unknown(let raw): raw
        }
    }
}

struct MemoryEntryRow: View {
    let entry: MemoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                if let title = entry.title {
                    Text(title).fontWeight(.semibold)
                }
                Spacer()
                if let date = entry.updatedAt.flatMap(Self.parse) {
                    Text(date, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary)
                }
            }
            let note = Self.split(entry.text)
            if let description = note.description {
                Text(description).font(.callout).foregroundStyle(.secondary)
            }
            MarkdownView(blocks: Markdown.blocks(for: note.body, id: "memory-\(entry.id)"))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    /// Memory files often start with YAML front matter (name, description, metadata). Show the
    /// description as a subtitle and the rest as markdown, not the raw header.
    static func split(_ text: String) -> (description: String?, body: String) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
              let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" })
        else { return (nil, text) }
        let header = lines[1..<end]
        let description = header.first { $0.hasPrefix("description:") }
            .map { $0.dropFirst("description:".count).trimmingCharacters(in: .whitespaces) }
        let body = lines[(end + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (description, body)
    }

    static func parse(_ string: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
}
