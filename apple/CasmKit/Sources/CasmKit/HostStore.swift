// The client-side host list: names and URLs in UserDefaults, tokens in the Keychain.
import Foundation
import Security

public struct HostEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var name: String
    public var url: URL

    public init(id: UUID = UUID(), name: String, url: URL) {
        self.id = id
        self.name = name
        self.url = url
    }
}

public struct HostStore: Sendable {
    public static let defaultsKey = "casm.hosts"
    private let defaultsSuite: String?
    private let keychain: Keychain

    /// `suite` and `keychainService` exist so tests don't touch the real list.
    public init(suite: String? = nil, keychainService: String = "casm.host-token") {
        defaultsSuite = suite
        keychain = Keychain(service: keychainService)
    }

    private var defaults: UserDefaults { defaultsSuite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    public func load() -> [HostEntry] {
        guard let data = defaults.data(forKey: Self.defaultsKey) else { return [] }
        return (try? JSONDecoder().decode([HostEntry].self, from: data)) ?? []
    }

    private func save(_ hosts: [HostEntry]) {
        defaults.set(try? JSONEncoder().encode(hosts), forKey: Self.defaultsKey)
    }

    /// Adds the host, or updates it when one with the same id exists.
    public func upsert(_ host: HostEntry, token: String) throws {
        try keychain.set(token, account: host.id.uuidString)
        var hosts = load()
        if let i = hosts.firstIndex(where: { $0.id == host.id }) { hosts[i] = host } else { hosts.append(host) }
        save(hosts)
    }

    public func remove(_ id: UUID) {
        save(load().filter { $0.id != id })
        keychain.delete(account: id.uuidString)
    }

    public func token(for id: UUID) -> String? {
        keychain.get(account: id.uuidString)
    }
}

/// Generic-password items, one per account.
public struct Keychain: Sendable {
    public struct Failure: Error, LocalizedError {
        public var status: OSStatus
        public var errorDescription: String? {
            "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")"
        }
    }

    public var service: String

    public init(service: String) { self.service = service }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func set(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(account)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let status = SecItemAdd(add as CFDictionary, nil)
            guard status == errSecSuccess else { throw Failure(status: status) }
        } else if status != errSecSuccess {
            throw Failure(status: status)
        }
    }

    public func get(account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    public func delete(account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
