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
                        ConfigPickers(chat: chat)
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
            .contentShape(RoundedRectangle(cornerRadius: 18))
            .onTapGesture { focused = true }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
        .padding(.top, 6)
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
        .onAppear { focused = true }
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
                        Task {
                            await chat.updateConfig { config in
                                config.model = m.id
                                // Drop an effort the new model doesn't accept.
                                if let effort = config.effort, !(m.efforts ?? []).contains(effort) { config.effort = nil }
                            }
                        }
                    } label: {
                        Text(m.displayName)
                        if let d = m.description { Text(d) }
                        if m.id == model?.id { Image(systemName: "checkmark") }
                    }
                }
            } label: {
                PickerLabel(icon: "asterisk", title: modelName)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Model")

            if let efforts = model?.efforts, !efforts.isEmpty {
                Menu {
                    Button {
                        Task { await chat.updateConfig { $0.effort = nil } }
                    } label: {
                        Text("Default")
                        if agent.config.effort == nil { Image(systemName: "checkmark") }
                    }
                    ForEach(efforts, id: \.self) { e in
                        Button {
                            Task { await chat.updateConfig { $0.effort = e } }
                        } label: {
                            Text(e.effortName)
                            if agent.config.effort == e { Image(systemName: "checkmark") }
                        }
                    }
                } label: {
                    PickerLabel(icon: "brain", title: agent.config.effort?.effortName ?? "Default effort")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Reasoning effort")
            }

            let modes = catalog?.modes ?? []
            let mode = modes.first { $0.id == (agent.config.mode ?? "default") }
            Menu {
                ForEach(modes) { m in
                    Button {
                        Task { await chat.updateConfig { $0.mode = m.id } }
                    } label: {
                        Text(m.displayName)
                        if let d = m.description { Text(d) }
                        if m.id == mode?.id { Image(systemName: "checkmark") }
                    }
                }
            } label: {
                PickerLabel(icon: "shield", title: "\(mode?.displayName ?? agent.config.mode ?? "Default") mode")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Permission mode")
        }
    }
}

private struct PickerLabel: View {
    let icon: String
    let title: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
            Text(title)
            Image(systemName: "chevron.down").font(.caption2)
        }
        .foregroundStyle(.secondary)
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
