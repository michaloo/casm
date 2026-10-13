// JSON-RPC 2.0 over one URLSessionWebSocketTask, authenticated with
// `Authorization: Bearer` on the upgrade request. Reconnects with exponential
// backoff; a connection counts as up once `server.info` answers.
import Foundation

public enum ConnectionState: Sendable, Equatable {
    /// Not started, or stopped.
    case disconnected
    case connecting(attempt: Int)
    case connected(ServerInfo)
    /// Offline; the next attempt starts at `retryAt`.
    case waiting(retryAt: Date, error: String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

public enum RPCError: Error, LocalizedError, Sendable, Equatable {
    case notConnected
    case connectionLost
    case unauthorized
    /// An error response from the server.
    case server(code: Int, message: String)
    case badResponse(String)

    public var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to the host."
        case .connectionLost: "The connection to the host was lost."
        case .unauthorized: "The host rejected the token (401)."
        case .server(_, let message): message
        case .badResponse(let detail): "Unexpected response: \(detail)"
        }
    }
}

public actor RPCClient {
    public nonisolated let url: URL
    private let token: String
    private let session: URLSession

    /// Server notifications. Single consumer.
    public nonisolated let notifications: AsyncStream<ServerNotification>
    /// Every connection state change, starting with the current one. Single consumer.
    public nonisolated let states: AsyncStream<ConnectionState>
    private let notificationSink: AsyncStream<ServerNotification>.Continuation
    private let stateSink: AsyncStream<ConnectionState>.Continuation

    public private(set) var state: ConnectionState = .disconnected {
        didSet { if state != oldValue { stateSink.yield(state) } }
    }

    private var socket: URLSessionWebSocketTask?
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var nextID = 1
    private var loop: Task<Void, Never>?
    private var backoff: Task<Void, Never>?
    private var closed: CheckedContinuation<Void, Never>?

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(url: URL, token: String, session: URLSession = .shared) {
        self.url = url
        self.token = token
        self.session = session
        (notifications, notificationSink) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
        (states, stateSink) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
        stateSink.yield(.disconnected)
    }

    deinit {
        loop?.cancel()
        backoff?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        notificationSink.finish()
        stateSink.finish()
    }

    /// Starts connecting and keeps the connection up until `stop()`.
    public func start() {
        guard loop == nil else { return }
        loop = Task { await self.run() }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
        backoff?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        state = .disconnected
    }

    /// Skips the remaining backoff delay, e.g. when the app comes to the foreground.
    public func reconnectNow() {
        backoff?.cancel()
    }

    // MARK: Calls

    public func call<P: Encodable & Sendable, R: Decodable & Sendable>(_ method: String, _ params: P) async throws -> R {
        guard let socket, state.isConnected || method == "server.info" else { throw RPCError.notConnected }
        let data = try await request(on: socket, method: method, params: params)
        do {
            return try decoder.decode(ResultBox<R>.self, from: data).result
        } catch {
            throw RPCError.badResponse("\(method): \(error)")
        }
    }

    private func request<P: Encodable>(on socket: URLSessionWebSocketTask, method: String, params: P) async throws -> Data {
        let id = nextID
        nextID += 1
        let body = try encoder.encode(Request(id: id, method: method, params: params))
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            Task {
                do {
                    try await socket.send(.string(String(decoding: body, as: UTF8.self)))
                } catch {
                    self.resolve(id, with: .failure(RPCError.connectionLost))
                }
            }
        }
    }

    private func resolve(_ id: Int, with result: Result<Data, Error>) {
        pending.removeValue(forKey: id)?.resume(with: result)
    }

    // MARK: Connection loop

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            attempt += 1
            state = .connecting(attempt: attempt)
            var failure = "connection closed"
            do {
                let info = try await connect()
                attempt = 0
                state = .connected(info)
                // No suspension between the check and storing the continuation, so a close can't slip in.
                if socket != nil { await withCheckedContinuation { closed = $0 } }
            } catch RPCError.unauthorized {
                failure = RPCError.unauthorized.errorDescription!
            } catch {
                failure = error.localizedDescription
            }
            tearDown()
            if Task.isCancelled { break }
            // 0.5 s, 1 s, 2 s … capped at 30 s, with some jitter.
            let delay = min(30, 0.5 * pow(2, Double(max(attempt, 1) - 1))) * Double.random(in: 0.8...1.2)
            state = .waiting(retryAt: Date().addingTimeInterval(delay), error: failure)
            let sleeper = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
            backoff = sleeper
            await sleeper.value
        }
        tearDown()
    }

    private func connect() async throws -> ServerInfo {
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 15
        let socket = session.webSocketTask(with: req)
        socket.maximumMessageSize = 64 * 1024 * 1024
        self.socket = socket
        socket.resume()
        Task { await self.receive(on: socket) }
        Task { await self.ping(socket) }
        do {
            return try await call("server.info", EmptyParams())
        } catch {
            if (socket.response as? HTTPURLResponse)?.statusCode == 401 { throw RPCError.unauthorized }
            throw error
        }
    }

    private func tearDown() {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        for cont in pending.values { cont.resume(throwing: RPCError.connectionLost) }
        pending.removeAll()
    }

    private func socketClosed(_ socket: URLSessionWebSocketTask) {
        guard socket === self.socket else { return }
        for cont in pending.values { cont.resume(throwing: RPCError.connectionLost) }
        pending.removeAll()
        self.socket = nil
        closed?.resume()
        closed = nil
    }

    private func receive(on socket: URLSessionWebSocketTask) async {
        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await socket.receive()
            } catch {
                socketClosed(socket)
                return
            }
            let data: Data
            switch message {
            case .string(let s): data = Data(s.utf8)
            case .data(let d): data = d
            @unknown default: continue
            }
            handle(data)
        }
    }

    /// Detects half-open connections (sleeping laptops, network switches).
    private func ping(_ socket: URLSessionWebSocketTask) async {
        while true {
            try? await Task.sleep(for: .seconds(20))
            guard socket === self.socket, state.isConnected else { return }
            let alive = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                socket.sendPing { cont.resume(returning: $0 == nil) }
            }
            if !alive { socket.cancel(with: .goingAway, reason: nil) }
        }
    }

    private func handle(_ data: Data) {
        guard let probe = try? decoder.decode(Probe.self, from: data) else { return }
        if let method = probe.method {
            if let note = try? ServerNotification(method: method, data: data, decoder: decoder) {
                notificationSink.yield(note)
            }
        } else if let id = probe.id {
            if let error = probe.error {
                resolve(id, with: .failure(RPCError.server(code: error.code, message: error.message)))
            } else {
                resolve(id, with: .success(data))
            }
        }
    }
}

private struct Request<P: Encodable>: Encodable {
    var jsonrpc = "2.0"
    var id: Int
    var method: String
    var params: P
}

private struct ResultBox<R: Decodable>: Decodable { var result: R }

/// Just enough of an envelope to route it.
private struct Probe: Decodable {
    struct ErrorBody: Decodable { var code: Int; var message: String }
    var id: Int?
    var method: String?
    var error: ErrorBody?
}
