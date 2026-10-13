import Foundation
import Testing
@testable import CasmKit

/// Talks to a real server: `CASM_TEST_URL=ws://127.0.0.1:7373 CASM_TEST_TOKEN=… swift test`.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["CASM_TEST_URL"] != nil))
struct LiveServerTests {
    let env = ProcessInfo.processInfo.environment

    @Test func connectsAndCalls() async throws {
        let client = RPCClient(url: URL(string: env["CASM_TEST_URL"]!)!, token: env["CASM_TEST_TOKEN"] ?? "")
        await client.start()
        for await state in client.states where state.isConnected { break }
        let projects = try await client.listProjects()
        _ = try await client.listAgents()
        _ = projects
        await #expect(throws: RPCError.self) { try await client.history(agentId: "nope") }
        await client.stop()
    }

    @Test func rejectsBadToken() async throws {
        let client = RPCClient(url: URL(string: env["CASM_TEST_URL"]!)!, token: "wrong")
        await client.start()
        for await state in client.states {
            if case .waiting(_, let error) = state {
                #expect(error.contains("401"))
                break
            }
        }
        await client.stop()
    }
}
