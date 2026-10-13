import CasmKit
import SwiftUI

extension LimitWindow {
    /// "5h", "Week", or the provider's own label.
    var shortLabel: String {
        switch (label?.lowercased(), windowMinutes) {
        case ("5-hour", _), (_, 300): "5h"
        case ("weekly", _), (_, 10080): "Week"
        default: label ?? id
        }
    }

    /// The percentage when the provider reports one; otherwise the status decides.
    var level: UsageLevel {
        if let used = usedPercent { return used >= 100 ? .exhausted : used >= 80 ? .warning : .ok }
        switch status {
        case .exhausted: return .exhausted
        case .warning: return .warning
        default: return .ok
        }
    }
}

enum UsageLevel {
    case ok, warning, exhausted

    var color: Color {
        switch self {
        case .ok: Theme.muted
        case .warning: .orange
        case .exhausted: .red
        }
    }
}

extension ProviderLimits {
    var worst: UsageLevel {
        let levels = windows.map(\.level)
        return levels.contains(.exhausted) ? .exhausted : levels.contains(.warning) ? .warning : .ok
    }

    /// "5-hour 100% · weekly 31%" for menus.
    var summary: String {
        windows.map { w in
            let name = w.label ?? w.id
            if let used = w.usedPercent { return "\(name) \(Int(used.rounded()))%" }
            return w.level == .exhausted ? "\(name) used up" : name
        }.joined(separator: " · ")
    }
}

/// The agent's subscription windows above the composer ("5h ▰▰▱ 62% · Week ▰▱▱ 31%"); click for
/// every provider on the host.
struct UsageChip: View {
    let host: HostModel
    let provider: ProviderID
    @State private var showDetails = false

    var body: some View {
        if let limits = host.limits[provider], !limits.windows.isEmpty {
            Button { showDetails = true } label: {
                HStack(spacing: 10) {
                    ForEach(limits.windows) { window in
                        HStack(spacing: 5) {
                            Text(window.shortLabel)
                            if let used = window.usedPercent {
                                UsageBar(fraction: used / 100, color: window.level == .ok ? Color.accentColor : window.level.color)
                                    .frame(width: 28, height: 4)
                                Text("\(Int(used.rounded()))%").monospacedDigit()
                            } else if let resets = ISOTime.parse(window.resetsAt) {
                                Text(window.level == .exhausted ? "until \(resets.formatted(date: .omitted, time: .shortened))"
                                                                 : "resets \(resets.formatted(date: .omitted, time: .shortened))")
                            }
                        }
                        .foregroundStyle(window.level == .ok ? Theme.muted : window.level.color)
                    }
                }
                .font(.system(size: 12))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Theme.surface1, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.border))
            }
            .buttonStyle(.plain)
            .help("\(MemoryGroupView.providerName(provider)) usage: \(limits.summary)")
            .popover(isPresented: $showDetails) {
                UsageDetails(host: host).frame(width: 320)
            }
        }
    }
}

/// A thin rounded progress bar (drawn, so it also renders in snapshots).
struct UsageBar: View {
    let fraction: Double
    let color: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surface3)
                Capsule().fill(color).frame(width: geo.size.width * min(max(fraction, 0), 1))
            }
        }
    }
}

/// Every provider's windows on one host: how much is used and when each resets.
struct UsageDetails: View {
    let host: HostModel
    @State private var refreshing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Usage on \(host.name)").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button {
                    Task {
                        refreshing = true
                        await host.refreshLimits()
                        refreshing = false
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(refreshing)
                .help("Ask the providers again")
            }
            let all = host.limits.values.sorted { $0.provider.rawValue < $1.provider.rawValue }
            if all.isEmpty {
                Text("No provider has reported limits yet.").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            ForEach(all, id: \.provider) { limits in
                ProviderUsage(limits: limits)
            }
        }
        .padding(14)
    }
}

struct ProviderUsage: View {
    let limits: ProviderLimits

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ProviderIcon(provider: limits.provider, size: 13)
                Text(MemoryGroupView.providerName(limits.provider)).font(.system(size: 13, weight: .medium))
                if let plan = limits.plan {
                    Text(plan.capitalized).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                Spacer()
                if let updated = ISOTime.parse(limits.updatedAt) {
                    Text(updated, format: .relative(presentation: .named))
                        .font(.system(size: 11)).foregroundStyle(Theme.muted)
                        .help("When \(MemoryGroupView.providerName(limits.provider)) last reported these")
                }
            }
            ForEach(limits.windows) { window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(Self.sentenceCase(window.label ?? window.id)).font(.system(size: 12))
                        Spacer()
                        Text(usedText(window)).font(.system(size: 12)).monospacedDigit()
                            .foregroundStyle(window.level == .ok ? Theme.muted : window.level.color)
                    }
                    if let used = window.usedPercent {
                        UsageBar(fraction: used / 100, color: window.level == .ok ? Color.accentColor : window.level.color)
                            .frame(height: 5)
                    }
                    if let resets = ISOTime.parse(window.resetsAt) {
                        Text("Resets \(ISOTime.describe(resets))").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
    }

    /// "weekly" → "Weekly", "5-hour" stays.
    static func sentenceCase(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    private func usedText(_ window: LimitWindow) -> String {
        if let used = window.usedPercent { return "\(Int(used.rounded()))% used" }
        switch window.level {
        case .exhausted: return "Used up"
        case .warning: return "Nearly used up"
        case .ok: return "Not reported"
        }
    }
}
