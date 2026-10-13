import CasmKit
import QuartzCore
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @Bindable var chat: ChatModel
    // Vertical offsets only: ScrollPosition(edge:) / scrollTo(edge:) also set x = 0, which ignores
    // the content margins and shifted the transcript sideways.
    @State private var position = ScrollPosition()
    @State private var nearBottom = true
    @State private var scrolling = false
    @State private var width: CGFloat = 0
    /// Largest vertical offset, i.e. "scrolled to the bottom".
    @State private var bottomOffset: CGFloat = 0
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var showStatusLabel: Bool { sizeClass != .compact }
    #else
    private let showStatusLabel = true
    #endif
    @State private var confirmRestart = false

    var body: some View {
        VStack(spacing: 0) {
            if Exp.list { ListTranscript(chat: chat) } else { transcript }
            if let error = chat.error {
                ErrorBar(message: error) { chat.error = nil }
            }
            ForEach(chat.permissions) { request in
                PermissionBanner(request: request) { decision in
                    Task { await chat.respond(to: request, decision) }
                }
            }
            ForEach(chat.questions) { request in
                QuestionCard(request: request) { answers in
                    Task { await chat.answer(request, answers) }
                }
            }
            Composer(chat: chat, working: app.workingSubagents(of: chat.agentId, on: chat.host))
        }
        .navigationTitle(chat.agent?.name ?? "Transcript")
        #if os(macOS)
        .navigationSubtitle(subtitle)
        #endif
        .toolbar {
            // Status only when there is something to say; an idle agent shows nothing.
            if chat.status.isBusy {
                ToolbarItem {
                    ActivityBadge(status: chat.status, compact: !showStatusLabel)
                }
                ToolbarSpacer(.fixed)
            }
            ToolbarItem {
                Button("New Session", systemImage: "square.and.pencil") { confirmRestart = true }
                    .help("New session: same agent settings, empty conversation")
            }
            ToolbarItem {
                Menu("More", systemImage: "ellipsis") {
                    // Reload keeps the conversation (new process, same session); New Session clears it.
                    Button("Reload Agent", systemImage: "arrow.clockwise") { Task { await chat.reload() } }
                    Divider()
                    Button("Copy Agent ID", systemImage: "doc.on.doc") { copy(chat.agentId) }
                    if let session = chat.agent?.nativeSessionId {
                        Button("Copy Session ID", systemImage: "doc.on.doc") { copy(session) }
                    }
                }
                .menuIndicator(.hidden)
                .help("More actions")
            }
        }
        .confirmationDialog("Start a new session?", isPresented: $confirmRestart) {
            Button("New Session", role: .destructive) { Task { await chat.restart() } }
        } message: {
            Text("The agent keeps its settings but forgets this conversation; the next message starts a fresh session. The old transcript stays in the provider's own store.")
        }
        #if DEBUG && os(macOS)
        .onAppear { DebugControl.shared.scroller = { position = $0 } }
        #endif
    }

    private var margin: CGFloat { max(20, (width - 900) / 2) }

    /// "34k / 200k context" from the latest `usage` event.
    private var contextText: String? {
        guard let used = chat.usage?.contextTokens else { return nil }
        let k = { (n: Double) in n >= 1000 ? "\(Int((n / 1000).rounded()))k" : "\(Int(n))" }
        if let window = chat.usage?.contextWindow { return "\(k(used)) / \(k(window)) context" }
        return "\(k(used)) context"
    }

    private func scrollToBottom() {
        position.scrollTo(y: bottomOffset)
        // Content may still grow this frame (first load); settle once more on the next one.
        Task { @MainActor in position.scrollTo(y: bottomOffset) }
    }

    /// Where the agent works and how full its context is. Model and mode are in the composer.
    private var subtitle: String {
        guard let agent = chat.agent else { return "\(chat.items.count) items" }
        return [Self.abbreviate(agent.cwd), contextText].compactMap { $0 }.joined(separator: " · ")
    }

    /// `/Users/me/x` or `/home/me/x` → `~/x`. Paths are on the agent's host, so this is cosmetic only.
    static func abbreviate(_ path: String) -> String {
        guard let match = path.firstMatch(of: /^\/(Users|home)\/[^\/]+/) else { return path }
        return "~" + path[match.range.upperBound...]
    }

    private func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if chat.canLoadOlder {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .onAppear {
                            // Keep the row that was on top in place, so revealing older rows doesn't
                            // move the view (and doesn't cascade while the sentinel stays visible).
                            let anchor = chat.visibleItems.first?.id
                            Task {
                                #if DEBUG && os(macOS)
                                let t0 = CACurrentMediaTime(), before = chat.visibleItems.count
                                #endif
                                await chat.revealOlder()
                                #if DEBUG && os(macOS)
                                DebugControl.shared.afterIdle {
                                    DebugControl.shared.log(String(format: "reveal %d→%d rows: %.0f ms", before, chat.visibleItems.count, (CACurrentMediaTime() - t0) * 1000))
                                }
                                #endif
                                if let anchor { position.scrollTo(id: anchor, anchor: .topLeading) }
                            }
                        }
                        // A new identity per window, so onAppear fires again if it stays visible.
                        .id("older-\(chat.windowStart)-\(chat.historyStart ?? 0)")
                }
                ForEach(chat.visibleItems) { item in
                    ItemRow(item: item, expanded: $chat.expanded)
                        .modifier(HoverSelectable(scrolling: scrolling))
                        .modifier(Column(margin: margin))
                }
                Group {
                    if let draft = chat.draft {
                        DraftRow(draft: draft)
                    } else if chat.status == .running {
                        ProgressView().controlSize(.small).padding(.leading, 4)
                    }
                }
                .modifier(Column(margin: margin))
            }
            .scrollTargetLayout()
        }
        // Side margins are padding inside each full-width row. Content margins on the scroll view
        // (or padding around the stack) left the transcript shifted sideways after programmatic
        // scrolls on iOS, because ScrollPosition offsets ignore them. Wide windows centre a 900 pt column.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .contentMargins(.vertical, 16, for: .scrollContent)
        .accessibilityIdentifier("transcript")
        .onScrollPhaseChange { _, phase in scrolling = phase != .idle }
        .scrollPosition(Exp.noPosition ? .constant(ScrollPosition()) : $position)
        // Keeps the bottom in place when content grows, so prepending older pages doesn't jump
        // and streaming text stays in view.
        .defaultScrollAnchor(Exp.noAnchor ? nil : .bottom)
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            max(0, geo.contentSize.height + geo.contentInsets.top + geo.contentInsets.bottom - geo.containerSize.height) - geo.contentInsets.top
        } action: { _, y in
            bottomOffset = y
        }
        .onScrollGeometryChange(for: Bool.self) { geo in
            Exp.noGeo || geo.contentSize.height - geo.visibleRect.maxY < 80
        } action: { _, near in
            nearBottom = near
            if near { chat.trimWindow() }
        }
        #if DEBUG && os(macOS)
        .onScrollGeometryChange(for: CGRect.self) { geo in
            CGRect(x: geo.contentOffset.y, y: 0, width: geo.contentSize.height, height: geo.containerSize.height)
        } action: { _, r in
            DebugControl.shared.offsetY = r.minX
            DebugControl.shared.contentHeight = r.width
            DebugControl.shared.viewportHeight = r.height
        }
        #endif
        .overlay {
            if chat.loading { ProgressView() }
        }
        .overlay(alignment: .bottomTrailing) {
            if !nearBottom {
                Button("Jump to bottom", systemImage: "arrow.down") {
                    scrollToBottom()
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .padding(16)
            }
        }
        .onChange(of: chat.scrollToBottomRequest) {
            scrollToBottom()
        }
        // Follow new items (and growing tool output) while the reader is at the bottom.
        .onChange(of: chat.items.last) {
            if nearBottom { scrollToBottom() }
        }
    }
}

