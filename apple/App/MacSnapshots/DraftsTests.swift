import CasmKit
import XCTest

@MainActor
final class DraftsTests: XCTestCase {
    func testDraftsPersistPerAgentAndClear() throws {
        let suite = "casm.tests.drafts.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let host = UUID()
        let a = Drafts.key(host: host, agent: "a"), b = Drafts.key(host: host, agent: "b")
        XCTAssertNotEqual(Drafts.key(host: UUID(), agent: "a"), a, "same agent id on another host is another draft")

        let drafts = Drafts(defaults: defaults)
        drafts.save(a, text: "half a thought", images: [ImageData(mediaType: "image/png", data: "AA==")])
        drafts.save(b, text: "other agent", images: [])
        var answers = Drafts.Answers()
        answers.picked["q0"] = ["Blue"]
        answers.other["q1"] = "Typed"
        drafts.save("req-1", answers: answers)

        // A new instance (relaunch) reads text and answers back; images are memory-only.
        let reloaded = Drafts(defaults: defaults)
        XCTAssertEqual(reloaded.text(a), "half a thought")
        XCTAssertEqual(reloaded.text(b), "other agent")
        XCTAssertTrue(reloaded.images(a).isEmpty)
        XCTAssertEqual(drafts.images(a).count, 1)
        XCTAssertEqual(reloaded.answers("req-1"), answers)

        // Sending (empty text) and resolving clear them.
        reloaded.save(a, text: "", images: [])
        reloaded.clearAnswers("req-1")
        let after = Drafts(defaults: defaults)
        XCTAssertEqual(after.text(a), "")
        XCTAssertEqual(after.text(b), "other agent")
        XCTAssertTrue(after.answers("req-1").isEmpty)
    }
}
