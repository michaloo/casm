// Codable mirrors of spec/protocol.json (protocol 1). Decoding is lenient where
// the protocol promises additive changes: unknown fields are ignored and unknown
// enum values, item kinds and event types decode to an `.unknown` case.
import Foundation

public let supportedProtocolVersion = 1

// MARK: - JSON values

/// Arbitrary JSON, for fields the protocol types as `unknown` (tool inputs, MCP config).
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Pretty-printed JSON, or the bare string for string values.
    public var prettyPrinted: String {
        if case .string(let s) = self { return s }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// A string enum that keeps values it doesn't know instead of failing to decode.
public protocol OpenEnum: RawRepresentable<String>, Codable, Sendable, Hashable {
    static func unknown(_ raw: String) -> Self
}

public extension OpenEnum {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown(raw)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

// MARK: - Domain

public enum ProviderID: OpenEnum {
    case claude, codex, pi, opencode
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "claude": self = .claude
        case "codex": self = .codex
        case "pi": self = .pi
        case "opencode": self = .opencode
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .claude: "claude"
        case .codex: "codex"
        case .pi: "pi"
        case .opencode: "opencode"
        case .unknown(let raw): raw
        }
    }
}

/// Derived from the live process on the server: `waiting` means a permission prompt is pending.
public enum AgentStatus: OpenEnum {
    case idle, running, waiting
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "idle": self = .idle
        case "running": self = .running
        case "waiting": self = .waiting
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .idle: "idle"
        case .running: "running"
        case .waiting: "waiting"
        case .unknown(let raw): raw
        }
    }

    /// True while a turn is in flight (running or blocked on a permission).
    public var isBusy: Bool { self == .running || self == .waiting }
}

public struct Project: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var parentId: String?
    public var path: String?
    public var tags: [String]
    public var sort: Double
    public var archivedAt: String?
    public var createdAt: String
}

public struct AgentConfig: Codable, Sendable, Hashable {
    public var model: String?
    public var mode: String?
    public var effort: String?
    public var systemPrompt: String?
    public var mcpServers: [String: JSONValue]?
    public var env: [String: String]?

    public init(model: String? = nil, mode: String? = nil, effort: String? = nil, systemPrompt: String? = nil,
                mcpServers: [String: JSONValue]? = nil, env: [String: String]? = nil) {
        self.model = model
        self.mode = mode
        self.effort = effort
        self.systemPrompt = systemPrompt
        self.mcpServers = mcpServers
        self.env = env
    }
}

public struct AgentParent: Codable, Sendable, Hashable {
    public var host: String
    public var agentId: String
}

public struct Agent: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var projectId: String
    public var name: String
    public var provider: ProviderID
    public var cwd: String
    public var config: AgentConfig
    public var nativeSessionId: String?
    public var parent: AgentParent?
    public var tags: [String]
    public var archivedAt: String?
    public var createdAt: String
    public var updatedAt: String
    public var status: AgentStatus
}

public enum ToolStatus: OpenEnum {
    case running, done, error
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "running": self = .running
        case "done": self = .done
        case "error": self = .error
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .running: "running"
        case .done: "done"
        case .error: "error"
        case .unknown(let raw): raw
        }
    }
}

public struct ToolCall: Codable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var input: JSONValue?
    public var status: ToolStatus
    public var output: String?

    public init(id: String, name: String, input: JSONValue?, status: ToolStatus, output: String? = nil) {
        self.id = id
        self.name = name
        self.input = input
        self.status = status
        self.output = output
    }
}

/// One normalized transcript entry, discriminated by `kind`. History and live
/// events share this shape; clients upsert by `id`.
public enum Item: Codable, Sendable, Hashable, Identifiable {
    case user(id: String, text: String)
    case assistant(id: String, text: String)
    case reasoning(id: String, text: String)
    case tool(ToolCall)
    case notice(id: String, text: String)
    /// A kind this client doesn't know yet.
    case unknown(id: String, kind: String)

    private enum CodingKeys: String, CodingKey { case kind, id, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let id = try c.decode(String.self, forKey: .id)
        switch kind {
        case "user": self = .user(id: id, text: try c.decode(String.self, forKey: .text))
        case "assistant": self = .assistant(id: id, text: try c.decode(String.self, forKey: .text))
        case "reasoning": self = .reasoning(id: id, text: try c.decode(String.self, forKey: .text))
        case "notice": self = .notice(id: id, text: try c.decode(String.self, forKey: .text))
        case "tool": self = .tool(try ToolCall(from: decoder))
        default: self = .unknown(id: id, kind: kind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .user(let id, let text), .assistant(let id, let text), .reasoning(let id, let text), .notice(let id, let text):
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
        case .tool(let call):
            try c.encode(kind, forKey: .kind)
            try call.encode(to: encoder)
        case .unknown(let id, let kind):
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
        }
    }

    public var id: String {
        switch self {
        case .user(let id, _), .assistant(let id, _), .reasoning(let id, _), .notice(let id, _), .unknown(let id, _): id
        case .tool(let call): call.id
        }
    }

