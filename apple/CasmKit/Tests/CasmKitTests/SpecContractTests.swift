import Foundation
import Testing
@testable import CasmKit

/// Generates sample JSON from spec/protocol.json and decodes it with the Swift types, so a
/// variant or field added to the protocol without a Swift counterpart fails here.
@Suite struct SpecContract {
    static let spec: JSONValue = {
        // Tests/CasmKitTests/ → repo root.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("spec/protocol.json")
        let data = try! Data(contentsOf: url)
        return try! JSONDecoder().decode(JSONValue.self, from: data)
    }()

    static func schema(method: String, _ part: String = "result") -> JSONValue {
        spec["methods"]![method]![part]!
    }

    static func schema(notification: String) -> JSONValue {
        spec["notifications"]![notification]!
    }

    func decode<T: Decodable>(_: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }

    // MARK: Unions

    /// Every `kind` in the spec's Item union decodes to a known case.
    @Test func everyItemVariant() throws {
        let union = Self.schema(notification: "agent.event")["properties"]!["event"]!.branches
            .first { $0.constant(of: "type") == "item" }!["properties"]!["item"]!
        let kinds = union.branches.compactMap { $0.constant(of: "kind") }
        #expect(kinds.count >= 5)
        for branch in union.branches {
            for sample in SampleGenerator.samples(branch) {
                let item = try decode(Item.self, sample)
                if case .unknown(_, let kind) = item { Issue.record("Item kind \(kind) not handled: \(sample.prettyPrinted)") }
            }
        }
    }

