// UI driver for real interaction tests: Accessibility presses, mouse clicks, typing and
// window screenshots. Needs Accessibility + Screen Recording for the process that runs it
// (we run it through Terminal, see scripts/ui).
//
//   uictl press <app> <title>          AXPress the first element whose title/description matches
//   uictl showmenu <app> <title>       open the context menu of a matching element
//   uictl dump <app> [depth]           print the AX tree (role, title, description, frame)
//   uictl click <x> <y> [app]          left click at global point (top-left origin); with app, only if frontmost
//   uictl clickel <app> <title>        click the centre of a matching element
//   uictl type <text>                  type text into the focused field
//   uictl key <return|escape|tab|down|up|space> [cmd|shift|opt]...
//   uictl shot <app> <path> [region]   screenshot the app's frontmost window; "region" includes popovers
//   uictl screen <path>                screenshot the whole screen
//   uictl closewins <app> <title>      close windows whose title contains <title>
//   uictl minimize <app> <title>       minimize windows whose title contains <title>
//   uictl scroll <app> <element> <dy> <n> <ms>  trackpad-style scroll over an element
//   uictl front <app>                  activate the app
//   uictl trust                        prompt for Accessibility permission
import AppKit
import ApplicationServices

func app(_ name: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.localizedName == name || $0.bundleIdentifier == name }
}

func attr(_ el: AXUIElement, _ key: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, key as CFString, &v) == .success ? v : nil
}

func children(_ el: AXUIElement) -> [AXUIElement] { attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] }

func label(_ el: AXUIElement) -> [String] {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute, "AXIdentifier"]
        .compactMap { attr(el, $0) as? String }.filter { !$0.isEmpty }
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return CGRect(origin: point, size: size)
}

/// `title` may be qualified with a role, e.g. `AXTextField@Token`.
func find(_ root: AXUIElement, _ title: String, depth: Int = 0) -> AXUIElement? {
    if depth > 40 { return nil }
    let parts = title.split(separator: "@", maxSplits: 1).map(String.init)
    let (role, name) = parts.count == 2 && parts[0].hasPrefix("AX") ? (parts[0], parts[1]) : (nil, title)
    if label(root).contains(where: { $0 == name }), role == nil || (attr(root, kAXRoleAttribute) as? String) == role { return root }
    for c in children(root) { if let hit = find(c, title, depth: depth + 1) { return hit } }
    return nil
}

func dump(_ el: AXUIElement, _ depth: Int, _ max: Int) {
    guard depth <= max else { return }
    let role = attr(el, kAXRoleAttribute) as? String ?? "?"
    let f = frame(el).map { "(\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height)))" } ?? ""
    print(String(repeating: "  ", count: depth) + role + " " + label(el).map { "\"\($0.prefix(60))\"" }.joined(separator: " ") + " " + f)
    for c in children(el) { dump(c, depth + 1, max) }
}

func root(_ name: String) -> AXUIElement {
    guard let a = app(name) else { fail("no app \(name)") }
    let el = AXUIElementCreateApplication(a.processIdentifier)
    // With a sheet open, look inside it first so a title can't match something behind it.
    for w in attr(el, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
        if let sheet = children(w).first(where: { (attr($0, kAXRoleAttribute) as? String) == "AXSheet" }) {
            return sheet
        }
    }
    return el
}

/// Activation from a background process is often refused, so also set AXFrontmost and raise the main window.
func bringToFront(_ name: String) {
    guard let a = app(name) else { fail("no app \(name)") }
    a.activate(options: [.activateAllWindows])
    let el = AXUIElementCreateApplication(a.processIdentifier)
    AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let w = (attr(el, kAXWindowsAttribute) as? [AXUIElement])?.first { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
    usleep(300_000)
}

/// Never click into someone else's window.
func requireFront(_ name: String) {
    bringToFront(name)
    guard NSWorkspace.shared.frontmostApplication == app(name) else { fail("\(name) is not frontmost; not clicking") }
}

/// Keyboard input goes to whatever is frontmost, so only send it to the app under test.
func requireOurAppFront() {
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
    guard ["casm", "Simulator"].contains(front) else { fail("\(front) is frontmost; not typing into it") }
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("uictl: \(msg)\n".utf8))
    exit(1)
}

func click(_ p: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}

let keyCodes: [String: CGKeyCode] = ["a": 0, "return": 36, "tab": 48, "space": 49, "escape": 53, "down": 125, "up": 126, "left": 123, "right": 124, "delete": 51]

func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
        e?.flags = flags
        e?.post(tap: .cghidEventTap)
        usleep(20_000)
    }
}

func type(_ text: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in text.utf16 {
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
            var c = ch
            e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
            // Don't inherit modifiers from the source state (a preceding ⌘A turned "." into ⌘.).
            e?.flags = []
            e?.post(tap: .cghidEventTap)
        }
        usleep(8_000)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("usage: see header") }
