import CasmKit
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
import PhotosUI
#endif

/// The message box under the transcript, Paseo-style: an activity pill, image thumbnails, a rounded
/// input with "/" and "@" completion and a "!" shell mode, and a row with attach, model / effort / mode
/// pickers, the context ring, and the busy, voice and send controls.
struct Composer: View {
    let chat: ChatModel
    /// Running subagents of this agent, on any host.
    let working: Int
    @State private var text = ""
    @State private var selection: TextSelection?
    @FocusState private var focused: Bool
    @State private var attachments: [Attachment] = []
    @State private var suggestions: [Suggestion] = []
    @State private var highlighted = 0
    /// The completion the user dismissed with Esc; stays hidden until the context changes.
    @State private var dismissedContext: CompletionContext?
    @State private var pickingFiles = false
    @State private var dropTargeted = false
    #if os(iOS)
    @State private var photoItems: [PhotosPickerItem] = []
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compactWidth: Bool { sizeClass == .compact }
    #else
    private let compactWidth = false
    @State private var pasteMonitor: Any?
    #endif

    private var busy: Bool { chat.status.isBusy }
    private var online: Bool { chat.host?.isOnline ?? false }
    /// A leading "!" runs the rest as a shell command in the agent's cwd.
    private var shellMode: Bool { text.hasPrefix("!") }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool {
        guard online else { return false }
        if shellMode { return trimmed.count > 1 && !busy }
        return !trimmed.isEmpty || !attachments.isEmpty
    }

    private var caret: String.Index? {
        if case .selection(let range) = selection?.indices, range.isEmpty { return range.upperBound }
        return selection == nil ? text.endIndex : nil
    }

    private var context: CompletionContext? {
        guard !shellMode, let caret else { return nil }
        return CompletionContext.at(caret, in: text)
    }

