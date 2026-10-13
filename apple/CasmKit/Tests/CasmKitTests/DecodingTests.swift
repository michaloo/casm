import Foundation
import Testing
@testable import CasmKit

private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Suite struct ItemDecoding {
    let items: [Item]

    init() throws {
        items = try JSONDecoder().decode([Item].self, from: fixture("items.json"))
    }

    @Test func everyKind() {
        #expect(items.map(\.kind) == ["user", "assistant", "reasoning", "tool", "tool", "tool", "tool", "notice", "diff"])
        #expect(items[0] == .user(id: "u1", text: "Write hello.txt"))
        #expect(items[1] == .assistant(id: "a1:0", text: "## Done\n\n- created `hello.txt`\n\n```bash\ncat hello.txt\n```"))
        #expect(items[2] == .reasoning(id: "a1:1", text: "The user wants a file."))
        #expect(items[7] == .notice(id: "n1", text: "Session resumed", level: nil))
        #expect(items[8] == .unknown(id: "d1", kind: "diff"))
    }

    @Test func tools() throws {
        guard case .tool(let running) = items[3], case .tool(let done) = items[4],
              case .tool(let failed) = items[5], case .tool(let bare) = items[6] else {
            Issue.record("expected tool items")
            return
        }
        #expect(running.status == .running)
        #expect(running.output == nil)
        #expect(running.input?["file_path"] == .string("/tmp/hello.txt"))
        #expect(running.input?["n"] == .number(2))
        #expect(running.input?["flags"] == .array([.bool(true), .null]))
        #expect(done.id == running.id)
        #expect(done.status == .done)
        #expect(done.output == "File created")
        #expect(failed.status == .error)
        #expect(failed.input == .string("ls"))
        #expect(bare.input == nil)
    }

    @Test func roundTrip() throws {
        let known = items.filter { if case .unknown = $0 { false } else { true } }
        let again = try JSONDecoder().decode([Item].self, from: JSONEncoder().encode(known))
        #expect(again == known)
    }
}

@Suite struct EventDecoding {
    @Test func everyType() throws {
        let events = try JSONDecoder().decode([AgentEvent].self, from: fixture("events.json"))
        #expect(events.count == 11)
        #expect(events[0] == .turnStarted(turnId: "t1"))
        #expect(events[1] == .item(.assistant(id: "a1:0", text: "Hi")))
        #expect(events[2] == .delta(kind: .assistant, text: "Hel"))
        #expect(events[3] == .delta(kind: .reasoning, text: "Hmm"))
        guard case .permission(let p) = events[4], case .permission(let q) = events[5] else {
            Issue.record("expected permission events")
            return
        }
        #expect(p.id == "toolu_1" && p.toolName == "Write" && p.title == "/tmp/x" && p.canAlwaysAllow)
        #expect(q.title == nil && !q.canAlwaysAllow && q.input?["command"] == .string("rm -rf /"))
        #expect(events[6] == .permissionResolved(requestId: "toolu_1"))
        #expect(events[7] == .turnEnded(turnId: "t1", outcome: .completed, error: nil))
        #expect(events[8] == .turnEnded(turnId: "t2", outcome: .failed, error: "agent process exited"))
        #expect(events[9] == .turnEnded(turnId: "t3", outcome: .unknown("timedOut"), error: nil))
        #expect(events[10] == .unknown(type: "compacted"))
    }

    @Test func roundTrip() throws {
        let events = try JSONDecoder().decode([AgentEvent].self, from: fixture("events.json"))
        let again = try JSONDecoder().decode([AgentEvent].self, from: JSONEncoder().encode(events))
        #expect(again == events)
    }

