import CasmKit
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
import PhotosUI
#endif

/// The message box under the transcript, Paseo-style: an activity pill, image thumbnails, a rounded
/// input with "/" and "@" completion and a "!" shell mode, and a row with attach, model / effort / mode
/// pickers, the context ring, and the send / stop control.
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
    @State private var suggestionHeight: CGFloat = 0
    /// The completion the user dismissed with Esc; stays hidden until the context changes.
    @State private var dismissedContext: CompletionContext?
    @State private var pickingFiles = false
    @State private var dropTargeted = false
    #if os(iOS)
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    /// The clipboard holds an image we haven't pasted yet (UIPasteboard.changeCount when last pasted).
    @State private var clipboardHasImage = false
    @State private var pastedChangeCount = -1
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compactWidth: Bool { sizeClass == .compact }
    #else
    private let compactWidth = false
    @State private var pasteMonitor: Any?
    #endif

    @State private var scheduling: ScheduleEditor.Mode?

    /// "Send later…": a once schedule that messages this agent, with the composer text as prompt.
    private func sendLater() {
        scheduling = .new(agentId: chat.agentId, prompt: text, once: true)
    }

    private var draftKey: String { chat.draftKey }
    /// A project's new-agent chat: no agent yet for "!", "/", "@" or Send Later.
    private var creating: Bool { chat.newAgent != nil }

    private var busy: Bool { chat.status.isBusy }
    private var online: Bool { chat.host?.isOnline ?? false }
    /// A leading "!" runs the rest as a shell command in the agent's cwd.
    private var shellMode: Bool { !creating && text.hasPrefix("!") }
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
        guard !shellMode, !creating, let caret else { return nil }
        return CompletionContext.at(caret, in: text)
    }

    private var showSuggestions: Bool { !suggestions.isEmpty && context != nil && context != dismissedContext }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Schedules and usage live at the host level in the sidebar; only working subagents here.
            if working > 0 { ActivityPill(count: working) }
            VStack(alignment: .leading, spacing: 10) {
                #if os(iOS)
                if clipboardHasImage && !shellMode {
                    Button { pasteImages() } label: {
                        Label("Paste image from clipboard", systemImage: "doc.on.clipboard")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                }
                #endif
                if !attachments.isEmpty && !shellMode {
                    AttachmentStrip(attachments: attachments) { a in attachments.removeAll { $0.id == a.id } }
                }
                if shellMode {
                    Label("Shell command in \(ChatView.abbreviate(chat.agent?.cwd ?? "the agent's folder"))", systemImage: "terminal")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.green)
                }
                TextField(creating ? "Message a new agent" : "Message the agent", text: $text, selection: $selection, axis: .vertical)
                    .accessibilityLabel("Message")
                    .textFieldStyle(.plain)
                    .font(shellMode ? .system(size: 14, design: .monospaced) : .system(size: Theme.proseSize))
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
                    if chat.provider != nil {
                        // Icons only on iPhone-width screens.
                        ConfigPickers(chat: chat).environment(\.compactPickers, compactWidth)
                    }
                    Spacer(minLength: 0)
                    // M4: the toolbar's Working badge is the one busy cue (and Stop shows here).
                    ContextRing(usage: chat.usage, limits: chat.provider.flatMap { chat.host?.limits[$0] })
                    // M5: dictation and voice mode come back with voice (phase 2); no dead buttons until then.
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
            // Suggestions float above the box: opening them must not resize the transcript (that
            // relayout left its lazy rows blank until the next scroll).
            .overlay(alignment: .top) {
                if showSuggestions {
                    SuggestionList(suggestions: suggestions, highlighted: highlighted, choose: accept)
                        .padding(6)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.secondary.opacity(0.2)))
                        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { suggestionHeight = $0 }
                        .offset(y: -suggestionHeight - 8)
                }
            }
            .onDrop(of: [.fileURL, .image], isTargeted: $dropTargeted) { providers in
                // NSItemProvider isn't Sendable; the providers are only read by the loading task.
                nonisolated(unsafe) let dropped = providers
                Task { attachments += await ImageEncoding.load(from: dropped).map { Attachment(image: $0) } }
                return true
            }
        }
        #if os(iOS)
        .padding(.bottom, 8)
        #else
        .padding(.bottom, 14)
        #endif
        .modifier(ComposerColumn())
        .task(id: context) { await refreshSuggestions() }
        .sheet(item: $scheduling, onDismiss: {
            // Created: the text now lives in the schedule.
            if let host = chat.host, host.schedules(for: chat.agentId).contains(where: { $0.prompt == trimmed }) { text = "" }
        }) { mode in
            if let host = chat.host { NavigationStack { ScheduleEditor(host: host, mode: mode) } }
        }
        // B1: the draft belongs to the agent, not to this view (which is rebuilt per selection).
        .onAppear {
            text = Drafts.shared.text(draftKey)
            attachments = Drafts.shared.images(draftKey).map { Attachment(image: $0) }
        }
        #if os(iOS)
        // A card that needs an answer gets the screen: the keyboard would squeeze it (iPhone mini).
        .onChange(of: chat.permissions.count + chat.questions.count) { old, new in
            if new > old { focused = false }
        }
        #endif
        .onChange(of: chat.composerTakeover) {
            guard let taken = chat.composerTakeover else { return }
            chat.composerTakeover = nil
            text = text.isEmpty ? taken : text + "\n" + taken
            focused = true
        }
        .onChange(of: text) { Drafts.shared.save(draftKey, text: text, images: attachments.map(\.image)) }
        .onChange(of: attachments) { Drafts.shared.save(draftKey, text: text, images: attachments.map(\.image)) }
        #if os(iOS)
        .onAppear(perform: checkClipboard)
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in checkClipboard() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in checkClipboard() }
        #endif
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
        // An iPhone text field can't take a pasted image, so pasting is a menu item here.
        Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { pickingPhotos = true }
            // Not disabled: the menu is built before the user copies something.
            Button("Paste Image", systemImage: "doc.on.clipboard") { pasteImages() }
            Divider()
            Button("Send Later…", systemImage: "calendar.badge.clock", action: sendLater).disabled(creating)
        } label: {
            Image(systemName: "plus").accessibilityLabel("Attach images")
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .disabled(shellMode)
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 6, matching: .images)
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
        Menu {
            Button("Attach Images…", systemImage: "photo") { pickingFiles = true }
            Divider()
            Button("Send Later…", systemImage: "calendar.badge.clock", action: sendLater).disabled(creating)
        } label: {
            Image(systemName: "plus").accessibilityLabel("Attach or send later")
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(shellMode)
        .help("Attach images (or paste / drop them here), or send later")
        #endif
    }

    @ViewBuilder private var sendOrInterrupt: some View {
        // M3: while a turn runs the button is Stop only when there's nothing to send; with text it
        // is Send, which queues the message (the only way to queue on iPhone, where Return adds a line).
        if busy && !shellMode && trimmed.isEmpty && attachments.isEmpty {
            Button("Interrupt", systemImage: "stop.fill") { Task { await chat.interrupt() } }
                .labelStyle(.iconOnly)
                .font(.caption)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Color.primary.opacity(0.8), in: Circle())
                .modifier(TapTarget())
                .help("Interrupt the running turn (⌘.). Enter still queues a message.")
        } else {
            Button(shellMode ? "Run" : "Send", systemImage: shellMode ? "return" : "arrow.up", action: submit)
                .labelStyle(.iconOnly)
                .fontWeight(.semibold)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(canSend ? (shellMode ? Color.green : Color.accentColor) : Color.secondary.opacity(0.35), in: Circle())
                .modifier(TapTarget())
                .disabled(!canSend)
                .help(shellMode ? "Run in the agent's folder (Enter)"
                      : busy ? "Queue: sends after the current turn (Enter). ⌘. interrupts."
                      : "Send (Enter). Shift-Enter for a new line.")
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
            if chat.commands.isEmpty {
                // agent.commands can take seconds (the agent scans its skills); say so meanwhile.
                suggestions = [Suggestion(id: "loading", icon: "hourglass", title: "Loading commands…", insert: "/")]
            }
            await chat.loadCommands()
            // A newer keystroke replaced this lookup while it waited; its result is stale.
            guard !Task.isCancelled else { return }
            if let failure = chat.commandsError, chat.commands.isEmpty {
                // m3: say why there's nothing; typing "/" again retries.
                suggestions = [Suggestion(id: "loading", icon: "exclamationmark.triangle", title: "Couldn't load commands",
                                          detail: failure, insert: "/")]
                return
            }
            let matches = Suggestion.commands(chat.commands, matching: context.query)
            suggestions = matches.isEmpty
                ? [Suggestion(id: "loading", icon: "magnifyingglass", title: "No commands match \u{201C}/\(context.query)\u{201D}", insert: "/")]
                : Array(matches.prefix(30))
        case .mention:
            try? await Task.sleep(for: .milliseconds(120)) // debounce typing
            guard !Task.isCancelled else { return }
            let files = await chat.searchFiles(context.query)
            guard !Task.isCancelled else { return }
            suggestions = Suggestion.files(files)
        }
    }

    private func accept(_ suggestion: Suggestion) {
        guard let context, suggestion.id != "loading" else { return }
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
        // m11: the keyboard stays up after sending, for the next message.
        Task {
            let ok = shell ? await chat.shell(String(message.dropFirst())) : await chat.send(message, images: images)
            // m1: put it back if it didn't go through, ahead of anything typed since.
            if !ok {
                text = text.isEmpty ? message : message + "\n" + text
                if !shell { attachments = images.map { Attachment(image: $0) } + attachments }
            }
        }
    }

    #if os(iOS)
    /// Images on the clipboard (iOS asks the user to allow the paste the first time).
    private func pasteImages() {
        let board = UIPasteboard.general
        // Prefer the original PNG bytes; fall back to the decoded images (photos, screenshots).
        let datas = board.data(forPasteboardType: UTType.png.identifier).map { [$0] }
            ?? (board.images ?? []).compactMap { $0.pngData() }
        let images = datas.compactMap { ImageEncoding.encode($0) }
        if images.isEmpty {
            chat.error = "There's no image on the clipboard."
        } else {
            attachments += images.map { Attachment(image: $0) }
            pastedChangeCount = board.changeCount
            clipboardHasImage = false
        }
    }

    /// `hasImages` doesn't read the clipboard, so it doesn't trigger the paste permission prompt.
    private func checkClipboard() {
        let board = UIPasteboard.general
        clipboardHasImage = board.hasImages && board.changeCount != pastedChangeCount
    }
    #endif

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

