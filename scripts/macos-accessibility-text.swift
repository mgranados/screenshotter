#!/usr/bin/env swift
import AppKit
import ApplicationServices
import Foundation

let assistantTurnMarkerPrefix = "__SCREENSHOTTER_TURN_MARKER__:"
let assistantUserTurnMarkerPrefix = "__SCREENSHOTTER_USER_TURN_MARKER__:"

struct Options {
  var pid: pid_t?
  var maxChars: Int = 12000
  var maxNodes: Int = 5000
  var maxDepth: Int = 20
  var checkOnly: Bool = false
  var prompt: Bool = false
  var cleanFixture: String?
}

struct AppMatcher {
  let bundleIds: Set<String>
  let names: Set<String>

  func matches(_ app: NSRunningApplication) -> Bool {
    let bundleId = (app.bundleIdentifier ?? "").lowercased()
    let name = (app.localizedName ?? "").lowercased()
    return bundleIds.contains(bundleId) || names.contains(name)
  }
}

let browserApps = AppMatcher(
  bundleIds: Set([
    "com.apple.safari",
    "com.google.chrome",
    "com.google.chrome.canary",
    "org.chromium.chromium",
    "com.brave.browser",
    "com.microsoft.edgemac",
    "company.thebrowser.browser",
    "org.mozilla.firefox",
    "com.vivaldi.vivaldi",
    "com.operasoftware.opera",
  ]),
  names: Set([
    "safari",
    "google chrome",
    "chrome",
    "chromium",
    "brave browser",
    "microsoft edge",
    "arc",
    "firefox",
    "vivaldi",
    "opera",
  ])
)

let webContentApps = AppMatcher(
  bundleIds: Set([
    "com.tinyspeck.slackmacgap",
    "notion.id",
    "com.microsoft.vscode",
    "com.microsoft.vscodeinsiders",
    "com.visualstudio.code.oss",
    "com.todesktop.230313mzl4w4u92",
    "com.cursor.cursor",
    "com.anthropic.claudefordesktop",
    "com.openai.codex",
  ]),
  names: Set([
    "slack",
    "notion",
    "visual studio code",
    "code",
    "cursor",
    "claude",
    "codex",
  ])
)

let terminalApps = AppMatcher(
  bundleIds: Set([
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "dev.warp.warp-stable",
    "dev.warp.warp",
    "com.github.wez.wezterm",
    "org.alacritty",
    "net.kovidgoyal.kitty",
  ]),
  names: Set([
    "terminal",
    "iterm2",
    "ghostty",
    "warp",
    "wezterm",
    "alacritty",
    "kitty",
  ])
)

let options = parseOptions()

if let fixture = options.cleanFixture {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  let input = String(data: data, encoding: .utf8) ?? ""
  let output: String
  switch fixture {
  case "terminal":
    output = cleanTerminalText(input)
  case "browser":
    output = cleanBrowserFixtureText(input)
  case "assistant":
    output = cleanAssistantChatText(input)
  default:
    FileHandle.standardError.write(Data("Unknown cleanup fixture: \(fixture)\n".utf8))
    exit(1)
  }
  FileHandle.standardOutput.write(Data(output.utf8))
  exit(0)
}

let trusted = accessibilityTrusted(prompt: options.prompt)
if options.checkOnly {
  emit([
    "status": trusted ? "ready" : "unavailable",
    "trusted": trusted,
    "prompted": options.prompt && !trusted,
    "error": trusted ? NSNull() : "Accessibility permission is required for the terminal/helper running screenshotter",
  ])
  exit(0)
}

guard trusted else {
  emit([
    "status": "unavailable",
    "trusted": false,
    "prompted": options.prompt,
    "error": "Accessibility permission is required for the terminal/helper running screenshotter",
  ])
  exit(0)
}

let app = targetApplication(pid: options.pid)
guard let app else {
  emit([
    "status": "unavailable",
    "error": "No target application was found",
  ])
  exit(0)
}

