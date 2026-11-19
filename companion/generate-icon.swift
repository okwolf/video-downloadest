import AppKit

let output = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)

func makeIcon(pixelSize: Int, outputPath: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelSize, pixelsHigh: pixelSize,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: pixelSize, height: pixelSize)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    let scale = CGFloat(pixelSize) / 1024
    context.scaleBy(x: scale, y: scale)

    let background = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 1024, height: 1024), xRadius: 225, yRadius: 225)
    NSGradient(colors: [NSColor(calibratedRed: 0.30, green: 0.29, blue: 0.91, alpha: 1),
                        NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.42, alpha: 1)])!
        .draw(in: background, angle: 135)

    let card = NSBezierPath(roundedRect: NSRect(x: 157, y: 210, width: 710, height: 574), xRadius: 78, yRadius: 78)
    NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
    card.fill()

    let screen = NSBezierPath(roundedRect: NSRect(x: 210, y: 270, width: 604, height: 410), xRadius: 42, yRadius: 42)
    NSColor(calibratedRed: 0.055, green: 0.075, blue: 0.18, alpha: 1).setFill()
    screen.fill()

    let play = NSBezierPath()
    play.move(to: NSPoint(x: 455, y: 385))
    play.line(to: NSPoint(x: 455, y: 565))
    play.line(to: NSPoint(x: 615, y: 475))
    play.close()
    NSColor(calibratedRed: 0.63, green: 0.67, blue: 1, alpha: 1).setFill()
    play.fill()

    let record = NSBezierPath(ovalIn: NSRect(x: 735, y: 647, width: 82, height: 82))
    NSColor(calibratedRed: 0.98, green: 0.26, blue: 0.31, alpha: 1).setFill()
    record.fill()

    let saved = NSBezierPath(ovalIn: NSRect(x: 684, y: 112, width: 214, height: 214))
    NSColor(calibratedRed: 0.18, green: 0.73, blue: 0.50, alpha: 1).setFill()
    saved.fill()
    let check = NSBezierPath()
    check.lineWidth = 25
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    check.move(to: NSPoint(x: 741, y: 216))
    check.line(to: NSPoint(x: 784, y: 174))
    check.line(to: NSPoint(x: 846, y: 250))
    NSColor.white.setStroke()
    check.stroke()

    NSGraphicsContext.current?.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "VideoDownloadestIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not encode icon image"])
    }
    try data.write(to: URL(fileURLWithPath: outputPath))
}

let variants: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
]
for (name, size) in variants { try makeIcon(pixelSize: size, outputPath: "\(output)/\(name)") }
