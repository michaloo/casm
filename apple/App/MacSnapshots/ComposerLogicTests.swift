import CasmKit
import SwiftUI
import XCTest

@MainActor
final class ComposerLogicTests: XCTestCase {
    func context(_ text: String) -> CompletionContext? {
        CompletionContext.at(text.endIndex, in: text)
    }

    func testPickerModelPrefersConfigThenReportedThenCatalogDefault() throws {
        let models = try JSONDecoder().decode([ModelInfo].self, from: Data("""
            [{"id": "gpt-6.1-sol", "isDefault": true}, {"id": "gpt-6-astra"}]
            """.utf8))
        func shown(_ model: String?, _ effective: String?) -> String? {
            ConfigPickers.model(config: AgentConfig(model: model), effective: effective, in: models)?.id
        }
        XCTAssertEqual(shown(nil, nil), "gpt-6.1-sol", "no session yet: the catalog's default")
        XCTAssertEqual(shown(nil, "gpt-6-astra"), "gpt-6-astra", "unset model: what the session runs")
        XCTAssertEqual(shown("gpt-6.1-sol", "gpt-6-astra"), "gpt-6.1-sol", "a configured model wins")
        XCTAssertNil(shown(nil, "gpt-unlisted"), "not in the catalog: the picker shows the raw id")
    }

    func testPickerMatchesClaudeFullIdsToCatalogAliases() throws {
        let models = try JSONDecoder().decode([ModelInfo].self, from: Data("""
            [{"id": "default", "name": "Default (recommended)", "isDefault": true},
             {"id": "opus", "name": "Opus 5.5"}, {"id": "haiku", "name": "Haiku 4.5"}]
            """.utf8))
        func shown(_ effective: String) -> String? {
            ConfigPickers.model(config: AgentConfig(), effective: effective, in: models)?.id
        }
        XCTAssertEqual(shown("claude-opus-5-5"), "opus")
        XCTAssertEqual(shown("claude-haiku-4-5-20251001"), "haiku", "dated ids match too")
        XCTAssertNil(shown("claude-opus-5"), "no catalog entry by that name")
    }

    func testAgentNamesComeFromTheFirstLine() {
        XCTAssertEqual(ChatModel.agentName(from: "  Fix the   login\tbug  \nmore detail"), "Fix the login bug")
        XCTAssertEqual(ChatModel.agentName(from: "\n\nsecond line first"), "second line first")
        XCTAssertEqual(ChatModel.agentName(from: "Refactor the authentication middleware so tokens refresh"),
                       "Refactor the authentication middleware…")
        XCTAssertEqual(ChatModel.agentName(from: String(repeating: "x", count: 50)), String(repeating: "x", count: 40) + "…")
        XCTAssertNil(ChatModel.agentName(from: " \n "), "no text: the server's default name")
    }

    func testLiveItemsMergeAfterHistory() {
        let history: [Item] = [.user(id: "u1", text: "old"), .assistant(id: "a1", text: "old reply")]
        // Opened mid-turn: the replayed turn (prompt not yet in the session file) came first.
        let live: [Item] = [.user(id: "u2", text: "new"), .reasoning(id: "r2", text: "hmm")]
        let ids = { (items: [Item]) in items.map(\.id) }
        XCTAssertEqual(ids(ChatModel.merge(history, fresh: Set(ids(history)), items: live, historyCount: 0)),
                       ["u1", "a1", "u2", "r2"], "the running turn goes after history, not above it")
        // A local notice after a history item stays right after it.
        let withNotice: [Item] = history + [.notice(id: "n", text: "Reloaded"), .user(id: "u2", text: "new")]
        XCTAssertEqual(ids(ChatModel.merge(history + [.assistant(id: "a2", text: "x")], fresh: ["u1", "a1", "a2"],
                                           items: withNotice, historyCount: 2)),
                       ["u1", "a1", "n", "u2", "a2"])
    }

    func testNoticesDropTheRepeatedLineAndGetIcons() {
        XCTAssertEqual(NoticeRow.cleaned("Task completed: Pull, build Release\nPull, build Release"), "Task completed: Pull, build Release")
        XCTAssertEqual(NoticeRow.cleaned("Interrupted"), "Interrupted")
        XCTAssertEqual(NoticeRow.cleaned("Turn failed: x\ndetails"), "Turn failed: x\ndetails")
        XCTAssertEqual(NoticeRow.icon(for: "Task completed: x", level: .info).0, "checkmark.circle")
        XCTAssertEqual(NoticeRow.icon(for: "Task running: x", level: nil).0, "clock")
        XCTAssertEqual(NoticeRow.icon(for: "Task completed: x", level: .error).0, "xmark.octagon.fill", "level wins")
        XCTAssertEqual(NoticeRow.icon(for: "Something else", level: nil).0, "info.circle")
    }