let appElement = AXUIElementCreateApplication(app.processIdentifier)
let root = focusedWindow(appElement) ?? firstWindow(appElement) ?? appElement
let windowTitle = stringAttribute(root, "AXTitle")
let preferredRoot = preferredContentRoot(appElement: appElement, root: root, app: app, options: options)
let prefersRecentText = isAssistantChatApp(app)
var collectionOptions = options
if prefersRecentText {
  let scaledLimit = options.maxChars <= 32_000 ? options.maxChars * 16 : 512_000
  collectionOptions.maxChars = max(options.maxChars, min(512_000, max(64_000, scaledLimit)))
}
let rawText = collectText(
  preferredRoot.element,
  options: collectionOptions,
  preservesLineBreaks: preferredRoot.shouldCleanTerminalText,
  prefersRecentText: prefersRecentText
)
let text = limitText(cleanText(rawText, app: app, preferredRoot: preferredRoot), maxChars: options.maxChars)

emit([
  "status": text.isEmpty ? "empty" : "ready",
  "app": app.localizedName ?? "",
  "bundleId": app.bundleIdentifier ?? "",
  "pid": Int(app.processIdentifier),
  "windowTitle": windowTitle ?? "",
  "source": preferredRoot.source,
  "text": text,
  "textLength": text.count,
])

func parseOptions() -> Options {
  var options = Options()
  var index = 1
  let args = CommandLine.arguments
  while index < args.count {
    let token = args[index]
    if token == "--check" {
      options.checkOnly = true
      index += 1
    } else if token == "--prompt" {
      options.prompt = true
      index += 1
    } else if token == "--pid", index + 1 < args.count {
      options.pid = pid_t(Int(args[index + 1]) ?? 0)
      index += 2
    } else if token == "--max-chars", index + 1 < args.count {
      options.maxChars = max(1, Int(args[index + 1]) ?? options.maxChars)
      index += 2
    } else if token == "--max-nodes", index + 1 < args.count {
      options.maxNodes = max(1, Int(args[index + 1]) ?? options.maxNodes)
      index += 2
    } else if token == "--max-depth", index + 1 < args.count {
      options.maxDepth = max(1, Int(args[index + 1]) ?? options.maxDepth)
      index += 2
    } else if token == "--clean-fixture", index + 1 < args.count {
      options.cleanFixture = args[index + 1]
      index += 2
    } else {
      index += 1
    }
  }
  return options
}

func accessibilityTrusted(prompt: Bool) -> Bool {
  if !prompt {
    return AXIsProcessTrusted()
  }

  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
}

func targetApplication(pid: pid_t?) -> NSRunningApplication? {
  if let pid, pid > 0 {
    return NSRunningApplication(processIdentifier: pid)
  }
  return NSWorkspace.shared.frontmostApplication
}

func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
  elementAttribute(app, "AXFocusedWindow")
}

func focusedElement(_ app: AXUIElement) -> AXUIElement? {
  elementAttribute(app, "AXFocusedUIElement")
}

func firstWindow(_ app: AXUIElement) -> AXUIElement? {
  if let windows: [AXUIElement] = arrayAttribute(app, "AXWindows"), let first = windows.first {
    return first
  }
  return nil
}

struct PreferredContentRoot {
  let element: AXUIElement
  let source: String
  let shouldCleanBrowserChrome: Bool
  let shouldCleanTerminalText: Bool
}

func preferredContentRoot(appElement: AXUIElement, root: AXUIElement, app: NSRunningApplication, options: Options) -> PreferredContentRoot {
  if isTerminalApp(app) {
    if let focused = focusedElement(appElement), isTerminalTextElement(focused) {
      return PreferredContentRoot(
        element: focused,
        source: "macOS Accessibility focused terminal text",
        shouldCleanBrowserChrome: false,
        shouldCleanTerminalText: true
      )
    }
    if let textArea = firstElement(withAnyRole: Set(["AXTextArea", "AXTextField"]), from: root, options: options) {
      return PreferredContentRoot(
        element: textArea,
        source: "macOS Accessibility terminal text",
        shouldCleanBrowserChrome: false,
        shouldCleanTerminalText: true
      )
    }
  }

  if isWebContentApp(app), let webArea = firstElement(withRole: "AXWebArea", from: root, options: options) {
    return PreferredContentRoot(
      element: webArea,
      source: "macOS Accessibility WebArea",
      shouldCleanBrowserChrome: false,
      shouldCleanTerminalText: false
    )
  }

  return PreferredContentRoot(
    element: root,
    source: "macOS Accessibility",
    shouldCleanBrowserChrome: isCommonBrowser(app),
    shouldCleanTerminalText: false
  )
}