    @Test func openEnums() throws {
        let statuses = try JSONDecoder().decode([AgentStatus].self, from: Data(#"["idle","running","waiting","sleeping"]"#.utf8))
        #expect(statuses == [.idle, .running, .waiting, .unknown("sleeping")])
        #expect(try JSONEncoder().encode(statuses) == Data(#"["idle","running","waiting","sleeping"]"#.utf8))
    }
}

/// Every frame of a recorded server session (scripts/record-session.mjs) decodes.
@Suite struct RecordedSession {
    struct Frame: Decodable {
        var id: Int?
        var method: String?
    }

    struct Box<R: Decodable>: Decodable { var result: R }

    @Test func allFramesDecode() throws {
        let lines = try String(decoding: fixture("recorded-session.jsonl"), as: UTF8.self)
            .split(separator: "\n").map { Data($0.utf8) }
        // Request ids in the order the recorder sends them.
        let results: [Int: (Data) throws -> Void] = [
            1: { _ = try JSONDecoder().decode(Box<ServerInfo>.self, from: $0) },
            2: { _ = try JSONDecoder().decode(Box<ProjectList>.self, from: $0) },
            3: { _ = try JSONDecoder().decode(Box<Agent>.self, from: $0) },
            4: { _ = try JSONDecoder().decode(Box<SubscribeResult>.self, from: $0) },
            5: { _ = try JSONDecoder().decode(Box<SendResult>.self, from: $0) },
            6: { data in
                let r = try JSONDecoder().decode(Box<SubscribeResult>.self, from: data).result
                #expect(r.status == .waiting)
                #expect(r.permissions.count == 1)
                #expect(r.turn.contains { if case .permission = $0 { true } else { false } })
            },
            10: { data in
                let page = try JSONDecoder().decode(Box<HistoryPage>.self, from: data).result
                #expect(page.items.contains { $0.kind == "tool" })
                #expect(page.total == page.items.count + page.start)
            },
            11: { _ = try JSONDecoder().decode(Box<AgentList>.self, from: $0) },
        ]
        var notifications: [ServerNotification] = []
        for line in lines {
            let frame = try JSONDecoder().decode(Frame.self, from: line)
            if let method = frame.method {
                let note = try ServerNotification(method: method, data: line)
                if case .unknown = note { Issue.record("unknown notification \(method)") }
                notifications.append(note)
            } else if let id = frame.id, let check = results[id] {
                try check(line)
            }
        }
        let events = notifications.compactMap { if case .agentEvent(_, let e) = $0 { e } else { nil } }
        #expect(events.contains { if case .delta = $0 { true } else { false } })
        #expect(events.contains { if case .permissionResolved = $0 { true } else { false } })
        #expect(events.contains { if case .turnEnded(_, .interrupted, _) = $0 { true } else { false } })
        #expect(notifications.contains { if case .agentStatus(_, .waiting) = $0 { true } else { false } })
        #expect(notifications.contains { if case .agentRemoved = $0 { true } else { false } })
    }
}

@Suite struct HostStoreTests {
    @Test func persistsHostsAndTokens() throws {
        let suite = "casm.tests.\(UUID().uuidString)"
        let store = HostStore(suite: suite, keychainService: suite)
        let host = HostEntry(name: "local", url: URL(string: "ws://127.0.0.1:7373")!)
        try store.upsert(host, token: "secret")
        #expect(store.load() == [host])
        #expect(store.token(for: host.id) == "secret")
        try store.upsert(HostEntry(id: host.id, name: "renamed", url: host.url), token: "secret2")
        #expect(store.load().map(\.name) == ["renamed"])
        #expect(store.token(for: host.id) == "secret2")
        store.remove(host.id)
        #expect(store.load().isEmpty)
        #expect(store.token(for: host.id) == nil)
        UserDefaults.standard.removePersistentDomain(forName: suite)
    }
}

@Suite struct ChatFeatureDecoding {
    @Test func plansNoticesImagesToolOutputUsage() throws {
        let raw = #"""
        [{"type": "item", "item": {"kind": "plan", "id": "p1", "entries": [
            {"text": "Read the code", "status": "completed"},
            {"text": "Fix the bug", "status": "in_progress"},
            {"text": "Ship", "status": "pending"}]}},
         {"type": "item", "item": {"kind": "notice", "id": "n1", "text": "Retrying in 5s", "level": "warning"}},
         {"type": "item", "item": {"kind": "user", "id": "u1", "text": "look", "images": [{"mediaType": "image/png", "data": "AA=="}, {"mediaType": "image/jpeg"}]}},
         {"type": "toolOutput", "itemId": "toolu_1", "text": "line 1\n"},
         {"type": "usage", "usage": {"model": "haiku", "contextTokens": 34000, "contextWindow": 200000, "costUsd": 0.01}}]
        """#
        let events = try JSONDecoder().decode([AgentEvent].self, from: Data(raw.utf8))
        #expect(events[0] == .item(.plan(id: "p1", entries: [
            PlanEntry(text: "Read the code", status: .completed),
            PlanEntry(text: "Fix the bug", status: .inProgress),
            PlanEntry(text: "Ship", status: .pending)])))
        #expect(events[1] == .item(.notice(id: "n1", text: "Retrying in 5s", level: .warning)))
        #expect(events[2] == .item(.user(id: "u1", text: "look", images: [
            ImageData(mediaType: "image/png", data: "AA=="), ImageData(mediaType: "image/jpeg", data: nil)])))
        #expect(events[3] == .toolOutput(itemId: "toolu_1", text: "line 1\n"))
        guard case .usage(let usage) = events[4] else { Issue.record("usage"); return }
        #expect(usage.contextTokens == 34000 && usage.contextWindow == 200000 && usage.model == "haiku")
        let again = try JSONDecoder().decode([AgentEvent].self, from: JSONEncoder().encode(events))
        #expect(again == events)
    }

    @Test func parentsOldAndNew() throws {
        let old = try JSONDecoder().decode(AgentParent.self, from: Data(#"{"host": "ubuntu", "agentId": "a"}"#.utf8))
        #expect(old.serverId == nil && old.host == "ubuntu")
        let new = try JSONDecoder().decode(AgentParent.self, from: Data(#"{"serverId": "s1", "agentId": "a"}"#.utf8))
        #expect(new.serverId == "s1" && new.host == nil)
    }
}

@Suite struct ProjectUpdates {
    @Test func groupChangeEncoding() throws {
        func json(_ p: UpdateProjectParams) throws -> String { String(decoding: try JSONEncoder().encode(p), as: UTF8.self) }
        #expect(try json(UpdateProjectParams(id: "p", group: .clear)).contains(#""group":null"#))
        #expect(try json(UpdateProjectParams(id: "p", group: .set("Work"))).contains(#""group":"Work""#))
        #expect(try !json(UpdateProjectParams(id: "p", archived: true)).contains("group"))
    }
}