    func testActivityPillsNameTheTwoKindsOfSubagents() {
        XCTAssertEqual(ActivityPill.title(count: 1, kind: .casm), "1 casm subagent working")
        XCTAssertEqual(ActivityPill.title(count: 2, kind: .internal), "2 internal subagents working")
        XCTAssertTrue(ActivityPill.explanation(.casm).contains("sidebar"))
        XCTAssertTrue(ActivityPill.explanation(.internal).contains("can't be messaged"))
    }

    func testFinishedNotificationsShowTheReply() {
        XCTAssertEqual(Notifier.excerpt("## Done\n\nThe **build** passes. See [log](http://x).\n- `npm test`: 161 ok"),
                       "Done The build passes. See log. npm test: 161 ok")
        let long = Notifier.excerpt(String(repeating: "word ", count: 100))
        XCTAssertTrue(long.hasSuffix("…") && long.count <= 181, long)
        XCTAssertEqual(Notifier.finishedBody(reply: "All set.", outcome: "completed", error: nil), "All set.")
        XCTAssertEqual(Notifier.finishedBody(reply: nil, outcome: "failed", error: "usage limit"), "Turn failed: usage limit")
        XCTAssertEqual(Notifier.finishedBody(reply: nil, outcome: nil, error: nil), "The turn is done.")
    }

    func testCompletionContexts() {
        XCTAssertEqual(context("/rev")?.kind, .command)
        XCTAssertEqual(context("/rev")?.query, "rev")
        XCTAssertEqual(context("/")?.query, "")
        XCTAssertNil(context("please /rev"), "commands only at the start")
        XCTAssertNil(context("/review now"), "past the first word")
        XCTAssertEqual(context("look at @src/ma")?.kind, .mention)
        XCTAssertEqual(context("look at @src/ma")?.query, "src/ma")
        XCTAssertEqual(context("@")?.query, "")
        XCTAssertNil(context("mail me@"), "an @ inside a word isn't a mention")
        XCTAssertNil(context("plain text"))
        // The replaced range covers the token up to the caret.
        let text = "see @Pack"
        let c = CompletionContext.at(text.endIndex, in: text)!
        XCTAssertEqual(String(text[c.range]), "@Pack")
    }

    func testCommandSuggestions() {
        let commands = [
            SlashCommand(name: "review", description: "Review a PR", argumentHint: "<pr>", kind: .command),
            SlashCommand(name: "compact", description: nil, argumentHint: nil, kind: .command),
            SlashCommand(name: "pdf", description: "Work with PDFs", argumentHint: nil, kind: .skill),
            SlashCommand(name: "preview", description: nil, argumentHint: nil, kind: nil),
        ]
        let rev = Suggestion.commands(commands, matching: "rev")
        XCTAssertEqual(rev.map(\.insert), ["/review ", "/preview "], "prefix matches first, then contains")
        XCTAssertEqual(rev.first?.title, "/review <pr>")
        XCTAssertEqual(Suggestion.commands(commands, matching: "pd").first?.badge, "Skill")
        XCTAssertEqual(Suggestion.commands(commands, matching: "").count, 4)
    }

    func testFileSuggestions() {
        let s = Suggestion.files([FileEntry(path: "Sources", kind: .dir), FileEntry(path: "README.md", kind: .file)])
        XCTAssertEqual(s.map(\.insert), ["@Sources/", "@README.md "])
    }

    func testImageEncoding() throws {
        // A 3000×1000 opaque image comes back as a JPEG no larger than 2048 on the long side.
        let size = NSSize(width: 3000, height: 1000)
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor.systemTeal.setFill(); rect.fill(); return true
        }
        let tiff = try XCTUnwrap(image.tiffRepresentation)
        let png = try XCTUnwrap(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
        let encoded = try XCTUnwrap(ImageEncoding.encode(png))
        let data = try XCTUnwrap(Data(base64Encoded: encoded.data ?? ""))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
        XCTAssertLessThanOrEqual(max(rep.pixelsWide, rep.pixelsHigh), 2048)
        XCTAssertTrue(["image/jpeg", "image/png"].contains(encoded.mediaType))
        XCTAssertNil(ImageEncoding.encode(Data("not an image".utf8)))
    }

