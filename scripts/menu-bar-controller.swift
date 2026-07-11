#!/usr/bin/env swift
import AppKit
import Foundation

private enum StatusAnimationPhase: Equatable {
  case idle
  case processing
  case complete
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private let toggleItem = NSMenuItem(title: "Turn off", action: #selector(toggleCapture(_:)), keyEquivalent: "")
  private let statsItem = NSMenuItem(title: "Saved historically: 0 B", action: nil, keyEquivalent: "")
  private var profileItems: [String: NSMenuItem] = [:]
  private var historyItems: [NSMenuItem] = []
  private var inputBuffer = Data()
  private var enabled = true
  private var profile = "readability"
  private var ready = 0
  private var history: [CompressionHistory] = []
  private var historicalSavedBytes: Int64 = 0
  private var historicalScreensPrepared = 0
  private var statusAnimationTimer: Timer?
  private var statusAnimationFrame = 0
  private var statusAnimationPhase = StatusAnimationPhase.idle
  private var processingAnimationIds = Set<String>()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    configureMenu()
    updateUi()
    readInput()
  }

  private func configureMenu() {
    toggleItem.target = self

    menu.addItem(toggleItem)
    menu.addItem(NSMenuItem.separator())

    for itemProfile in ["readability", "balanced", "token"] {
      let item = NSMenuItem(title: profileTitle(itemProfile), action: #selector(selectProfile(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = itemProfile
      menu.addItem(item)
      profileItems[itemProfile] = item
    }

    menu.addItem(NSMenuItem.separator())
    for _ in 0..<3 {
      let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
      historyItems.append(item)
    }

    menu.addItem(NSMenuItem.separator())
    statsItem.isEnabled = false
    menu.addItem(statsItem)

    menu.addItem(NSMenuItem.separator())
    let quitItem = NSMenuItem(title: "Quit Screenshotter", action: #selector(quit(_:)), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu
  }

  private func updateUi() {
    updateStatusButton()
    toggleItem.title = enabled ? "Turn off" : "Turn on"
    toggleItem.isEnabled = true
    toggleItem.state = .off

    for (itemProfile, item) in profileItems {
      item.title = profileTitle(itemProfile)
      item.state = itemProfile == profile ? .on : .off
    }

    updateHistoryItems()
    updateStatsItem()
  }

  private func updateStatusButton() {
    guard let button = statusItem.button else { return }
    let tooltip: String
    switch statusAnimationPhase {
    case .processing:
      tooltip = "screenshotter processing screenshot"
    case .complete:
      tooltip = "screenshotter ready to paste"
    case .idle:
      tooltip = "screenshotter \(enabled ? "running" : "paused") / \(profileTitle(profile)) / \(ready) ready"
    }
    button.toolTip = tooltip
    button.imageScaling = .scaleNone
    statusItem.length = 31
    button.image = statusIcon(enabled: enabled, profile: profile, tooltip: tooltip)
    button.attributedTitle = NSAttributedString(string: "")
    button.imagePosition = .imageOnly
  }

  private func readInput() {
    FileHandle.standardInput.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        DispatchQueue.main.async { NSApp.terminate(nil) }
        return
      }

      DispatchQueue.main.async {
        self?.appendInput(data)
      }
    }
  }

  private func appendInput(_ data: Data) {
    inputBuffer.append(data)

    while let newline = inputBuffer.firstIndex(of: 10) {
      let line = inputBuffer.prefix(upTo: newline)
      inputBuffer.removeSubrange(...newline)
      handleLine(Data(line))
    }
  }

  private func handleLine(_ data: Data) {
    guard
      let object = try? JSONSerialization.jsonObject(with: data),
      let payload = object as? [String: Any]
    else {
      return
    }

    let messageType = payload["type"] as? String
    switch messageType {
    case "processing":
      startProcessingAnimation(id: animationId(payload))
      return
    case "ready":
      finishProcessingAnimation(id: animationId(payload), completed: true)
      return
    case "failed", "idle":
      finishProcessingAnimation(id: animationId(payload), completed: false)
      return
    default:
      break
    }
    guard messageType == "state" else { return }

    if let value = payload["enabled"] as? Bool { enabled = value }
    if let value = payload["profile"] as? String { profile = value }
    if let value = payload["ready"] as? Int { ready = value }
    if let values = payload["history"] as? [[String: Any]] {
      history = values.compactMap { CompressionHistory(payload: $0) }
    }
    if let stats = payload["stats"] as? [String: Any] {
      if let value = stats["savedBytes"] as? NSNumber {
        historicalSavedBytes = value.int64Value
      }
      if let value = stats["screensPrepared"] as? NSNumber {
        historicalScreensPrepared = value.intValue
      }
    }
    updateUi()
  }

  private func animationId(_ payload: [String: Any]) -> String {
    return payload["id"] as? String ?? "capture"
  }

