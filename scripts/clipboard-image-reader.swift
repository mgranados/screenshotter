#!/usr/bin/env swift
import AppKit
import Foundation

let pasteboard = NSPasteboard.general
let arguments = Array(CommandLine.arguments.dropFirst())

func declaredTypeNames() -> [String] {
  (pasteboard.types ?? []).map(\.rawValue)
}

func isScreenshotLikeImage(_ typeNames: [String]) -> Bool {
  let names = Set(typeNames)
  let hasImage = names.contains(NSPasteboard.PasteboardType.png.rawValue)
    || names.contains(NSPasteboard.PasteboardType.tiff.rawValue)
  guard hasImage else { return false }

  let blockedTypes: Set<String> = [
    NSPasteboard.PasteboardType.fileURL.rawValue,
    NSPasteboard.PasteboardType.URL.rawValue,
    NSPasteboard.PasteboardType.string.rawValue,
    NSPasteboard.PasteboardType.html.rawValue,
    NSPasteboard.PasteboardType.rtf.rawValue,
    NSPasteboard.PasteboardType.rtfd.rawValue,
    "NSFilenamesPboardType",
    "com.apple.webarchive",
  ]
  if !names.isDisjoint(with: blockedTypes) { return false }
  return !names.contains { type in
    type.hasPrefix("com.apple.finder.") || type.contains("promised-file")
  }
}

func emit(_ response: [String: Any]) throws {
  let encoded = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
  FileHandle.standardOutput.write(encoded)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func captureImage(in outputDirectory: String, changeCount: Int, uniqueName: Bool) throws -> [String: Any] {
  let typeNames = declaredTypeNames()
  var response: [String: Any] = [
    "changeCount": changeCount,
    "types": typeNames,
  ]
  guard isScreenshotLikeImage(typeNames) else {
    response["status"] = "ignored"
    return response
  }
  let candidates: [(type: NSPasteboard.PasteboardType, extension: String)] = [
    (.png, "png"),
    (.tiff, "tiff"),
  ]
  for candidate in candidates {
    guard let data = pasteboard.data(forType: candidate.type) else { continue }
    let stem = uniqueName ? "clipboard-\(changeCount)" : "clipboard"
    let outputURL = URL(fileURLWithPath: outputDirectory, isDirectory: true)
      .appendingPathComponent("\(stem).\(candidate.extension)")
    try data.write(to: outputURL, options: .atomic)
    response["path"] = outputURL.path
    response["pasteboardType"] = candidate.type.rawValue
    response["status"] = "ready"
    break
  }
  return response
}

if arguments.first == "--metadata" {
  let typeNames = declaredTypeNames()
  try emit([
    "changeCount": pasteboard.changeCount,
    "screenshotLike": isScreenshotLikeImage(typeNames),
    "types": typeNames,
  ])
  exit(0)
}

if arguments.first == "--classify-types" {
  let typeNames = Array(arguments.dropFirst())
  try emit([
    "screenshotLike": isScreenshotLikeImage(typeNames),
    "types": typeNames,
  ])
  exit(0)
}

if arguments.first == "--watch" {
  guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: clipboard-image-reader --watch <output-directory> [--poll-ms n]\n".utf8))
    exit(2)
  }
  let outputDirectory = arguments[1]
  let pollIndex = arguments.firstIndex(of: "--poll-ms")
  let pollMs = pollIndex.flatMap { index in
    arguments.indices.contains(index + 1) ? Int(arguments[index + 1]) : nil
  } ?? 500
  var previousChangeCount = pasteboard.changeCount
  while true {
    Thread.sleep(forTimeInterval: Double(max(50, pollMs)) / 1000)
    let currentChangeCount = pasteboard.changeCount
    guard currentChangeCount != previousChangeCount else { continue }
    previousChangeCount = currentChangeCount
    do {
      let response = try captureImage(
        in: outputDirectory,
        changeCount: currentChangeCount,
        uniqueName: true
      )
      if response["path"] != nil {
        try emit(response)
      }
    } catch {
      FileHandle.standardError.write(Data("could not save clipboard image: \(error)\n".utf8))
    }
  }
}

guard let outputDirectory = arguments.first else {
  FileHandle.standardError.write(Data("usage: clipboard-image-reader <output-directory>\n".utf8))
  exit(2)
}

do {
  try emit(captureImage(
    in: outputDirectory,
    changeCount: pasteboard.changeCount,
    uniqueName: false
  ))
} catch {
  FileHandle.standardError.write(Data("could not save clipboard image: \(error)\n".utf8))
  exit(1)
}
