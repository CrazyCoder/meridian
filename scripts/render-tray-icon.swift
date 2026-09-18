// Regenerate the committed macOS template assets: swift scripts/render-tray-icon.swift
// Draw directly at each backing scale to preserve crisp menu-bar strokes.
import Foundation
import CoreGraphics
import ImageIO

let directory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "assets", isDirectory: true)
for scale in 1...3 {
    let pixels = 18 * scale
    guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                                  bytesPerRow: pixels * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fatalError("Could not create template drawing context")
    }
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    context.setStrokeColor(CGColor(gray: 0, alpha: 1))
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.setLineWidth(1.5)
    context.strokeEllipse(in: CGRect(x: 2, y: 2, width: 14, height: 14))
    context.setLineWidth(1)
    context.strokeEllipse(in: CGRect(x: 6, y: 2, width: 6, height: 14))
    context.move(to: CGPoint(x: 2, y: 9))
    context.addLine(to: CGPoint(x: 16, y: 9))
    context.strokePath()
    for y in [2.0, 16.0] {
        context.fillEllipse(in: CGRect(x: 7.75, y: y - 1.25, width: 2.5, height: 2.5))
    }
    let suffix = scale == 1 ? "" : "@\(scale)x"
    let output = directory.appendingPathComponent("trayTemplate\(suffix).png")
    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("Could not create \(output.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Could not write \(output.path)") }
}
