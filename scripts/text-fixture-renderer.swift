#!/usr/bin/env swift
import AppKit
import Foundation

struct Fixture: Decodable {
  let width: Int
  let height: Int
  let blocks: [Block]
}

struct Block: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  let fontSize: Double
  let lineHeight: Double?
  let mono: Bool?
  let lines: [String]
}

guard CommandLine.arguments.count == 3 else {
  fail("Usage: text-fixture-renderer <fixture.json> <output.png>")
}

let fixturePath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: fixture.width,
  pixelsHigh: fixture.height,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fail("Could not allocate fixture bitmap")
}

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fail("Could not create fixture graphics context")
}
NSGraphicsContext.current = context
NSColor(calibratedRed: 0.969, green: 0.973, blue: 0.984, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: fixture.width, height: fixture.height).fill()

for block in fixture.blocks {
  let panel = NSRect(
    x: block.x - 18,
    y: Double(fixture.height) - block.y - block.height + block.fontSize + 16,
    width: block.width,
    height: block.height
  )
  NSColor.white.setFill()
  NSColor(calibratedRed: 0.851, green: 0.871, blue: 0.91, alpha: 1).setStroke()
  let panelPath = NSBezierPath(roundedRect: panel, xRadius: 8, yRadius: 8)
  panelPath.fill()
  panelPath.stroke()

  let font = block.mono == true
    ? NSFont.monospacedSystemFont(ofSize: block.fontSize, weight: .regular)
    : NSFont.systemFont(ofSize: block.fontSize)
  let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor(calibratedRed: 0.09, green: 0.125, blue: 0.165, alpha: 1),
  ]
  let lineHeight = block.lineHeight ?? (block.fontSize * 1.55)
  var baseline = Double(fixture.height) - block.y
  for line in block.lines {
    (line as NSString).draw(at: NSPoint(x: block.x, y: baseline - block.fontSize), withAttributes: attributes)
    baseline -= lineHeight
  }
}

context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fail("Could not encode fixture PNG")
}
try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
