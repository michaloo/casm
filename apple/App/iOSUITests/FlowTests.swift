import XCTest

/// Drives the iOS app against a running casm server. Expects (create with the CLI first):
///   casm project create /tmp/casm-scratch/ios --name "iOS Scratch" --group Scratch
///   casm run --project "iOS Scratch" --name ios-scratch --model haiku --mode default "Reply with just: ready"
/// testFailedPendingAndThinkingRows retries a failed message if ios-scratch has one: send it a slow
/// prompt and stop the server before it answers.
/// Runner env (prefix with TEST_RUNNER_ for xcodebuild): CASM_URL, CASM_TOKEN, CASM_SHOTS.
@MainActor
final class FlowTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["CASM_DEV_URL"] = env["CASM_URL"] ?? "ws://127.0.0.1:7373"
        app.launchEnvironment["CASM_DEV_TOKEN"] = env["CASM_TOKEN"] ?? ""
        app.launchEnvironment["CASM_DEV_NAME"] = env["CASM_HOST_NAME"] ?? "macbook"
        app.launchEnvironment["CASM_DEV_REPLACE"] = "1"
        app.launchEnvironment["CASM_EXP"] = env["CASM_EXP"] ?? ""
        app.launch()
    }

    func shot(_ name: String) {
        let dir = env["CASM_SHOTS"] ?? "/tmp/casm-shots"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
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

    func openAgent() {
        XCTAssertTrue(element("ios-scratch").waitForExistence(timeout: 15), "agent list loaded")
        element("ios-scratch").tap()
        XCTAssertTrue(app.textFields["Message"].waitForExistence(timeout: 10))
        sleep(1)
    }

    /// The turn is over when the round button is Send again (Interrupt while busy).
    func waitIdle(_ timeout: TimeInterval = 90) {
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: timeout), "turn finished")
    }

    func testSidebarAndProjectDetails() throws {
        XCTAssertTrue(element("ios-scratch").waitForExistence(timeout: 15))
        XCTAssertTrue(element("Scratch").exists, "group label shown")
        shot("ios-01-sidebar")

        element("iOS Scratch").swipeLeft()
        app.buttons["Details"].tap()
        XCTAssertTrue(element("AGENTS.md").waitForExistence(timeout: 10))
        sleep(1)
        shot("ios-02-details-agentsmd")
        if element("Create AGENTS.md").exists {
            element("Create AGENTS.md").tap()
            sleep(1)
            app.buttons["Create"].tap()
            sleep(2)
            shot("ios-03-details-agentsmd-created")
        }
        element("Memories").tap()
        sleep(2)
        shot("ios-04-details-memories")
        app.buttons["Done"].tap()
    }

    func testComposerAndModeSheet() throws {
        openAgent()
        shot("ios-05-chat")

        // + menu: Photo Library and Paste Image.
        app.buttons["Attach images"].tap()
        XCTAssertTrue(element("Paste Image").waitForExistence(timeout: 5))
        shot("ios-06-plus-menu")
        app.tap() // dismiss
        sleep(1)

        // An image on the clipboard shows the paste chip.
        UIPasteboard.general.image = Self.sampleImage()
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(element("Paste image from clipboard").waitForExistence(timeout: 5), "paste chip")
        shot("ios-07-paste-chip")
        // iOS asks before an app reads another app's clipboard.
        addUIInterruptionMonitor(withDescription: "Allow Paste") { alert in
            alert.buttons["Allow Paste"].exists ? (alert.buttons["Allow Paste"].tap(), true).1 : false
        }
        element("Paste image from clipboard").tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow Paste"].waitForExistence(timeout: 3) { springboard.buttons["Allow Paste"].tap() }
        XCTAssertTrue(app.buttons["Remove image"].waitForExistence(timeout: 5), "thumbnail attached")
        shot("ios-08-attached")
        app.buttons["Remove image"].tap()

        // Mode sheet lists the provider's catalog (Claude: Always ask, …).
        app.buttons.matching(NSPredicate(format: "label == 'Always ask' OR label ENDSWITH 'mode' OR label == 'Default mode'")).firstMatch.tap()
        XCTAssertTrue(app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Search modes'")).firstMatch
            .waitForExistence(timeout: 5), "mode sheet")
        shot("ios-09-mode-sheet")
        element("Always ask").tap()
        sleep(1)
    }

    func testPermissionAndQuestionCards() throws {
        openAgent()
        send("Use the Write tool to create ios-check.txt containing 'ios'. Then reply 'ok'.")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 90), "permission card")
        shot("ios-10-permission")
        app.buttons["Allow"].tap()
        waitIdle()

        send("Use the AskUserQuestion tool to ask me which color I prefer: red, green or blue (single choice). Then tell me my answer.")
        XCTAssertTrue(app.buttons["Submit"].waitForExistence(timeout: 90), "question card")
        shot("ios-11-question")
        element("Blue").tap()
        app.buttons["Submit"].tap()
        waitIdle()
        sleep(2)
        shot("ios-12-answered")
    }

    /// Tapping a project opens its empty new-agent chat; the first message creates the agent,
    /// named after the message, and the chat becomes that agent's.
    func testProjectTapStartsANewAgent() throws {
        XCTAssertTrue(element("iOS Scratch").waitForExistence(timeout: 15))
        element("iOS Scratch").tap()
        XCTAssertTrue(element("New agent in iOS Scratch").waitForExistence(timeout: 10), "new-agent chat")
        XCTAssertTrue(app.textFields["Message"].exists)
        sleep(1)
        shot("ios-13-new-agent-chat")
        let name = "Reply with just the word pong \(Int.random(in: 100...999))"
        send(name)
        // The chat switches to the new agent (its title is the message) without losing the message.
        XCTAssertTrue(app.navigationBars.staticTexts[name].waitForExistence(timeout: 20), "agent named after the message")
        XCTAssertTrue(element(name).exists, "first message shown")
        waitIdle()
        sleep(1)
        shot("ios-14-new-agent-created")

        // Clean up: each run creates an agent.
        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Delete Agent…"].waitForExistence(timeout: 5))
        app.buttons["Delete Agent…"].tap()
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
        app.buttons["Delete"].tap()
        XCTAssertTrue(app.navigationBars.staticTexts[name].waitForNonExistence(timeout: 10), "agent deleted")
    }

    /// A prompt kept as failed (make one by stopping the server mid-turn) shows its error with
    /// Retry; then a reasoning prompt shows a streaming Thinking row that expands when done.
    func testFailedPendingAndThinkingRows() throws {
        openAgent()
        if element("Not sent").waitForExistence(timeout: 5) {
            shot("ios-15-failed-pending")
            app.buttons["Retry"].tap()
            XCTAssertTrue(element("Not sent").waitForNonExistence(timeout: 10), "retried message leaves the strip")
            waitIdle(180)
        } else {
            print("no failed pending message for ios-scratch; skipping that part")
        }
        send("ultrathink: without tools, how many squares of any size are on a chessboard? Reason, then one line.")
        // While the turn runs the round button is Interrupt; the reasoning streams as a Thinking row.
        XCTAssertTrue(app.buttons["Interrupt"].waitForExistence(timeout: 20), "turn running")
        sleep(4)
        shot("ios-16-thinking-streaming")
        let thinking = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Thinking'"))
        waitIdle(180)
        guard thinking.count > 0 else { return XCTFail("no Thinking row after the turn") }
        let last = thinking.element(boundBy: thinking.count - 1)
        last.tap()
        sleep(1)
        shot("ios-17-thinking-expanded")
    }

    /// Going back to a chat opened before shows its transcript at once (cached), not a reload.
    func testSwitchingBackShowsCachedTranscript() throws {
        openAgent()
        let transcript = app.descendants(matching: .any)["transcript"]
        let texts = transcript.staticTexts
        XCTAssertTrue(texts.firstMatch.waitForExistence(timeout: 15), "ios-scratch transcript loaded")
        sleep(2)
        let seen = texts.allElementsBoundByIndex.suffix(3).map(\.label).filter { !$0.isEmpty }
        XCTAssertFalse(seen.isEmpty)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(element("s46-think").waitForExistence(timeout: 10))
        element("s46-think").tap()
        XCTAssertTrue(texts.firstMatch.waitForExistence(timeout: 15), "s46-think transcript loaded")
        sleep(1)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(element("ios-scratch").waitForExistence(timeout: 10))
        element("ios-scratch").tap()
        // Well under a history round trip: the rows are already there.
        let label = try XCTUnwrap(seen.last)
        let row = transcript.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", String(label.prefix(60)))).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 1), "cached transcript shows immediately")
        shot("ios-19-cached-chat")
    }

    /// The host's schedules list (create some with `casm schedule add` first).
    func testSchedulesList() throws {
        XCTAssertTrue(element("ios-scratch").waitForExistence(timeout: 15), "sidebar loaded")
        // Schedules is the host's last row, below the projects.
        for _ in 0..<4 where !element("Schedules").isHittable { app.swipeUp() }
        element("Schedules").tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        shot("ios-18-schedules")
    }

    static func sampleImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 120, height: 80)).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 120, height: 80))
            UIColor.systemPink.setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 35, y: 15, width: 50, height: 50))
        }
    }
}
