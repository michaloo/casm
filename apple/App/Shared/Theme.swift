import CasmKit
import SwiftUI

/// Chat styling, matched to Paseo's chat (packages/app/src/styles/theme.ts and markdown-styles.ts):
/// 15/21 prose, 12 pt paragraph gaps, an 820 pt column, neutral surfaces.
enum Theme {
    // MARK: Type
    static let proseSize: CGFloat = 15
    /// Extra space between lines so 15 pt prose has a 21 pt line height.
    static let proseLineSpacing: CGFloat = 3
    static let codeSize: CGFloat = 12
    static let toolSize: CGFloat = 14
    static let metaSize: CGFloat = 13
    static func headingSize(_ level: Int) -> CGFloat {
        switch level {
        // Chat-sized: a clear step above 15 pt prose without shouting.
        case 1: 21
        case 2: 18
        case 3: 16
        default: 15
        }
    }

    // MARK: Layout
    static let columnWidth: CGFloat = 820
    static let sideMargin: CGFloat = 24
    static let paragraphGap: CGFloat = 12

    // MARK: Colours (light, dark)
    static let surface1 = adaptive(light: 0xFAFAFA, dark: 0x1E2120)
    static let surface2 = adaptive(light: 0xF4F4F5, dark: 0x272A29)
    static let surface3 = adaptive(light: 0xE4E4E7, dark: 0x434645)
    static let border = adaptive(light: 0xE4E4E7, dark: 0x252B2A)
    static let borderAccent = adaptive(light: 0xECECF1, dark: 0x2F3534)
    static let muted = adaptive(light: 0x71717A, dark: 0xA1A5A4)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? ns(dark) : ns(light)
        })
        #else
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
        #endif
    }

    #if os(macOS)
    private static func ns(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    #else
    private static func ui(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    #endif
}

extension Item {
    /// Space above this item given the one before it (Paseo's agent-stream/spacing.ts): related
    /// blocks of one reply sit close, a new user turn gets room.
    func gap(after previous: Item?) -> CGFloat {
        guard let previous else { return 0 }
        switch (previous, self) {
        case (.user, .user): return 4
        case (.user, _): return 16
        case (_, .user): return 24
        case (.tool, .tool), (.reasoning, .tool), (.tool, .reasoning), (.subagent, .tool), (.tool, .subagent): return 2
        // Prose around tool rows gets Paseo's 12 pt block padding.
        case (.tool, .assistant), (.subagent, .assistant): return 12
        case (.assistant, .tool), (.assistant, .subagent): return 8
        case (.assistant, .assistant): return 12
        default: return 14
        }
    }
}
