// Params and results of the methods the apps use, with typed wrappers on RPCClient.
import Foundation

public struct EmptyParams: Codable, Sendable { public init() {} }
public struct OK: Codable, Sendable { public var ok: Bool }
struct ByID: Codable, Sendable { var id: String }

public struct ServerInfo: Codable, Sendable, Hashable {
    /// Stable server id; `AgentParent.serverId` refers to it. Absent on older servers.
    public var id: String?
    public var name: String
    public var version: String
    public var `protocol`: Int
    public var providers: [ProviderID]
}

public struct ProjectList: Codable, Sendable { public var projects: [Project] }

/// A slash command or skill; send it as text ("/name args").
public struct SlashCommand: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable { case command, skill }
    public var name: String
    public var description: String?
    public var argumentHint: String?
    public var kind: Kind?
    public var id: String { name }

    public init(name: String, description: String? = nil, argumentHint: String? = nil, kind: Kind? = nil) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
        self.kind = kind
    }
}

struct CommandList: Codable, Sendable { var commands: [SlashCommand] }
struct UsageResult: Codable, Sendable { var usage: Usage? }

public struct FileEntry: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable { case file, dir }
    /// Relative to the search root.
    public var path: String
    public var kind: Kind
    public var id: String { path }

    public init(path: String, kind: Kind) {
        self.path = path
        self.kind = kind
    }
}

public struct FileSearchResult: Codable, Sendable {
    public var root: String
    public var entries: [FileEntry]
}

struct FileSearchParams: Codable, Sendable {
    var agentId: String?
    var cwd: String?
    var query: String
    var limit: Int?
}

struct ShellParams: Codable, Sendable {
    var id: String
    var command: String
}

/// A server this one can call (configured with `casm peer add` on the server; read-only here).
public struct Peer: Codable, Sendable, Hashable, Identifiable {
    public var name: String
    public var url: String
    public var serverId: String?
    public var reachable: Bool?
    public var id: String { name }
}

struct PeerList: Codable, Sendable { var peers: [Peer] }
struct PeerListParams: Codable, Sendable { var probe: Bool? }
public struct AgentList: Codable, Sendable { public var agents: [Agent] }

public struct CreateProjectParams: Codable, Sendable {
    public var name: String
    public var parentId: String?
    public var path: String?
    public var tags: [String]?

    public init(name: String, parentId: String? = nil, path: String? = nil, tags: [String]? = nil) {
        self.name = name
        self.parentId = parentId
        self.path = path
        self.tags = tags
    }
}

public struct CreateAgentParams: Codable, Sendable {
    public var projectId: String
    public var provider: ProviderID
    public var name: String?
    public var cwd: String?
    public var config: AgentConfig?
    public var tags: [String]?
    public var prompt: String?
    public var images: [ImageData]?

    public init(projectId: String, provider: ProviderID, name: String? = nil, cwd: String? = nil,
                config: AgentConfig? = nil, tags: [String]? = nil, prompt: String? = nil) {
        self.projectId = projectId
        self.provider = provider
        self.name = name
        self.cwd = cwd
        self.config = config
        self.tags = tags
        self.prompt = prompt
    }
}

public struct HistoryParams: Codable, Sendable {
    public var id: String
    public var before: Int?
    public var limit: Int?
}

public struct HistoryPage: Codable, Sendable {
    public var items: [Item]
    /// Index of `items[0]` in the full transcript; pass it as `before` for the previous page.
    public var start: Int
    public var total: Int
}

public struct SubscribeResult: Codable, Sendable {
    public var status: AgentStatus
    /// Events of the in-flight turn, for clients that subscribe mid-turn.
    public var turn: [AgentEvent]
    public var permissions: [PermissionRequest]
    /// Pending questions; absent from servers older than the questions change.
    public var questions: [QuestionRequest]

    private enum CodingKeys: String, CodingKey { case status, turn, permissions, questions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(AgentStatus.self, forKey: .status)
        turn = try c.decode([AgentEvent].self, forKey: .turn)
        permissions = try c.decode([PermissionRequest].self, forKey: .permissions)
        questions = try c.decodeIfPresent([QuestionRequest].self, forKey: .questions) ?? []
    }
}

struct CatalogParams: Codable, Sendable {
    var provider: ProviderID
    var refresh: Bool?
}

public struct UpdateAgentParams: Codable, Sendable {
    public var id: String
    public var name: String?
    public var projectId: String?
    /// Replaces the stored config; send the full config, not a patch.
    public var config: AgentConfig?
    public var tags: [String]?
    public var archived: Bool?

