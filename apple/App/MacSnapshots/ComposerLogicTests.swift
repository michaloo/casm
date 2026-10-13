import CasmKit
import SwiftUI
import XCTest

@MainActor
final class ComposerLogicTests: XCTestCase {
    func context(_ text: String) -> CompletionContext? {
        CompletionContext.at(text.endIndex, in: text)
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
        XCTAssertTrue(ring.details.contains("Model haiku"), ring.details)
        XCTAssertTrue(ring.details.contains("Cost") && ring.details.contains("0123"), ring.details)
    }
}