    /// Regression: a Codex agent was created with mode "default", a Claude mode id.
    func testAgentConfigOnlyUsesTheProvidersCatalog() throws {
        let codex = try JSONDecoder().decode(Catalog.self, from: Data(#"""
        {"models": [{"id": "gpt-5.5-codex", "isDefault": true, "efforts": ["low", "medium", "high"]}, {"id": "gpt-5-mini"}],
         "modes": [{"id": "plan"}, {"id": "auto"}, {"id": "auto-review"}, {"id": "full-access"}]}
        """#.utf8))
        // Another provider's ids are dropped, so Codex picks its own defaults.
        let foreign = AgentConfigChoice.config(model: "haiku", effort: "xhigh", mode: "default", catalog: codex)
        XCTAssertNil(foreign.mode)
        XCTAssertNil(foreign.model)
        XCTAssertNil(foreign.effort)
        // The provider's own ids go through.
        let own = AgentConfigChoice.config(model: "gpt-5.5-codex", effort: "high", mode: "auto-review", catalog: codex)
        XCTAssertEqual(own.model, "gpt-5.5-codex")
        XCTAssertEqual(own.mode, "auto-review")
        XCTAssertEqual(own.effort, "high")
        // An effort the chosen model doesn't take is dropped.
        XCTAssertNil(AgentConfigChoice.config(model: "gpt-5-mini", effort: "high", mode: "", catalog: codex).effort)
        // "Default" everywhere sends nothing.
        let defaults = AgentConfigChoice.config(model: "", effort: "", mode: "", catalog: codex)
        XCTAssertNil(defaults.model)
        XCTAssertNil(defaults.mode)
        // Without a catalog nothing is guessed.
        XCTAssertNil(AgentConfigChoice.config(model: "haiku", effort: "low", mode: "default", catalog: nil).mode)
    }

    func testMemoryFrontMatter() {
        let note = MemoryEntryRow.split("---\nname: x\ndescription: Short summary\nmetadata:\n  type: reference\n---\n\nBody **text**.")
        XCTAssertEqual(note.description, "Short summary")
        XCTAssertEqual(note.body, "Body **text**.")
        XCTAssertNil(MemoryEntryRow.split("Plain memory").description)
        XCTAssertEqual(MemoryEntryRow.split("Plain memory").body, "Plain memory")
    }

    func testNotificationKinds() {
        XCTAssertEqual(Notifier.kind(from: .running, to: .waiting, focusedOnAgent: false), .needsYou)
        XCTAssertEqual(Notifier.kind(from: .running, to: .idle, focusedOnAgent: false), .finished)
        XCTAssertEqual(Notifier.kind(from: .waiting, to: .idle, focusedOnAgent: false), .finished)
        XCTAssertNil(Notifier.kind(from: .running, to: .waiting, focusedOnAgent: true), "not while looking at it")
        XCTAssertNil(Notifier.kind(from: .idle, to: .running, focusedOnAgent: false))
        XCTAssertNil(Notifier.kind(from: .idle, to: .idle, focusedOnAgent: false))
    }

    func testContextRingDetails() {
        let ring = ContextRing(usage: Usage(model: "haiku", contextTokens: 34200, contextWindow: 200000, inputTokens: nil, outputTokens: nil, costUsd: 0.0123))
        // Numbers and currency follow the user's locale, so only check the stable parts.
        XCTAssertTrue(ring.details.contains("tokens (17%)"), ring.details)
        XCTAssertFalse(ring.details.contains("Model") || ring.details.contains("Cost"), "model is in the picker; limits replace cost")
        let limits = try! JSONDecoder().decode(ProviderLimits.self, from: Data("""
            {"provider": "claude", "updatedAt": "2026-10-14T08:00:00Z", "windows": [
              {"id": "five_hour", "label": "5-hour", "usedPercent": 44, "resetsAt": "2026-10-14T10:30:00Z"},
              {"id": "seven_day", "label": "weekly"}]}
            """.utf8))
        let withLimits = ContextRing(usage: ring.usage, limits: limits).details
        XCTAssertTrue(withLimits.contains("5-hour: 44% used, resets"), withLimits)
        XCTAssertTrue(withLimits.contains("Weekly: not reported"), withLimits)
    }
}
