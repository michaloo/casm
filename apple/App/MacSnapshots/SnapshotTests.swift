import CasmKit
import SwiftUI
import XCTest

/// Renders UI components to PNGs with ImageRenderer: no app launch, no windows, nothing on screen.
/// Toolbars, sheets and popovers need a real window and are not covered.
/// Output: $CASM_SNAPSHOTS or /tmp/casm-shots/snap-*.png.
@MainActor
final class SnapshotTests: XCTestCase {
    let dir = ProcessInfo.processInfo.environment["CASM_SNAPSHOTS"] ?? "/tmp/casm-shots"

    func render<V: View>(_ name: String, width: CGFloat = 420, dark: Bool = false, @ViewBuilder _ view: () -> V) throws {
        let content = view()
            .padding(16)
            .frame(width: width, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage, "render \(name)")
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: "\(dir)/snap-\(name).png"))
    }

    func testActivityBadges() throws {
        for dark in [false, true] {
            try render("activity-\(dark ? "dark" : "light")", width: 360, dark: dark) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 20) {
                        ActivityBadge(status: .running)
                        ActivityBadge(status: .waiting)
                    }
                    HStack(spacing: 20) {
                        ActivityBadge(status: .running, compact: true)
                        ActivityBadge(status: .waiting, compact: true)
                    }
                }
            }
        }
    }

    func testComposerPieces() throws {
        let commands = [
            SlashCommand(name: "review", description: "Review a pull request", argumentHint: "<pr>", kind: .command),
            SlashCommand(name: "pdf", description: "Read and fill PDFs", argumentHint: nil, kind: .skill),
        ]
        try render("composer-pieces", width: 460) {
            VStack(alignment: .leading, spacing: 16) {
                // Rows directly: SuggestionList's ScrollView doesn't render offscreen.
                let rows = Suggestion.commands(commands, matching: "")
                    + Suggestion.files([FileEntry(path: "packages/server", kind: .dir), FileEntry(path: "README.md", kind: .file)])
                VStack(spacing: 1) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, s in SuggestionRow(suggestion: s, highlighted: i == 0) }
                }
                HStack(spacing: 16) {
                    ContextRing(usage: Usage(model: "haiku", contextTokens: 34200, contextWindow: 200000))
                    ContextRing(usage: Usage(model: "haiku", contextTokens: 150000, contextWindow: 200000))
                    ContextRing(usage: Usage(model: "haiku", contextTokens: 190000, contextWindow: 200000))
                }
            }
        }
    }

    func testMemories() throws {
        let groups = [
            AgentMemories(provider: .claude, scope: .project, location: "~/.claude/projects/-Users-me-app/memory/MEMORY.md", entries: [
                MemoryEntry(id: "1", title: "Testing", text: "Run `npm test` before committing; the e2e suite needs `CASM_HOME`.",
                            updatedAt: "2026-10-12T09:00:00Z"),
                MemoryEntry(id: "2", text: "The user prefers small commits with short messages."),
            ]),
            AgentMemories(provider: .codex, scope: .global, location: "~/.codex/memories.md", entries: [
                MemoryEntry(id: "3", title: "Style", text: "Answer in the language the user wrote in."),
            ]),
        ]
        try render("memories", width: 620) {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(Array(groups.enumerated()), id: \.offset) { _, g in MemoryGroupView(group: g) }
            }
        }
    }

    func testProviderIcons() throws {
        for dark in [false, true] {
            try render("providers-\(dark ? "dark" : "light")", width: 260, dark: dark) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach([ProviderID.claude, .codex, .opencode, .pi], id: \.self) { p in
                        Label { Text(p.rawValue) } icon: { ProviderIcon(provider: p) }
                    }
                }
            }
        }
    }

    func testSubtitlePaths() {
        XCTAssertEqual(ChatView.abbreviate("~/code/casm"), "~/Projects/casm")
        XCTAssertEqual(ChatView.abbreviate("/home/me"), "~")
        XCTAssertEqual(ChatView.abbreviate("/tmp/casm-play"), "/tmp/casm-play")
    }

    func testTranscriptRows() throws {
        try render("rows", width: 640) {
            VStack(alignment: .leading, spacing: 14) {
                UserBubble(text: "Fix the failing test in `server.test.ts`.")
                ToolRow(call: ToolCall(id: "t", name: "Bash", input: .object(["command": .string("npm test")]),
                                       status: .done, output: "2 passing"), expanded: .constant(false))
                PlanRow(entries: [PlanEntry(text: "Run the tests", status: .completed),
                                  PlanEntry(text: "Fix the flaky subscribe test", status: .inProgress),
                                  PlanEntry(text: "Commit", status: .pending)])
                NoticeRow(text: "Context is 90% full; compacting soon", level: .warning)
                MarkdownView(blocks: Markdown.parse("Done. The test was waiting for `turnEnded`.\n\n```bash\nnpm test\n```"))
            }
        }
    }
}
