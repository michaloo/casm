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

/// Messages waiting to be sent, above the composer, the way Paseo shows its queue: one quiet row
/// per message with Edit and Send now; cancel is in the row's context menu.
struct PendingStrip: View {
    let chat: ChatModel
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showAll = false
    /// iPhone: the composer area is short, so show two and a "more" line.
    private var limit: Int { sizeClass == .compact && !showAll ? 2 : .max }
    #else
    private let limit = Int.max
    #endif

    var body: some View {
        if !chat.pending.isEmpty {
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(chat.pending.prefix(limit)) { message in
                    PendingRow(message: message,
                               edit: { Task { await chat.editPending(message) } },
                               sendNow: { Task { await chat.sendPendingNow(message) } },
                               cancel: { Task { await chat.cancelPending(message) } })
                }
                #if os(iOS)
                if chat.pending.count > limit {
                    Button("\(chat.pending.count - limit) more pending") { withAnimation { showAll = true } }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }
                #endif
            }
        }
    }
}

struct PendingRow: View {
    let message: PendingMessage
    let edit: () -> Void
    let sendNow: () -> Void
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(message.text.isEmpty ? "Image" : message.text)
                    .font(.system(size: 14))
                    .lineLimit(2)
                if let caption {
                    Text(caption).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 8)
            RoundIconButton(label: "Edit", systemImage: "pencil", fill: Theme.surface2, tint: .primary, action: edit)
            RoundIconButton(label: "Send now", systemImage: "arrow.up", fill: .accentColor, tint: .white, action: sendNow)
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(Theme.surface1, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
        .contextMenu {
            Button("Send Now", action: sendNow)
            Button("Edit", action: edit)
            Divider()
            Button("Cancel Message", role: .destructive, action: cancel)
        }
    }

    /// Only when it isn't simply "after the current turn".
    private var caption: String? {
        let when = ISOTime.parse(message.notBefore).map { ISOTime.describe($0) }
        switch message.reason {
        case .queued: return nil
        case .limit: return "When the usage limit resets" + (when.map { " · \($0)" } ?? "")
        case .scheduled: return when.map { "Scheduled · \($0)" } ?? "Scheduled"
        case .unknown(let raw): return raw
        }
    }
}

/// A 28 pt circular icon button with a 44 pt hit area on iOS.
struct RoundIconButton: View {
    let label: String
    let systemImage: String
    let fill: Color
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(fill, in: Circle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .modifier(TapTarget())
    }
}

/// The provider is over a usage limit (B2): when it resets, and that waiting prompts go then.
struct LimitBanner: View {
    let chat: ChatModel

    /// A single quiet line; orange only when work is actually held back.
    var body: some View {
        if let text {
            HStack(spacing: 6) {
                Image(systemName: "hourglass")
                Text(text.title).fontWeight(.medium)
                Text(text.detail).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .font(.system(size: 12))
            .foregroundStyle(blocking ? Color.orange : Theme.muted)
            .padding(.horizontal, 4)
            .help(text.detail)
        }
    }

    private var blocking: Bool { chat.agent?.deferred != nil || chat.limit != nil }

    private var text: (title: String, detail: String)? {
        let agent = chat.agent
        let resets = ISOTime.parse(agent?.deferred?.until) ?? ISOTime.parse(chat.limit?.resetsAt)
        if agent?.deferred != nil || chat.limit != nil {
            let when = resets.map { "Resumes at \(ISOTime.describe($0))" } ?? "Resumes when the limit resets"
            let reason = agent?.deferred?.reason ?? chat.limit?.message
            let waiting = chat.pending.isEmpty ? "" : " · \(chat.pending.count) waiting"
            return ("Usage limit reached", [when + waiting, reason].compactMap { $0 }.joined(separator: " · "))
        }
        // No failure yet, but a subscription window is nearly used up.
        if let provider = agent?.provider, let limits = chat.host?.limits[provider],
           let window = limits.windows.first(where: { $0.status == .exhausted || $0.status == .warning }) {
            let used = window.usedPercent.map { "\(Int($0.rounded()))% used" } ?? (window.status == .exhausted ? "Used up" : "Nearly used up")
            let reset = ISOTime.parse(window.resetsAt).map { " · resets \(ISOTime.describe($0))" } ?? ""
            return ("\(window.label ?? "Usage") limit \(used)", "\(MemoryGroupView.providerName(provider))\(reset)")
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
