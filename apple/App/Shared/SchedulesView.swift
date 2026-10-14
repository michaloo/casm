import CasmKit
import SwiftUI

extension ScheduleCadence {
    /// "Every 15 min", "Weekdays at 09:00", "Once · Wed 18:30", or the cron expression.
    var summary: String {
        switch self {
        case .every(let m): return m % 60 == 0 ? (m == 60 ? "Hourly" : "Every \(m / 60) h") : "Every \(m) min"
        case .once(let at): return "Once · " + (ISOTime.parse(at).map { ISOTime.describe($0) } ?? at)
        case .cron(let expr): return CronPreset.describe(expr) ?? "Cron \(expr)"
        case .unknown(let type): return type
        }
    }
}

/// The cron shapes the editor offers as presets; anything else is "custom".
enum CronPreset {
    static func daily(hour: Int, minute: Int) -> String { "\(minute) \(hour) * * *" }
    static func weekdays(hour: Int, minute: Int) -> String { "\(minute) \(hour) * * 1-5" }

    /// (kind, hour, minute) for "M H * * *" and "M H * * 1-5".
    static func parse(_ expr: String) -> (weekdays: Bool, hour: Int, minute: Int)? {
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5, let m = Int(f[0]), let h = Int(f[1]), f[2] == "*", f[3] == "*",
              f[4] == "*" || f[4] == "1-5" else { return nil }
        return (f[4] == "1-5", h, m)
    }

    static func describe(_ expr: String) -> String? {
        guard let p = parse(expr) else { return nil }
        return (p.weekdays ? "Weekdays at " : "Daily at ") + String(format: "%02d:%02d", p.hour, p.minute)
    }
}

/// A host's schedules (optionally only those messaging one agent).
struct SchedulesView: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    var agentId: String?
    @State private var editing: ScheduleEditor.Mode?

    private var schedules: [Schedule] {
        let all = agentId.map { host.schedules(for: $0) } ?? host.schedules
        return all.sorted { ($0.enabled ? 0 : 1, $0.nextRunAt ?? "~") < ($1.enabled ? 0 : 1, $1.nextRunAt ?? "~") }
    }

    var body: some View {
        Group {
            if schedules.isEmpty {
                ContentUnavailableView {
                    Label("No schedules", systemImage: "calendar.badge.clock")
                } description: {
                    Text("Schedules message an agent, or start a new one, on a cadence.")
                } actions: {
                    Button("New Schedule…") { editing = .new(agentId: agentId) }
                }
            } else {
                List {
                    ForEach(schedules) { schedule in
                        ScheduleRow(host: host, schedule: schedule) { editing = .edit(schedule) }
                    }
                }
            }
        }
        .navigationTitle(agentId.flatMap { host.agent($0)?.name }.map { "Schedules · \($0)" } ?? "Schedules · \(host.name)")
        .toolbar {
            ToolbarItem {
                Button("New Schedule", systemImage: "plus") { editing = .new(agentId: agentId) }
            }
        }
        .sheet(item: $editing) { mode in
            NavigationStack { ScheduleEditor(host: host, mode: mode) }
        }
    }
}

