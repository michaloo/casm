import Foundation

/// Which agent's chat: agent ids are only unique per host.
struct ChatKey: Hashable {
    var host: UUID
    var agent: String
}

/// Recently opened chats, least recently used first, so going back to one shows it at once.
/// Only the policy; the app closes (unsubscribes) whatever this hands back as evicted.
struct ChatCache<Key: Hashable, Value> {
    let capacity: Int
    private(set) var entries: [(key: Key, value: Value)] = []

    init(capacity: Int) {
        self.capacity = capacity
    }

    var keys: [Key] { entries.map(\.key) }

    /// The cached value, made the most recently used.
    mutating func take(_ key: Key) -> Value? {
        guard let i = entries.firstIndex(where: { $0.key == key }) else { return nil }
        let entry = entries.remove(at: i)
        entries.append(entry)
        return entry.value
    }

    /// Adds (or replaces) the value as the most recently used; returns what fell out: the value
    /// it replaced and the least recently used ones beyond capacity.
    @discardableResult
    mutating func insert(_ value: Value, for key: Key) -> [Value] {
        var evicted = removeAll { k, _ in k == key }
        entries.append((key, value))
        while entries.count > capacity { evicted.append(entries.removeFirst().value) }
        return evicted
    }

    /// Removes the entries that match; returns their values.
    @discardableResult
    mutating func removeAll(where gone: (Key, Value) -> Bool) -> [Value] {
        var evicted: [Value] = []
        entries.removeAll { entry in
            guard gone(entry.key, entry.value) else { return false }
            evicted.append(entry.value)
            return true
        }
        return evicted
    }
}
