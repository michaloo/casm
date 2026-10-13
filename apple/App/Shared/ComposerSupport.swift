import CasmKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Images

/// An image waiting in the composer, already encoded for `agent.send`.
struct Attachment: Identifiable, Equatable {
    let id = UUID()
    let image: ImageData
}

enum ImageEncoding {
    /// Downscales to `maxPixel` on the long side and encodes as JPEG, or PNG when the image has
    /// transparency (screenshots of UI often do). Returns nil for data that isn't an image.
    static func encode(_ data: Data, maxPixel: Int = 2048) -> ImageData? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        let opaque = [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
        let type = opaque ? UTType.jpeg : UTType.png
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
        let properties = opaque ? [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary : nil
        CGImageDestinationAddImage(destination, image, properties)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return ImageData(mediaType: type.preferredMIMEType ?? "image/png", data: (out as Data).base64EncodedString())
    }

    /// Images from a drop or paste: image data directly, or image files by URL.
    static func load(from providers: [NSItemProvider]) async -> [ImageData] {
        var images: [ImageData] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
               let url = await loadURL(provider), let type = UTType(filenameExtension: url.pathExtension),
               type.conforms(to: .image), let data = try? Data(contentsOf: url), let image = encode(data) {
                images.append(image)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
                      let data = await loadData(provider, type: .image), let image = encode(data) {
                images.append(image)
            }
        }
        return images
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { cont in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in cont.resume(returning: url) }
        }
    }

    private static func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
        await withCheckedContinuation { cont in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in cont.resume(returning: data) }
        }
    }
}

struct AttachmentStrip: View {
    let attachments: [Attachment]
    let remove: (Attachment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    ImageThumbnail(image: attachment.image, size: 56)
                        .overlay(alignment: .topTrailing) {
                            Button("Remove image", systemImage: "xmark.circle.fill") { remove(attachment) }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.plain)
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                                .padding(3)
                        }
                }
            }
        }
    }
}

// MARK: - Completion

/// What the word at the caret is asking for: a "/command" at the start of the message, or an
/// "@path" mention anywhere.
struct CompletionContext: Equatable {
    enum Kind { case command, mention }
    let kind: Kind
    let query: String
    /// The text to replace when a suggestion is accepted (the "/…" or "@…" token up to the caret).
    let range: Range<String.Index>

    static func at(_ caret: String.Index, in text: String) -> CompletionContext? {
        guard caret <= text.endIndex else { return nil }
        let head = text[..<caret]
        let wordStart = head.lastIndex(where: { $0.isWhitespace }).map { text.index(after: $0) } ?? text.startIndex
        let word = text[wordStart..<caret]
        if word.hasPrefix("/"), wordStart == text.startIndex {
            return CompletionContext(kind: .command, query: String(word.dropFirst()), range: wordStart..<caret)
        }
        if word.hasPrefix("@") {
            return CompletionContext(kind: .mention, query: String(word.dropFirst()), range: wordStart..<caret)
        }
        return nil
    }
}

struct Suggestion: Identifiable, Equatable {
    let id: String
    let icon: String
    let title: String
    var detail: String?
    var badge: String?
    /// Replaces the context's range.
    let insert: String

    static func commands(_ commands: [SlashCommand], matching query: String) -> [Suggestion] {
        let q = query.lowercased()
        let prefix = commands.filter { $0.name.lowercased().hasPrefix(q) }
        let rest = q.isEmpty ? [] : commands.filter { !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q) }
        return (prefix + rest).map { c in
            Suggestion(id: "cmd:\(c.name)", icon: c.kind == .skill ? "sparkles" : "slash.circle",
                       title: "/\(c.name)" + (c.argumentHint.map { " \($0)" } ?? ""),
                       detail: c.description, badge: c.kind == .skill ? "Skill" : nil, insert: "/\(c.name) ")
        }
    }

    static func files(_ entries: [FileEntry]) -> [Suggestion] {
        entries.map { e in
            Suggestion(id: "file:\(e.path)", icon: e.kind == .dir ? "folder" : "doc",
                       title: e.path, insert: "@\(e.path)" + (e.kind == .dir ? "/" : " "))
        }
    }
}

