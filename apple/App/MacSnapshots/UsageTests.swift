import CasmKit
import SwiftUI
import XCTest

@MainActor
final class UsageTests: XCTestCase {
    func window(_ json: [String: Any]) throws -> LimitWindow {
        try JSONDecoder().decode(LimitWindow.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testLevelsAndSummary() throws {
        let five = try window(["id": "codex:primary", "label": "5-hour", "usedPercent": 100, "windowMinutes": 300, "status": "exhausted"])
        let week = try window(["id": "codex:secondary", "label": "weekly", "usedPercent": 31, "windowMinutes": 10080, "status": "exhausted"])
        let claude = try window(["id": "five_hour", "label": "5-hour", "status": "ok"])
        XCTAssertEqual(five.shortLabel, "5h")
        XCTAssertEqual(week.shortLabel, "Week")
        XCTAssertEqual(five.level, .exhausted)
        // A reported percentage wins over the provider-wide status.
        XCTAssertEqual(week.level, .ok)
        XCTAssertEqual(claude.level, .ok)
        let limits = ProviderLimits(provider: .codex, plan: "plus", windows: [five, week], updatedAt: "2026-10-14T00:00:00Z")
        XCTAssertEqual(limits.summary, "5-hour 100% · weekly 31%")
        XCTAssertEqual(limits.worst, .exhausted)
    }

    func testDetailsSnapshot() throws {
        let codex = ProviderLimits(provider: .codex, plan: "plus", windows: [
            try window(["id": "p", "label": "5-hour", "usedPercent": 84, "windowMinutes": 300, "resetsAt": "2026-10-14T03:30:00Z"]),
            try window(["id": "s", "label": "weekly", "usedPercent": 31, "windowMinutes": 10080, "resetsAt": "2026-10-20T13:31:28Z"]),
        ], updatedAt: ISO8601DateFormatter().string(from: .now.addingTimeInterval(-300)))
        let claude = ProviderLimits(provider: .claude, windows: [
            try window(["id": "five_hour", "label": "5-hour", "status": "ok", "resetsAt": "2026-10-14T02:30:00Z"]),
        ], updatedAt: ISO8601DateFormatter().string(from: .now.addingTimeInterval(-60)))
        for dark in [false, true] {
            let view = VStack(alignment: .leading, spacing: 0) {
                ProviderUsage(limits: claude).padding(14)
                ProviderUsage(limits: codex).padding(14)
            }
            .frame(width: 320, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(renderer.nsImage?.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: "/tmp/casm-shots/snap-usage-\(dark ? "dark" : "light").png"))
        }
    }
}
