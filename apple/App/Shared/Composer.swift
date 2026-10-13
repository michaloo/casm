import CasmKit
import SwiftUI

/// The message box under the transcript: an activity pill, a rounded input, and a row of
/// model / effort / mode pickers with the busy, voice and send controls.
struct Composer: View {
    let chat: ChatModel
    /// Running subagents of this agent, on any host.
    let working: Int
    @State private var text = ""
    @State private var selection: TextSelection?
    @FocusState private var focused: Bool
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compactWidth: Bool { sizeClass == .compact }
    #else
    private let compactWidth = false
    #endif

    private var busy: Bool { chat.status.isBusy }
    private var online: Bool { chat.host?.isOnline ?? false }
    private var canSend: Bool { online && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if working > 0 {
                ActivityPill(count: working)
            }
            VStack(alignment: .leading, spacing: 10) {
                TextField("Message the agent", text: $text, selection: $selection, axis: .vertical)
                    .accessibilityLabel("Message")
                    .textFieldStyle(.plain)
                    .lineLimit(2...10)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down, action: handleReturn)
                    #if os(iOS)
                    .onSubmit(submit)
                    #endif
                HStack(spacing: 14) {
                    Button("Attach", systemImage: "plus") {}
                        .labelStyle(.iconOnly)
                        .disabled(true)
                        .help("Attachments aren't supported yet")
                    if chat.agent != nil {
                        // Icons only on iPhone-width screens.
                        ConfigPickers(chat: chat).environment(\.compactPickers, compactWidth)
                    }
                    Spacer(minLength: 0)
                    if busy {
                        ProgressView().controlSize(.small)
                    }
                    Button("Dictate", systemImage: "mic") {}
                        .labelStyle(.iconOnly)
                        .disabled(true)
                        .help("Dictation comes with voice (phase 2)")
                    Button("Voice mode", systemImage: "waveform") {}
                        .labelStyle(.iconOnly)
                        .disabled(true)
                        .help("Voice mode comes in phase 2")
                    sendOrInterrupt
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.secondary.opacity(0.2)))
            #if os(macOS)
            // Clicking the padding focuses the field. On iOS this would swallow taps on the pickers.
            .contentShape(RoundedRectangle(cornerRadius: 18))
            .onTapGesture { focused = true }
            #endif
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
        #if os(macOS)
        .onAppear { focused = true }
        #endif
    }

    @ViewBuilder private var sendOrInterrupt: some View {
        if busy {
            Button("Interrupt", systemImage: "stop.fill") { Task { await chat.interrupt() } }
                .labelStyle(.iconOnly)
                .font(.caption)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Color.primary.opacity(0.8), in: Circle())
                .keyboardShortcut(".", modifiers: .command)
                .help("Interrupt the running turn (⌘.). Enter still queues a message.")
        } else {
            Button("Send", systemImage: "arrow.up", action: submit)
                .labelStyle(.iconOnly)
                .fontWeight(.semibold)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(canSend ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
                .disabled(!canSend)
                .help("Send (Enter). Shift-Enter for a new line.")
        }
    }

    /// Enter sends (or queues while busy); Shift-Enter inserts a newline.
    private func handleReturn(_ press: KeyPress) -> KeyPress.Result {
        if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
            insertNewline()
        } else {
            submit()
        }
        return .handled
    }

    private func insertNewline() {
        if case .selection(let range) = selection?.indices {
            text.replaceSubrange(range, with: "\n")
            let caret = text.index(after: range.lowerBound)
            selection = TextSelection(insertionPoint: caret)
        } else {
            text += "\n"
        }
    }

    private func submit() {
        let message = text
        guard canSend else { return }
        text = ""
        #if os(iOS)
        focused = false
        #endif
        Task { await chat.send(message) }
    }
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
