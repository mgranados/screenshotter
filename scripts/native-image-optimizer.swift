#!/usr/bin/env swift
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Options {
  var maxLongEdge = 2200
  var jpegQuality = 50
  var smallDirectBytes = 256 * 1024
  var outDir = ""
  var stem: String?
  var paths: [String] = []
}

let start = DispatchTime.now().uptimeNanoseconds
var options = parseArgs()

guard !options.outDir.isEmpty, !options.paths.isEmpty else {
  fail("Usage: native-image-optimizer --out-dir <dir> [--stem name] [--max-long-edge px] [--quality n] <image...>")
}

try FileManager.default.createDirectory(atPath: options.outDir, withIntermediateDirectories: true)

var rows: [[String: Any]] = []
var originalTotal = 0
var optimizedTotal = 0

for path in options.paths {
  let rowStart = DispatchTime.now().uptimeNanoseconds
  do {
    let result = try optimize(path: path, options: options)
    let rowEnd = DispatchTime.now().uptimeNanoseconds
    originalTotal += result.originalBytes
    optimizedTotal += result.optimizedBytes
    rows.append([
      "path": path,
      "optimizedPath": result.optimizedPath,
      "originalBytes": result.originalBytes,
      "optimizedBytes": result.optimizedBytes,
      "savedPercent": savedPercent(original: result.originalBytes, optimized: result.optimizedBytes),
      "width": result.width,
      "height": result.height,
      "originalWidth": result.originalWidth,
      "originalHeight": result.originalHeight,
      "optimized": result.optimized,
      "durationMs": elapsedMs(rowStart, rowEnd),
    ])
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
  "sampleCount": options.paths.count,
  "originalBytes": originalTotal,
  "optimizedBytes": optimizedTotal,
  "savedPercent": savedPercent(original: originalTotal, optimized: optimizedTotal),
  "durationMs": elapsedMs(start, end),
  "rows": rows,
]

let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))

struct Result {
  let optimizedPath: String
  let originalBytes: Int
  let optimizedBytes: Int
  let width: Int
  let height: Int
  let originalWidth: Int
  let originalHeight: Int
  let optimized: Bool
}

func optimize(path: String, options: Options) throws -> Result {
  let url = URL(fileURLWithPath: path)
  let attrs = try FileManager.default.attributesOfItem(atPath: path)
  let originalBytes = attrs[.size] as? Int ?? 0
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
    throw BenchError("Could not open image")
  }

  let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
  let originalWidth = props[kCGImagePropertyPixelWidth] as? Int ?? 0
  let originalHeight = props[kCGImagePropertyPixelHeight] as? Int ?? 0
  let originalLongEdge = max(originalWidth, originalHeight)
  let sourceExt = url.pathExtension.lowercased()
  let directExts = Set(["png", "jpg", "jpeg", "webp", "gif"])
  let stem = options.stem ?? safeStem(url)

  if originalBytes <= options.smallDirectBytes && originalLongEdge <= options.maxLongEdge && directExts.contains(sourceExt) {
    let outputPath = URL(fileURLWithPath: options.outDir).appendingPathComponent(stem + "." + sourceExt).path
    if !FileManager.default.fileExists(atPath: outputPath) {
      try FileManager.default.copyItem(atPath: path, toPath: outputPath)
    }
    return Result(
      optimizedPath: outputPath,
      originalBytes: originalBytes,
      optimizedBytes: fileSize(outputPath),
      width: originalWidth,
      height: originalHeight,
      originalWidth: originalWidth,
      originalHeight: originalHeight,
      optimized: false
    )
  }

  let outputPath = URL(fileURLWithPath: options.outDir).appendingPathComponent(stem + "-native-max\(options.maxLongEdge)-q\(options.jpegQuality).jpg").path
  let outputUrl = URL(fileURLWithPath: outputPath)
  if !FileManager.default.fileExists(atPath: outputPath) {
    let thumbnailOptions: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: options.maxLongEdge,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCache: false,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
      throw BenchError("Could not create thumbnail")
    }
    guard let destination = CGImageDestinationCreateWithURL(outputUrl as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
      throw BenchError("Could not create JPEG destination")
    }
    let jpegOptions: [CFString: Any] = [
      kCGImageDestinationLossyCompressionQuality: Double(options.jpegQuality) / 100.0,
    ]
    CGImageDestinationAddImage(destination, image, jpegOptions as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw BenchError("Could not write JPEG")
    }
  }

  let metadata = imageDimensions(outputPath)
  let optimizedBytes = fileSize(outputPath)
  if optimizedBytes >= originalBytes {
    let fallbackPath = URL(fileURLWithPath: options.outDir).appendingPathComponent(stem + "." + sourceExt).path
    if !FileManager.default.fileExists(atPath: fallbackPath) {
      try FileManager.default.copyItem(atPath: path, toPath: fallbackPath)
    }
    return Result(
      optimizedPath: fallbackPath,
      originalBytes: originalBytes,
      optimizedBytes: fileSize(fallbackPath),
      width: originalWidth,
      height: originalHeight,
      originalWidth: originalWidth,
      originalHeight: originalHeight,
      optimized: false
    )
  }

  return Result(
    optimizedPath: outputPath,
    originalBytes: originalBytes,
    optimizedBytes: optimizedBytes,
    width: metadata.width,
    height: metadata.height,
    originalWidth: originalWidth,
    originalHeight: originalHeight,
    optimized: true
  )
}

func imageDimensions(_ path: String) -> (width: Int, height: Int) {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
    return (0, 0)
  }
  return (
    props[kCGImagePropertyPixelWidth] as? Int ?? 0,
    props[kCGImagePropertyPixelHeight] as? Int ?? 0
  )
}

func parseArgs() -> Options {
  var options = Options()
  var index = 1
  while index < CommandLine.arguments.count {
    let arg = CommandLine.arguments[index]
    switch arg {
    case "--max-long-edge":
      index += 1
      options.maxLongEdge = Int(CommandLine.arguments[safe: index] ?? "") ?? options.maxLongEdge
    case "--quality":
      index += 1
      options.jpegQuality = Int(CommandLine.arguments[safe: index] ?? "") ?? options.jpegQuality
    case "--small-direct-bytes":
      index += 1
      options.smallDirectBytes = Int(CommandLine.arguments[safe: index] ?? "") ?? options.smallDirectBytes
    case "--out-dir":
      index += 1
      options.outDir = CommandLine.arguments[safe: index] ?? ""
    case "--stem":
      index += 1
      options.stem = CommandLine.arguments[safe: index]
    default:
      options.paths.append(arg)
    }
    index += 1
  }
  return options
}

func safeStem(_ url: URL) -> String {
  let raw = url.deletingPathExtension().lastPathComponent
  let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
  return String(raw.map { allowed.contains($0) ? $0 : "_" })
}

func fileSize(_ path: String) -> Int {
  ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? Int) ?? 0
}

func savedPercent(original: Int, optimized: Int) -> Double {
  guard original > 0 else { return 0 }
  return rounded((1.0 - Double(optimized) / Double(original)) * 100.0)
}

func elapsedMs(_ start: UInt64, _ end: UInt64) -> Double {
  rounded(Double(end - start) / 1_000_000.0)
}

func rounded(_ value: Double) -> Double {
  (value * 10).rounded() / 10
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

extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