// MARK: - Rows

struct ItemRow: View {
    let item: Item
    @Binding var expanded: Set<String>

    var body: some View {
        switch item {
        case .user(_, let text, let images):
            UserBubble(text: text, images: images)
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
        case .notice(_, let text, let level):
            NoticeRow(text: text, level: level)
        case .plan(_, let entries):
            PlanRow(entries: entries)
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
    var images: [ImageData] = []

    var body: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 6) {
                if !images.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(images.enumerated()), id: \.offset) { _, image in ImageThumbnail(image: image) }
                    }
                }
                if !text.isEmpty { bubble }
            }
        }
    }

    private var bubble: some View {
        Text(Markdown.inline(text))
            .modifier(Selectable())
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// An image attached to a prompt; history may leave out the data of very large ones.
struct ImageThumbnail: View {
    let image: ImageData
    var size: CGFloat = 96

    var body: some View {
        Group {
            if let data = image.data.flatMap({ Data(base64Encoded: $0) }), let picture = Self.decode(data) {
                picture.resizable().scaledToFill()
            } else {
                Image(systemName: "photo").font(.title2).foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private static func decode(_ data: Data) -> Image? {
        #if os(macOS)
        NSImage(data: data).map(Image.init(nsImage:))
        #else
        UIImage(data: data).map(Image.init(uiImage:))
        #endif
    }
}

struct NoticeRow: View {
    let text: String
    let level: NoticeLevel?

    var body: some View {
        HStack(spacing: 5) {
            switch level {
            case .warning: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            case .error: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
            default: EmptyView()
            }
            Text(text)
                .foregroundStyle(level == .error ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
        }
        .font(.caption)
        .frame(maxWidth: .infinity)
    }
}

/// The agent's todo list.
struct PlanRow: View {
    let entries: [PlanEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("Plan", systemImage: "checklist").font(.callout.weight(.medium)).foregroundStyle(.secondary)
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    switch entry.status {
                    case .completed: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    case .inProgress: Image(systemName: "circle.dotted.circle").foregroundStyle(.blue)
                    default: Image(systemName: "circle").foregroundStyle(.tertiary)
                    }
                    Text(entry.text)
                        .strikethrough(entry.status == .completed, color: .secondary)
                        .foregroundStyle(entry.status == .completed ? .secondary : .primary)
                        .fontWeight(entry.status == .inProgress ? .medium : .regular)
                }
                .font(.callout)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
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
        // Buttons beside the request when there's room, below it on narrow screens.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 10) {
                summary
                Spacer()
                buttons
            }
            VStack(alignment: .leading, spacing: 10) {
                summary
                HStack { Spacer(); buttons }
            }
        }
        .padding(12)
        .background(.orange.opacity(0.12))
    }

    private var summary: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange).font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text("Allow \(request.toolName)?").fontWeight(.semibold)
                if let detail = request.title ?? request.input?.prettyPrinted {
                    Text(detail).font(.callout.monospaced()).foregroundStyle(.secondary).lineLimit(4)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: 8) {
            Button("Deny", role: .destructive) { respond(.deny) }
            if request.canAlwaysAllow {
                Button("Always allow") { respond(.allowAlways) }
            }
            Button("Allow") { respond(.allow) }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .fixedSize()
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

/// The agent's activity in the chat toolbar: a spinner while it works, an orange hand when it
/// waits for a permission or an answer.
struct ActivityBadge: View {
    let status: AgentStatus
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            if status == .waiting {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            } else {
                WorkingIndicator()
            }
            if !compact {
                Text(status == .waiting ? "Needs you" : "Working")
                    .foregroundStyle(status == .waiting ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            }
        }
        .font(.callout.weight(.medium))
        .padding(.horizontal, 6)
        .fixedSize()
        .help(status == .waiting ? "Waiting for a permission or an answer" : "Working on a turn")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status == .waiting ? "Needs you" : "Working")
    }
}

/// The animated "working" glyph, used in the toolbar and the composer.
struct WorkingIndicator: View {
    var body: some View {
        Image(systemName: "progress.indicator")
            .symbolEffect(.variableColor.iterative.dimInactiveLayers.nonReversing, options: .repeat(.continuous))
            .foregroundStyle(.secondary)
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private var label: String {
        switch status {
        case .running: "Running"
        case .waiting: "Waiting for you"
        case .idle: "Idle"
        case .unknown(let raw): raw
        }
    }
}

/// A full-width transcript row with the column's side margins inside it.
private struct Column: ViewModifier {
    let margin: CGFloat

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, margin)
    }
}
