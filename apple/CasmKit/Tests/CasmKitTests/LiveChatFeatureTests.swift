import Foundation
import Testing
@testable import CasmKit

/// The round-3 calls against a real server:
/// `CASM_TEST_URL=ws://127.0.0.1:7474 CASM_TEST_TOKEN=… CASM_TEST_DIR=/tmp/dir swift test --filter LiveChatFeatures`.
/// Uses the claude provider but never sends a prompt to a model.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["CASM_TEST_URL"] != nil), .serialized)
struct LiveChatFeatures {
    let env = ProcessInfo.processInfo.environment

    func connect() async throws -> RPCClient {
        let client = RPCClient(url: URL(string: env["CASM_TEST_URL"]!)!, token: env["CASM_TEST_TOKEN"] ?? "")
        await client.start()
        for await state in client.states where state.isConnected { break }
        return client
    }

    /// A fresh project + claude agent in CASM_TEST_DIR.
    func makeAgent(_ client: RPCClient) async throws -> Agent {
        let dir = env["CASM_TEST_DIR"] ?? NSTemporaryDirectory()
        let project = try await client.createProject(CreateProjectParams(path: dir, name: "t-\(UUID().uuidString.prefix(6))", group: "tests"))
        return try await client.createAgent(CreateAgentParams(projectId: project.id, provider: .claude, config: AgentConfig(model: "haiku")))
    }

    @Test func infoPeersUsageCommandsSearch() async throws {
        let client = try await connect()
        let info = try await client.serverInfo()
        #expect(info.id?.isEmpty == false)
        #expect(try await client.peers().isEmpty)

        let agent = try await makeAgent(client)
        #expect(try await client.usage(agentId: agent.id) == nil, "no usage before the first run")

        let commands = try await client.commands(agentId: agent.id)
        #expect(commands.allSatisfy { !$0.name.isEmpty })

        let found = try await client.searchFiles(agentId: agent.id, query: "readme")
        #expect(found.entries.contains { $0.path.lowercased().contains("readme") && $0.kind == .file })
        await client.stop()
    }

    @Test func agentsMdAndMemories() async throws {
        let client = try await connect()
        let dir = (env["CASM_TEST_DIR"] ?? NSTemporaryDirectory()) + "/agentsmd-\(UUID().uuidString.prefix(6))"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let project = try await client.createProject(CreateProjectParams(path: dir))
        let before = try await client.agentsMd(projectId: project.id)
        #expect(before.content == nil, "no AGENTS.md yet")
        let written = try await client.setAgentsMd(projectId: project.id, content: "# Notes\n\nBe brief.\n")
        #expect(written.content == "# Notes\n\nBe brief.\n")
        #expect(try String(contentsOfFile: written.path, encoding: .utf8) == "# Notes\n\nBe brief.\n")
        #expect(try await client.agentsMd(projectId: project.id).content == written.content)
        let memories = try await client.memories(projectId: project.id)
        #expect(memories.allSatisfy { !$0.location.isEmpty })
        await client.stop()
    }

    /// Needs a provider that implements shell; enable with CASM_TEST_SHELL=1.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CASM_TEST_SHELL"] != nil))
    func shellRunsAsATurnAndRejectsWhileBusy() async throws {
        let client = try await connect()
        let agent = try await makeAgent(client)
        _ = try await client.subscribe(agentId: agent.id)

        try await client.shell(agentId: agent.id, command: "sleep 1; echo casm-shell-ok")
        // A second command while the first runs is refused with Busy (1002).
        await #expect(throws: RPCError.self) { try await client.shell(agentId: agent.id, command: "echo again") }
        do {
            try await client.shell(agentId: agent.id, command: "echo again")
        } catch let RPCError.server(code, _) {
            #expect(code == 1002)
        }

        var output = ""
        var ended = false
        for await note in client.notifications {
            guard case .agentEvent(agent.id, let event) = note else { continue }
            switch event {
            case .toolOutput(_, let text): output += text
            case .item(.tool(let call)) where call.output != nil: output = call.output ?? output
            case .turnEnded: ended = true
            default: break
            }
            if ended { break }
        }
        #expect(output.contains("casm-shell-ok"))
        await client.stop()
    }
}
