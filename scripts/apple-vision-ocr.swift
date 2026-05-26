#!/usr/bin/env swift
import Foundation
import Vision

var imagePath: String?
var recognitionLevel = "accurate"
var recognitionLanguages = ["en-US"]
var usesLanguageCorrection = true

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
  default:
    if imagePath == nil {
      imagePath = argument
    } else {
      fail("Unexpected argument: \(argument)")
    }
  }
  index += 1
}

guard let imagePath else {
  fail("Usage: apple-vision-ocr <image> [--level accurate|fast] [--languages en-US]")
}

let imageUrl = URL(fileURLWithPath: imagePath)
guard FileManager.default.fileExists(atPath: imagePath) else {
  fail("Image not found: \(imagePath)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = recognitionLevel == "fast" ? .fast : .accurate
request.usesLanguageCorrection = usesLanguageCorrection
request.recognitionLanguages = recognitionLanguages

let handler = VNImageRequestHandler(url: imageUrl, options: [:])

do {
  try handler.perform([request])
} catch {
  fail("Apple Vision OCR failed: \(error.localizedDescription)")
}

let text = (request.results ?? [])
  .compactMap { $0.topCandidates(1).first?.string }
  .joined(separator: "\n")

print(text)

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
