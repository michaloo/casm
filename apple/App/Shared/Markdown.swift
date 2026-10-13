import Foundation
import SwiftUI

/// Block-level markdown, split by hand so SwiftUI `Text` only has to render inline markdown.
/// Code fences and tables become monospaced blocks; everything else is inline-parsed text.
enum MarkdownBlock: Hashable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case code(language: String?, String)
    case quote(AttributedString)
    case rule
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

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [Substring] = []
        var fence: (marker: Substring, language: String?, lines: [Substring])?
        var table: [Substring] = []
        var quote: [Substring] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(inline(paragraph.map(bullet).joined(separator: "\n"))))
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

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
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
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let marker = trimmed.prefix(while: { $0 == trimmed.first })
                let language = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
                fence = (marker, language.isEmpty ? nil : language, [])
            } else if trimmed.isEmpty {
                flushAll()
            } else if trimmed.hasPrefix("|") {
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

    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
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
    private static func bullet(_ line: Substring) -> String {
        let indent = line.prefix(while: { $0 == " " })
        let rest = line.dropFirst(indent.count)
        if rest.hasPrefix("- ") || rest.hasPrefix("* ") || rest.hasPrefix("+ ") {
            return indent + "• " + rest.dropFirst(2)
        }
        return String(line)
    }
}

struct MarkdownView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    Text(text)
                case .heading(let level, let text):
                    Text(text).font(level == 1 ? .title2 : level == 2 ? .title3 : .headline).bold()
                case .code(let language, let code):
                    CodeBlock(language: language, code: code)
                case .quote(let text):
                    Text(text)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 3) }
                case .rule:
                    Divider()
                }
            }
        }
        .modifier(Selectable())
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
    static func int(_ key: String) -> Int? { ProcessInfo.processInfo.environment[key].flatMap(Int.init) }
    #else
    static func int(_ key: String) -> Int? { nil }
    static let noSelect = false, noCodeScroll = false, noGeo = false, list = false, noWindow = false
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
                Text(language).font(.caption2).foregroundStyle(.secondary)
            }
            if Exp.noCodeScroll {
                Text(code).font(.system(.callout, design: .monospaced))
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(.system(.callout, design: .monospaced))
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}
