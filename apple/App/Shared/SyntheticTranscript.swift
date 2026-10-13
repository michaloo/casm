#if DEBUG
import CasmKit
import Foundation

/// A deterministic transcript for the rendering spike: user prompts, reasoning, tool rows
/// with input/output, and assistant markdown with headings, lists, tables and code blocks.
enum SyntheticTranscript {
    static func items(count: Int) -> [Item] {
        var items: [Item] = []
        var turn = 0
        while items.count < count {
            turn += 1
            items.append(.user(id: "u\(turn)", text: prompts[turn % prompts.count] + " (turn \(turn))",
                               images: turn % 7 == 0 ? [ImageData(mediaType: "image/png", data: thumbnail)] : []))
            if turn % 5 == 0 {
                items.append(.plan(id: "p\(turn)", entries: [
                    PlanEntry(text: "Read the history reader", status: .completed),
                    PlanEntry(text: "Stream pages instead of slicing", status: .inProgress),
                    PlanEntry(text: "Update the tests", status: .pending),
                ]))
            }
            if turn % 11 == 0 {
                items.append(.notice(id: "n\(turn)", text: "API overloaded, retrying in 5 s", level: .warning))
            }
            if turn % 3 == 0 {
                items.append(.reasoning(id: "r\(turn)", text: "Let me look at the relevant files first. " +
                    String(repeating: "I should check how the parser handles edge cases before changing anything. ", count: 4)))
            }
            for t in 0..<(turn % 4 + 1) {
                let (name, input, output) = tools[(turn + t) % tools.count]
                items.append(.tool(ToolCall(id: "t\(turn)-\(t)", name: name, input: input,
                                            status: (turn + t) % 17 == 0 ? .error : .done, output: output)))
            }
            items.append(.assistant(id: "a\(turn)", text: replies[turn % replies.count]))
        }
        return Array(items.prefix(count))
    }

    /// A 40×40 gradient PNG.
    private static let thumbnail = "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"

    private static let prompts = [
        "Can you explain how the session store works?",
        "Fix the failing test in `server.test.ts`.",
        "Refactor the history reader to stream pages.",
        "Why is the reconnect logic racing with subscribe?",
        "Write a short summary of today's changes.",
    ]

    private static let fileOutput = (1...40).map { "\($0)\tlet value\($0) = compute(\($0)) // some code line" }.joined(separator: "\n")

    private static let tools: [(String, JSONValue, String)] = [
        ("Read", .object(["file_path": .string("/Users/me/project/packages/server/src/agents.ts")]), fileOutput),
        ("Bash", .object(["command": .string("npm test -- --grep history"), "description": .string("Run history tests")]),
         "> casm@0.0.1 test\n✔ history pages (12ms)\n✔ subscribe mid-turn (30ms)\n2 passing"),
        ("Grep", .object(["pattern": .string("subscribeState"), "path": .string("packages")]),
         "packages/server/src/agents.ts:244\npackages/server/src/methods.ts:97"),
        ("Edit", .object(["file_path": .string("/Users/me/project/README.md"), "old_string": .string("foo"), "new_string": .string("bar")]),
         "The file /Users/me/project/README.md has been updated."),
    ]

    private static let replies = [
        """
        ## How it works

        The server keeps **no transcript** of its own. When you open an agent it reads the provider's \
        native session file and normalizes it into items:

        - `user` and `assistant` text
        - `reasoning` blocks, collapsed by default
        - `tool` calls with their *input* and *output*

        ```ts
        async history(id: string, before?: number, limit = 200) {
          const all = await this.provider(a.provider).history(a.nativeSessionId, a.cwd);
          const end = Math.min(before ?? all.length, all.length);
          return { items: all.slice(Math.max(0, end - limit), end), start, total: all.length };
        }
        ```

        That keeps state minimal at the cost of a slower open.
        """,
        """
        Fixed. The test was waiting for `turnEnded` before the permission was answered, so it timed out.

        1. Answer the permission first.
        2. Then wait for the turn to end.
        3. Assert on the final status.

        | Test | Before | After |
        |------|--------|-------|
        | history pages | ✔ | ✔ |
        | permission flow | ✘ | ✔ |
        """,
        """
        Done — a short one this time. See [the docs](https://example.com) for details, or run `casm agents --json`.
        """,
        """
        ### Summary

        > The reconnect handler re-subscribes before the history read, so no events are lost.

        ```swift
        func resync() async {
            let sub = try await client.subscribe(agentId: id)
            for event in sub.turn { apply(event) }
            try await loadLatest()
        }
        ```

        ```bash
        swift test --filter RecordedSession
        xcodebuild -scheme CasmMac build
        ```

        ---

        Everything passes now. Let me know if you want the same change on iOS.
        """,
    ]
}
#endif
