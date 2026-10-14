#if DEBUG
import AppKit
import CasmKit
import QuartzCore
import SwiftUI

/// Debug-only remote control, so test scripts can drive the app without UI scripting:
///
///     apple/scripts/casmctl select sample
///
/// Commands arrive as JSON in the `object` of a distributed notification named `casm.debug`.
/// Each one calls the same model method as the corresponding button. Results go to stderr.
@MainActor
final class DebugControl {
    static let shared = DebugControl()

    private weak var app: AppModel?
    /// Set by the chat view so the benchmark can drive its scroll position.
    var scroller: ((ScrollPosition) -> Void)?
    var contentHeight: CGFloat = 0
    var offsetY: CGFloat = 0
    var viewportHeight: CGFloat = 0
    private var observer: NSObjectProtocol?
    /// Rendered rows' top edge in the viewport (CASM_PROBE=1), and the row `anchor` watches.
    private var rowY: [String: CGFloat] = [:]
    private var anchor: (id: String, y: CGFloat, drift: CGFloat)?

    func rowGone(_ id: String) { rowY[id] = nil }

    func rowMoved(_ id: String, to y: CGFloat) {
        rowY[id] = y
        guard let a = anchor, a.id == id else { return }
        if abs(y - a.y) > abs(a.drift) { anchor?.drift = y - a.y }
    }