    private var showSuggestions: Bool { !suggestions.isEmpty && context != nil && context != dismissedContext }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if working > 0 {
                ActivityPill(count: working)
            }
            VStack(alignment: .leading, spacing: 10) {
                if showSuggestions {
                    SuggestionList(suggestions: suggestions, highlighted: highlighted, choose: accept)
                    Divider()
                }
                if !attachments.isEmpty && !shellMode {
                    AttachmentStrip(attachments: attachments) { a in attachments.removeAll { $0.id == a.id } }
                }
                if shellMode {
                    Label("Shell command in \(ChatView.abbreviate(chat.agent?.cwd ?? "the agent's folder"))", systemImage: "terminal")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.green)
                }
                TextField("Message the agent", text: $text, selection: $selection, axis: .vertical)
                    .accessibilityLabel("Message")
                    .textFieldStyle(.plain)
                    .font(shellMode ? .body.monospaced() : .body)
                    .lineLimit(2...10)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down, action: handleReturn)
                    .onKeyPress(.tab) { acceptHighlighted() }
                    .onKeyPress(.upArrow) { moveHighlight(-1) }
                    .onKeyPress(.downArrow) { moveHighlight(1) }
                    .onKeyPress(.escape) {
                        guard showSuggestions else { return .ignored }
                        dismissedContext = context
                        return .handled
                    }
                    #if os(iOS)
                    .onSubmit(submit)
                    #endif
                HStack(spacing: 14) {
                    attachButton
                    if chat.agent != nil {
                        // Icons only on iPhone-width screens.
                        ConfigPickers(chat: chat).environment(\.compactPickers, compactWidth)
                    }
                    Spacer(minLength: 0)
                    if busy {
                        WorkingIndicator()
                    }
                    ContextRing(usage: chat.usage)
                    Button("Dictate", systemImage: "mic") {}
                        .labelStyle(.iconOnly)
                        .disabled(true)
                        .help("Dictation comes with voice (phase 2)")
                    if !compactWidth {
                        Button("Voice mode", systemImage: "waveform") {}
                            .labelStyle(.iconOnly)
                            .disabled(true)
                            .help("Voice mode comes in phase 2")
                    }
                    sendOrInterrupt
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .background(boxFill, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(boxStroke, lineWidth: dropTargeted ? 2 : 1))
            #if os(macOS)
            // Clicking the padding focuses the field. On iOS this would swallow taps on the pickers.
            .contentShape(RoundedRectangle(cornerRadius: 18))
            .onTapGesture { focused = true }
            #endif
            .onDrop(of: [.fileURL, .image], isTargeted: $dropTargeted) { providers in
                // NSItemProvider isn't Sendable; the providers are only read by the loading task.
                nonisolated(unsafe) let dropped = providers
                Task { attachments += await ImageEncoding.load(from: dropped).map { Attachment(image: $0) } }
                return true
            }
        }
        #if os(iOS)
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        #else
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
        #endif
        .padding(.top, 6)
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
        .task(id: context) { await refreshSuggestions() }
        .onChange(of: chat.focusComposerRequest) { focused = true }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url), let image = ImageEncoding.encode(data) {
                    attachments.append(Attachment(image: image))
                }
            }
        }
        #if os(macOS)
        .onAppear {
            focused = true
            installPasteMonitor()
        }
        .onDisappear {
            if let pasteMonitor { NSEvent.removeMonitor(pasteMonitor) }
            pasteMonitor = nil
        }
        #endif
    }

    private var boxFill: Color { shellMode ? Color.green.opacity(0.06) : Color.secondary.opacity(0.05) }
    private var boxStroke: Color {
        if dropTargeted { return .accentColor }
        return shellMode ? Color.green.opacity(0.45) : Color.secondary.opacity(0.2)
    }

    @ViewBuilder private var attachButton: some View {
        #if os(iOS)
        PhotosPicker(selection: $photoItems, maxSelectionCount: 6, matching: .images) {
            Image(systemName: "plus").accessibilityLabel("Attach images")
        }
        .disabled(shellMode)
        .onChange(of: photoItems) {
            let items = photoItems
            photoItems = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = ImageEncoding.encode(data) {
                        attachments.append(Attachment(image: image))
                    }
                }
            }
        }
        #else
        Button("Attach images", systemImage: "plus") { pickingFiles = true }
            .labelStyle(.iconOnly)
            .disabled(shellMode)
            .help("Attach images (or paste / drop them here)")
        #endif
    }

    @ViewBuilder private var sendOrInterrupt: some View {
        // While a turn runs the round button is Interrupt; Enter still queues a message.
        if busy && !shellMode {
            Button("Interrupt", systemImage: "stop.fill") { Task { await chat.interrupt() } }
                .labelStyle(.iconOnly)
                .font(.caption)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Color.primary.opacity(0.8), in: Circle())
                .help("Interrupt the running turn (⌘.). Enter still queues a message.")
        } else {
            Button(shellMode ? "Run" : "Send", systemImage: shellMode ? "return" : "arrow.up", action: submit)
                .labelStyle(.iconOnly)
                .fontWeight(.semibold)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(canSend ? (shellMode ? Color.green : Color.accentColor) : Color.secondary.opacity(0.35), in: Circle())
                .disabled(!canSend)
                .help(shellMode ? "Run in the agent's folder (Enter)" : "Send (Enter). Shift-Enter for a new line.")
        }
    }

    // MARK: Keys

    /// Enter accepts a suggestion or sends (queues while busy); Shift/Option-Enter inserts a newline.
    private func handleReturn(_ press: KeyPress) -> KeyPress.Result {
        if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
            insertNewline()
        } else if showSuggestions {
            _ = acceptHighlighted()
        } else {
            submit()
        }
        return .handled
    }

    private func acceptHighlighted() -> KeyPress.Result {
        guard showSuggestions, suggestions.indices.contains(highlighted) else { return .ignored }
        accept(suggestions[highlighted])
        return .handled
    }

    private func moveHighlight(_ delta: Int) -> KeyPress.Result {
        guard showSuggestions else { return .ignored }
        highlighted = (highlighted + delta + suggestions.count) % suggestions.count
        return .handled
    }

    private func insertNewline() {
        replace(caretRange ?? text.endIndex..<text.endIndex, with: "\n")
    }

    private var caretRange: Range<String.Index>? {
        if case .selection(let range) = selection?.indices { return range }
        return nil
    }

    private func replace(_ range: Range<String.Index>, with string: String) {
        let offset = text.distance(from: text.startIndex, to: range.lowerBound) + string.count
        text.replaceSubrange(range, with: string)
        selection = TextSelection(insertionPoint: text.index(text.startIndex, offsetBy: offset))
    }

    // MARK: Completion

    private func refreshSuggestions() async {
        highlighted = 0
        guard let context else { suggestions = []; return }
        switch context.kind {
        case .command:
            await chat.loadCommands()
            suggestions = Array(Suggestion.commands(chat.commands, matching: context.query).prefix(30))
        case .mention:
            try? await Task.sleep(for: .milliseconds(120)) // debounce typing
            guard !Task.isCancelled else { return }
            suggestions = Suggestion.files(await chat.searchFiles(context.query))
        }
    }

    private func accept(_ suggestion: Suggestion) {
        guard let context else { return }
        replace(context.range, with: suggestion.insert)
        suggestions = []
        focused = true
    }

    // MARK: Send

    private func submit() {
        guard canSend else { return }
        let message = text
        let images = attachments.map(\.image)
        let shell = shellMode
        text = ""
        attachments = []
        suggestions = []
        #if os(iOS)
        focused = false
        #endif
        Task {
            let ok = shell ? await chat.shell(String(message.dropFirst())) : await chat.send(message, images: images)
            // Put the draft back if it didn't go through.
            if !ok && text.isEmpty {
                text = message
                if !shell { attachments = images.map { Attachment(image: $0) } }
            }
        }
    }

    #if os(macOS)
    /// ⌘V with an image (or image files) on the pasteboard attaches it instead of pasting text.
    private func installPasteMonitor() {
        guard pasteMonitor == nil else { return }
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard focused, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers == "v" else { return event }
            let board = NSPasteboard.general
            let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
                .filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }
            var images = urls.compactMap { url in (try? Data(contentsOf: url)).flatMap { ImageEncoding.encode($0) } }
            if images.isEmpty, board.string(forType: .string) == nil,
               let data = board.data(forType: .png) ?? board.data(forType: .tiff), let image = ImageEncoding.encode(data) {
                images = [image]
            }
            guard !images.isEmpty else { return event }
            attachments += images.map { Attachment(image: $0) }
            return nil
        }
    }
    #endif
}

