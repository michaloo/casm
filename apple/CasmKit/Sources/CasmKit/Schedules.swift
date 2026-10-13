// Host-level schedules: on a cadence, message an existing agent or start a new one from a preset.
import Foundation

public enum ScheduleCadence: Codable, Sendable, Hashable {
    /// 5-field cron in the server's local time.
    case cron(String)
    case every(minutes: Int)
    /// One run at an ISO time; the schedule disables itself afterwards.
    case once(at: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, expr, minutes, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "cron": self = .cron(try c.decode(String.self, forKey: .expr))
        case "every": self = .every(minutes: try c.decode(Int.self, forKey: .minutes))
        case "once": self = .once(at: try c.decode(String.self, forKey: .at))
        default: self = .unknown(type: type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .cron(let expr): try c.encode("cron", forKey: .type); try c.encode(expr, forKey: .expr)
        case .every(let minutes): try c.encode("every", forKey: .type); try c.encode(minutes, forKey: .minutes)
        case .once(let at): try c.encode("once", forKey: .type); try c.encode(at, forKey: .at)
        case .unknown(let type): try c.encode(type, forKey: .type)
        }
    }
}

public enum ScheduleWhenBusy: String, Codable, Sendable, Hashable { case queue, skip }

public enum ScheduleTarget: Codable, Sendable, Hashable {
    case agent(agentId: String, whenBusy: ScheduleWhenBusy?)
    case newAgent(projectId: String, provider: ProviderID, config: AgentConfig?, name: String?)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, agentId, whenBusy, projectId, provider, config, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "agent":
            self = .agent(agentId: try c.decode(String.self, forKey: .agentId),
                          whenBusy: try c.decodeIfPresent(ScheduleWhenBusy.self, forKey: .whenBusy))
        case "newAgent":
            self = .newAgent(projectId: try c.decode(String.self, forKey: .projectId),
                             provider: try c.decode(ProviderID.self, forKey: .provider),
                             config: try c.decodeIfPresent(AgentConfig.self, forKey: .config),
                             name: try c.decodeIfPresent(String.self, forKey: .name))
        default: self = .unknown(type: type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .agent(let agentId, let whenBusy):
            try c.encode("agent", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
            try c.encodeIfPresent(whenBusy, forKey: .whenBusy)
        case .newAgent(let projectId, let provider, let config, let name):
            try c.encode("newAgent", forKey: .type)
            try c.encode(projectId, forKey: .projectId)
            try c.encode(provider, forKey: .provider)
            try c.encodeIfPresent(config, forKey: .config)
            try c.encodeIfPresent(name, forKey: .name)
        case .unknown(let type):
            try c.encode(type, forKey: .type)
        }
    }

    public var agentId: String? { if case .agent(let id, _) = self { id } else { nil } }
}

public struct ScheduleRun: Codable, Sendable, Hashable {
    public enum Outcome: OpenEnum {
        case sent, queued, skipped, created, failed
        case unknown(String)

        public init?(rawValue: String) {
            switch rawValue {
            case "sent": self = .sent
            case "queued": self = .queued
            case "skipped": self = .skipped
            case "created": self = .created
            case "failed": self = .failed
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .sent: "sent"
            case .queued: "queued"
            case .skipped: "skipped"
            case .created: "created"
            case .failed: "failed"
            case .unknown(let raw): raw
            }
        }
    }

    public var at: String
    public var outcome: Outcome
    /// The agent it messaged or created.
    public var agentId: String?
    public var error: String?
}

public struct Schedule: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var enabled: Bool
    public var cadence: ScheduleCadence
    public var target: ScheduleTarget
    public var prompt: String
    public var nextRunAt: String?
    public var lastRun: ScheduleRun?
    public var createdAt: String
}

public struct CreateScheduleParams: Codable, Sendable {
    public var name: String?
    public var cadence: ScheduleCadence
    public var target: ScheduleTarget
    public var prompt: String
    public var enabled: Bool?

    public init(name: String? = nil, cadence: ScheduleCadence, target: ScheduleTarget, prompt: String, enabled: Bool? = nil) {
        self.name = name
        self.cadence = cadence
        self.target = target
        self.prompt = prompt
        self.enabled = enabled
    }
}

public struct UpdateScheduleParams: Codable, Sendable {
    public var id: String
    public var name: String?
    public var cadence: ScheduleCadence?
    public var target: ScheduleTarget?
    public var prompt: String?
    public var enabled: Bool?

    public init(id: String, name: String? = nil, cadence: ScheduleCadence? = nil, target: ScheduleTarget? = nil,
                prompt: String? = nil, enabled: Bool? = nil) {
        self.id = id
        self.name = name
        self.cadence = cadence
        self.target = target
        self.prompt = prompt
        self.enabled = enabled
    }
}

struct ScheduleList: Codable, Sendable { var schedules: [Schedule] }
struct ScheduleListParams: Codable, Sendable { var agentId: String? }

public extension RPCClient {
    func schedules(agentId: String? = nil) async throws -> [Schedule] {
        try await (call("schedule.list", ScheduleListParams(agentId: agentId)) as ScheduleList).schedules
    }

    func createSchedule(_ params: CreateScheduleParams) async throws -> Schedule {
        try await call("schedule.create", params)
    }

    func updateSchedule(_ params: UpdateScheduleParams) async throws -> Schedule {
        try await call("schedule.update", params)
    }

    func deleteSchedule(id: String) async throws {
        let _: OK = try await call("schedule.delete", ByID(id: id))
    }

    @discardableResult
    func runScheduleNow(id: String) async throws -> ScheduleRun {
        try await call("schedule.runNow", ByID(id: id))
    }
}
