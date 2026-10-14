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

/// A hand-picked folder on the server. Its name and path are fixed at creation; `group` is only a
/// visual grouping label.
public struct Project: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var path: String
    public var group: String?
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

/// The agent that created this one, possibly on another server. `serverId` matches that server's
/// `server.info` id; `host` is only a display hint. (Servers before protocol 1.x sent `host` only.)
public struct AgentParent: Codable, Sendable, Hashable {
    public var serverId: String?
    public var agentId: String
    public var host: String?
}

public struct ImageData: Codable, Sendable, Hashable {
    public var mediaType: String
    /// Base64; history may omit it for very large images.
    public var data: String?

    public init(mediaType: String, data: String?) {
        self.mediaType = mediaType
        self.data = data
    }
}

public enum PlanStatus: OpenEnum {
    case pending, inProgress, completed
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "in_progress": self = .inProgress
        case "completed": self = .completed
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .inProgress: "in_progress"
        case .completed: "completed"
        case .unknown(let raw): raw
        }
    }
}

public struct PlanEntry: Codable, Sendable, Hashable {
    public var text: String
    public var status: PlanStatus

    public init(text: String, status: PlanStatus) {
        self.text = text
        self.status = status
    }
}

public enum NoticeLevel: OpenEnum {
    case info, warning, error
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "info": self = .info
        case "warning": self = .warning
        case "error": self = .error
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .info: "info"
        case .warning: "warning"
        case .error: "error"
        case .unknown(let raw): raw
        }
    }
}

/// Context and cost, as far as the agent reports them.
public struct Usage: Codable, Sendable, Hashable {
    public var model: String?
    public var contextTokens: Double?
    public var contextWindow: Double?
    public var inputTokens: Double?
    public var outputTokens: Double?
    public var costUsd: Double?

    public init(model: String? = nil, contextTokens: Double? = nil, contextWindow: Double? = nil,
                inputTokens: Double? = nil, outputTokens: Double? = nil, costUsd: Double? = nil) {
        self.model = model
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
    }
}

public struct Agent: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var projectId: String
    public var name: String
    public var provider: ProviderID
    public var cwd: String
    public var config: AgentConfig
    public var nativeSessionId: String?
    /// The model the agent's session runs, as the provider last reported it (also when
    /// `config.model` is unset). Nil until a session reports one or after the model changes.
    public var effectiveModel: String?
    public var parent: AgentParent?
    public var tags: [String]
    public var archivedAt: String?
    public var createdAt: String
    public var updatedAt: String
    public var status: AgentStatus
    /// A prompt waiting for a provider usage limit to reset; the server sends it then.
    public var deferred: Deferred?
    /// Messages waiting to be sent (see `agent.pending`).
    public var pending: PendingSummary?

    public struct Deferred: Codable, Sendable, Hashable {
        /// ISO time the limit resets.
        public var until: String
        public var reason: String
    }

    public struct PendingSummary: Codable, Sendable, Hashable {
        public var count: Int
        /// The earliest time a waiting message is due (ISO), if any waits for a time.
        public var next: String?
    }
}

/// A message waiting for its agent to become available: behind a running turn ("queued") or
/// until a usage limit resets ("limit"). Sent in order. (Timed sends are schedules.)
public struct PendingMessage: Codable, Sendable, Hashable, Identifiable {
    public enum Reason: OpenEnum {
        /// Behind a running turn.
        case queued
        /// Waiting for a usage limit to reset.
        case limit
        /// The prompt of a turn that failed before the agent answered (`note` has the error).
        /// Kept, never resent on its own: retry it (`agent.retryPending`) or cancel it.
        case failed
        case unknown(String)

        public init?(rawValue: String) {
            switch rawValue {
            case "queued": self = .queued
            case "limit": self = .limit
            case "failed": self = .failed
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .queued: "queued"
            case .limit: "limit"
            case .failed: "failed"
            case .unknown(let raw): raw
            }
        }
    }

    public var id: String
    public var agentId: String
    public var text: String
    public var imageCount: Int?
    public var reason: Reason
    /// ISO time it may be sent from.
    public var notBefore: String?
    public var note: String?
    public var createdAt: String