struct SuggestionList: View {
    let suggestions: [Suggestion]
    let highlighted: Int
    let choose: (Suggestion) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(suggestions.enumerated()), id: \.element.id) { i, s in
                        Button { choose(s) } label: {
                            SuggestionRow(suggestion: s, highlighted: i == highlighted)
                        }
                        .buttonStyle(.plain)
                        .id(s.id)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            // As tall as its rows, up to 260 pt.
            .frame(maxHeight: 260)
            .fixedSize(horizontal: false, vertical: true)
            .onChange(of: highlighted) {
                if suggestions.indices.contains(highlighted) { proxy.scrollTo(suggestions[highlighted].id) }
            }
        }
    }
}

struct SuggestionRow: View {
    let suggestion: Suggestion
    let highlighted: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: suggestion.icon).foregroundStyle(.secondary).frame(width: 16)
            Text(suggestion.title).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
            if let badge = suggestion.badge {
                Text(badge).font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(.purple.opacity(0.15), in: Capsule())
                    .foregroundStyle(.purple)
            }
            if let detail = suggestion.detail {
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(highlighted ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
    }
}

// MARK: - Context ring

/// How full the agent's context is, like Paseo's ring; details in the tooltip (or a tap on iOS).
struct ContextRing: View {
    let usage: Usage?
    @State private var showDetails = false

    var body: some View {
        if let usage, usage.contextTokens != nil || usage.costUsd != nil {
            Button { showDetails.toggle() } label: {
                // M4: a filled pie on a tinted disc, so it doesn't read as a spinner; the percentage
                // shows once the context is half full.
                HStack(spacing: 4) {
                    ZStack {
                        Circle().fill(Color.secondary.opacity(0.18))
                        PieSlice(fraction: fraction).fill(color)
                        Circle().strokeBorder(Color.secondary.opacity(0.35), lineWidth: 0.5)
                    }
                    .frame(width: 13, height: 13)
                    if fraction >= 0.5 {
                        Text("\(Int((fraction * 100).rounded()))%")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(color)
                    }
                }
                .padding(2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(details)
            .accessibilityLabel("Context: \(details)")
            .popover(isPresented: $showDetails) {
                Text(details).font(.callout).padding(12).presentationCompactAdaptation(.popover)
            }
        }
    }

    private var fraction: CGFloat {
        guard let used = usage?.contextTokens, let window = usage?.contextWindow, window > 0 else { return 0 }
        return min(1, used / window)
    }

    private var color: Color {
        fraction < 0.7 ? .secondary : fraction < 0.9 ? .orange : .red
    }

    var details: String {
        guard let usage else { return "" }
        var lines: [String] = []
        if let used = usage.contextTokens {
            if let window = usage.contextWindow, window > 0 {
                lines.append("\(Int(used).formatted()) / \(Int(window).formatted()) tokens (\(Int((used / window * 100).rounded()))%)")
            } else {
                lines.append("\(Int(used).formatted()) tokens in context")
            }
        }
        if let cost = usage.costUsd { lines.append("Cost \(cost.formatted(.currency(code: "USD").precision(.fractionLength(2...4))))") }
        if let model = usage.model { lines.append("Model \(model)") }
        return lines.joined(separator: "\n")
    }
}

/// A pie sector from 12 o'clock, clockwise.
struct PieSlice: Shape {
    var fraction: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard fraction > 0 else { return path }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: center)
        path.addArc(center: center, radius: min(rect.width, rect.height) / 2,
                    startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * Double(min(1, fraction))), clockwise: false)
        path.closeSubpath()
        return path
    }
}