  private func startProcessingAnimation(id: String) {
    processingAnimationIds.insert(id)
    statusAnimationPhase = .processing
    statusAnimationFrame = 0
    ensureStatusAnimationTimer()
    updateStatusButton()
  }

  private func finishProcessingAnimation(id: String, completed: Bool) {
    processingAnimationIds.remove(id)

    if !processingAnimationIds.isEmpty {
      statusAnimationPhase = .processing
      updateStatusButton()
      return
    }

    if completed {
      statusAnimationPhase = .complete
      statusAnimationFrame = 0
      ensureStatusAnimationTimer()
    } else {
      stopStatusAnimation()
    }
    updateStatusButton()
  }

  private func ensureStatusAnimationTimer() {
    guard statusAnimationTimer == nil else { return }

    let timer = Timer(timeInterval: 0.07, repeats: true) { [weak self] timer in
      guard let self = self else {
        timer.invalidate()
        return
      }

      self.statusAnimationFrame += 1
      if self.statusAnimationPhase == .complete && self.statusAnimationFrame >= 10 {
        self.stopStatusAnimation()
      }
      self.updateStatusButton()
    }

    statusAnimationTimer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  private func stopStatusAnimation() {
    statusAnimationTimer?.invalidate()
    statusAnimationTimer = nil
    statusAnimationFrame = 0
    statusAnimationPhase = .idle
  }

  @objc private func toggleCapture(_ sender: NSMenuItem) {
    emit(["type": "toggle"])
  }

  @objc private func selectProfile(_ sender: NSMenuItem) {
    guard let selectedProfile = sender.representedObject as? String else { return }
    emit(["type": "profile", "profile": selectedProfile])
  }

  @objc private func quit(_ sender: NSMenuItem) {
    stopStatusAnimation()
    emit(["type": "quit"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      NSApp.terminate(nil)
    }
  }

  private func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
      return
    }

    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }

  private func profileTitle(_ value: String) -> String {
    return profileInfo(value).title
  }

  private func profileStatusTitle(_ value: String) -> String {
    return profileInfo(value).shortTitle
  }

  private func compressionLevel(_ value: String) -> Int {
    return profileInfo(value).level
  }

  private func profileInfo(_ value: String) -> (title: String, shortTitle: String, level: Int) {
    switch value {
    case "readability":
      return ("Low Compression (avg ~30%)", "Low", 1)
    case "balanced":
      return ("Mid Compression (avg ~45%)", "Mid", 2)
    case "token":
      return ("High Compression (avg ~80%)", "High", 3)
    default:
      return (value, value, 1)
    }
  }

  private func updateHistoryItems() {
    if history.isEmpty {
      historyItems.first?.title = "No recent compressions"
      historyItems.first?.isHidden = false
      for item in historyItems.dropFirst() {
        item.isHidden = true
      }
      return
    }

    for (index, item) in historyItems.enumerated() {
      guard index < history.count else {
        item.isHidden = true
        continue
      }

      let entry = history[index]
      if entry.optimized {
        item.title = "\(profileStatusTitle(entry.profile)) \(formatPercent(entry.savedPercent)) saved - \(compactName(entry.name))"
      } else {
        item.title = "\(profileStatusTitle(entry.profile)) unchanged - \(compactName(entry.name))"
      }
      item.isHidden = false
    }
  }

  private func updateStatsItem() {
    if historicalScreensPrepared > 0 {
      statsItem.title = "Saved historically: \(formatBytes(historicalSavedBytes))"
    } else {
      statsItem.title = "Saved historically: 0 B"
    }
    statsItem.isHidden = false
  }

  private func formatPercent(_ value: Double) -> String {
    let rounded = value.rounded()
    if abs(value - rounded) < 0.05 {
      return "\(Int(rounded))%"
    }
    return String(format: "%.1f%%", value)
  }

  private func compactName(_ value: String) -> String {
    let limit = 32
    if value.count <= limit { return value }
    let suffix = value.suffix(limit - 3)
    return "..." + suffix
  }

  private func formatBytes(_ value: Int64) -> String {
    let bytes = Double(max(0, value))
    let kb = 1024.0
    let mb = kb * 1024.0
    let gb = mb * 1024.0

    if bytes >= gb {
      return String(format: "%.2f GB", bytes / gb)
    }
    if bytes >= mb {
      return String(format: "%.1f MB", bytes / mb)
    }
    if bytes >= kb {
      return "\(Int((bytes / kb).rounded())) KB"
    }
    return "\(Int(bytes)) B"
  }

  private func statusIcon(enabled: Bool, profile: String, tooltip: String) -> NSImage {
    let image = NSImage(size: NSSize(width: 30, height: 21))
    image.lockFocus()

    if statusAnimationPhase == .complete {
      drawCompletionIcon(tooltip: tooltip)
    } else {
      drawCameraIcon(enabled: enabled, tooltip: tooltip)
      if statusAnimationPhase == .processing {
        drawProcessingArc()
      }
    }
    drawCompressionStack(enabled: enabled, profile: profile)

    image.unlockFocus()
    image.isTemplate = true
    return image
  }