func firstElement(withRole targetRole: String, from root: AXUIElement, options: Options) -> AXUIElement? {
  firstElement(withAnyRole: Set([targetRole]), from: root, options: options)
}

func firstElement(withAnyRole targetRoles: Set<String>, from root: AXUIElement, options: Options) -> AXUIElement? {
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var index = 0
  var visited = 0

  while index < queue.count {
    let (element, depth) = queue[index]
    index += 1
    visited += 1

    if let role = stringAttribute(element, "AXRole"), targetRoles.contains(role) {
      return element
    }
    if visited >= options.maxNodes || depth >= options.maxDepth {
      continue
    }
    for child in childElements(element) {
      queue.append((child, depth + 1))
    }
  }

  return nil
}

func isTerminalTextElement(_ element: AXUIElement) -> Bool {
  guard let role = stringAttribute(element, "AXRole") else {
    return false
  }
  return role == "AXTextArea" || role == "AXTextField"
}

func isCommonBrowser(_ app: NSRunningApplication) -> Bool {
  browserApps.matches(app)
}

func isWebContentApp(_ app: NSRunningApplication) -> Bool {
  isCommonBrowser(app) || webContentApps.matches(app)
}

func isTerminalApp(_ app: NSRunningApplication) -> Bool {
  terminalApps.matches(app)
}

func collectText(
  _ root: AXUIElement,
  options: Options,
  preservesLineBreaks: Bool = false,
  prefersRecentText: Bool = false
) -> String {
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  var visited = 0
  var seen = Set<String>()
  var lines: [String] = []
  var charCount = 0

  while let (element, depth) = stack.popLast() {
    if visited >= options.maxNodes || (!prefersRecentText && charCount >= options.maxChars) {
      break
    }
    visited += 1

    let role = stringAttribute(element, "AXRole") ?? ""
    for attribute in textAttributes(for: role) {
      guard let raw = stringAttribute(element, attribute) else {
        continue
      }
      let normalized = preservesLineBreaks ? normalizeMultiline(raw) : normalize(raw)
      let recentText = prefersRecentText ? suffixText(normalized, maxChars: options.maxChars) : normalized
      let markerPrefix: String?
      if role == "AXButton" && isAssistantTurnMarker(recentText) {
        markerPrefix = assistantTurnMarkerPrefix
      } else if role == "AXButton" && isAssistantUserTurnMarker(recentText) {
        markerPrefix = assistantUserTurnMarkerPrefix
      } else if isAssistantActiveTurnElement(element, role: role, text: recentText) {
        markerPrefix = assistantTurnMarkerPrefix
      } else {
        markerPrefix = nil
      }
      let text: String
      if prefersRecentText, let markerPrefix {
        text = markerPrefix + recentText
      } else {
        text = recentText
      }
      if text.isEmpty || (!prefersRecentText && seen.contains(text)) {
        continue
      }
      if !prefersRecentText {
        seen.insert(text)
      }
      lines.append(text)
      charCount += text.count + 1
      if prefersRecentText {
        trimRecentTextBuffer(&lines, charCount: &charCount, maxChars: options.maxChars)
      } else if charCount >= options.maxChars {
        break
      }
    }

    if depth >= options.maxDepth {
      continue
    }

    var children = childElements(element)
    children.reverse()
    for child in children {
      stack.append((child, depth + 1))
    }
  }

  let joined = lines.joined(separator: "\n")
  if joined.count <= options.maxChars {
    return joined
  }
  let end = joined.index(joined.startIndex, offsetBy: options.maxChars)
  return String(joined[..<end])
}

