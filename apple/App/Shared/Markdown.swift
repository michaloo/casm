import Foundation
import SwiftUI

/// Block-level markdown, split by hand so SwiftUI `Text` only has to render inline markdown.
/// Code fences become monospaced blocks, GFM tables become grids; everything else is inline-parsed text.
enum MarkdownBlock: Hashable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case code(language: String?, String)
    case quote(AttributedString)
    case rule
    case table(MarkdownTable)
    /// Consecutive list items; wrapped lines hang under the text, not the marker.
    case list([MarkdownListItem])
}

struct MarkdownListItem: Hashable {
    /// "•" or "3."
    var marker: String
    var text: AttributedString
    var level: Int
}

/// A GitHub-flavoured markdown table; every row has as many cells as the header.
struct MarkdownTable: Hashable {
    enum Alignment: Hashable { case leading, center, trailing }
    var header: [AttributedString]
    var alignments: [Alignment]
    var rows: [[AttributedString]]
}

enum Markdown {
    @MainActor private static let cache = NSCache<NSString, Box>()

    private final class Box {
        let blocks: [MarkdownBlock]
        init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
    }

    /// Parsed blocks, cached by item id and text so scrolling doesn't re-parse.
    @MainActor static func blocks(for text: String, id: String) -> [MarkdownBlock] {
        let key = "\(id)#\(text.count)#\(text.hashValue)" as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = parse(text)
        cache.setObject(Box(blocks), forKey: key)
        return blocks
    }