    /// Every `type` in the spec's AgentEvent union decodes to a known case.
    @Test func everyEventVariant() throws {
        let union = Self.schema(notification: "agent.event")["properties"]!["event"]!
        var seen: Set<String> = []
        for branch in union.branches {
            let type = try #require(branch.constant(of: "type"))
            seen.insert(type)
            for sample in SampleGenerator.samples(branch) {
                let event = try decode(AgentEvent.self, sample)
                if case .unknown = event { Issue.record("AgentEvent \(type) not handled: \(sample.prettyPrinted)") }
                if case .item(.unknown(_, let kind)) = event { Issue.record("Item \(kind) not handled") }
            }
        }
        #expect(seen.isSuperset(of: ["turnStarted", "item", "delta", "permission", "permissionResolved",
                                     "question", "questionResolved", "turnEnded"]))
    }

    @Test func everyNotification() throws {
        guard case .object(let notes) = Self.spec["notifications"]! else { return }
        for (method, schema) in notes {
            for params in SampleGenerator.samples(schema) {
                let envelope = JSONValue.object(["jsonrpc": .string("2.0"), "method": .string(method), "params": params])
                let note = try ServerNotification(method: method, data: JSONEncoder().encode(envelope))
                if case .unknown = note { Issue.record("notification \(method) not handled") }
                if case .agentEvent(_, .unknown(let type)) = note { Issue.record("event \(type) in \(method) not handled") }
            }
        }
    }

    // MARK: Results

    /// Results of every method the app calls decode in all sample shapes.
    @Test func methodResults() throws {
        let decoders: [String: (JSONValue) throws -> Void] = [
            "server.info": { _ = try decode(ServerInfo.self, $0) },
            "provider.catalog": { _ = try decode(Catalog.self, $0) },
            "project.list": { _ = try decode(ProjectList.self, $0) },
            "project.create": { _ = try decode(Project.self, $0) },
            "agent.list": { _ = try decode(AgentList.self, $0) },
            "agent.create": { _ = try decode(Agent.self, $0) },
            "agent.update": { _ = try decode(Agent.self, $0) },
            "agent.history": { _ = try decode(HistoryPage.self, $0) },
            "agent.subscribe": { _ = try decode(SubscribeResult.self, $0) },
            "agent.send": { _ = try decode(SendResult.self, $0) },
            "agent.unsubscribe": { _ = try decode(OK.self, $0) },
            "agent.interrupt": { _ = try decode(OK.self, $0) },
            "agent.reload": { _ = try decode(OK.self, $0) },
            "agent.restart": { _ = try decode(OK.self, $0) },
            "agent.answerQuestion": { _ = try decode(OK.self, $0) },
            "agent.respondPermission": { _ = try decode(OK.self, $0) },
        ]
        for (method, check) in decoders {
            let samples = SampleGenerator.samples(Self.schema(method: method))
            #expect(!samples.isEmpty, "\(method)")
            for sample in samples {
                do { try check(sample) } catch { Issue.record("\(method): \(error)\n\(sample.prettyPrinted)") }
            }
        }
    }

    // MARK: Params

    /// Params the app sends only use keys the spec declares.
    @Test func paramsUseDeclaredKeys() throws {
        let sent: [(String, any Encodable)] = [
            ("provider.catalog", CatalogParams(provider: .claude, refresh: true)),
            ("project.create", CreateProjectParams(name: "n", parentId: "p", path: "/x", tags: ["t"])),
            ("agent.create", CreateAgentParams(projectId: "p", provider: .claude, name: "n", cwd: "/", config: AgentConfig(model: "m", mode: "default", effort: "low"), tags: [], prompt: "hi")),
            ("agent.update", UpdateAgentParams(id: "a", config: AgentConfig(model: "m"))),
            ("agent.history", HistoryParams(id: "a", before: 1, limit: 2)),
            ("agent.send", SendParams(id: "a", text: "t", whenBusy: .queue)),
            ("agent.answerQuestion", AnswerQuestionParams(id: "a", requestId: "r", answers: ["q": .strings(["x"]), "c": .bool(true), "t": .string("s")])),
            ("agent.respondPermission", RespondPermissionParams(id: "a", requestId: "r", decision: .allowAlways, message: "m")),
        ]
        for (method, params) in sent {
            let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(params))
            let declared = Self.schema(method: method, "params")["properties"]!
            guard case .object(let fields) = value, case .object(let props) = declared else { continue }
            for key in fields.keys where props[key] == nil { Issue.record("\(method) sends undeclared key \(key)") }
        }
    }

    @Test func unknownVariantsFallBack() throws {
        let raw = #"""
        [{"type": "hologram", "beam": 1},
         {"type": "item", "item": {"kind": "diff", "id": "d", "patch": "x"}},
         {"type": "item", "item": {"kind": "tool", "id": "t", "name": "Bash", "status": "running", "input": null, "extra": {"nested": [1]}}},
         {"type": "permission", "request": {"id": "p"}},
         {"type": "question", "request": {"id": "q", "prompts": [{"id": "a", "text": "?", "kind": "slider"}]}}]
        """#
        let events = try JSONDecoder().decode([AgentEvent].self, from: Data(raw.utf8))
        #expect(events[0] == .unknown(type: "hologram"))
        #expect(events[1] == .item(.unknown(id: "d", kind: "diff")))
        if case .item(.tool(let call)) = events[2] { #expect(call.name == "Bash") } else { Issue.record("tool") }
        #expect(events[3] == .unknown(type: "permission")) // malformed body, not a crash
        if case .question(let q) = events[4] { #expect(q.prompts[0].kind == .unknown("slider")) } else { Issue.record("question") }
    }
}

// MARK: - Sample generation

/// Produces a small set of JSON instances for a schema: every union branch, every enum value,
/// optional fields both present and absent, nullable fields both null and set.
enum SampleGenerator {
    static func samples(_ schema: JSONValue) -> [JSONValue] {
        if let c = schema["const"] { return [c] }
        if case .array(let values)? = schema["enum"] { return values }
        if !schema.branches.isEmpty { return schema.branches.flatMap(samples) }
        switch schema["type"] {
        case .array(let types)?:
            return types.flatMap { samples(schema.with(type: $0)) }
        case .string("string")?: return [.string("s")]
        case .string("number")?, .string("integer")?: return [.number(1)]
        case .string("boolean")?: return [.bool(true), .bool(false)]
        case .string("null")?: return [.null]
        case .string("array")?:
            let items = schema["items"].map(samples) ?? [.string("s")]
            return [.array([])] + items.map { .array([$0]) }
        case .string("object")?:
            return objects(schema)
        default:
            // `{}`: unknown/any.
            return [.object(["k": .number(1)]), .string("s"), .null]
        }
    }

    private static func objects(_ schema: JSONValue) -> [JSONValue] {
        guard case .object(let props)? = schema["properties"] else {
            // A record: one entry with each value shape.
            let values = schema["additionalProperties"].map(samples) ?? [.string("s")]
            return [.object([:])] + values.map { .object(["key": $0]) }
        }
        var required: Set<String> = []
        if case .array(let r)? = schema["required"] { required = Set(r.compactMap(\.stringValue)) }
        let variants = props.mapValues(samples)
        let base = variants.compactMapValues(\.first)
        var out: [JSONValue] = [.object(base), .object(base.filter { required.contains($0.key) })]
        // Vary one property at a time to keep the count linear.
        for (key, values) in variants.sorted(by: { $0.key < $1.key }) {
            for value in values.dropFirst() {
                var o = base
                o[key] = value
                out.append(.object(o))
            }
        }
        return out
    }
}

extension JSONValue {
    var branches: [JSONValue] {
        if case .array(let b)? = self["oneOf"] ?? self["anyOf"] { return b }
        return []
    }

    func constant(of key: String) -> String? {
        self["properties"]?[key]?["const"]?.stringValue
    }

    func with(type: JSONValue) -> JSONValue {
        guard case .object(var o) = self else { return self }
        o["type"] = type
        return .object(o)
    }
}