struct ActivityPill: View {
    let count: Int

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "smallcircle.filled.circle")
                .foregroundStyle(.blue)
                .symbolEffect(.pulse)
            Text("\(count) working")
                .foregroundStyle(.secondary)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.05), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.2)))
    }
}

/// Model, effort and mode menus, fed by `provider.catalog`.
struct ConfigPickers: View {
    let chat: ChatModel

    var body: some View {
        if let agent = chat.agent, let host = chat.host {
            let catalog = host.catalog(for: agent.provider)
            let models = catalog?.models ?? []
            let model = models.first { $0.id == agent.config.model } ?? (agent.config.model == nil ? models.first { $0.isDefault == true } : nil)
            let modelName = model?.displayName ?? agent.config.model ?? "Default model"

            Menu {
                ForEach(models) { m in
                    Button {
                        // Clear an effort the new model doesn't accept.
                        let dropEffort = agent.config.effort.map { !(m.efforts ?? []).contains($0) } ?? false
                        Task { await chat.updateConfig(AgentConfig(model: m.id, effort: dropEffort ? "" : nil)) }
                    } label: {
                        Text(m.displayName)
                        if let d = m.description { Text(d) }
                        if m.id == model?.id { Image(systemName: "checkmark") }
                    }
                }
            } label: {
                PickerLabel(icon: Image(systemName: "asterisk"), title: modelName)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Model")

            if let efforts = model?.efforts, !efforts.isEmpty {
                Menu {
                    Button {
                        Task { await chat.updateConfig(AgentConfig(effort: "")) }
                    } label: {
                        Text("Default")
                        if agent.config.effort == nil { Image(systemName: "checkmark") }
                    }
                    ForEach(efforts, id: \.self) { e in
                        Button {
                            Task { await chat.updateConfig(AgentConfig(effort: e)) }
                        } label: {
                            Text(e.effortName)
                            if agent.config.effort == e { Image(systemName: "checkmark") }
                        }
                    }
                } label: {
                    PickerLabel(icon: Image(systemName: "brain"), title: agent.config.effort?.effortName ?? "Default effort")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Reasoning effort")
            }

            ModePicker(chat: chat, provider: agent.provider, modes: catalog?.modes ?? [], current: agent.config.mode)
        }
    }
}

/// Paseo-style mode picker: a searchable popover with a shield icon per mode.
struct ModePicker: View {
    let chat: ChatModel
    let provider: ProviderID
    let modes: [ModeInfo]
    let current: String?
    @State private var open = false
    @State private var search = ""

    private var selected: ModeInfo? { modes.first { $0.id == (current ?? "default") } }

    private var filtered: [ModeInfo] {
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return modes }
        // Name matches first, then description matches.
        let byName = modes.filter { $0.displayName.localizedCaseInsensitiveContains(q) || $0.id.localizedCaseInsensitiveContains(q) }
        let byDescription = modes.filter { m in !byName.contains(m) && (m.description ?? "").localizedCaseInsensitiveContains(q) }
        return byName + byDescription
    }

    var body: some View {
        Button {
            open.toggle()
        } label: {
            PickerLabel(icon: ModeIcon(provider: provider, mode: selected?.id ?? current ?? "default"),
                        title: selected?.displayName ?? current ?? "Default")
        }
        .fixedSize()
        .help("Permission mode")
        .popover(isPresented: $open, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 4) {
                TextField("Search modes...", text: $search)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .onSubmit { if let first = filtered.first { choose(first) } }
                Divider()
                ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                ForEach(filtered) { mode in
                    Button { choose(mode) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            ModeIcon(provider: provider, mode: mode.id).frame(width: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(mode.displayName)
                                if let d = mode.description {
                                    Text(d).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 12)
                            if mode.id == selected?.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if filtered.isEmpty {
                    Text("No matching modes").foregroundStyle(.secondary).padding(10)
                }
                }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .padding(6)
            #if os(macOS)
            .frame(width: 320)
            .frame(maxHeight: 460)
            #else
            // On iPhone the popover becomes a sheet; a popover above the composer has no room.
            .padding(.top, 10)
            .presentationDetents([.medium, .large])
            #endif
        }
    }

    private func choose(_ mode: ModeInfo) {
        open = false
        search = ""
        Task { await chat.updateConfig(AgentConfig(mode: mode.id)) }
    }
}

/// Shield icons for Claude's permission modes; a generic one for other providers' modes.
struct ModeIcon: View {
    let provider: ProviderID
    let mode: String

    var body: some View {
        switch (provider, mode) {
        case (.claude, "plan"): overlay("ellipsis")
        case (.claude, "default"): Image(systemName: "shield")
        case (.claude, "acceptEdits"): overlay("plus")
        case (.claude, "auto"): Image(systemName: "checkmark.shield")
        case (.claude, "bypassPermissions"): Image(systemName: "shield.slash")
        default: Image(systemName: "slider.horizontal.3")
        }
    }

    /// A shield with a small glyph inside, for symbols SF Symbols doesn't ship.
    private func overlay(_ glyph: String) -> some View {
        Image(systemName: "shield").overlay {
            Image(systemName: glyph).font(.system(size: 6, weight: .heavy)).offset(y: -0.5)
        }
    }
}

extension EnvironmentValues {
    @Entry var compactPickers = false
}

private struct PickerLabel<Icon: View>: View {
    let icon: Icon
    let title: String
    @Environment(\.compactPickers) private var compact

    var body: some View {
        HStack(spacing: 5) {
            icon
            if !compact { Text(title).lineLimit(1) }
            Image(systemName: "chevron.down").font(.caption2)
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
    }
}

private extension String {
    /// "xhigh" → "Extra high", "medium" → "Medium".
    var effortName: String {
        switch self {
        case "xhigh": "Extra high"
        default: prefix(1).uppercased() + dropFirst()
        }
    }
}