    /// `$$ … $$` or `\[ … \]` on one line: the formula inside.
    static func displayMath(_ line: Substring) -> String? {
        let t = line.trimmingCharacters(in: .whitespaces)
        for (open, close) in [("$$", "$$"), ("\\[", "\\]")] where t.count > open.count + close.count && t.hasPrefix(open) && t.hasSuffix(close) {
            let inner = t.dropFirst(open.count).dropLast(close.count).trimmingCharacters(in: .whitespaces)
            return inner.isEmpty ? nil : inner
        }
        return nil
    }

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [Substring] = []
        var fence: (marker: Substring, language: String?, lines: [Substring])?
        var table: [Substring] = []
        var quote: [Substring] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            // Split into runs of plain lines and list items (continuation lines join their item).
            var lines: [String] = []
            var items: [MarkdownListItem] = []
            var itemText: [String] = []
            func flushItem() {
                guard var last = items.popLast() else { return }
                last.text = inline(itemText.joined(separator: " "))
                items.append(last)
                itemText = []
            }
            func flushLines() {
                if !lines.isEmpty { blocks.append(.paragraph(inline(lines.joined(separator: "\n")))); lines = [] }
            }
            func flushList() {
                flushItem()
                if !items.isEmpty { blocks.append(.list(items)); items = [] }
            }
            for line in paragraph {
                if let (marker, rest, level) = listItem(line) {
                    flushLines()
                    flushItem()
                    items.append(MarkdownListItem(marker: marker, text: AttributedString(), level: level))
                    itemText = [rest]
                } else if !items.isEmpty && line.first == " " {
                    itemText.append(line.trimmingCharacters(in: .whitespaces))
                } else {
                    flushList()
                    lines.append(String(line))
                }
            }
            flushList()
            flushLines()
            paragraph = []
        }
        func flushTable() {
            guard !table.isEmpty else { return }
            blocks.append(.code(language: "table", table.joined(separator: "\n")))
            table = []
        }
        func flushQuote() {
            guard !quote.isEmpty else { return }
            blocks.append(.quote(inline(quote.joined(separator: "\n"))))
            quote = []
        }
        func flushAll() { flushParagraph(); flushTable(); flushQuote() }

        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var index = 0
        while index < lines.count {
            let line = lines[index]
            index += 1
            let trimmed = line.drop(while: { $0 == " " })
            if var open = fence {
                if trimmed.hasPrefix(open.marker) && trimmed.allSatisfy({ $0 == open.marker.first }) {
                    blocks.append(.code(language: open.language, open.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    open.lines.append(line)
                    fence = open
                }
                continue
            }
            if let math = displayMath(trimmed) {
                // No native LaTeX renderer: display math reads best as source in a code block.
                flushAll()
                blocks.append(.code(language: "math", math))
            } else if trimmed.trimmingCharacters(in: .whitespaces) == "$$" {
                flushAll()
                fence = ("$$", "math", [])
            } else if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let marker = trimmed.prefix(while: { $0 == trimmed.first })
                let language = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
                fence = (marker, language.isEmpty ? nil : language, [])
            } else if trimmed.isEmpty {
                flushAll()
            } else if trimmed.contains("|"), index < lines.count, let alignments = delimiterRow(lines[index]) {
                // A header row followed by |---|:--:| starts a table; it runs while lines have pipes.
                flushAll()
                index += 1
                var rows: [[AttributedString]] = []
                while index < lines.count, lines[index].contains("|"),
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(cells(lines[index]).map(inline))
                    index += 1
                }
                let header = cells(line).map(inline)
                let width = header.count
                func fit(_ row: [AttributedString]) -> [AttributedString] {
                    Array((row + Array(repeating: AttributedString(), count: max(0, width - row.count))).prefix(width))
                }
                let aligns = Array((alignments + Array(repeating: MarkdownTable.Alignment.leading, count: max(0, width - alignments.count))).prefix(width))
                blocks.append(.table(MarkdownTable(header: header, alignments: aligns, rows: rows.map(fit))))
            } else if trimmed.hasPrefix("|") {
                // Pipe lines without a delimiter row (ASCII art, broken tables): keep them monospaced.
                flushParagraph(); flushQuote()
                table.append(trimmed)
            } else if trimmed.hasPrefix(">") {
                flushParagraph(); flushTable()
                quote.append(trimmed.dropFirst().drop(while: { $0 == " " }))
            } else if let level = headingLevel(trimmed) {
                flushAll()
                blocks.append(.heading(level: level, inline(String(trimmed.dropFirst(level).drop(while: { $0 == " " })))))
            } else if isRule(trimmed) {
                flushAll()
                blocks.append(.rule)
            } else {
                flushTable(); flushQuote()
                paragraph.append(line)
            }
        }
        if let open = fence { blocks.append(.code(language: open.language, open.lines.joined(separator: "\n"))) }
        flushAll()
        return blocks
    }

    /// `| :--- | :---: | ---: |` → alignments, or nil if the line isn't a delimiter row.
    static func delimiterRow(_ line: Substring) -> [MarkdownTable.Alignment]? {
        let parts = cells(line)
        guard !parts.isEmpty else { return nil }
        var out: [MarkdownTable.Alignment] = []
        for part in parts {
            let p = part.trimmingCharacters(in: .whitespaces)
            let dashes = p.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            switch (p.hasPrefix(":"), p.hasSuffix(":")) {
            case (true, true): out.append(.center)
            case (false, true): out.append(.trailing)
            default: out.append(.leading)
            }
        }
        return out
    }

    /// Splits a table row on unescaped pipes outside `code`, dropping the outer pipes.
    static func cells(_ line: Substring) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|") && !row.hasSuffix("\\|") { row.removeLast() }
        var cells: [String] = []
        var current = ""
        var inCode = false
        var escaped = false
        for ch in row {
            if escaped {
                current.append(ch == "|" ? "|" : "\\\(ch)")
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "`" {
                inCode.toggle()
                current.append(ch)
            } else if ch == "|" && !inCode {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(ch)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        var result = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        // Inline `code`: monospaced on a tinted run, like Paseo's surface2 chip.
        for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
            result[run.range].backgroundColor = Theme.surface2
        }
        return result
    }

    private static func headingLevel(_ line: Substring) -> Int? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }

    private static func isRule(_ line: Substring) -> Bool {
        let chars = line.filter { $0 != " " }
        return chars.count >= 3 && (chars.allSatisfy { $0 == "-" } || chars.allSatisfy { $0 == "*" } || chars.allSatisfy { $0 == "_" })
    }

    /// `- item` / `* item` → `• item`, keeping the indentation.
    /// "- x" / "* x" / "+ x" → ("•", "x"); "3. x" / "3) x" → ("3.", "x"). Level from indentation.
    static func listItem(_ line: Substring) -> (String, String, Int)? {
        let indent = line.prefix(while: { $0 == " " }).count
        let rest = line.dropFirst(indent)
        let level = indent / 2
        if rest.hasPrefix("- ") || rest.hasPrefix("* ") || rest.hasPrefix("+ ") {
            if rest.hasPrefix("- [ ] ") { return ("☐", String(rest.dropFirst(6)), level) }
            if rest.hasPrefix("- [x] ") || rest.hasPrefix("- [X] ") { return ("☑", String(rest.dropFirst(6)), level) }
            return ("•", String(rest.dropFirst(2)), level)
        }
        let digits = rest.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 3 {
            let after = rest.dropFirst(digits.count)
            if after.hasPrefix(". ") || after.hasPrefix(") ") {
                return ("\(digits).", String(after.dropFirst(2)), level)
            }
        }
        return nil
    }
}