    func attach(_ app: AppModel) {
        self.app = app
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("casm.debug"), object: nil, queue: .main
        ) { note in
            let raw = note.object as? String ?? "{}"
            MainActor.assumeIsolated {
                let cmd = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: String] ?? [:]
                self.run(cmd)
            }
        }
        log("debug control ready")
    }

    func log(_ message: String) {
        FileHandle.standardError.write(Data("[casm-debug] \(message)\n".utf8))
    }

    func run(_ cmd: [String: String]) {
        guard let app else { return }
        let chat = app.chat
        switch cmd["cmd"] {
        case "select" where cmd["schedules"] != nil:
            guard let host = app.hosts.first else { return log("no host") }
            app.selection = .schedules(host: host.id)
            log("selected schedules")
        case "select" where cmd["project"] != nil:
            for host in app.hosts {
                if let project = host.projects.first(where: { $0.name == cmd["project"] || $0.id == cmd["project"] }) {
                    app.selection = .project(host: host.id, project: project.id)
                    return log("selected project \(project.name)")
                }
            }
            log("no project \(cmd["project"] ?? "")")
        case "select":
            rowY = [:]
            let name = cmd["agent"] ?? ""
            for host in app.hosts {
                if let agent = host.agents.first(where: { $0.name == name || $0.id == name }) {
                    app.selection = .agent(host: host.id, agent: agent.id)
                    return log("selected \(agent.name)")
                }
            }
            log("no agent \(name)")
        case "synthetic":
            let t0 = CACurrentMediaTime()
            app.selection = .synthetic
            afterIdle { self.log(String(format: "synthetic open+render: %.1f ms", (CACurrentMediaTime() - t0) * 1000)) }
        case "send":
            Task { await chat?.send(cmd["text"] ?? ""); log("sent") }
        case "permission":
            guard let request = chat?.permissions.first else { return log("no pending permission") }
            let decision = PermissionDecision(rawValue: cmd["decision"] ?? "allow") ?? .allow
            Task { await chat?.respond(to: request, decision); log("permission \(decision.rawValue) \(request.toolName)") }
        case "answer":
            // answer: JSON object of prompt id → value, or omitted to dismiss.
            guard let request = chat?.questions.first else { return log("no pending question") }
            let answers = cmd["answers"].flatMap { try? JSONDecoder().decode([String: AnswerValue].self, from: Data($0.utf8)) }
            Task { await chat?.answer(request, answers); log("answered \(request.id): \(String(describing: answers))") }
        case "questions":
            for q in chat?.questions ?? [] {
                log("question \(q.id): " + q.prompts.map { "\($0.id) [\($0.kind.rawValue)] \($0.text) options=\($0.options?.map(\.label) ?? [])" }.joined(separator: " | "))
            }
        case "config":
            Task {
                await chat?.updateConfig(AgentConfig(model: cmd["model"], mode: cmd["mode"], effort: cmd["effort"]))
                log("config now \(String(describing: chat?.agent?.config))")
            }
        case "event":
            // Feeds a raw AgentEvent (JSON) into the open chat, e.g. to preview toolOutput or usage.
            guard let json = cmd["json"], let event = try? JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8)) else {
                return log("event: bad json")
            }
            chat?.apply(event)
            log("applied \(event)")
        case "retry":
            guard let chat, let failed = chat.pending.first(where: { $0.reason == .failed }) else { return log("no failed pending message") }
            Task { await chat.retryPending(failed); log("retried \(failed.id); pending now \(chat.pending.count)") }
        case "interrupt":
            Task { await chat?.interrupt(); log("interrupted") }
        case "reload":
            Task { await chat?.reload(); log("reloaded") }
        case "restart":
            Task { await chat?.restart(); log("new session") }
        case "sheet":
            switch cmd["name"] {
            case "addHost": app.sheet = .addHost
            case "newProject": app.sheet = .newProject(nil)
            case "newAgent": app.sheet = .newAgent(app.hosts.first, projectId: app.hosts.first?.pickerProjects().first?.id)
            default: app.sheet = nil
            }
        case "createAgent":
            guard let host = app.hosts.first,
                  let project = host.projects.first(where: { $0.name == cmd["project"] }) else { return log("no such project") }
            Task {
                do {
                    try await app.createAgent(on: host, CreateAgentParams(
                        projectId: project.id, provider: .claude, name: cmd["name"],
                        config: AgentConfig(model: cmd["model"] ?? "haiku", mode: cmd["mode"] ?? "default"), prompt: cmd["prompt"]))
                    log("created agent \(cmd["name"] ?? "")")
                } catch { log("createAgent failed: \(error.localizedDescription)") }
            }
        case "expand":
            if let chat { chat.expanded.formUnion(chat.items.suffix(Int(cmd["last"] ?? "20") ?? 20).map(\.id)) }
        case "scroll" where cmd["by"] != nil:
            // Positive scrolls up (towards older rows), like reading back.
            // From AppKit's offset: SwiftUI's reported one can lag behind after programmatic scrolls.
            let from = transcriptScrollView()?.contentView.bounds.minY ?? offsetY
            scroller?(ScrollPosition(y: max(0, from - CGFloat(Double(cmd["by"]!) ?? 0))))
            afterIdle { self.log(String(format: "scrolled to y=%.0f of %.0f", self.transcriptScrollView()?.contentView.bounds.minY ?? -1, self.contentHeight)) }
        case "scroll":
            let t0 = CACurrentMediaTime()
            scroller?(ScrollPosition(edge: cmd["to"] == "top" ? .top : .bottom))
            afterIdle { self.log(String(format: "scroll to %@: %.1f ms", cmd["to"] ?? "bottom", (CACurrentMediaTime() - t0) * 1000)) }
        case "wheel":
            // Wheel-like scrolling: `steps` small scrolls up of `by` points, one per frame.
            let steps = Int(cmd["steps"] ?? "15") ?? 15, by = CGFloat(Double(cmd["by"] ?? "20") ?? 20)
            func tick(_ n: Int) {
                guard n < steps, let sv = transcriptScrollView() else {
                    return log(String(format: "wheel done: y=%.0f of %.0f", transcriptScrollView()?.contentView.bounds.minY ?? -1,
                                      transcriptScrollView()?.documentView?.frame.height ?? -1))
                }
                scroller?(ScrollPosition(y: max(0, sv.contentView.bounds.minY - by)))
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { tick(n + 1) }
            }
            tick(0)
        case "anchor":
            // anchor: watch the topmost fully visible row; anchor action=report: how far it moved.
            if cmd["action"] == "report" {
                guard let a = anchor else { return log("anchor: none") }
                let now = rowY[a.id].map { String(format: "%.1f", $0 - a.y) } ?? "gone"
                log(String(format: "anchor %@: now %@ pt, max drift %.1f pt, offset %.0f/%.0f", a.id, now, a.drift, offsetY, contentHeight))
            } else {
                guard let top = rowY.filter({ $0.value >= 0 && $0.value < viewportHeight }).min(by: { $0.value < $1.value }) else {
                    return log("anchor: no rows (CASM_PROBE=1?)")
                }
                anchor = (top.key, top.value, 0)
                log(String(format: "anchor %@ at %.1f, offset %.0f/%.0f", top.key, top.value, offsetY, contentHeight))
            }
        case "stream":
            // A turn streaming below the reader: deltas, then the final reply and a tool row, then the end.
            guard let chat else { return }
            let n = Int(cmd["deltas"] ?? "30") ?? 30, tag = UUID().uuidString.prefix(6)
            chat.apply(.turnStarted(turnId: "t-\(tag)"))
            func step(_ i: Int) {
                switch i {
                case ..<n:
                    chat.apply(.delta(kind: .assistant, text: "Line \(i) of the streamed reply, long enough to wrap once in a narrow column here.\n\n"))
                case n:
                    chat.apply(.item(.assistant(id: "a-\(tag)", text: "The final reply replaces the draft.\n\nIt has two paragraphs.")))
                case n + 1:
                    chat.apply(.item(.tool(ToolCall(id: "tool-\(tag)", name: "Bash", input: .object(["command": .string("ls")]), status: .done))))
                default:
                    chat.apply(.turnEnded(turnId: "t-\(tag)", outcome: .completed, error: nil))
                    return log("stream: done")
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + (Double(cmd["every"] ?? "50") ?? 50) / 1000) { step(i + 1) }
            }
            step(0)
        case "views":
            for w in NSApp.windows {
                log("window \(type(of: w)) visible=\(w.isVisible) frame=\(w.frame)")
                func dump(_ v: NSView, _ d: Int) {
                    if d < 14 { log(String(repeating: " ", count: d) + "\(type(of: v)) \(v.frame) layer=\(v.layer.map { "\(type(of: $0))" } ?? "-")") }
                    v.subviews.forEach { dump($0, d + 1) }
                }
                if let root = w.contentView?.superview { dump(root, 0) }
            }
        case "fps":
            if cmd["action"] == "stop" { stopFrames() } else { startFrames() }
        case "bench":
            bench()
        case "snapshot":
            snapshot(to: cmd["path"] ?? "/tmp/casm-shots/snapshot.png")
        case "state":
            log("hosts: " + app.hosts.map { "\($0.name)=\($0.state) projects=\($0.projects.count) agents=\($0.agents.count)" }.joined(separator: ", "))
            if let chat {
                log("chat: items=\(chat.items.count) window=\(chat.windowStart) offset=\(Int(offsetY))/\(Int(contentHeight)) start=\(chat.historyStart ?? -1) status=\(chat.status.rawValue) permissions=\(chat.permissions.count) questions=\(chat.questions.count) draft=\(chat.draft?.text.count ?? 0) error=\(chat.error ?? "-") viewport=\(Int(viewportHeight))")
            }
        case "geo":
            // What AppKit's scroll views say, independent of SwiftUI's geometry callbacks.
            for w in NSApp.windows where w.isVisible {
                for case let sv as NSScrollView in Self.descendants(of: w.contentView?.superview ?? NSView()) {
                    guard let doc = sv.documentView, doc.frame.height > 0 else { continue }
                    log(String(format: "geo %@: clip y=%.0f h=%.0f doc h=%.0f insets t=%.0f b=%.0f", "\(type(of: sv))",
                               sv.contentView.bounds.minY, sv.contentView.bounds.height, doc.frame.height,
                               sv.contentInsets.top, sv.contentInsets.bottom))
                }
            }
        default:
            log("unknown command \(cmd)")
        }
    }

    /// Runs `body` when the main run loop next goes idle, i.e. after SwiftUI's update and the CA commit.
    func afterIdle(_ body: @escaping @MainActor () -> Void) {
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, CFIndex.max) { _, _ in
            MainActor.assumeIsolated { body() }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }

    private func transcriptScrollView() -> NSScrollView? {
        for w in NSApp.windows where w.isVisible {
            for case let sv as NSScrollView in Self.descendants(of: w.contentView?.superview ?? NSView())
            where "\(type(of: sv))" == "HostingScrollView" && (sv.documentView?.frame.height ?? 0) > 200 { return sv }
        }
        return nil
    }

    // MARK: Scroll benchmark

    /// Scrolls the open transcript from bottom to top and back in fixed steps, measuring the
    /// main-thread cost of each step (state change → layout → commit). The first pass renders
    /// every row for the first time; the second runs over cached markdown.
    private func bench(step: CGFloat = 40) {
        guard let scroller, contentHeight > viewportHeight else { return log("bench: open a long transcript first") }
        let maxY = contentHeight - viewportHeight
        log(String(format: "bench: content %.0f pt, viewport %.0f pt, step %.0f pt", contentHeight, viewportHeight, step))
        var up = Array(stride(from: maxY, through: 0, by: -step))
        var costs: [Double] = []
        var passes: [(String, [Double])] = []
        var phase = "up (first render)"
        func next() {
            guard !up.isEmpty else {
                passes.append((phase, costs))
                costs = []
                if phase.hasPrefix("up") {
                    phase = "down (cached)"
                    // Content height changes as estimated rows get measured; re-read it.
                    up = Array(stride(from: 0, through: max(0, self.contentHeight - self.viewportHeight), by: step))
                    return next()
                }
                for (name, c) in passes { report(name, c) }
                return
            }
            let y = up.removeFirst()
            let t0 = CACurrentMediaTime()
            scroller(ScrollPosition(y: y))
            afterIdle {
                costs.append((CACurrentMediaTime() - t0) * 1000)
                if costs.count % 250 == 0 {
                    self.log(String(format: "bench %@: %d steps, y=%.0f, last %.1f ms", phase, costs.count, y, costs.last!))
                }
                DispatchQueue.main.async { next() }
            }
        }
        next()
    }

    private func report(_ name: String, _ costs: [Double]) {
        guard !costs.isEmpty else { return }
        let sorted = costs.sorted()
        func p(_ q: Double) -> Double { sorted[min(sorted.count - 1, Int(Double(sorted.count) * q))] }
        let over8 = costs.filter { $0 > 8.3 }.count, over16 = costs.filter { $0 > 16.7 }.count
        log(String(format: "bench %@: %d steps, mean %.2f ms, p50 %.2f, p95 %.2f, p99 %.2f, max %.2f ms; >8.3 ms: %d, >16.7 ms: %d",
                   name, costs.count, costs.reduce(0, +) / Double(costs.count), p(0.5), p(0.95), p(0.99), sorted.last!, over8, over16))
    }

    // MARK: Frame recorder

    private var link: CADisplayLink?
    private var frames: [(timestamp: CFTimeInterval, expected: CFTimeInterval)] = []

    /// Records display-link callbacks while real input scrolls the transcript. A frame whose
    /// interval exceeds 1.5× the refresh interval means at least one dropped frame.
    private func startFrames() {
        frames = []
        link?.invalidate()
        guard let screen = NSApp.windows.first(where: \.isVisible)?.screen ?? NSScreen.main else { return }
        let link = screen.displayLink(target: FrameTarget.shared, selector: #selector(FrameTarget.tick(_:)))
        FrameTarget.shared.onTick = { [weak self] l in self?.frames.append((l.timestamp, l.targetTimestamp - l.timestamp)) }
        link.add(to: .main, forMode: .common)
        self.link = link
        log("fps: recording")
    }

    private func stopFrames() {
        link?.invalidate()
        link = nil
        guard frames.count > 2 else { return log("fps: no frames") }
        let intervals = zip(frames.dropFirst(), frames).map { ($0.timestamp - $1.timestamp) * 1000 }
        let expected = (frames.map(\.expected).sorted()[frames.count / 2]) * 1000
        let dropped = intervals.reduce(0) { $0 + max(0, Int(($1 / expected).rounded()) - 1) }
        let hitches = intervals.filter { $0 > expected * 1.5 }
        let sorted = intervals.sorted()
        let total = intervals.reduce(0, +)
        log(String(format: "fps: %d frames over %.0f ms at %.1f Hz refresh: %.1f fps, %d dropped (%.1f%%), %d hitches, p95 %.1f ms, max %.1f ms",
                   intervals.count, total, 1000 / expected, Double(intervals.count) * 1000 / total, dropped,
                   Double(dropped) * 100 / Double(intervals.count + dropped), hitches.count,
                   sorted[Int(Double(sorted.count) * 0.95)], sorted.last!))
    }

    // MARK: Snapshot

    private static func descendants(of view: NSView) -> [NSView] {
        view.subviews + view.subviews.flatMap(descendants)
    }

    /// Renders the key window (including the toolbar) to a PNG. Works without screen-recording
    /// permission and while the screen is locked, unlike `screencapture`.
    private func snapshot(to path: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && !($0 is NSPanel) }),
              let view = window.contentView?.superview ?? window.contentView else { return log("snapshot: no window") }
        // Include attached sheets.
        let target = window.attachedSheet?.contentView?.superview ?? view
        guard let rep = target.bitmapImageRepForCachingDisplay(in: target.bounds) else { return log("snapshot failed") }
        target.cacheDisplay(in: target.bounds, to: rep)
        // cacheDisplay skips views hosted in glass containers (the macOS 26 sidebar); draw table
        // and outline views individually on top, at their place in the window.
        if let ctx = NSGraphicsContext(bitmapImageRep: rep) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = ctx
            for case let table as NSTableView in Self.descendants(of: target) {
                for row in 0..<table.numberOfRows {
                    guard let rowView = table.rowView(atRow: row, makeIfNecessary: false) else { continue }
                    for cell in [rowView] + rowView.subviews {
                        guard let piece = cell.bitmapImageRepForCachingDisplay(in: cell.bounds) else { continue }
                        cell.cacheDisplay(in: cell.bounds, to: piece)
                        let frame = cell.convert(cell.bounds, to: target)
                        let rect = NSRect(x: frame.minX, y: target.isFlipped ? target.bounds.height - frame.maxY : frame.minY,
                                          width: frame.width, height: frame.height)
                        piece.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
                    }
                }
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        do {
            try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            log("snapshot \(path)")
        } catch {
            log("snapshot failed: \(error.localizedDescription)")
        }
    }
}

@MainActor
final class FrameTarget: NSObject {
    static let shared = FrameTarget()
    var onTick: ((CADisplayLink) -> Void)?
    @objc func tick(_ link: CADisplayLink) { onTick?(link) }
}
#endif