func trimRecentTextBuffer(_ lines: inout [String], charCount: inout Int, maxChars: Int) {
  while charCount > maxChars, !lines.isEmpty {
    let overflow = charCount - maxChars
    let firstLength = lines[0].count + 1
    if firstLength <= overflow || lines[0].isEmpty {
      charCount -= firstLength
      lines.removeFirst()
      continue
    }

    let dropCount = min(overflow, lines[0].count)
    let start = lines[0].index(lines[0].startIndex, offsetBy: dropCount)
    lines[0] = String(lines[0][start...])
    charCount -= dropCount
  }
}

func limitText(_ text: String, maxChars: Int) -> String {
  guard text.count > maxChars else { return text }
  let end = text.index(text.startIndex, offsetBy: maxChars)
  return String(text[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
}

func suffixText(_ text: String, maxChars: Int) -> String {
  guard text.count > maxChars else { return text }
  let start = text.index(text.endIndex, offsetBy: -maxChars)
  return String(text[start...])
}

func cleanText(_ text: String, app: NSRunningApplication, preferredRoot: PreferredContentRoot) -> String {
  if preferredRoot.shouldCleanTerminalText {
    return cleanTerminalText(text)
  }
  if isAssistantChatApp(app) {
    return cleanAssistantChatText(text)
  }
  if preferredRoot.shouldCleanBrowserChrome {
    return cleanBrowserChromeText(text, app: app)
  }
  return text
}

func isAssistantChatApp(_ app: NSRunningApplication) -> Bool {
  let bundleId = (app.bundleIdentifier ?? "").lowercased()
  let name = (app.localizedName ?? "").lowercased()
  return bundleId.contains("codex")
    || bundleId.contains("claude")
    || name == "codex"
    || name == "claude"
    || name == "claude desktop"
}

func cleanAssistantChatText(_ text: String) -> String {
  let lines = text
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty && !isAssistantChatChromeLine($0) }

  let start = chatTranscriptStartIndex(lines)
  let selectedLines = lines.dropFirst(start).map { line in
    line.hasPrefix(assistantTurnMarkerPrefix)
      ? String(line.dropFirst(assistantTurnMarkerPrefix.count))
      : line
  }
  return deduplicateLines(selectedLines)
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func deduplicateLines(_ lines: [String]) -> [String] {
  var result: [String] = []
  for line in lines where result.last != line {
    result.append(line)
  }
  return result
}

func chatTranscriptStartIndex(_ lines: [String]) -> Int {
  if let structuralIndex = lines.lastIndex(where: {
    $0.hasPrefix(assistantTurnMarkerPrefix) || $0.hasPrefix(assistantUserTurnMarkerPrefix)
  }) {
    return lines[structuralIndex].hasPrefix(assistantUserTurnMarkerPrefix)
      ? min(structuralIndex + 1, lines.count)
      : structuralIndex
  }
  if let workedIndex = lines.lastIndex(where: {
    isAssistantTurnMarker($0)
  }) {
    return workedIndex
  }
  if let projectIndex = lines.lastIndex(where: { $0.hasPrefix("Project: ") }) {
    return min(projectIndex + 1, lines.count)
  }
  return 0
}

func isAssistantActiveTurnElement(_ element: AXUIElement, role: String, text: String) -> Bool {
  guard role == "AXStaticText", text.hasPrefix("Working for "),
        let parent = elementAttribute(element, "AXParent"),
        let classes: [String] = arrayAttribute(parent, "AXDOMClassList") else {
    return false
  }
  return classes.contains("text-size-chat")
}

func isAssistantTurnMarker(_ text: String) -> Bool {
  text.hasPrefix("Worked for ")
    || text.hasPrefix("Working for ")
    || text.hasPrefix("You stopped after ")
}

func isAssistantUserTurnMarker(_ text: String) -> Bool {
  text == "Edit user message" || text == "Edit message"
}

func isAssistantChatChromeLine(_ line: String) -> Bool {
  let exact = Set([
    "New chat",
    "Search",
    "Scheduled",
    "Plugins",
    "Pinned",
    "Projects",
    "Collapse all",
    "Project sidebar options",
    "Add new project",
    "Collapse project",
    "Expand project",
    "Show more",
    "Chats",
    "Filter sidebar chats",
    "Open settings",
    "Open Codex mobile",
    "Hide sidebar",
    "Back",
    "Forward",
    "Chat actions",
    "Open in",
    "Secondary action",
    "Toggle pinned summary",
    "Toggle bottom panel",
    "Toggle side panel",
    "Copy message",
    "Edit user message",
    "Edit message",
    "Review changed files",
    "Good response",
    "Bad response",
    "Fork from this point",
    "User attachment",
    "Review",
    "Undo",
    "Copy",
    "Environment",
    "Changes",
    "Local",
    "Commit or push",
    "Tasks",
    "Background terminal",
    "Background terminal actions",
    "Create environment",
    "Open bottom panel tab",
    "Sources",
    "Create pull request",
    "Attach files or connect apps",
    "View all",
    "Continue in new task from here",
  ])

  if exact.contains(line) {
    return true
  }
  if line.hasPrefix("Project actions for ") || line.hasPrefix("Start new chat in ") {
    return true
  }
  if line.hasPrefix("Pin chat") || line.hasPrefix("Archive chat") || line.hasPrefix("Unpin chat") {
    return true
  }
  if line.hasPrefix("Jump to user message") || line.hasPrefix("Jump to assistant message") {
    return true
  }
  if line.hasPrefix("Changes +") || line.hasPrefix("Running Background terminal") {
    return true
  }
  if line.hasPrefix("Close ") && line.hasSuffix(" tab") {
    return true
  }
  if line.contains("; Close ") && line.hasSuffix("; tab") {
    return true
  }
  if line == "main" || line == "Close" {
    return true
  }
  if line.range(of: #"^[+-]\d[\d,]*$"#, options: .regularExpression) != nil {
    return true
  }
  if line.range(of: #"^\d{1,2}:\d{2}$"#, options: .regularExpression) != nil {
    return true
  }
  if line.range(of: #"^\d+\s*(m|h|d|w|mo)$"#, options: .regularExpression) != nil {
    return true
  }
  return false
}

func cleanBrowserChromeText(_ text: String, app: NSRunningApplication) -> String {
  guard isCommonBrowser(app) else {
    return text
  }

  return cleanBrowserFixtureText(text)
}

func cleanBrowserFixtureText(_ text: String) -> String {
  let lines = text
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }

  let filtered = lines.filter { line in
    !line.isEmpty && !isBrowserChromeLine(line)
  }

  return filtered.joined(separator: "\n")
}

func cleanTerminalText(_ text: String) -> String {
  let lines = repairTerminalLineBreaks(text)
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { stripTerminalChrome(String($0)) }

  var cleaned: [String] = []
  var previousBlank = false
  for line in lines {
    if isTerminalDecorationLine(line) {
      continue
    }

    let isBlank = line.isEmpty
    if isBlank && previousBlank {
      continue
    }
    cleaned.append(line)
    previousBlank = isBlank
  }

  return cleaned.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

func repairTerminalLineBreaks(_ text: String) -> String {
  let border = #"[│┃║▕▐┆┊╎╏]"#
  let withoutLeadingBorders = text.replacingOccurrences(
    of: #"(?m)^[ \t]*(?:"# + border + #"[ \t]*)+"#,
    with: "",
    options: .regularExpression
  )
  let withoutEdgeBorders = withoutLeadingBorders.replacingOccurrences(
    of: #"(?m)[ \t]*(?:"# + border + #"[ \t]*)+$"#,
    with: "",
    options: .regularExpression
  )
  return withoutEdgeBorders.replacingOccurrences(
    of: #"[ \t]*(?:"# + border + #"[ \t]*)+"#,
    with: "\n",
    options: .regularExpression
  )
}

func stripTerminalChrome(_ line: String) -> String {
  var value = line.trimmingCharacters(in: .whitespaces)
  let borderPrefixes = ["▕ │", "▐ │", "│", "▕", "▐", "┃", "║"]
  var changed = true
  while changed {
    changed = false
    for prefix in borderPrefixes {
      if value.hasPrefix(prefix) {
        value = String(value.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
        changed = true
      }
    }
  }
  return value
}

func isTerminalDecorationLine(_ line: String) -> Bool {
  if line.isEmpty {
    return false
  }
  let decoration = CharacterSet(charactersIn: "─━═│┃║▕▐┌┐└┘├┤┬┴┼╭╮╰╯ ")
  return line.unicodeScalars.allSatisfy { decoration.contains($0) }
}

func isBrowserChromeLine(_ line: String) -> Bool {
  let exact = Set([
    "Back",
    "Forward",
    "Reload",
    "Stop",
    "Home",
    "Open tab in split view",
    "View site information",
    "Search DuckDuckGo or type a URL",
    "Search Google or type a URL",
    "Search or enter website name",
    "Address and search bar",
    "Bookmark this tab",
    "Extensions",
    "Developer Tools – pinned",
    "Chrome",
    "Safari",
    "Arc",
    "Firefox",
    "Work",
    "New tab",
    "Tab search",
    "Close",
    "To get missing image descriptions, open the context menu.",
  ])

  if exact.contains(line) {
    return true
  }
  if line.hasSuffix(" Has access to this site") {
    return true
  }
  if line.contains(" - Memory usage - ") || line.contains(" – Memory usage - ") {
    return true
  }
  return false
}

func textAttributes(for role: String) -> [String] {
  switch role {
    case "AXStaticText", "AXHeading":
      return ["AXValue", "AXTitle", "AXDescription"]
    case "AXLink", "AXButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXTabGroup":
      return ["AXTitle", "AXValue", "AXDescription"]
    case "AXTextField", "AXTextArea", "AXComboBox":
      return ["AXSelectedText", "AXValue", "AXPlaceholderValue", "AXTitle"]
    case "AXCell", "AXRow", "AXColumn":
      return ["AXValue", "AXTitle"]
    default:
      return ["AXSelectedText"]
  }
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
  for attribute in ["AXChildren", "AXVisibleChildren", "AXRows", "AXContents"] {
    if let children: [AXUIElement] = arrayAttribute(element, attribute), !children.isEmpty {
      return children
    }
  }
  return []
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  guard let value = copyAttribute(element, attribute) else {
    return nil
  }

  if let string = value as? String {
    return string
  }
  if let attributed = value as? NSAttributedString {
    return attributed.string
  }
  if CFGetTypeID(value) == AXValueGetTypeID() {
    return nil
  }
  return nil
}

func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  guard let value = copyAttribute(element, attribute) else {
    return nil
  }
  return (value as! AXUIElement)
}

func arrayAttribute<T>(_ element: AXUIElement, _ attribute: String) -> [T]? {
  copyAttribute(element, attribute) as? [T]
}

func copyAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard error == .success, let value else {
    return nil
  }
  return value as AnyObject
}

func normalize(_ value: String) -> String {
  value
    .replacingOccurrences(of: "\u{00a0}", with: " ")
    .components(separatedBy: .whitespacesAndNewlines)
    .filter { !$0.isEmpty }
    .joined(separator: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func normalizeMultiline(_ value: String) -> String {
  value
    .replacingOccurrences(of: "\u{00a0}", with: " ")
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { line in
      line
        .split(whereSeparator: { $0 == " " || $0 == "\t" })
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespaces)
    }
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func emit(_ object: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    let fallback = "{\"status\":\"failed\",\"error\":\"Could not encode JSON\"}\n"
    FileHandle.standardOutput.write(Data(fallback.utf8))
  }
}
