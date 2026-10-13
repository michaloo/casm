import CasmKit
import SwiftUI

/// A question from the agent, shown above the composer like the permission banner.
struct QuestionCard: View {
    let request: QuestionRequest
    /// m6: the card that takes ⌘Return (only when no permission banner claims it).
    var takesShortcut = false
    let submit: ([String: AnswerValue]?) -> Void
    @State private var confirmDismiss = false

    @State private var picked: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var text: [String: String] = [:]
    @State private var confirmed: [String: Bool] = [:]

    /// B1: half-filled answers survive switching agents and relaunching.
    private var draft: Drafts.Answers {
        Drafts.Answers(picked: picked.mapValues { Array($0).sorted() }, other: other, text: text, confirmed: confirmed)
    }

    private func restoreDraft() {
        let saved = Drafts.shared.answers(request.id)
        picked = saved.picked.mapValues(Set.init)
        other = saved.other
        text = saved.text
        confirmed = saved.confirmed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(request.title ?? "The agent has a question", systemImage: "questionmark.bubble.fill")
                .fontWeight(.semibold)
                .foregroundStyle(.blue)
            // The prompts scroll when they would take more than about half the screen, so the
            // transcript and the buttons stay visible.
            ViewThatFits(in: .vertical) {
                prompts
                // Never squeezed to nothing on a short screen: keep a few options visible.
                ScrollView { prompts }.frame(minHeight: 140, maxHeight: 300)
            }
            HStack {
                Spacer()
                // m6: dismissing can't be undone, so it's quiet and asks first.
                Button("Dismiss") { confirmDismiss = true }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                Button("Submit") { submit(answers) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!complete)
                    .keyboardShortcut(takesShortcut ? KeyboardShortcut(.return, modifiers: .command) : nil)
                    .help(takesShortcut ? "Submit (⌘Return)" : "Submit")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.blue.opacity(0.25)))
        .onAppear(perform: restoreDraft)
        .confirmationDialog("Dismiss the question?", isPresented: $confirmDismiss, titleVisibility: .visible) {
            Button("Dismiss Without Answering", role: .destructive) { submit(nil) }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The agent continues without your answer.")
        }
        .onChange(of: draft) { Drafts.shared.save(request.id, answers: draft) }
    }

    private var prompts: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(request.prompts) { prompt in
                PromptView(prompt: prompt, picked: binding(prompt.id, in: $picked, default: []),
                           other: binding(prompt.id, in: $other, default: ""),
                           text: binding(prompt.id, in: $text, default: ""),
                           confirmed: Binding { confirmed[prompt.id] } set: { confirmed[prompt.id] = $0 })
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func binding<V>(_ id: String, in dict: Binding<[String: V]>, default value: V) -> Binding<V> {
        Binding { dict.wrappedValue[id] ?? value } set: { dict.wrappedValue[id] = $0 }
    }

    private func answer(_ prompt: QuestionPrompt) -> AnswerValue? {
        switch prompt.kind {
        case .select:
            let free = (other[prompt.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            // Keep the agent's option order.
            var labels = (prompt.options ?? []).map(\.label).filter { picked[prompt.id]?.contains($0) == true }
            if prompt.multiple == true {
                if !free.isEmpty { labels.append(free) }
                return labels.isEmpty ? nil : .strings(labels)
            }
            if !free.isEmpty { return .string(free) }
            return labels.first.map(AnswerValue.string)
        case .confirm:
            return confirmed[prompt.id].map(AnswerValue.bool)
        case .text, .unknown:
            let value = text[prompt.id] ?? ""
            return value.isEmpty ? nil : .string(value)
        }
    }

    private var answers: [String: AnswerValue] {
        Dictionary(uniqueKeysWithValues: request.prompts.compactMap { p in answer(p).map { (p.id, $0) } })
    }

    private var complete: Bool { request.prompts.allSatisfy { answer($0) != nil } }
}

private struct PromptView: View {
    let prompt: QuestionPrompt
    @Binding var picked: Set<String>
    @Binding var other: String
    @Binding var text: String
    @Binding var confirmed: Bool?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header = prompt.header {
                Text(header.uppercased()).font(.caption2).fontWeight(.semibold).foregroundStyle(.secondary)
            }
            Text(prompt.text).textSelection(.enabled)
            switch prompt.kind {
            case .select: options
            case .confirm: confirm
            case .text, .unknown: textInput
            }
        }
    }

    private var multiple: Bool { prompt.multiple == true }

    @ViewBuilder private var options: some View {
        ForEach(prompt.options ?? [], id: \.label) { option in
            let on = picked.contains(option.label)
            Button {
                if multiple {
                    if on { picked.remove(option.label) } else { picked.insert(option.label) }
                } else {
                    picked = [option.label]
                    other = ""
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: multiple ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                        .foregroundStyle(on ? Color.accentColor : .secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(option.label)
                        if let d = option.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        if prompt.allowOther == true {
            TextField("Other…", text: $other)
                .textFieldStyle(.roundedBorder)
                .onChange(of: other) { if !multiple && !other.isEmpty { picked = [] } }
        }
    }

    private var confirm: some View {
        Picker(prompt.text, selection: $confirmed) {
            Text("Yes").tag(Bool?.some(true))
            Text("No").tag(Bool?.some(false))
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }

    @ViewBuilder private var textInput: some View {
        if prompt.secret == true {
            SecureField(prompt.placeholder ?? "", text: $text).textFieldStyle(.roundedBorder)
        } else if prompt.multiline == true {
            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 70, maxHeight: 160)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        } else {
            TextField(prompt.placeholder ?? "", text: $text).textFieldStyle(.roundedBorder)
        }
    }
}