    public init(id: String, name: String? = nil, projectId: String? = nil, config: AgentConfig? = nil,
                tags: [String]? = nil, archived: Bool? = nil) {
        self.id = id
        self.name = name
        self.projectId = projectId
        self.config = config
        self.tags = tags
        self.archived = archived
    }
}

struct AnswerQuestionParams: Codable, Sendable {
    var id: String
    var requestId: String
    var answers: [String: AnswerValue]?
}

public enum WhenBusy: String, Codable, Sendable { case queue, steer }

public struct SendParams: Codable, Sendable {
    public var id: String
    public var text: String
    public var images: [ImageData]?
    public var whenBusy: WhenBusy?
}

public struct SendResult: Codable, Sendable { public var queued: Bool }

public struct RespondPermissionParams: Codable, Sendable {
    public var id: String
    public var requestId: String
    public var decision: PermissionDecision
    public var message: String?
}

public extension RPCClient {
    func serverInfo() async throws -> ServerInfo {
        try await call("server.info", EmptyParams())
    }

    func catalog(provider: ProviderID, refresh: Bool = false) async throws -> Catalog {
        try await call("provider.catalog", CatalogParams(provider: provider, refresh: refresh ? true : nil))
    }

    func listProjects() async throws -> [Project] {
        try await (call("project.list", EmptyParams()) as ProjectList).projects
    }

    func createProject(_ params: CreateProjectParams) async throws -> Project {
        try await call("project.create", params)
    }

    func listAgents() async throws -> [Agent] {
        try await (call("agent.list", EmptyParams()) as AgentList).agents
    }

    func createAgent(_ params: CreateAgentParams) async throws -> Agent {
        try await call("agent.create", params)
    }

    func usage(agentId: String) async throws -> Usage? {
        try await (call("agent.usage", ByID(id: agentId)) as UsageResult).usage
    }

    func commands(agentId: String) async throws -> [SlashCommand] {
        try await (call("agent.commands", ByID(id: agentId)) as CommandList).commands
    }

    /// Files and directories for @-mentions, under the agent's cwd or `cwd`.
    func searchFiles(agentId: String? = nil, cwd: String? = nil, query: String, limit: Int? = 50) async throws -> FileSearchResult {
        try await call("fs.search", FileSearchParams(agentId: agentId, cwd: cwd, query: query, limit: limit))
    }

    /// Runs "!command" as its own turn. Fails with code 1002 while a turn runs.
    func shell(agentId: String, command: String) async throws {
        let _: OK = try await call("agent.shell", ShellParams(id: agentId, command: command))
    }

    func peers(probe: Bool = false) async throws -> [Peer] {
        try await (call("peer.list", PeerListParams(probe: probe ? true : nil)) as PeerList).peers
    }

    func updateAgent(_ params: UpdateAgentParams) async throws -> Agent {
        try await call("agent.update", params)
    }

    func history(agentId: String, before: Int? = nil, limit: Int? = nil) async throws -> HistoryPage {
        try await call("agent.history", HistoryParams(id: agentId, before: before, limit: limit))
    }

    func subscribe(agentId: String) async throws -> SubscribeResult {
        try await call("agent.subscribe", ByID(id: agentId))
    }

    func unsubscribe(agentId: String) async throws {
        let _: OK = try await call("agent.unsubscribe", ByID(id: agentId))
    }

    @discardableResult
    func send(agentId: String, text: String, images: [ImageData] = [], whenBusy: WhenBusy? = nil) async throws -> SendResult {
        try await call("agent.send", SendParams(id: agentId, text: text, images: images.isEmpty ? nil : images, whenBusy: whenBusy))
    }

    func interrupt(agentId: String) async throws {
        let _: OK = try await call("agent.interrupt", ByID(id: agentId))
    }

    func reload(agentId: String) async throws {
        let _: OK = try await call("agent.reload", ByID(id: agentId))
    }

    func restart(agentId: String) async throws {
        let _: OK = try await call("agent.restart", ByID(id: agentId))
    }

    /// `answers == nil` dismisses the question.
    func answerQuestion(agentId: String, requestId: String, answers: [String: AnswerValue]?) async throws {
        let _: OK = try await call("agent.answerQuestion", AnswerQuestionParams(id: agentId, requestId: requestId, answers: answers))
    }

    func respondPermission(agentId: String, requestId: String, decision: PermissionDecision, message: String? = nil) async throws {
        let _: OK = try await call("agent.respondPermission",
                                   RespondPermissionParams(id: agentId, requestId: requestId, decision: decision, message: message))
    }
}