/// The centred column the composer sits in (900 pt max, same side margins); banners and cards
/// above it use it too so their edges line up with the input box.
struct ComposerColumn: ViewModifier {
    func body(content: Content) -> some View {
        content
            #if os(iOS)
            .padding(.horizontal, 10)
            #else
            .padding(.horizontal, 20)
            #endif
            .padding(.top, 6)
            .frame(maxWidth: Theme.columnWidth)
            .frame(maxWidth: .infinity)
    }
}

/// M6: a 44 pt hit area around small round buttons on iOS (the drawn button stays 26 pt).
struct TapTarget: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content.padding(9).contentShape(Rectangle())
        #else
        content
        #endif
    }
}

struct ActivityPill: View {
    let count: Int

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "smallcircle.filled.circle")
                .foregroundStyle(.blue)
                .modifier(PulseUnlessReduced())
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
    @Environment(\.compactPickers) private var compact

    @ViewBuilder private func providerButtons(_ providers: [ProviderID], current: ProviderID) -> some View {
        ForEach(providers, id: \.self) { p in
            Button {
                chat.setProvider(p)
            } label: {
                Text(MemoryGroupView.providerName(p))
                if p == current { Image(systemName: "checkmark") }
            }
        }
    }

    var body: some View {
        if let provider = chat.provider, let config = chat.config, let host = chat.host {
            let catalog = host.catalog(for: provider)
            let models = catalog?.models ?? []
            let effective = chat.agent?.effectiveModel
            let model = Self.model(config: config, effective: effective, in: models)
            // m2: no raw ids while the catalog loads.
            let modelName = catalog == nil ? "…" : (model?.displayName ?? config.model ?? effective ?? "Default model")

            // Only before the agent exists; an agent keeps its provider.
            let providers = chat.newAgent != nil ? host.info?.providers ?? [] : []
            let pickProvider = providers.count > 1
            if pickProvider && !compact {
                Menu {
                    providerButtons(providers, current: provider)
                } label: {
                    PickerLabel(icon: ProviderIcon(provider: provider), title: MemoryGroupView.providerName(provider))
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Provider")
            }

            Menu {
                if pickProvider && compact {
                    // iPhone: no room for a provider picker of its own; it heads the model menu.
                    Picker("Provider", selection: Binding(get: { provider }, set: { chat.setProvider($0) })) {
                        ForEach(providers, id: \.self) { Text(MemoryGroupView.providerName($0)).tag($0) }
                    }
                    .pickerStyle(.menu)
                    Divider()
                }
                ForEach(models) { m in
                    Button {
                        // Clear an effort the new model doesn't accept.
                        let dropEffort = config.effort.map { !(m.efforts ?? []).contains($0) } ?? false
                        Task { await chat.updateConfig(AgentConfig(model: m.id, effort: dropEffort ? "" : nil)) }
                    } label: {
                        Text(m.displayName)
                        if let d = m.description { Text(d) }
                        if m.id == model?.id { Image(systemName: "checkmark") }
                    }
                }
            } label: {
                // "Haiku 4.5" → "Haiku" on iPhone, so the model is always visible; there the
                // provider's icon shows which provider a new agent gets.
                PickerLabel(icon: pickProvider && compact ? AnyView(ProviderIcon(provider: provider)) : AnyView(Image(systemName: "asterisk")),
                            title: modelName, compactTitle: modelName.split(separator: " ").first.map(String.init))
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
                        if config.effort == nil { Image(systemName: "checkmark") }
                    }
                    ForEach(efforts, id: \.self) { e in
                        Button {
                            Task { await chat.updateConfig(AgentConfig(effort: e)) }
                        } label: {
                            Text(e.effortName)
                            if config.effort == e { Image(systemName: "checkmark") }
                        }
                    }
                } label: {
                    PickerLabel(icon: Image(systemName: "brain"), title: config.effort?.effortName ?? "Default effort")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Reasoning effort")
            }

            ModePicker(chat: chat, provider: provider, modes: catalog?.modes ?? [], current: config.mode)
        }
    }
}

