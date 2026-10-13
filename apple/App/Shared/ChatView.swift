import CasmKit
import SwiftUI

struct ChatView: View {
    @Bindable var chat: ChatModel
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var nearBottom = true
    @State private var confirmRestart = false

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if let error = chat.error {
                ErrorBar(message: error) { chat.error = nil }
            }
            ForEach(chat.permissions) { request in
                PermissionBanner(request: request) { decision in
                    Task { await chat.respond(to: request, decision) }
                }
            }
            Divider()
            Composer(busy: chat.status.isBusy, enabled: chat.host?.isOnline ?? false) { text in
                await chat.send(text)
            } interrupt: {
                Task { await chat.interrupt() }
            }
        }
        .navigationTitle(chat.agent?.name ?? "Transcript")
        #if os(macOS)
        .navigationSubtitle(subtitle)
        #endif
        .toolbar {
            ToolbarItem {
                StatusBadge(status: chat.status, showLabel: true)
            }
            ToolbarItemGroup {
                Button("Reload", systemImage: "arrow.clockwise") { Task { await chat.reload() } }
                    .help("Restart the agent process on the same session")
                Button("Restart", systemImage: "arrow.counterclockwise.circle") { confirmRestart = true }
                    .help("Start a new session with the same config")
            }
        }
        .confirmationDialog("Start a new session?", isPresented: $confirmRestart) {
            Button("Restart", role: .destructive) { Task { await chat.restart() } }
        } message: {
            Text("The next message starts a fresh session. The current transcript stays in Claude's own store.")
        }
        #if DEBUG && os(macOS)
        .onAppear { DebugControl.shared.scroller = { position = $0 } }
        #endif
    }

    private var subtitle: String {
        guard let agent = chat.agent else { return "\(chat.items.count) items" }
        return [agent.provider.rawValue, agent.config.model, agent.config.mode, agent.cwd].compactMap { $0 }.joined(separator: " · ")
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if chat.canLoadOlder {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .onAppear { Task { await chat.loadOlder() } }
                }
                ForEach(chat.items) { item in
                    ItemRow(item: item, expanded: $chat.expanded)
                }
                if let draft = chat.draft, !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    DraftRow(draft: draft)
                } else if chat.status == .running {
                    ProgressView().controlSize(.small).padding(.leading, 4)
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .scrollPosition($position)
        // Keeps the bottom in place when content grows, so prepending older pages doesn't jump
        // and streaming text stays in view.
        .defaultScrollAnchor(.bottom)
        .onScrollGeometryChange(for: Bool.self) { geo in
            geo.contentSize.height - geo.visibleRect.maxY < 80
        } action: { _, near in
            nearBottom = near
        }
        #if DEBUG && os(macOS)
        .onScrollGeometryChange(for: CGSize.self) { geo in
            CGSize(width: geo.contentSize.height, height: geo.containerSize.height)
        } action: { _, size in
            DebugControl.shared.contentHeight = size.width
            DebugControl.shared.viewportHeight = size.height
        }
        #endif
        .overlay {
            if chat.loading { ProgressView() }
        }
        .overlay(alignment: .bottomTrailing) {
            if !nearBottom {
                Button("Jump to bottom", systemImage: "arrow.down") {
                    position.scrollTo(edge: .bottom)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .padding(16)
            }
        }
        .onChange(of: chat.scrollToBottomRequest) {
            position.scrollTo(edge: .bottom)
        }
    }
}

// MARK: - Rows

struct ItemRow: View {
    let item: Item
    @Binding var expanded: Set<String>

