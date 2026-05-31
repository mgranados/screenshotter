#!/usr/bin/env swift
import Foundation
import Vision

var recognitionLevel = "accurate"
var recognitionLanguages = ["en-US"]
var usesLanguageCorrection = true
var includeText = false
var paths: [String] = []

var index = 1
while index < CommandLine.arguments.count {
  let argument = CommandLine.arguments[index]
  switch argument {
  case "--level":
    index += 1
    if index < CommandLine.arguments.count {
      recognitionLevel = CommandLine.arguments[index]
    }
  case "--languages":
    index += 1
    if index < CommandLine.arguments.count {
      recognitionLanguages = CommandLine.arguments[index]
        .split(separator: ",")
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    }
  case "--no-language-correction":
    usesLanguageCorrection = false
  case "--include-text":
    includeText = true
  default:
    paths.append(argument)
  }
  index += 1
}

guard !paths.isEmpty else {
  fail("Usage: apple-vision-batch-ocr [--level accurate|fast] [--languages en-US] [--include-text] <image...>")
}

let start = DispatchTime.now().uptimeNanoseconds
var rows: [[String: Any]] = []

for path in paths {
  let rowStart = DispatchTime.now().uptimeNanoseconds
  do {
    let text = try recognize(path: path)
    let rowEnd = DispatchTime.now().uptimeNanoseconds
    var row: [String: Any] = [
      "path": path,
      "textLength": text.count,
      "textTokens": tokenCount(text),
      "durationMs": elapsedMs(rowStart, rowEnd),
    ]
    if includeText {
      row["text"] = text
    }
    rows.append(row)
  } catch {
    rows.append([
      "path": path,
      "error": "\(error)",
      "durationMs": elapsedMs(rowStart, DispatchTime.now().uptimeNanoseconds),
    ])
  }
}

let end = DispatchTime.now().uptimeNanoseconds
let output: [String: Any] = [
  "sampleCount": paths.count,
  "durationMs": elapsedMs(start, end),
  "rows": rows,
]

let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))

func recognize(path: String) throws -> String {
  guard FileManager.default.fileExists(atPath: path) else {
    throw BenchError("Image not found: \(path)")
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = recognitionLevel == "fast" ? .fast : .accurate
  request.usesLanguageCorrection = usesLanguageCorrection
  request.recognitionLanguages = recognitionLanguages

  let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
  try handler.perform([request])

  return (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")
}

func tokenCount(_ text: String) -> Int {
  text
    .lowercased()
    .components(separatedBy: CharacterSet.alphanumerics.inverted)
    .filter { $0.count >= 2 || Int($0) != nil }
    .count
}

func elapsedMs(_ start: UInt64, _ end: UInt64) -> Double {
  ((Double(end - start) / 1_000_000.0) * 10).rounded() / 10
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

struct BenchError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