if cmd == "trust" {
    // Shows the system prompt that adds the responsible app (Terminal) to the Accessibility list.
    let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    print(trusted ? "trusted" : "not trusted yet")
    exit(0)
}
if !AXIsProcessTrusted() && cmd != "shot" { fail("not trusted for Accessibility") }

switch cmd {
case "front":
    bringToFront(args[1])
case "press":
    guard let el = find(root(args[1]), args[2]) else { fail("no element \(args[2])") }
    let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if r != .success { fail("press failed \(r.rawValue)") }
case "showmenu":
    // Opens an element's context menu.
    requireFront(args[1])
    guard let el = find(root(args[1]), args[2]) else { fail("no element \(args[2])") }
    let r = AXUIElementPerformAction(el, "AXShowMenu" as CFString)
    if r != .success { fail("show menu failed \(r.rawValue)") }
case "clickel":
    requireFront(args[1])
    guard let el = find(root(args[1]), args[2]), let f = frame(el) else { fail("no element \(args[2])") }
    click(CGPoint(x: f.midX, y: f.midY))
case "dump":
    dump(root(args[1]), 0, args.count > 2 ? Int(args[2])! : 12)
case "click":
    if args.count > 3 { requireFront(args[3]) }
    click(CGPoint(x: Double(args[1])!, y: Double(args[2])!))
case "type":
    requireOurAppFront()
    type(args[1...].joined(separator: " "))
case "key":
    var flags: CGEventFlags = []
    for m in args.dropFirst(2) {
        switch m {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt": flags.insert(.maskAlternate)
        default: break
        }
    }
    guard let code = keyCodes[args[1]] else { fail("unknown key \(args[1])") }
    requireOurAppFront()
    key(code, flags)
case "closewins":
    // Closes the app's windows whose title contains the given text (e.g. our Terminal helpers).
    let el = root(args[1])
    var closed = 0
    for w in attr(el, kAXWindowsAttribute) as? [AXUIElement] ?? [] where (attr(w, kAXTitleAttribute) as? String ?? "").contains(args[2]) {
        if let button = attr(w, kAXCloseButtonAttribute) {
            AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
            closed += 1
        }
    }
    print("closed \(closed)")
case "minimize":
    let el = root(args[1])
    for w in attr(el, kAXWindowsAttribute) as? [AXUIElement] ?? [] where (attr(w, kAXTitleAttribute) as? String ?? "").contains(args[2]) {
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    }
case "scroll":
    // scroll <app> <title-of-element-to-scroll-over> <dy per event> <events> <interval ms>
    // Continuous (trackpad-like) pixel scrolling through the normal event path. Positive dy scrolls up.
    requireFront(args[1])
    guard let el = find(root(args[1]), args[2]), let f = frame(el) else { fail("no element \(args[2])") }
    let p = CGPoint(x: f.midX, y: f.midY)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    let dy = Int32(args[3])!, n = Int(args[4])!, interval = useconds_t(Int(args[5])! * 1000)
    for i in 0..<n {
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)
        e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        // Trackpad phases: began, changed…, ended.
        e?.setIntegerValueField(.scrollWheelEventScrollPhase, value: i == 0 ? 1 : (i == n - 1 ? 4 : 2))
        e?.location = p
        e?.post(tap: .cghidEventTap)
        usleep(interval)
    }
case "screen":
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", args[1]]
    try p.run()
    p.waitUntilExit()
    exit(p.terminationStatus)
case "shot":
    guard let a = app(args[1]) else { fail("no app") }
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    // Frontmost normal-layer window of the app (sheets and popovers are separate windows; -l of the
    // parent includes attached sheets, popovers need a region shot instead).
    func area(_ w: [String: Any]) -> Double {
        let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return (b["Width"] ?? 0) * (b["Height"] ?? 0)
    }
    // The main window: the app's largest normal-layer window (popovers are small windows of their own).
    guard let win = infos.filter({ ($0[kCGWindowOwnerPID as String] as? pid_t) == a.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 })
            .max(by: { area($0) < area($1) }),
          let id = win[kCGWindowNumber as String] as? Int else { fail("no window") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // With "region", capture the window's rectangle from the screen so popovers and sheets on top are included.
    if args.count > 3, args[3] == "region", let b = win[kCGWindowBounds as String] as? [String: Double] {
        p.arguments = ["-x", "-R", "\(Int(b["X"]!)),\(Int(b["Y"]!)),\(Int(b["Width"]!)),\(Int(b["Height"]!))", args[2]]
    } else {
        p.arguments = ["-x", "-o", "-l", String(id), args[2]]
    }
    try p.run()
    p.waitUntilExit()
    exit(p.terminationStatus)
default:
    fail("unknown command \(cmd)")
}