    public init(id: String, agentId: String, text: String, imageCount: Int? = nil, reason: Reason,
                notBefore: String? = nil, note: String? = nil, createdAt: String) {
        self.id = id
        self.agentId = agentId
        self.text = text
        self.imageCount = imageCount
        self.reason = reason
        self.notBefore = notBefore
        self.note = note
        self.createdAt = createdAt
    }
}

/// A turn that failed on a usage or rate limit; its prompt waits for the reset.
public struct TurnLimit: Codable, Sendable, Hashable {
    public var message: String
    public var resetsAt: String?

    public init(message: String, resetsAt: String? = nil) {
        self.message = message
        self.resetsAt = resetsAt
    }
}

/// One usage window of a provider subscription (e.g. 5-hour session, weekly).
public struct LimitWindow: Codable, Sendable, Hashable, Identifiable {
    public enum Status: OpenEnum {
        case ok, warning, exhausted
        case unknown(String)

        public init?(rawValue: String) {
            switch rawValue {
            case "ok": self = .ok
            case "warning": self = .warning
            case "exhausted": self = .exhausted
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .ok: "ok"
            case .warning: "warning"
            case .exhausted: "exhausted"
            case .unknown(let raw): raw
            }
        }
    }

    public var id: String
    public var label: String?
    public var usedPercent: Double?
    public var resetsAt: String?
    public var windowMinutes: Double?
    public var status: Status?
}

/// The latest known subscription limits of one provider on a host.
public struct ProviderLimits: Codable, Sendable, Hashable {
    public var provider: ProviderID
    public var plan: String?
    public var windows: [LimitWindow]
    public var updatedAt: String

    public init(provider: ProviderID, plan: String? = nil, windows: [LimitWindow], updatedAt: String) {
        self.provider = provider
        self.plan = plan
        self.windows = windows
        self.updatedAt = updatedAt
    }
}

public struct SubagentRun: Codable, Sendable, Hashable {
    public var id: String
    public var title: String
    public var agentType: String?
    public var status: ToolStatus
    /// The latest thing it did, e.g. the tool it is running.
    public var activity: String?
    public var summary: String?
    public var usage: Usage?

    public init(id: String, title: String, agentType: String? = nil, status: ToolStatus,
                activity: String? = nil, summary: String? = nil, usage: Usage? = nil) {
        self.id = id
        self.title = title
        self.agentType = agentType
        self.status = status
        self.activity = activity
        self.summary = summary
        self.usage = usage
    }
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
    /// "user" for the user's own "!" shell commands, "agent" (or nil) for the agent's tools.
    public var origin: String?

    public var isUserCommand: Bool { origin == "user" }

    public init(id: String, name: String, input: JSONValue?, status: ToolStatus, output: String? = nil, origin: String? = nil) {
        self.id = id
        self.name = name
        self.input = input
        self.status = status
        self.output = output
        self.origin = origin
    }
}

/// One normalized transcript entry, discriminated by `kind`. History and live
/// events share this shape; clients upsert by `id`.
public enum Item: Codable, Sendable, Hashable, Identifiable {
    case user(id: String, text: String, images: [ImageData] = [])
    case assistant(id: String, text: String)
    case reasoning(id: String, text: String)
    case tool(ToolCall)
    /// Status lines (interrupts, retries, compaction, warnings), upserted by id.
    case notice(id: String, text: String, level: NoticeLevel? = nil)
    /// The agent's todo list; each update replaces the entries.
    case plan(id: String, entries: [PlanEntry])
    /// A subagent the agent spawned itself (Claude Task tool, Codex sub-agents); upserted as it runs.
    case subagent(SubagentRun)
    /// A kind this client doesn't know yet.
    case unknown(id: String, kind: String)

