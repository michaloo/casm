import CasmKit
import Foundation
import UserNotifications

/// Local notifications (no push) when an agent starts waiting for a permission or an answer, or
/// finishes a turn, unless the app is focused on that agent. Clicking one opens the agent.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private weak var app: AppModel?
    private var authorized: Bool?
    /// Whether the app is frontmost (macOS) / active (iOS); set by the app.
    var appActive = true

    func attach(_ app: AppModel) {
        self.app = app
        UNUserNotificationCenter.current().delegate = self
    }

    enum Kind: Equatable { case needsYou, finished }

    /// Which notification a status change deserves, if any.
    nonisolated static func kind(from old: AgentStatus, to new: AgentStatus, focusedOnAgent: Bool) -> Kind? {
        guard old != new, !focusedOnAgent else { return nil }
        switch (old, new) {
        case (_, .waiting): return .needsYou
        case (.running, .idle), (.waiting, .idle): return .finished
        default: return nil
        }
    }

    /// Called for every status change the server broadcasts.
    func statusChanged(host: HostModel, agent: Agent, from old: AgentStatus, to new: AgentStatus) {
        guard let app else { return }
        let focused = appActive && app.selection == .agent(host: host.id, agent: agent.id)
        switch Self.kind(from: old, to: new, focusedOnAgent: focused) {
        case .needsYou:
            post(host: host, agent: agent, title: "\(agent.name) needs you", body: "Waiting for a permission or an answer.")
        case .finished:
            // The reply itself says more than "done"; the app isn't subscribed to unfocused
            // agents, so ask the server (agent.wait returns at once for an idle agent).
            Task {
                let result = try? await host.client.wait(agentId: agent.id, timeoutMs: 2000)
                post(host: host, agent: agent, title: "\(agent.name) finished",
                     body: Self.finishedBody(reply: result?.lastReply, outcome: result?.lastTurn?.outcome, error: result?.lastTurn?.error))
            }
        case nil:
            break
        }
    }

    /// "The turn is done." unless there's something better: the error of a failed turn, or the
    /// start of the reply as plain text.
    nonisolated static func finishedBody(reply: String?, outcome: String?, error: String?) -> String {
        if outcome == "failed" { return "Turn failed" + (error.map { ": \(excerpt($0))" } ?? ".") }
        if let reply, !excerpt(reply).isEmpty { return excerpt(reply) }
        return outcome == "interrupted" ? "Interrupted." : "The turn is done."
    }

    /// Markdown reduced to a single plain line of about `limit` characters, cut at a word.
    nonisolated static func excerpt(_ text: String, limit: Int = 180) -> String {
        var plain = text
            .replacingOccurrences(of: "```[^\n]*", with: "", options: .regularExpression)
            .replacingOccurrences(of: "(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+[.)])\\s+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[*_`]+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard plain.count > limit else { return plain }
        plain = String(plain.prefix(limit))
        if let space = plain.lastIndex(of: " ") { plain = String(plain[..<space]) }
        return plain + "…"
    }

    private func post(host: HostModel, agent: Agent, title: String, body: String) {
        Task {
            guard await ensureAuthorized() else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.subtitle = host.name
            content.body = body
            content.sound = .default
            content.threadIdentifier = agent.id
            content.userInfo = ["host": host.id.uuidString, "agent": agent.id]
            // One pending notification per agent: a newer state replaces the older one.
            let request = UNNotificationRequest(identifier: "agent-\(agent.id)", content: content, trigger: nil)
            try? await UNUserNotificationCenter.current().add(request)
        }
    }

    private func ensureAuthorized() async -> Bool {
        if let authorized { return authorized }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        authorized = granted
        return granted
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let host = (info["host"] as? String).flatMap(UUID.init(uuidString:)), let agent = info["agent"] as? String else { return }
        await MainActor.run {
            app?.selection = .agent(host: host, agent: agent)
            app?.bringToFront()
        }
    }
}