    var body: some View {
        switch item {
        case .user(_, let text) where text.hasPrefix("[Request interrupted"):
            // Claude stores the interrupt marker as a user message.
            Text("Interrupted").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        case .user(_, let text):
            UserBubble(text: text)
        case .assistant(let id, let text):
            MarkdownView(blocks: Markdown.blocks(for: text, id: id))
        case .reasoning(let id, let text):
            DisclosureGroup(isExpanded: binding(id)) {
                Text(text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            } label: {
                Label("Thinking", systemImage: "brain").font(.callout).foregroundStyle(.secondary)
            }
        case .tool(let call):
            ToolRow(call: call, expanded: binding(call.id))
        case .notice(_, let text):
            Text(text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        case .unknown(_, let kind):
            Text("Unsupported item: \(kind)").font(.caption).foregroundStyle(.tertiary)
        }
    }

    private func binding(_ id: String) -> Binding<Bool> {
        Binding { expanded.contains(id) } set: { if $0 { expanded.insert(id) } else { expanded.remove(id) } }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 60)
            Text(Markdown.inline(text))
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct DraftRow: View {
    let draft: ChatModel.Draft

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if draft.kind == .reasoning {
                Image(systemName: "brain").foregroundStyle(.secondary)
            }
            Text(draft.text)
                .foregroundStyle(draft.kind == .reasoning ? .secondary : .primary)
                .opacity(0.85)
        }
    }
}

struct ToolRow: View {
    let call: ToolCall
    @Binding var expanded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    statusIcon.frame(width: 14)
                    Text(call.name).fontWeight(.medium)
                    Text(summary).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(.tertiary)
                }
                .font(.callout)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                if let input = call.input {
                    ToolSection(title: "Input", text: input.prettyPrinted)
                }
                if let output = call.output, !output.isEmpty {
                    ToolSection(title: "Output", text: output)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private var statusIcon: some View {
        switch call.status {
        case .running: ProgressView().controlSize(.mini)
        case .done: Image(systemName: "checkmark").foregroundStyle(.green)
        case .error: Image(systemName: "xmark").foregroundStyle(.red)
        case .unknown: Image(systemName: "questionmark").foregroundStyle(.secondary)
        }
    }

    /// The most telling input field, e.g. the path or the command.
    private var summary: String {
        guard let input = call.input else { return "" }
        for key in ["file_path", "command", "pattern", "path", "url", "query", "description", "prompt"] {
            if let value = input[key]?.stringValue { return value }
        }
        if let s = input.stringValue { return s }
        return ""
    }
}

struct ToolSection: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(text.count > 4000 ? text.prefix(4000) + "\n…" : text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
                .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

// MARK: - Banners and composer

struct PermissionBanner: View {
    let request: PermissionRequest
    let respond: (PermissionDecision) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange).font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text("Allow \(request.toolName)?").fontWeight(.semibold)
                if let detail = request.title ?? request.input?.prettyPrinted {
                    Text(detail).font(.callout.monospaced()).foregroundStyle(.secondary).lineLimit(4)
                }
            }
            Spacer()
            Button("Deny", role: .destructive) { respond(.deny) }
            if request.canAlwaysAllow {
                Button("Always allow") { respond(.allowAlways) }
            }
            Button("Allow") { respond(.allow) }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .padding(12)
        .background(.orange.opacity(0.12))
    }
}

struct ErrorBar: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(message).font(.callout).lineLimit(2)
            Spacer()
            Button("Dismiss", systemImage: "xmark", action: dismiss).labelStyle(.iconOnly).buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.red.opacity(0.1))
    }
}

struct Composer: View {
    let busy: Bool
    let enabled: Bool
    let send: (String) async -> Void
    let interrupt: () -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(busy ? "Queue a message…" : "Message", text: $text, axis: .vertical)
                .lineLimit(1...8)
                .textFieldStyle(.plain)
                .focused($focused)
                .onSubmit(submit)
                .padding(.vertical, 6)
            if busy {
                Button("Interrupt", systemImage: "stop.fill", action: interrupt)
                    .keyboardShortcut(".", modifiers: .command)
                    .help("Interrupt the running turn (⌘.)")
            }
            Button("Send", systemImage: "arrow.up", action: submit)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !enabled)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .onAppear { focused = true }
    }

    private func submit() {
        let message = text
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, enabled else { return }
        text = ""
        Task { await send(message) }
    }
}

struct StatusBadge: View {
    let status: AgentStatus
    var showLabel = false

    var body: some View {
        HStack(spacing: 4) {
            switch status {
            case .running:
                Image(systemName: "circle.fill").foregroundStyle(.green).symbolEffect(.pulse)
            case .waiting:
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            case .idle, .unknown:
                Image(systemName: "circle").foregroundStyle(.tertiary)
            }
            if showLabel { Text(label).foregroundStyle(.secondary) }
        }
        .font(.caption)
        .help(label)
    }

    private var label: String {
        switch status {
        case .running: "Running"
        case .waiting: "Waiting for permission"
        case .idle: "Idle"
        case .unknown(let raw): raw
        }
    }
}