    private enum CodingKeys: String, CodingKey { case kind, id, text, images, level, entries }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        let id = (try? c.decode(String.self, forKey: .id)) ?? ""
        do {
            self = try Self.decodeKnown(kind: kind, id: id, c, decoder)
        } catch {
            // A newer server may add kinds or change fields; one odd item must not fail the whole message.
            self = .unknown(id: id, kind: kind)
        }
    }

    private static func decodeKnown(kind: String, id: String, _ c: KeyedDecodingContainer<CodingKeys>, _ decoder: Decoder) throws -> Item {
        switch kind {
        case "user": .user(id: id, text: try c.decode(String.self, forKey: .text),
                           images: try c.decodeIfPresent([ImageData].self, forKey: .images) ?? [])
        case "assistant": .assistant(id: id, text: try c.decode(String.self, forKey: .text))
        case "reasoning": .reasoning(id: id, text: try c.decode(String.self, forKey: .text))
        case "notice": .notice(id: id, text: try c.decode(String.self, forKey: .text),
                               level: try c.decodeIfPresent(NoticeLevel.self, forKey: .level))
        case "plan": .plan(id: id, entries: try c.decode([PlanEntry].self, forKey: .entries))
        case "subagent": .subagent(try SubagentRun(from: decoder))
        case "tool": .tool(try ToolCall(from: decoder))
        default: .unknown(id: id, kind: kind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .assistant(let id, let text), .reasoning(let id, let text):
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
        case .user(let id, let text, let images):
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            if !images.isEmpty { try c.encode(images, forKey: .images) }
        case .notice(let id, let text, let level):
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(level, forKey: .level)
        case .plan(let id, let entries):
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(entries, forKey: .entries)
        case .subagent(let run):
            try c.encode(kind, forKey: .kind)
            try run.encode(to: encoder)
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
        case .user(let id, _, _), .assistant(let id, _), .reasoning(let id, _), .notice(let id, _, _), .plan(let id, _),
             .unknown(let id, _): id
        case .subagent(let run): run.id
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
        case .plan: "plan"
        case .subagent: "subagent"
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

// MARK: Questions

public enum QuestionKind: OpenEnum {
    case select, text, confirm
    case unknown(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "select": self = .select
        case "text": self = .text
        case "confirm": self = .confirm
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .select: "select"
        case .text: "text"
        case .confirm: "confirm"
        case .unknown(let raw): raw
        }
    }
}

public struct QuestionOption: Codable, Sendable, Hashable {
    public var label: String
    public var description: String?

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

/// One prompt of a question. `select` uses `options` (`multiple`, `allowOther`); `text` uses
/// `multiline`, `placeholder` and `secret`; `confirm` is yes/no.
public struct QuestionPrompt: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var text: String
    public var header: String?
    public var kind: QuestionKind
    public var options: [QuestionOption]?
    public var multiple: Bool?
    public var allowOther: Bool?
    public var multiline: Bool?
    public var placeholder: String?
    public var secret: Bool?

    public init(id: String, text: String, header: String? = nil, kind: QuestionKind, options: [QuestionOption]? = nil,
                multiple: Bool? = nil, allowOther: Bool? = nil, multiline: Bool? = nil, placeholder: String? = nil, secret: Bool? = nil) {
        self.id = id
        self.text = text
        self.header = header
        self.kind = kind
        self.options = options
        self.multiple = multiple
        self.allowOther = allowOther
        self.multiline = multiline
        self.placeholder = placeholder
        self.secret = secret
    }
}

public struct QuestionRequest: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String?
    public var prompts: [QuestionPrompt]

    public init(id: String, title: String? = nil, prompts: [QuestionPrompt]) {
        self.id = id
        self.title = title
        self.prompts = prompts
    }
}

/// select: option label(s) or free text; text: the text; confirm: a boolean.
public enum AnswerValue: Codable, Sendable, Hashable {
    case string(String)
    case strings([String])
    case bool(Bool)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let a = try? c.decode([String].self) { self = .strings(a) }
        else { self = .string(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .strings(let a): try c.encode(a)
        case .bool(let b): try c.encode(b)
        }
    }
}

// MARK: Catalog

public struct ModelInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String?
    public var description: String?
    public var isDefault: Bool?
    /// Reasoning effort levels this model accepts (`AgentConfig.effort`); nil or empty means none.
    public var efforts: [String]?

    public var displayName: String { name ?? id }
}

public struct ModeInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String?
    public var description: String?

    public var displayName: String { name ?? id }

    public init(id: String, name: String? = nil, description: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
    }
}

public struct Catalog: Codable, Sendable, Hashable {
    public var models: [ModelInfo]
    public var modes: [ModeInfo]

