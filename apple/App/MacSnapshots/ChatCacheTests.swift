import XCTest

@MainActor
final class ChatCacheTests: XCTestCase {
    func testLeastRecentlyUsedFallsOut() {
        var cache = ChatCache<String, Int>(capacity: 3)
        XCTAssertEqual(cache.insert(1, for: "a"), [])
        cache.insert(2, for: "b")
        cache.insert(3, for: "c")
        XCTAssertEqual(cache.take("a"), 1, "going back to a chat makes it the newest")
        XCTAssertEqual(cache.insert(4, for: "d"), [2], "b was used least recently")
        XCTAssertEqual(cache.keys, ["c", "a", "d"])
        XCTAssertNil(cache.take("b"))
        XCTAssertEqual(cache.keys, ["c", "a", "d"], "a miss changes nothing")
    }

    func testInsertingAgainReplaces() {
        var cache = ChatCache<String, Int>(capacity: 2)
        cache.insert(1, for: "a")
        cache.insert(2, for: "b")
        XCTAssertEqual(cache.insert(10, for: "a"), [1], "the old value is handed back to close")
        XCTAssertEqual(cache.keys, ["b", "a"])
        XCTAssertEqual(cache.take("a"), 10)
    }

    func testRemoveAllHandsBackEvicted() {
        var cache = ChatCache<String, Int>(capacity: 8)
        for (i, key) in ["a", "b", "c"].enumerated() { cache.insert(i, for: key) }
        XCTAssertEqual(cache.removeAll { key, _ in key != "b" }, [0, 2])
        XCTAssertEqual(cache.keys, ["b"])
    }

    func testStaleChats() {
        let host = UUID()
        let a = ChatKey(host: host, agent: "a"), b = ChatKey(host: host, agent: "b")
        XCTAssertFalse(AppModel.isStale(a, shown: b, archived: false))
        XCTAssertTrue(AppModel.isStale(a, shown: b, archived: true), "archived agents leave the cache")
        XCTAssertTrue(AppModel.isStale(a, shown: nil, archived: nil), "deleted agent or removed host")
        XCTAssertFalse(AppModel.isStale(a, shown: a, archived: true), "the chat on screen stays until left")
        XCTAssertFalse(AppModel.isStale(a, shown: a, archived: nil))
        XCTAssertNotEqual(ChatKey(host: UUID(), agent: "a"), a, "same agent id on another host is another chat")
    }

    func testParkCapsItemsAndResetsWindow() {
        let chat = ChatModel.synthetic(count: 1500)
        chat.expanded = [chat.items[0].id, chat.items[1400].id]
        chat.park(keeping: 1000)
        XCTAssertEqual(chat.items.count, 1000)
        XCTAssertEqual(chat.historyStart, 500, "dropped pages load again on scrolling up")
        XCTAssertTrue(chat.canLoadOlder)
        XCTAssertEqual(chat.expanded.count, 1, "expanded rows that are still loaded stay expanded")
        XCTAssertEqual(chat.visibleItems.count, ChatModel.window, "the next view opens on the newest rows")

        let short = ChatModel.synthetic(count: 300)
        let items = short.items.map(\.id)
        short.park(keeping: 1000)
        XCTAssertEqual(short.items.map(\.id), items)
        XCTAssertEqual(short.historyStart, 0)
    }
}
