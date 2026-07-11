#!/usr/bin/env swift
import AppKit
import Foundation

struct Fixture: Decodable {
  let title: String
  let labels: [String]
  let textField: String
  let button: String
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
  private let fixture: Fixture
  private var window: NSWindow?

  init(fixture: Fixture) {
    self.fixture = fixture
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 720, height: 480),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = fixture.title

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
    for label in fixture.labels {
      stack.addArrangedSubview(NSTextField(labelWithString: label))
    }

    let field = NSTextField(string: fixture.textField)
    field.frame.size.width = 620
    field.setAccessibilityIdentifier("fixture-text-field")
    stack.addArrangedSubview(field)

    let button = NSButton(title: fixture.button, target: nil, action: nil)
    button.setAccessibilityIdentifier("fixture-button")
    stack.addArrangedSubview(button)

    window.contentView = stack
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    self.window = window

    emit([
      "status": "ready",
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "title": fixture.title,
    ])
  }
}

guard CommandLine.arguments.count == 2 else {
  fail("Usage: accessibility-fixture-app <fixture.json>")
}
let fixture = try JSONDecoder().decode(
  Fixture.self,
  from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
)
let app = NSApplication.shared
let delegate = FixtureDelegate(fixture: fixture)
app.delegate = delegate
app.run()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
    fail("Could not encode fixture status")
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