    public var kind: String {
        switch self {
        case .user: "user"
        case .assistant: "assistant"
        case .reasoning: "reasoning"
        case .tool: "tool"
        case .notice: "notice"
        case .unknown(_, let kind): kind
        }
    }
}

public struct PermissionRequest: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var toolName: String
    public var input: JSONValue?
    public var title: String?
    public var canAlwaysAllow: Bool
}

public enum PermissionDecision: String, Codable, Sendable {
    case allow, allowAlways, deny
}

public enum TurnOutcome: OpenEnum {
    case completed, interrupted, failed
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "completed": self = .completed
        case "interrupted": self = .interrupted
        case "failed": self = .failed
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .completed: "completed"
        case .interrupted: "interrupted"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

public enum DeltaKind: String, Codable, Sendable, Hashable {
    case assistant, reasoning
}

/// Live events for one agent, discriminated by `type`.
public enum AgentEvent: Codable, Sendable, Hashable {
    case turnStarted(turnId: String)
    case item(Item)
    /// Incremental text for the transient draft; dropped when the next assistant/reasoning item lands.
    case delta(kind: DeltaKind, text: String)
    case permission(PermissionRequest)
    case permissionResolved(requestId: String)
    case turnEnded(turnId: String, outcome: TurnOutcome, error: String?)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, turnId, item, kind, text, request, requestId, outcome, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "turnStarted": self = .turnStarted(turnId: try c.decode(String.self, forKey: .turnId))
        case "item": self = .item(try c.decode(Item.self, forKey: .item))
        case "delta": self = .delta(kind: try c.decode(DeltaKind.self, forKey: .kind), text: try c.decode(String.self, forKey: .text))
        case "permission": self = .permission(try c.decode(PermissionRequest.self, forKey: .request))
        case "permissionResolved": self = .permissionResolved(requestId: try c.decode(String.self, forKey: .requestId))
        case "turnEnded":
            self = .turnEnded(turnId: try c.decode(String.self, forKey: .turnId),
                              outcome: try c.decode(TurnOutcome.self, forKey: .outcome),
                              error: try c.decodeIfPresent(String.self, forKey: .error))
        default: self = .unknown(type: type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .turnStarted(let turnId):
            try c.encode("turnStarted", forKey: .type)
            try c.encode(turnId, forKey: .turnId)
        case .item(let item):
            try c.encode("item", forKey: .type)
            try c.encode(item, forKey: .item)
        case .delta(let kind, let text):
            try c.encode("delta", forKey: .type)
            try c.encode(kind, forKey: .kind)
            try c.encode(text, forKey: .text)
        case .permission(let request):
            try c.encode("permission", forKey: .type)
            try c.encode(request, forKey: .request)
        case .permissionResolved(let requestId):
            try c.encode("permissionResolved", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
        case .turnEnded(let turnId, let outcome, let error):
            try c.encode("turnEnded", forKey: .type)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(outcome, forKey: .outcome)
            try c.encodeIfPresent(error, forKey: .error)
        case .unknown(let type):
            try c.encode(type, forKey: .type)
        }
    }
}

// MARK: - Notifications

/// Server → client notifications.
public enum ServerNotification: Sendable {
    case agentEvent(agentId: String, event: AgentEvent)
    case agentStatus(agentId: String, status: AgentStatus)
    case agentChanged(Agent)
    case agentRemoved(agentId: String)
    case projectChanged(Project)
    case projectRemoved(projectId: String)
    case unknown(method: String)

    private struct AgentEventParams: Decodable { var agentId: String; var event: AgentEvent }
    private struct AgentStatusParams: Decodable { var agentId: String; var status: AgentStatus }
    private struct AgentParams: Decodable { var agent: Agent }
    private struct AgentIDParams: Decodable { var agentId: String }
    private struct ProjectParams: Decodable { var project: Project }
    private struct ProjectIDParams: Decodable { var projectId: String }
    private struct Envelope<P: Decodable>: Decodable { var params: P }

    /// Decodes the params of a notification envelope whose `method` is already known.
    public init(method: String, data: Data, decoder: JSONDecoder = JSONDecoder()) throws {
        func params<P: Decodable>(_: P.Type) throws -> P { try decoder.decode(Envelope<P>.self, from: data).params }
        switch method {
        case "agent.event":
            let p = try params(AgentEventParams.self)
            self = .agentEvent(agentId: p.agentId, event: p.event)
        case "agent.status":
            let p = try params(AgentStatusParams.self)
            self = .agentStatus(agentId: p.agentId, status: p.status)
        case "agent.changed": self = .agentChanged(try params(AgentParams.self).agent)
        case "agent.removed": self = .agentRemoved(agentId: try params(AgentIDParams.self).agentId)
        case "project.changed": self = .projectChanged(try params(ProjectParams.self).project)
        case "project.removed": self = .projectRemoved(projectId: try params(ProjectIDParams.self).projectId)
        default: self = .unknown(method: method)
        }
    }
}