struct MarkdownView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.paragraphGap) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                switch block {
                case .paragraph(let text):
                    Text(text).lineSpacing(Theme.proseLineSpacing)
                case .list(let items):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(item.marker)
                                    .foregroundStyle(Theme.muted)
                                    .monospacedDigit()
                                    .frame(minWidth: 14, alignment: .trailing)
                                Text(item.text).lineSpacing(Theme.proseLineSpacing)
                            }
                            .padding(.leading, CGFloat(item.level) * 18)
                        }
                    }
                case .heading(let level, let text):
                    Text(text)
                        .font(.system(size: Theme.headingSize(level), weight: .semibold))
                        .padding(.top, i == 0 ? 0 : 6)
                case .code(let language, let code):
                    CodeBlock(language: language, code: code)
                case .quote(let text):
                    Text(text)
                        .lineSpacing(Theme.proseLineSpacing)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface1)
                        .overlay(alignment: .leading) { Rectangle().fill(Theme.surface2).frame(width: 4) }
                case .rule:
                    Divider()
                case .table(let table):
                    MarkdownTableView(table: table)
                }
            }
        }
        .font(.system(size: Theme.proseSize))
        .modifier(Selectable())
    }
}

struct MarkdownTableView: View {
    let table: MarkdownTable

    var body: some View {
        let columns = table.header.count
        let rows = [table.header] + table.rows
        TableLayout(columns: columns, minColumnWidth: 64) {
            ForEach(rows.indices, id: \.self) { r in
                ForEach(0..<columns, id: \.self) { c in
                    cell(rows[r][c], column: c, header: r == 0, last: r == rows.count - 1)
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.25)))
    }

    private func cell(_ text: AttributedString, column: Int, header: Bool, last: Bool) -> some View {
        let alignment = table.alignments[column]
        let horizontal: HorizontalAlignment = alignment == .center ? .center : alignment == .trailing ? .trailing : .leading
        return Text(text)
            .font(.system(size: 14))
            .fontWeight(header ? .semibold : nil)
            .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: Alignment(horizontal: horizontal, vertical: .top))
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Color.secondary.opacity(header ? 0.35 : 0.18)).frame(height: 1) }
            }
    }
}

/// Lays out cells (row-major, `columns` per row) like an HTML table: columns get their natural
/// width when everything fits; otherwise narrow columns keep theirs and the wide ones share the
/// rest and wrap.
/// Rows are as tall as their tallest cell.
struct TableLayout: Layout {
    let columns: Int
    let minColumnWidth: CGFloat

    struct Cache {
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    private func rows(_ subviews: Subviews) -> Int { columns == 0 ? 0 : (subviews.count + columns - 1) / columns }

