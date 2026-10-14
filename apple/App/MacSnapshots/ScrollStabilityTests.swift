import CasmKit
import XCTest

/// What keeps the transcript still while someone reads above a turn that is still streaming.
@MainActor
final class ScrollStabilityTests: XCTestCase {
    private func spot(_ offset: CGFloat, _ height: CGFloat, atBottom: Bool = false) -> ScrollSpot {
        ScrollSpot(offset: offset, height: height, atBottom: atBottom)
    }

    func testReaderScrollDecidesFollowing() {
        // Scrolling up with the content unchanged unpins; back at the bottom pins again.
        XCTAssertFalse(ScrollSpot.pinned(true, from: spot(1000, 2000, atBottom: true), to: spot(900, 2000)))
        XCTAssertTrue(ScrollSpot.pinned(false, from: spot(900, 2000), to: spot(1000, 2000, atBottom: true)))
        // A wheel step up in the same frame as streamed text grows the content still unpins.
        XCTAssertFalse(ScrollSpot.pinned(true, from: spot(1000, 2000, atBottom: true), to: spot(960, 2040)))
    }

    func testContentChangesAloneKeepFollowingAsItWas() {
        // Growth while pinned (the bottom anchor raises the offset) keeps following...
        XCTAssertTrue(ScrollSpot.pinned(true, from: spot(1000, 2000, atBottom: true), to: spot(1040, 2040)))
        // ...even if the end is briefly more than the threshold away.
        XCTAssertTrue(ScrollSpot.pinned(true, from: spot(1000, 2000, atBottom: true), to: spot(1000, 2400)))
        // Growth below someone reading (top anchor: offset unchanged) doesn't pin them.
        XCTAssertFalse(ScrollSpot.pinned(false, from: spot(400, 2000), to: spot(400, 2400)))
        // Shrinking clamps the offset; that is not the reader scrolling.
        XCTAssertTrue(ScrollSpot.pinned(true, from: spot(1000, 2000, atBottom: true), to: spot(900, 1900)))
        XCTAssertFalse(ScrollSpot.pinned(false, from: spot(1000, 2000), to: spot(900, 1900, atBottom: true)))
    }

    private func items(_ ids: [String]) -> [Item] { ids.map { .assistant(id: $0, text: $0) } }

    func testWindowKeepsTheFirstRenderedRow() {
        let old = items((0..<200).map { "i\($0)" })
        // Reading from row 100 (100 rows shown); history merged after the turn adds a row above it.
        var merged = old.map(\.id)
        merged.insert("interrupt", at: 150)
        let new = items(merged)
        XCTAssertEqual(ChatModel.windowStart(old: old, start: 100, new: new), 100, "row i100 stays first")
        // Rows appended below keep the same start.
        XCTAssertEqual(ChatModel.windowStart(old: old, start: 100, new: items(old.map(\.id) + ["n1", "n2"])), 100)
    }

    func testWindowStaysAnchoredToTheEnd() {
        // An older page prepended: the same newest rows stay rendered.
        let old = items((100..<200).map { "i\($0)" })
        let new = items((0..<200).map { "i\($0)" })
        XCTAssertEqual(ChatModel.windowStart(old: old, start: 40, new: new), 140)
        // First open: a few live rows, then the history page; the window shows the newest rows.
        let live = items(["live1", "live2"])
        let page = items((0..<100).map { "h\($0)" } + ["live1", "live2"])
        XCTAssertEqual(ChatModel.windowStart(old: live, start: 0, new: page), page.count - ChatModel.window)
        // The first row went away (the local first message replaced by the agent's copy).
        XCTAssertEqual(ChatModel.windowStart(old: items(["local"]), start: 0, new: items(["u1"])), 0)
    }
}
