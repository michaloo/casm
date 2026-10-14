import SwiftUI
import XCTest

final class MarkdownTableTests: XCTestCase {
    func table(_ markdown: String) throws -> MarkdownTable {
        let tables = Markdown.parse(markdown).compactMap { if case .table(let t) = $0 { t } else { nil } }
        return try XCTUnwrap(tables.first, "no table in: \(markdown)")
    }

    func plain(_ s: AttributedString) -> String { String(s.characters) }

    func testDisplayMathBecomesMathCodeBlocks() {
        let blocks = Markdown.parse("""
        So:
        $$D_9 = 9 \\cdot 14{,}833 - 1$$
        \\[ x^2 \\]
        $$
        a = b
        $$
        It costs $5 and $6.
        """)
        let math = blocks.compactMap { if case .code("math", let source) = $0 { source } else { nil } }
        XCTAssertEqual(math, ["D_9 = 9 \\cdot 14{,}833 - 1", "x^2", "a = b"])
        XCTAssertEqual(blocks.count, 5, "the dollar amounts stay a paragraph")
    }

    func testBasicTableWithAlignment() throws {
        let t = try table("""
        | Test | Before | After |
        |:-----|:------:|------:|
        | history pages | ✔ | ✔ |
        | permission flow | ✘ | **✔** |
        """)
        XCTAssertEqual(t.header.map(plain), ["Test", "Before", "After"])
        XCTAssertEqual(t.alignments, [.leading, .center, .trailing])
        XCTAssertEqual(t.rows.count, 2)
        XCTAssertEqual(t.rows[1].map(plain), ["permission flow", "✘", "✔"], "inline markdown is parsed, ** removed")
    }

    func testWithoutOuterPipesAndSurroundingText() throws {
        let blocks = Markdown.parse("""
        Here are the results:

        Name | Value
        --- | ---
        a | 1
        b | 2

        Done.
        """)
        XCTAssertEqual(blocks.count, 3)
        guard case .table(let t) = blocks[1] else { return XCTFail("expected a table, got \(blocks[1])") }
        XCTAssertEqual(t.header.map(plain), ["Name", "Value"])
        XCTAssertEqual(t.rows.map { $0.map(plain) }, [["a", "1"], ["b", "2"]])
    }

    func testEscapedPipesCodeAndRaggedRows() throws {
        let t = try table("""
        | Command | Meaning |
        |---|---|
        | `a | b` | pipe in code |
        | x \\| y | escaped |
        | only one |
        | 1 | 2 | 3 |
        """)
        XCTAssertEqual(t.rows[0].map(plain), ["a | b", "pipe in code"])
        XCTAssertEqual(t.rows[1].map(plain), ["x | y", "escaped"])
        XCTAssertEqual(t.rows[2].map(plain), ["only one", ""], "short rows are padded")
        XCTAssertEqual(t.rows[3].map(plain), ["1", "2"], "long rows are cut to the header")
    }

    func testTableRightAfterAParagraphLine() throws {
        // No blank line between the intro and the table (common in agent output).
        let blocks = Markdown.parse("Summary:\n| a | b |\n|---|---|\n| 1 | 2 |")
        XCTAssertTrue(blocks.contains { if case .table = $0 { true } else { false } })
    }

    func testPipesWithoutDelimiterStayMonospaced() {
        let blocks = Markdown.parse("| not | a table |\n| just | pipes |")
        XCTAssertFalse(blocks.contains { if case .table = $0 { true } else { false } })
    }
}