extension ConfigPickers {
    /// The model the picker shows: the configured one; with none configured, the one the session
    /// reported running (e.g. Codex's config.toml default), and only before any session the
    /// catalog's default. Nil when that id isn't in the catalog.
    static func model(config: AgentConfig, effective: String?, in models: [ModelInfo]) -> ModelInfo? {
        if let id = config.model { return models.first { $0.id == id } }
        if let id = effective { return models.first { $0.id == id } ?? models.first { named($0, id) } }
        return models.first { $0.isDefault == true }
    }

    /// Claude reports full ids ("claude-opus-5-5", "claude-haiku-4-5-20251001") while its catalog
    /// lists aliases named after them ("Opus 5.5"): match on the name.
    private static func named(_ model: ModelInfo, _ id: String) -> Bool {
        guard let name = model.name, model.isDefault != true else { return false }
        let slug = name.lowercased().replacing(/[ .]/, with: "-")
        let bare = id.replacing(/^claude-/, with: "").replacing(/-\d{8}$/, with: "")
        return slug == bare
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

    /// Unset means the provider's own default; don't assume another provider's mode ids.
    private var selected: ModeInfo? { current.flatMap { id in modes.first { $0.id == id } } }

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
            PickerLabel(icon: ModeIcon(provider: provider, mode: selected?.id ?? current ?? "")
                            .foregroundStyle(Self.isUnsafe(current) ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary)),
                        title: modes.isEmpty ? "…" : (selected?.displayName ?? current ?? "Default mode"))
        }
        .fixedSize()
        .help("Permission mode")
        .confirmationDialog("Run every tool without asking?", isPresented: Binding(get: { confirmUnsafe != nil }, set: { if !$0 { confirmUnsafe = nil } }),
                            titleVisibility: .visible, presenting: confirmUnsafe) { mode in
            Button("Switch to \(mode.displayName)", role: .destructive) {
                Task { await chat.updateConfig(AgentConfig(mode: mode.id)) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The agent will edit files and run commands without asking for permission.")
        }
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

    /// Modes that run every tool without asking.
    static func isUnsafe(_ id: String?) -> Bool { id == "bypassPermissions" || id == "full-access" }

    @State private var confirmUnsafe: ModeInfo?

    private func choose(_ mode: ModeInfo) {
        open = false
        search = ""
        // M7: skipping every permission prompt is one tap away otherwise.
        if Self.isUnsafe(mode.id) && !Self.isUnsafe(current) {
            confirmUnsafe = mode
            return
        }
        Task { await chat.updateConfig(AgentConfig(mode: mode.id)) }
    }
}

/// Shield icons for permission modes, by mode id (Claude Code and Codex share some ideas, not ids);
/// a generic icon for modes it doesn't know.
struct ModeIcon: View {
    let provider: ProviderID
    let mode: String

    var body: some View {
        switch mode {
        case "plan": overlay("ellipsis")
        case "default": Image(systemName: "shield")
        case "acceptEdits": overlay("plus")
        case "auto": Image(systemName: "checkmark.shield")
        case "auto-review": Image(systemName: "exclamationmark.shield")
        case "bypassPermissions", "full-access": Image(systemName: "shield.slash")
        case "": Image(systemName: "shield.lefthalf.filled")
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
    /// M6: what to show on iPhone-width screens (nil: icon only).
    var compactTitle: String? = nil
    @Environment(\.compactPickers) private var compact

    var body: some View {
        HStack(spacing: 5) {
            icon
            if !compact { Text(title).lineLimit(1) } else if let compactTitle { Text(compactTitle).lineLimit(1) }
            Image(systemName: "chevron.down").font(.caption2)
        }
        .foregroundStyle(.secondary)
        #if os(iOS)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        #endif
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
    }
}

extension String {
    /// "xhigh" → "Extra high", "medium" → "Medium".
    var effortName: String {
        switch self {
        case "xhigh": "Extra high"
        default: prefix(1).uppercased() + dropFirst()
        }
    }
}
