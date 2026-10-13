import CasmKit
import XCTest

@MainActor
final class SidebarSearchTests: XCTestCase {
    func decode<T: Decodable>(_ json: [String: Any]) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func project(_ id: String, _ name: String, archived: Bool = false) throws -> Project {
        try decode(["id": id, "name": name, "path": "/srv/\(name)", "tags": [], "sort": 0,
                    "archivedAt": archived ? "2026-10-01T00:00:00Z" : NSNull(), "createdAt": "2026-09-01T00:00:00Z"])
    }

    func agent(_ id: String, _ name: String, project: String, archived: Bool = false, updated: String) throws -> Agent {
        try decode(["id": id, "projectId": project, "name": name, "provider": "claude", "cwd": "/srv/\(project)",
                    "config": [:], "tags": [], "archivedAt": archived ? "2026-10-02T00:00:00Z" : NSNull(),
                    "createdAt": "2026-09-01T00:00:00Z", "updatedAt": updated, "status": "idle"])
    }

    func testSearchFindsArchivedAndRanksLiveFirst() throws {
        let host = HostModel(entry: HostEntry(name: "macbook", url: URL(string: "ws://127.0.0.1:1")!), token: "")
        host.upsert(try project("p1", "website"))
        host.upsert(try project("p2", "old-site", archived: true))
        host.upsert(try agent("a1", "Fix login", project: "p1", archived: true, updated: "2026-10-10T00:00:00Z"))
        host.upsert(try agent("a2", "Login tests", project: "p1", updated: "2026-10-01T00:00:00Z"))
        host.upsert(try agent("a3", "Migrate", project: "p2", archived: true, updated: "2026-10-05T00:00:00Z"))

        XCTAssertEqual(host.search("login").agents.map(\.id), ["a2", "a1"])
        // Words match across fields: name plus project.
        XCTAssertEqual(host.search("migrate old").agents.map(\.id), ["a3"])
        XCTAssertEqual(host.search("site").projects.map(\.id), ["p1", "p2"])
        XCTAssertTrue(host.search("  ").agents.isEmpty)
        XCTAssertTrue(host.search("nothing").agents.isEmpty)
    }
}
