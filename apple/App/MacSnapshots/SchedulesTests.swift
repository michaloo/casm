import CasmKit
import SwiftUI
import XCTest

@MainActor
final class SchedulesTests: XCTestCase {
    func testCadenceSummaries() {
        XCTAssertEqual(ScheduleCadence.every(minutes: 15).summary, "Every 15 min")
        XCTAssertEqual(ScheduleCadence.every(minutes: 60).summary, "Hourly")
        XCTAssertEqual(ScheduleCadence.every(minutes: 120).summary, "Every 2 h")
        XCTAssertEqual(ScheduleCadence.cron("30 9 * * 1-5").summary, "Weekdays at 09:30")
        XCTAssertEqual(ScheduleCadence.cron("0 18 * * *").summary, "Daily at 18:00")
        XCTAssertEqual(ScheduleCadence.cron("*/5 * * * 0").summary, "Cron */5 * * * 0")
        XCTAssertTrue(ScheduleCadence.once(at: "2026-10-14T16:30:00Z").summary.hasPrefix("Once · "))
        XCTAssertEqual(CronPreset.daily(hour: 7, minute: 5), "5 7 * * *")
        XCTAssertNil(CronPreset.parse("0 9 1 * *"))
    }

    func schedule(_ name: String, _ cadence: ScheduleCadence, enabled: Bool = true, last: String? = nil) throws -> Schedule {
        var json: [String: Any] = ["id": name, "name": name, "enabled": enabled, "prompt": "Any new failing tests? Summarise and propose fixes.",
                                   "nextRunAt": "2026-10-14T07:00:00Z", "createdAt": "2026-10-13T10:00:00Z",
                                   "target": ["type": "agent", "agentId": "a1", "whenBusy": "skip"]]
        json["cadence"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(cadence))
        json["lastRun"] = last.map { ["at": "2026-10-13T18:00:00Z", "outcome": $0] } ?? NSNull()
        return try JSONDecoder().decode(Schedule.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testRowsSnapshot() throws {
        let host = HostModel(entry: HostEntry(name: "macbook", url: URL(string: "ws://127.0.0.1:1")!), token: "")
        let rows = [try schedule("Standup", .cron("0 9 * * 1-5"), last: "sent"),
                    try schedule("Test sweep", .every(minutes: 30), last: "skipped"),
                    try schedule("Paused", .every(minutes: 60), enabled: false, last: "failed")]
        let pending = [PendingMessage(id: "1", agentId: "a", text: "Then summarise what you counted in one sentence.", reason: .queued, createdAt: ""),
                       PendingMessage(id: "2", agentId: "a", text: "Retry the build", reason: .limit, notBefore: "2026-10-13T23:30:00Z", createdAt: "")]
        for dark in [false, true] {
            let view = VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(rows) { ScheduleRow(host: host, schedule: $0, edit: {}) }
                }
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(pending) { PendingRow(message: $0, sendNow: {}, cancel: {}) }
                }
            }
            .environment(AppModel())
            .padding(16)
            .frame(width: 640, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(renderer.nsImage?.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: "/tmp/casm-shots/snap-schedules-\(dark ? "dark" : "light").png"))
        }
    }
}
