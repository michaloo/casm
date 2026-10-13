// Params and results of the methods the apps use, with typed wrappers on RPCClient.
import Foundation

public struct EmptyParams: Codable, Sendable { public init() {} }
public struct OK: Codable, Sendable { public var ok: Bool }
struct ByID: Codable, Sendable { var id: String }
struct IncludeArchived: Codable, Sendable { var includeArchived: Bool? }

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

/// A project's AGENTS.md; `content` is nil when the file doesn't exist yet.
public struct AgentsMd: Codable, Sendable, Equatable {
    public var path: String
    public var content: String?
}

struct SetAgentsMdParams: Codable, Sendable {
    var id: String
    var content: String
}

public struct MemoryEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String?
    public var text: String
    public var updatedAt: String?

    public init(id: String, title: String? = nil, text: String, updatedAt: String? = nil) {
        self.id = id
        self.title = title
        self.text = text
        self.updatedAt = updatedAt
    }
}

/// The memories one coding agent (provider) keeps that apply to a project. Read-only in casm.
public struct AgentMemories: Codable, Sendable, Hashable {
    public enum Scope: OpenEnum {
        /// Stored per folder (Claude Code).
        case project
        /// Applies to every folder (Codex).
        case global
        case unknown(String)

        public init?(rawValue: String) {
            switch rawValue {
            case "project": self = .project
            case "global": self = .global
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .project: "project"
            case .global: "global"
            case .unknown(let raw): raw
            }
        }
    }

    public var provider: ProviderID
    public var scope: Scope
    /// Where the provider keeps them (a file or folder on the host).
    public var location: String
    public var entries: [MemoryEntry]

    public init(provider: ProviderID, scope: Scope, location: String, entries: [MemoryEntry]) {
        self.provider = provider
        self.scope = scope
        self.location = location
        self.entries = entries
    }
}

struct ProjectMemories: Codable, Sendable { var agents: [AgentMemories] }
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
    /// Absolute path on the server.
    public var path: String
    /// Defaults to the path's last segment.
    public var name: String?
    public var group: String?
    public var tags: [String]?

    public init(path: String, name: String? = nil, group: String? = nil, tags: [String]? = nil) {
        self.path = path
        self.name = name
        self.group = group
        self.tags = tags
    }
}

/// `project.update`: only group, tags, sort and archived can change after creation.
public struct UpdateProjectParams: Encodable, Sendable {
    public enum GroupChange: Sendable, Equatable {
        case set(String)
        /// Sends `null`: removes the project from its group.
        case clear
    }

    public var id: String
    public var group: GroupChange?
    public var tags: [String]?
    public var sort: Double?
    public var archived: Bool?

    public init(id: String, group: GroupChange? = nil, tags: [String]? = nil, sort: Double? = nil, archived: Bool? = nil) {
        self.id = id
        self.group = group
        self.tags = tags
        self.sort = sort
        self.archived = archived
    }

    private enum CodingKeys: String, CodingKey { case id, group, tags, sort, archived }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        switch group {
        case .set(let name): try c.encode(name, forKey: .group)
        case .clear: try c.encodeNil(forKey: .group)
        case nil: break
        }
        try c.encodeIfPresent(tags, forKey: .tags)
        try c.encodeIfPresent(sort, forKey: .sort)
        try c.encodeIfPresent(archived, forKey: .archived)
    }
}

/// `agent.create`. The agent works in its project's folder; there is no separate working directory.
public struct CreateAgentParams: Codable, Sendable {
    public var projectId: String
    public var provider: ProviderID
    public var name: String?
    public var config: AgentConfig?
    public var tags: [String]?
    public var prompt: String?
    public var images: [ImageData]?

    public init(projectId: String, provider: ProviderID, name: String? = nil,
                config: AgentConfig? = nil, tags: [String]? = nil, prompt: String? = nil) {
        self.projectId = projectId
        self.provider = provider
        self.name = name
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

/// `agent.update`. An agent's project is fixed at creation, so there is no way to move it.
public struct UpdateAgentParams: Codable, Sendable {
    public var id: String
    public var name: String?
    /// Replaces the stored config; send the full config, not a patch.
    public var config: AgentConfig?
    public var tags: [String]?
    public var archived: Bool?

    public init(id: String, name: String? = nil, config: AgentConfig? = nil,
                tags: [String]? = nil, archived: Bool? = nil) {
        self.id = id
        self.name = name
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

    func listProjects(includeArchived: Bool = false) async throws -> [Project] {
        try await (call("project.list", IncludeArchived(includeArchived: includeArchived ? true : nil)) as ProjectList).projects
    }

    func createProject(_ params: CreateProjectParams) async throws -> Project {
        try await call("project.create", params)
    }

    func updateProject(_ params: UpdateProjectParams) async throws -> Project {
        try await call("project.update", params)
    }

    /// Also stops and removes the project's agents on the server.
    func deleteProject(id: String) async throws {
        let _: OK = try await call("project.delete", ByID(id: id))
    }

    func deleteAgent(id: String) async throws {
        let _: OK = try await call("agent.delete", ByID(id: id))
    }

    func agentsMd(projectId: String) async throws -> AgentsMd {
        try await call("project.agentsMd", ByID(id: projectId))
    }

    /// Writes (or creates) the project's AGENTS.md.
    func setAgentsMd(projectId: String, content: String) async throws -> AgentsMd {
        try await call("project.setAgentsMd", SetAgentsMdParams(id: projectId, content: content))
    }

    /// Each installed coding agent's memories for the project folder (read-only).
    func memories(projectId: String) async throws -> [AgentMemories] {
        try await (call("project.memories", ByID(id: projectId)) as ProjectMemories).agents
    }

    func listAgents(includeArchived: Bool = false) async throws -> [Agent] {
        try await (call("agent.list", IncludeArchived(includeArchived: includeArchived ? true : nil)) as AgentList).agents
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