    private func columnWidths(_ subviews: Subviews, available: CGFloat?) -> [CGFloat] {
        var ideal = Array(repeating: CGFloat(0), count: columns)
        for (i, view) in subviews.enumerated() {
            ideal[i % columns] = max(ideal[i % columns], ceil(view.sizeThatFits(.unspecified).width))
        }
        guard let available, ideal.reduce(0, +) > available else { return ideal }
        // Narrow columns that fit in an equal share keep their natural width; the wide ones split
        // what's left (never below minColumnWidth, so very tight tables may still overflow).
        var widths = ideal
        var remaining = available
        var open = Array(ideal.indices)
        for index in ideal.indices.sorted(by: { ideal[$0] < ideal[$1] }) {
            let share = remaining / CGFloat(open.count)
            let width = ideal[index] <= share ? ideal[index] : max(minColumnWidth, floor(share))
            widths[index] = min(ideal[index], width)
            remaining -= widths[index]
            open.removeAll { $0 == index }
        }
        return widths
    }

    private func rowHeights(_ subviews: Subviews, widths: [CGFloat]) -> [CGFloat] {
        var heights = Array(repeating: CGFloat(0), count: rows(subviews))
        for (i, view) in subviews.enumerated() {
            let h = view.sizeThatFits(ProposedViewSize(width: widths[i % columns], height: nil)).height
            heights[i / columns] = max(heights[i / columns], ceil(h))
        }
        return heights
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        guard columns > 0 else { return .zero }
        cache.widths = columnWidths(subviews, available: proposal.width)
        cache.heights = rowHeights(subviews, widths: cache.widths)
        return CGSize(width: cache.widths.reduce(0, +), height: cache.heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        guard columns > 0 else { return }
        if cache.widths.count != columns {
            cache.widths = columnWidths(subviews, available: bounds.width)
            cache.heights = rowHeights(subviews, widths: cache.widths)
        }
        var y = bounds.minY
        for row in 0..<rows(subviews) {
            var x = bounds.minX
            for column in 0..<columns {
                let index = row * columns + column
                guard index < subviews.count else { break }
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                      proposal: ProposedViewSize(width: cache.widths[column], height: cache.heights[row]))
                x += cache.widths[column]
            }
            y += cache.heights[row]
        }
    }
}

/// Rendering experiments for the scroll spike (DEBUG only): `CASM_EXP=noselect,nocodescroll,nogeo`.
enum Exp {
    #if DEBUG
    private static let flags = Set((ProcessInfo.processInfo.environment["CASM_EXP"] ?? "").split(separator: ",").map(String.init))
    static let noSelect = flags.contains("noselect")
    static let noCodeScroll = flags.contains("nocodescroll")
    static let noGeo = flags.contains("nogeo")
    static let list = flags.contains("list")
    static let noWindow = flags.contains("nowindow")
    static let noAnchor = flags.contains("noanchor")
    static let noPosition = flags.contains("noposition")
    static func int(_ key: String) -> Int? { ProcessInfo.processInfo.environment[key].flatMap(Int.init) }
    #else
    static func int(_ key: String) -> Int? { nil }
    static let noSelect = false, noCodeScroll = false, noGeo = false, list = false, noWindow = false
    static let noAnchor = false, noPosition = false
    #endif
}

extension EnvironmentValues {
    /// Whether transcript text is selectable right now. Text selection is the most expensive part
    /// of laying out a row while scrolling, so on macOS it is turned on only for the row under the
    /// pointer once scrolling has stopped (see `HoverSelectable`).
    @Entry var transcriptSelectable = true
}

struct Selectable: ViewModifier {
    @Environment(\.transcriptSelectable) private var selectable

    func body(content: Content) -> some View {
        if selectable && !Exp.noSelect { content.textSelection(.enabled) } else { content }
    }
}

/// Makes a transcript row's text selectable while the pointer rests on it (macOS).
struct HoverSelectable: ViewModifier {
    let scrolling: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .onHover { hovering = $0 }
            .environment(\.transcriptSelectable, hovering && !scrolling)
        #else
        content
        #endif
    }
}

struct CodeBlock: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let language, language != "table" {
                Text(language).font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
            if Exp.noCodeScroll {
                Text(code).font(.system(size: Theme.codeSize, design: .monospaced)).lineSpacing(5)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(.system(size: Theme.codeSize, design: .monospaced))
                        .lineSpacing(5)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.border))
    }
}
