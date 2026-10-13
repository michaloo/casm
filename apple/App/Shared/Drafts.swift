import CasmKit
import Foundation

/// Unsent composer text and half-filled question answers, per agent, so switching agents (or
/// quitting) doesn't lose them. Text and answers persist in UserDefaults; attached images are kept
/// in memory only (they can be megabytes).
@MainActor
final class Drafts {
    static let shared = Drafts()

    struct Answers: Codable, Equatable {
        var picked: [String: [String]] = [:]
        var other: [String: String] = [:]
        var text: [String: String] = [:]
        var confirmed: [String: Bool] = [:]

        var isEmpty: Bool { picked.values.allSatisfy(\.isEmpty) && other.values.allSatisfy(\.isEmpty)
            && text.values.allSatisfy(\.isEmpty) && confirmed.isEmpty }
    }

    private struct Stored: Codable {
        var texts: [String: String] = [:]
        var answers: [String: Answers] = [:]
    }

    private let defaults: UserDefaults
    private let key = "casm.drafts"
    private var stored: Stored
    private var images: [String: [ImageData]] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        stored = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) } ?? Stored()
    }

    /// Drafts are per agent on a host: the same agent id on two hosts is two agents.
    static func key(host: UUID?, agent: String) -> String { "\(host?.uuidString ?? "-")/\(agent)" }

    // MARK: Composer

    func text(_ key: String) -> String { stored.texts[key] ?? "" }
    func images(_ key: String) -> [ImageData] { images[key] ?? [] }

    func save(_ key: String, text: String, images new: [ImageData]) {
        images[key] = new.isEmpty ? nil : new
        let value = text.isEmpty ? nil : text
        guard stored.texts[key] != value else { return }
        stored.texts[key] = value
        persist()
    }

    // MARK: Questions (keyed by request id, which is unique per question)

    func answers(_ requestId: String) -> Answers { stored.answers[requestId] ?? Answers() }

    func save(_ requestId: String, answers: Answers) {
        let value = answers.isEmpty ? nil : answers
        guard stored.answers[requestId] != value else { return }
        stored.answers[requestId] = value
        persist()
    }

    func clearAnswers(_ requestId: String) {
        guard stored.answers.removeValue(forKey: requestId) != nil else { return }
        persist()
    }

    private func persist() {
        defaults.set(try? JSONEncoder().encode(stored), forKey: key)
    }
}
