import XCTest

/// Drives the iOS app against a running casm server (scripts/run-dev.sh's server on 127.0.0.1:7373):
/// open an agent, switch mode, send, answer a permission and a question. Screenshots go to
/// $CASM_SHOTS (default /tmp/casm-shots). Needs an agent named "writer" in project "Playground".
@MainActor
final class FlowTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["CASM_DEV_URL"] = env["CASM_URL"] ?? "ws://127.0.0.1:7373"
        app.launchEnvironment["CASM_DEV_TOKEN"] = env["CASM_TOKEN"] ?? ""
        app.launchEnvironment["CASM_EXP"] = env["CASM_EXP"] ?? ""
        app.launch()
    }

    func shot(_ name: String) {
        let dir = env["CASM_SHOTS"] ?? "/tmp/casm-shots"
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func element(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
    }

    func send(_ text: String) {
        let field = app.textFields["Message"]
        field.tap()
        field.typeText(text)
        // On iPhone Return inserts a newline; sending is the Send button.
        app.buttons["Send"].tap()
    }

    /// Just opens the agent; for layout checks (`-only-testing:CasmiOSUITests/FlowTests/testOpenChat`).
    func testOpenChat() throws {
        XCTAssertTrue(element("writer").waitForExistence(timeout: 10))
        element("writer").tap()
        XCTAssertTrue(app.textFields["Message"].waitForExistence(timeout: 10))
        sleep(2)
        shot("i-open-\(env["CASM_EXP"] ?? "")")
    }

    func testMainFlows() throws {
        XCTAssertTrue(element("writer").waitForExistence(timeout: 10), "agent list loaded")
        shot("i01-sidebar")

        element("writer").tap()
        XCTAssertTrue(app.textFields["Message"].waitForExistence(timeout: 10))
        sleep(1)
        shot("i02-chat")

        // Mode popover: switch to "Always ask" so the next write needs a permission.
        app.buttons.matching(NSPredicate(format: "label ENDSWITH 'mode' OR label == 'Always ask' OR label == 'Bypass'")).firstMatch.tap()
        let search = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Search modes'")).firstMatch
        if !search.waitForExistence(timeout: 5) {
            shot("dbg-after-mode-tap")
            print("TREE\n" + app.debugDescription)
            XCTFail("mode popover open")
            return
        }
        shot("i03-mode-popover")
        element("Always ask").firstMatch.tap()
        sleep(1)

        // Permission card.
        send("Use the Write tool to create ios-check.txt containing 'ios'. Then reply 'ok'.")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 60), "permission card")
        shot("i04-permission")
        app.buttons["Allow"].tap()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 60), "turn finished")
        sleep(2)
        shot("i05-after-allow")

        // Question card.
        send("Use the AskUserQuestion tool to ask me which color I prefer: red, green or blue (single choice). Then tell me my answer.")
        XCTAssertTrue(app.buttons["Submit"].waitForExistence(timeout: 60), "question card")
        shot("i06-question")
        element("Blue").tap()
        app.buttons["Submit"].tap()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 60), "turn finished")
        sleep(2)
        shot("i07-answered")

        // Back to the list (navigation stack).
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(element("writer").waitForExistence(timeout: 5))
    }
}
