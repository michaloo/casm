import CasmKit
import SwiftUI
import XCTest

/// The transcript as the chat lays it out (rows, gaps, column), offscreen, for typography checks.
@MainActor
final class TranscriptSnapshotTests: XCTestCase {
    static let items: [Item] = [
        .user(id: "u1", text: "Can you check if the session store survives a server restart?"),
        .reasoning(id: "r1", text: "Look at shutdown first."),
        .tool(ToolCall(id: "t1", name: "Read", input: .object(["file_path": .string("packages/server/src/agents.ts")]), status: .done, output: "…")),
        .tool(ToolCall(id: "t2", name: "shell", input: .object(["command": .string("ls -la")]), status: .done,
                       output: "total 4\n-rw-r--r--  1 me  staff  17 README.md\n-rw-r--r--  1 me  staff   0 notes.txt", origin: "user")),
        .assistant(id: "a1", text: """
        ## Short answer

        **Session records survive**, but active work does not continue through a restart. Running turns are \
        interrupted and need another message.

        - Sessions stay resumable: the native session id is kept in SQLite.
        - Pending permission prompts are lost.

        ```ts
        async shutdown() {
          await Promise.all(sessions.map((s) => s.close()));
        }
        ```

        Use `casm pending` to see what is still queued.
        """),
        .notice(id: "n1", text: "Interrupted", level: nil),
        .user(id: "u2", text: "ok, thanks"),
        .assistant(id: "a2", text: "You're welcome."),
    ]

    func testTranscriptTypography() throws {
        let width: CGFloat = 1000
        let margin = max(Theme.sideMargin, (width - Theme.columnWidth) / 2)
        for dark in [true, false] {
            let view = VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(Self.items.enumerated()), id: \.offset) { i, item in
                    ItemRow(item: item, expanded: .constant(["t2"]))
                        .padding(.top, item.gap(after: i > 0 ? Self.items[i - 1] : nil))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, margin)
                }
            }
            .padding(.vertical, 16)
            .frame(width: width)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(renderer.nsImage?.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: "/tmp/casm-shots/snap-transcript-\(dark ? "dark" : "light").png"))
        }
    }
}