    public init(models: [ModelInfo] = [], modes: [ModeInfo] = []) {
        self.models = models
        self.modes = modes
    }
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
    case question(QuestionRequest)
    case questionResolved(requestId: String)
    /// Appends to a running tool item's output; the final tool item replaces it.
    case toolOutput(itemId: String, text: String)
    case usage(Usage)
    case turnEnded(turnId: String, outcome: TurnOutcome, error: String?, limit: TurnLimit? = nil)
    /// A type this client doesn't know yet, or a known type with an unexpected body.
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, turnId, item, kind, text, request, requestId, outcome, error, itemId, usage, limit }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        do {
            self = try Self.decodeKnown(type: type, c)
        } catch {
            self = .unknown(type: type)
        }
    }

    private static func decodeKnown(type: String, _ c: KeyedDecodingContainer<CodingKeys>) throws -> AgentEvent {
        switch type {
        case "turnStarted": .turnStarted(turnId: try c.decode(String.self, forKey: .turnId))
        case "item": .item(try c.decode(Item.self, forKey: .item))
        case "delta": .delta(kind: try c.decode(DeltaKind.self, forKey: .kind), text: try c.decode(String.self, forKey: .text))
        case "permission": .permission(try c.decode(PermissionRequest.self, forKey: .request))
        case "permissionResolved": .permissionResolved(requestId: try c.decode(String.self, forKey: .requestId))
        case "question": .question(try c.decode(QuestionRequest.self, forKey: .request))
        case "questionResolved": .questionResolved(requestId: try c.decode(String.self, forKey: .requestId))
        case "toolOutput": .toolOutput(itemId: try c.decode(String.self, forKey: .itemId), text: try c.decode(String.self, forKey: .text))
        case "usage": .usage(try c.decode(Usage.self, forKey: .usage))
        case "turnEnded":
            .turnEnded(turnId: try c.decode(String.self, forKey: .turnId),
                       outcome: try c.decode(TurnOutcome.self, forKey: .outcome),
                       error: try c.decodeIfPresent(String.self, forKey: .error),
                       limit: try c.decodeIfPresent(TurnLimit.self, forKey: .limit))
        default: .unknown(type: type)
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
        case .question(let request):
            try c.encode("question", forKey: .type)
            try c.encode(request, forKey: .request)
        case .questionResolved(let requestId):
            try c.encode("questionResolved", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
        case .toolOutput(let itemId, let text):
            try c.encode("toolOutput", forKey: .type)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(text, forKey: .text)
        case .usage(let usage):
            try c.encode("usage", forKey: .type)
            try c.encode(usage, forKey: .usage)
        case .turnEnded(let turnId, let outcome, let error, let limit):
            try c.encode("turnEnded", forKey: .type)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(outcome, forKey: .outcome)
            try c.encodeIfPresent(error, forKey: .error)
            try c.encodeIfPresent(limit, forKey: .limit)
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
    case providerLimits(ProviderLimits)
    case scheduleChanged(Schedule)
    case scheduleRemoved(scheduleId: String)
    /// The server's connection to a peer dropped; subscriptions made through it are gone.
    case peerDisconnected(host: String)
    case unknown(method: String)

    private struct AgentEventParams: Decodable { var agentId: String; var event: AgentEvent }
    private struct AgentStatusParams: Decodable { var agentId: String; var status: AgentStatus }
    private struct AgentParams: Decodable { var agent: Agent }
    private struct AgentIDParams: Decodable { var agentId: String }
    private struct ProjectParams: Decodable { var project: Project }
    private struct ProjectIDParams: Decodable { var projectId: String }
    private struct LimitsParams: Decodable { var limits: ProviderLimits }
    private struct ScheduleParams: Decodable { var schedule: Schedule }
    private struct ScheduleIDParams: Decodable { var scheduleId: String }
    private struct PeerParams: Decodable { var host: String }
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
        case "provider.limits": self = .providerLimits(try params(LimitsParams.self).limits)
        case "schedule.changed": self = .scheduleChanged(try params(ScheduleParams.self).schedule)
        case "schedule.removed": self = .scheduleRemoved(scheduleId: try params(ScheduleIDParams.self).scheduleId)
        case "peer.disconnected": self = .peerDisconnected(host: try params(PeerParams.self).host)
        default: self = .unknown(method: method)
        }
    }
}