struct ScheduleRow: View {
    @Environment(AppModel.self) private var app
    let host: HostModel
    let schedule: Schedule
    let edit: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(schedule.name).font(.system(size: 14, weight: .semibold))
                    Text(schedule.cadence.summary).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                Text(schedule.prompt).font(.system(size: 13)).lineLimit(2).foregroundStyle(.primary.opacity(0.85))
                // One line where it fits; stacked on an iPhone, where squeezing the three into
                // columns wrapped them mid-word.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { details }.fixedSize()
                    VStack(alignment: .leading, spacing: 2) { details }
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
                .labelStyle(.titleAndIcon)
            }
            .opacity(schedule.enabled ? 1 : 0.55)
            Spacer()
            Toggle("Enabled", isOn: Binding(get: { schedule.enabled }, set: { on in Task { await host.setEnabled(schedule, on) } }))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture(count: 2, perform: edit)
        .contextMenu {
            Button("Run Now") { Task { await host.runNow(schedule) } }
            Button("Edit…", action: edit)
            Divider()
            Button("Delete Schedule…", role: .destructive) {
                app.confirmation = .init(title: "Delete \u{201C}\(schedule.name)\u{201D}?",
                                         message: "It won't run again. Agents it created are kept.", confirm: "Delete") {
                    Task { await host.delete(schedule) }
                }
            }
        }
        .swipeActions {
            Button("Run Now") { Task { await host.runNow(schedule) } }.tint(.accentColor)
            Button("Edit", action: edit)
        }
    }

    @ViewBuilder private var details: some View {
        Label(targetText, systemImage: targetIcon)
        if schedule.enabled, let next = ISOTime.parse(schedule.nextRunAt) {
            Text("Next \(ISOTime.describe(next))")
        }
        if let run = schedule.lastRun { lastRun(run) }
    }

    private var targetText: String {
        switch schedule.target {
        case .agent(let id, let whenBusy):
            return (host.agent(id)?.name ?? "agent") + (whenBusy == .skip ? " · skip if busy" : "")
        case .newAgent(let projectId, let provider, _, let name):
            return "New \(MemoryGroupView.providerName(provider)) agent" + (name.map { " \u{201C}\($0)\u{201D}" } ?? "")
                + " in " + (host.project(projectId)?.name ?? "project")
        case .unknown(let type): return type
        }
    }

    private var targetIcon: String {
        if case .newAgent = schedule.target { "plus.bubble" } else { "bubble.left" }
    }

    /// Last outcome; clicking it opens the agent it messaged or created.
    @ViewBuilder private func lastRun(_ run: ScheduleRun) -> some View {
        let when = ISOTime.parse(run.at).map { $0.formatted(.relative(presentation: .named)) } ?? run.at
        let label = "\(run.outcome.rawValue.capitalized) \(when)"
        let color: Color = run.outcome == .failed ? .red : run.outcome == .skipped ? .orange : Theme.muted
        if let agentId = run.agentId, host.agent(agentId) != nil {
            Button { app.selection = .agent(host: host.id, agent: agentId) } label: {
                Label(label, systemImage: "arrow.turn.down.right")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(color)
            .help(run.error ?? "Open the agent")
        } else {
            Label(label, systemImage: "clock.arrow.circlepath").foregroundStyle(color).help(run.error ?? "")
        }
    }
}

/// Create or edit a schedule: cadence, target and prompt.
struct ScheduleEditor: View {
    enum Mode: Identifiable {
        case new(agentId: String?, prompt: String = "", once: Bool = false)
        case edit(Schedule)
        var id: String {
            switch self {
            case .new(let a, _, _): "new-\(a ?? "-")"
            case .edit(let s): s.id
            }
        }
    }

    enum CadenceKind: String, CaseIterable, Identifiable {
        case every15, every30, hourly, daily, weekdays, once, custom
        var id: String { rawValue }
        var title: String {
            switch self {
            case .every15: "Every 15 minutes"
            case .every30: "Every 30 minutes"
            case .hourly: "Hourly"
            case .daily: "Daily at…"
            case .weekdays: "Weekdays at…"
            case .once: "Once at…"
            case .custom: "Custom cron"
            }
        }
    }

    @Environment(\.dismiss) private var dismiss
    let host: HostModel
    let mode: Mode

