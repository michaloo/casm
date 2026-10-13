// Params and results of the methods the apps use, with typed wrappers on RPCClient.
import Foundation

public struct EmptyParams: Codable, Sendable { public init() {} }
public struct OK: Codable, Sendable { public var ok: Bool }
struct ByID: Codable, Sendable { var id: String }

public struct ServerInfo: Codable, Sendable, Hashable {
    public var name: String
    public var version: String
    public var `protocol`: Int
    public var providers: [ProviderID]
}

public struct ProjectList: Codable, Sendable { public var projects: [Project] }
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
    func send(agentId: String, text: String, whenBusy: WhenBusy? = nil) async throws -> SendResult {
        try await call("agent.send", SendParams(id: agentId, text: text, whenBusy: whenBusy))
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
