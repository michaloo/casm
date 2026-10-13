import CasmKit
import SwiftUI

enum ISOTime {
    static func parse(_ string: String?) -> Date? {
        guard let string else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }

    /// "18:31 (in 42 min)", or "Fri 09:00 (in 2 days)" when not today.
    static func describe(_ date: Date, now: Date = .now) -> String {
        let time = Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        let relative = date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        return "\(time) (\(relative))"
    }
}

/// Messages waiting to be sent to this agent, above the composer (B2): why each waits, and Edit /
/// cancel for each.
struct PendingStrip: View {
    let chat: ChatModel
    #if os(iOS)
    /// On iPhone the strip is one summary line until tapped: the composer area is short.
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var expanded = false
    private var collapsed: Bool { sizeClass == .compact && !expanded }
    #else
    private let collapsed = false
    #endif

    private var summary: String {
        let next = chat.pending.compactMap { ISOTime.parse($0.notBefore) }.min()
        return "\(chat.pending.count) pending" + (next.map { " · next \(ISOTime.describe($0))" } ?? "")
    }

    var body: some View {
        if !chat.pending.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(collapsed ? summary : "\(chat.pending.count) pending", systemImage: "tray.full")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    #if os(iOS)
                    if sizeClass == .compact {
                        Button(expanded ? "Hide" : "Show") { withAnimation { expanded.toggle() } }
                            .buttonStyle(.borderless)
                            .font(.caption)
                    }
                    #endif
                    if chat.pending.count > 1 {
                        Button("Cancel All") { Task { await chat.cancelPending(nil) } }
                            .buttonStyle(.borderless)
                            .font(.caption)
                    }
                }
                if !collapsed {
                ForEach(chat.pending) { message in
                    PendingRow(message: message,
                               edit: { Task { await chat.editPending(message) } },
                               cancel: { Task { await chat.cancelPending(message) } })
                }
                }
            }
            .padding(10)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.18)))
        }
    }
}

struct PendingRow: View {
    let message: PendingMessage
    let edit: () -> Void
    let cancel: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).foregroundStyle(tint).frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(message.text.isEmpty ? "(images only)" : message.text)
                    .lineLimit(2)
                    .truncationMode(.tail)
                Text(caption).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Edit", systemImage: "pencil", action: edit)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .help("Take it back into the composer")
            Button("Cancel Message", systemImage: "xmark", action: cancel)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .help("Don't send it")
        }
        .font(.callout)
        .frame(minHeight: 28)
    }

    private var icon: String {
        switch message.reason {
        case .queued: "arrow.turn.down.right"
        case .limit: "hourglass"
        case .scheduled: "clock"
        case .unknown: "tray"
        }
    }

    private var tint: Color { message.reason == .limit ? .orange : .secondary }

    private var caption: String {
        var parts: [String] = []
        switch message.reason {
        case .queued: parts.append("After the current turn")
        case .limit: parts.append("When the usage limit resets")
        case .scheduled: parts.append("Scheduled")
        case .unknown(let raw): parts.append(raw)
        }
        if let date = ISOTime.parse(message.notBefore) { parts.append(ISOTime.describe(date)) }
        if let images = message.imageCount, images > 0 { parts.append("\(images) image\(images == 1 ? "" : "s")") }
        if let note = message.note { parts.append(note) }
        return parts.joined(separator: " · ")
    }
}

/// The provider is over a usage limit (B2): when it resets, and that waiting prompts go then.
struct LimitBanner: View {
    let chat: ChatModel

    var body: some View {
        if let text {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "hourglass").foregroundStyle(.orange).font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(text.title).fontWeight(.semibold)
                    Text(text.detail).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(12)
            .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.orange.opacity(0.3)))
        }
    }

    private var text: (title: String, detail: String)? {
        let agent = chat.agent
        let resets = ISOTime.parse(agent?.deferred?.until) ?? ISOTime.parse(chat.limit?.resetsAt)
        if agent?.deferred != nil || chat.limit != nil {
            let when = resets.map { "Resumes at \(ISOTime.describe($0))" } ?? "Resumes when the limit resets"
            let reason = agent?.deferred?.reason ?? chat.limit?.message
            let waiting = chat.pending.isEmpty ? "" : " · \(chat.pending.count) waiting"
            return ("Usage limit reached", [when + waiting, reason].compactMap { $0 }.joined(separator: "\n"))
        }
        // No failure yet, but a subscription window is nearly used up.
        if let provider = agent?.provider, let limits = chat.host?.limits[provider],
           let window = limits.windows.first(where: { $0.status == .exhausted || $0.status == .warning }) {
            let used = window.usedPercent.map { "\(Int($0.rounded()))% used" } ?? (window.status == .exhausted ? "Used up" : "Nearly used up")
            let reset = ISOTime.parse(window.resetsAt).map { " · resets \(ISOTime.describe($0))" } ?? ""
            return ("\(window.label ?? "Usage") limit: \(used)", "\(MemoryGroupView.providerName(provider))\(reset)")
        }
        return nil
    }
}

/// A subagent the agent spawned (Task tool, Codex sub-agents) and what it's doing.
struct SubagentRow: View {
    let run: SubagentRun

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                switch run.status {
                case .running: WorkingIndicator()
                case .done: Image(systemName: "checkmark").foregroundStyle(.green)
                case .error: Image(systemName: "xmark").foregroundStyle(.red)
                case .unknown: Image(systemName: "questionmark").foregroundStyle(.secondary)
                }
            }
            .frame(width: 14)
            Image(systemName: "person.2").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(run.title).fontWeight(.medium).lineLimit(1)
                    if let type = run.agentType {
                        Text(type).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let line = run.status == .running ? run.activity : (run.summary ?? run.activity) {
                    Text(line).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
    }
}