  private func drawCameraIcon(enabled: Bool, tooltip: String) {
    let alpha: CGFloat = enabled ? (statusAnimationPhase == .processing ? 0.48 : 1) : 0.34

    if #available(macOS 11.0, *) {
      if let symbol = NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: tooltip) {
        NSColor.black.setFill()
        symbol.draw(in: NSRect(x: -0.5, y: 1.5, width: 20.8, height: 18), from: .zero, operation: .sourceOver, fraction: alpha)
        return
      }
    }

    NSColor.black.withAlphaComponent(alpha).setStroke()
    NSColor.black.withAlphaComponent(alpha).setFill()

    let body = NSBezierPath(roundedRect: NSRect(x: 1, y: 5.2, width: 16.5, height: 10.2), xRadius: 2.1, yRadius: 2.1)
    body.lineWidth = 1.7
    body.stroke()

    let top = NSBezierPath()
    top.move(to: NSPoint(x: 5.7, y: 15.4))
    top.line(to: NSPoint(x: 7.8, y: 17.5))
    top.line(to: NSPoint(x: 11.1, y: 17.5))
    top.line(to: NSPoint(x: 13.2, y: 15.4))
    top.lineWidth = 1.7
    top.stroke()

    let lens = NSBezierPath(ovalIn: NSRect(x: 7.3, y: 8, width: 4.2, height: 4.2))
    lens.lineWidth = 1.5
    lens.stroke()

    if enabled {
      NSBezierPath(ovalIn: NSRect(x: 14.6, y: 12.1, width: 2.1, height: 2.1)).fill()
    }
  }

  private func drawProcessingArc() {
    let startAngle = CGFloat((statusAnimationFrame * 24) % 360)
    let arc = NSBezierPath()
    arc.appendArc(
      withCenter: NSPoint(x: 9.9, y: 10.5),
      radius: 4,
      startAngle: startAngle,
      endAngle: startAngle + 105
    )
    arc.lineWidth = 1.65
    arc.lineCapStyle = .round
    NSColor.black.setStroke()
    arc.stroke()
  }

  private func drawCompletionIcon(tooltip: String) {
    if #available(macOS 11.0, *) {
      if let symbol = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: tooltip) {
        symbol.draw(in: NSRect(x: 1.1, y: 2.2, width: 17.2, height: 17.2), from: .zero, operation: .sourceOver, fraction: 1)
        return
      }
    }

    NSColor.black.setStroke()
    let circle = NSBezierPath(ovalIn: NSRect(x: 2.1, y: 3.2, width: 15.2, height: 15.2))
    circle.lineWidth = 1.7
    circle.stroke()

    let check = NSBezierPath()
    check.move(to: NSPoint(x: 5.8, y: 10.7))
    check.line(to: NSPoint(x: 8.7, y: 7.9))
    check.line(to: NSPoint(x: 14, y: 13.5))
    check.lineWidth = 1.8
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    check.stroke()
  }

  private func drawCompressionStack(enabled: Bool, profile: String) {
    let barWidth: CGFloat = 5.7
    let barHeight: CGFloat = 2.7
    let gap: CGFloat = 2
    let baseX: CGFloat = 23
    let baseY: CGFloat = 4.3

    for index in 0..<3 {
      let width: CGFloat
      let alpha: CGFloat

      if !enabled {
        width = barWidth
        alpha = 0.16
      } else if statusAnimationPhase == .processing {
        let wave = CGFloat((sin(Double(statusAnimationFrame) * 0.62 - Double(index) * 1.05) + 1) / 2)
        width = 2.8 + 2.9 * wave
        alpha = 0.32 + 0.68 * wave
      } else if statusAnimationPhase == .complete {
        width = barWidth
        alpha = 1
      } else {
        width = barWidth
        alpha = index < compressionLevel(profile) ? 0.9 : 0.28
      }

      let rect = NSRect(
        x: baseX + (barWidth - width) / 2,
        y: baseY + CGFloat(index) * (barHeight + gap),
        width: width,
        height: barHeight
      )
      let path = NSBezierPath(roundedRect: rect, xRadius: 1.15, yRadius: 1.15)
      NSColor.black.withAlphaComponent(alpha).setFill()
      path.fill()
    }
  }
}

private struct CompressionHistory {
  let name: String
  let savedPercent: Double
  let optimized: Bool
  let profile: String

  init?(payload: [String: Any]) {
    guard let name = payload["name"] as? String else { return nil }
    self.name = name
    self.optimized = payload["optimized"] as? Bool ?? false
    self.profile = payload["profile"] as? String ?? "unknown"

    if let value = payload["savedPercent"] as? NSNumber {
      self.savedPercent = value.doubleValue
    } else if let value = payload["savedPercent"] as? Double {
      self.savedPercent = value
    } else {
      self.savedPercent = 0
    }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
