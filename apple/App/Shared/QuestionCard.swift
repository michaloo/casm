import CasmKit
import SwiftUI

/// A question from the agent, shown above the composer like the permission banner.
struct QuestionCard: View {
    let request: QuestionRequest
    let submit: ([String: AnswerValue]?) -> Void

    @State private var picked: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var text: [String: String] = [:]
    @State private var confirmed: [String: Bool] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(request.title ?? "The agent has a question", systemImage: "questionmark.bubble.fill")
                .fontWeight(.semibold)
                .foregroundStyle(.blue)
            ForEach(request.prompts) { prompt in
                PromptView(prompt: prompt, picked: binding(prompt.id, in: $picked, default: []),
                           other: binding(prompt.id, in: $other, default: ""),
                           text: binding(prompt.id, in: $text, default: ""),
                           confirmed: Binding { confirmed[prompt.id] } set: { confirmed[prompt.id] = $0 })
            }
            HStack {
                Spacer()
                Button("Dismiss") { submit(nil) }
                Button("Submit") { submit(answers) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!complete)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.07))
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
