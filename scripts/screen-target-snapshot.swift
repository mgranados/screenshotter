#!/usr/bin/env swift
import AppKit
import CoreGraphics
import Foundation

let collectedAt = iso8601(Date())
let frontmost = NSWorkspace.shared.frontmostApplication
let pointer = CGEvent(source: nil)?.location ?? CGPoint.zero
let pointerWindow = windowUnderPointer(pointer)

var output: [String: Any] = [
  "collectedAt": collectedAt,
  "pointer": [
    "x": round1(pointer.x),
    "y": round1(pointer.y),
  ],
]

if let frontmost {
  output["frontmostApp"] = appInfo(frontmost)
} else {
  output["frontmostApp"] = NSNull()
}

if let pointerWindow {
  output["pointerWindow"] = pointerWindow
} else {
  output["pointerWindow"] = NSNull()
}

do {
  let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fail("Could not encode screen target snapshot: \(error.localizedDescription)")
}

func windowUnderPointer(_ point: CGPoint) -> [String: Any]? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }

  let currentPid = Int(ProcessInfo.processInfo.processIdentifier)
  for window in rawWindows {
    guard let boundsValue = window[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsValue as CFDictionary),
          bounds.width > 1,
          bounds.height > 1 else {
      continue
    }

    if !bounds.contains(point) {
      continue
    }

    let layer = intValue(window[kCGWindowLayer as String]) ?? 0
    if layer != 0 {
      continue
    }

    let pid = intValue(window[kCGWindowOwnerPID as String])
    if let pid, pid == currentPid {
      continue
    }

    var result: [String: Any] = [
      "pid": pid ?? 0,
      "ownerName": stringValue(window[kCGWindowOwnerName as String]) ?? "",
      "windowTitle": stringValue(window[kCGWindowName as String]) ?? "",
      "windowNumber": intValue(window[kCGWindowNumber as String]) ?? 0,
      "layer": layer,
      "bounds": [
        "x": round1(bounds.origin.x),
        "y": round1(bounds.origin.y),
        "width": round1(bounds.width),
        "height": round1(bounds.height),
      ],
    ]

    if let pid,
       let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
      result["app"] = appInfo(app)
    }

    return result
  }

  return nil
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
  [
    "name": app.localizedName ?? "",
    "pid": Int(app.processIdentifier),
    "bundleId": app.bundleIdentifier ?? "",
  ]
}

func intValue(_ value: Any?) -> Int? {
  if let value = value as? Int {
    return value
  }
  if let value = value as? NSNumber {
    return value.intValue
  }
  return nil
}

func stringValue(_ value: Any?) -> String? {
  if let value = value as? String {
    return value
  }
  return nil
}

func round1(_ value: CGFloat) -> Double {
  (Double(value) * 10).rounded() / 10
}

func iso8601(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