    @State private var name = ""
    @State private var kind: CadenceKind = .daily
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: .now) ?? .now
    @State private var onceAt = Date.now.addingTimeInterval(3600)
    @State private var cron = "0 9 * * 1-5"
    @State private var targetsAgent = true
    @State private var agentId: String?
    @State private var skipIfBusy = false
    @State private var projectId: String?
    @State private var provider: ProviderID = .claude
    @State private var model = ""
    @State private var agentMode = ""
    @State private var newAgentName = ""
    @State private var prompt = ""
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("Optional"))
                Picker("Runs", selection: $kind) {
                    ForEach(CadenceKind.allCases) { Text($0.title).tag($0) }
                }
                switch kind {
                case .daily, .weekdays:
                    DatePicker("At", selection: $time, displayedComponents: .hourAndMinute)
                case .once:
                    DatePicker("At", selection: $onceAt, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                case .custom:
                    TextField("Cron", text: $cron, prompt: Text("m h dom mon dow"))
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                default:
                    EmptyView()
                }
            } footer: {
                Text("Times are in \(host.name)'s local time.").font(.caption).foregroundStyle(.secondary)
            }

            Section("Target") {
                Picker("Target", selection: $targetsAgent) {
                    Text("An agent").tag(true)
                    Text("A new agent").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if targetsAgent {
                    Picker("Agent", selection: $agentId) {
                        if agentId == nil { Text("Choose…").tag(String?.none) }
                        ForEach(host.pickerProjects()) { p in
                            ForEach(host.agents(in: p.id)) { a in Text("\(p.name) › \(a.name)").tag(Optional(a.id)) }
                        }
                    }
                    Toggle("Skip the run if the agent is busy", isOn: $skipIfBusy)
                } else {
                    Picker("Project", selection: $projectId) {
                        if projectId == nil { Text("Choose…").tag(String?.none) }
                        ForEach(host.pickerProjects()) { p in Text(p.group.map { "\($0) › \(p.name)" } ?? p.name).tag(Optional(p.id)) }
                    }
                    Picker("Provider", selection: $provider) {
                        ForEach(host.info?.providers ?? [.claude], id: \.self) { Text(MemoryGroupView.providerName($0)).tag($0) }
                    }
                    let catalog = host.catalog(for: provider)
                    Picker("Model", selection: $model) {
                        Text("Default").tag("")
                        ForEach(catalog?.models ?? []) { Text($0.displayName).tag($0.id) }
                    }
                    Picker("Mode", selection: $agentMode) {
                        Text("Default").tag("")
                        ForEach(catalog?.modes ?? []) { Text($0.displayName).tag($0.id) }
                    }
                    TextField("Agent name", text: $newAgentName, prompt: Text("Optional; the run time is added"))
                }
            }

            Section("Prompt") {
                TextEditor(text: $prompt).font(.body).frame(minHeight: 90)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle(isNew ? "New Schedule" : "Edit Schedule")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(isNew ? "Create" : "Save") { Task { await save() } }.disabled(!valid || busy)
            }
        }
        .onChange(of: provider) { model = ""; agentMode = "" }
        .onAppear(perform: load)
        .sheetSize(minWidth: 520, minHeight: 560)
    }

    private var isNew: Bool { if case .new = mode { true } else { false } }

    private var valid: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (targetsAgent ? agentId != nil : projectId != nil)
            && (kind != .custom || cron.split(separator: " ").count == 5)
    }

    private var cadence: ScheduleCadence {
        let c = Calendar.current.dateComponents([.hour, .minute], from: time)
        switch kind {
        case .every15: return .every(minutes: 15)
        case .every30: return .every(minutes: 30)
        case .hourly: return .every(minutes: 60)
        case .daily: return .cron(CronPreset.daily(hour: c.hour ?? 9, minute: c.minute ?? 0))
        case .weekdays: return .cron(CronPreset.weekdays(hour: c.hour ?? 9, minute: c.minute ?? 0))
        case .once: return .once(at: ISO8601DateFormatter().string(from: onceAt))
        case .custom: return .cron(cron.trimmingCharacters(in: .whitespaces))
        }
    }

    private var target: ScheduleTarget {
        if targetsAgent, let agentId { return .agent(agentId: agentId, whenBusy: skipIfBusy ? .skip : .queue) }
        let config = AgentConfigChoice.config(model: model, effort: "", mode: agentMode, catalog: host.catalog(for: provider))
        let trimmed = newAgentName.trimmingCharacters(in: .whitespaces)
        return .newAgent(projectId: projectId ?? "", provider: provider, config: config, name: trimmed.isEmpty ? nil : trimmed)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        switch mode {
        case .new(let agent, let text, let once):
            agentId = agent
            prompt = text
            targetsAgent = agent != nil || host.agents.isEmpty == false
            if once { kind = .once }
            projectId = agent.flatMap { host.agent($0)?.projectId } ?? host.pickerProjects().first?.id
        case .edit(let s):
            name = s.name
            prompt = s.prompt
            switch s.cadence {
            case .every(15): kind = .every15
            case .every(30): kind = .every30
            case .every(60): kind = .hourly
            case .every(let m): kind = .custom; cron = "*/\(m) * * * *"
            case .once(let at): kind = .once; onceAt = ISOTime.parse(at) ?? onceAt
            case .cron(let expr):
                if let p = CronPreset.parse(expr) {
                    kind = p.weekdays ? .weekdays : .daily
                    time = Calendar.current.date(bySettingHour: p.hour, minute: p.minute, second: 0, of: .now) ?? time
                } else {
                    kind = .custom; cron = expr
                }
            case .unknown: kind = .custom
            }
            switch s.target {
            case .agent(let id, let whenBusy):
                targetsAgent = true; agentId = id; skipIfBusy = whenBusy == .skip
            case .newAgent(let p, let prov, let config, let n):
                targetsAgent = false; projectId = p; provider = prov
                model = config?.model ?? ""; agentMode = config?.mode ?? ""; newAgentName = n ?? ""
            case .unknown: break
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            switch mode {
            case .new:
                try await host.createSchedule(CreateScheduleParams(name: trimmedName.isEmpty ? nil : trimmedName,
                                                                   cadence: cadence, target: target, prompt: text))
            case .edit(let s):
                try await host.updateSchedule(UpdateScheduleParams(id: s.id, name: trimmedName.isEmpty ? nil : trimmedName,
                                                                   cadence: cadence, target: target, prompt: text))
            }
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}


