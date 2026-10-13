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
            items.append(.user(id: "u\(turn)", text: prompts[turn % prompts.count] + " (turn \(turn))"))
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
