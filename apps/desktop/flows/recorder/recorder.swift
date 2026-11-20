// Records the app's window for `npm run record` (M16.12, S17): ScreenCaptureKit on the window's region of its
// display, which keeps the real window buttons (capturing the window alone swaps them for a sharing pill), so
// the window must be in front and whatever covers it would be recorded. ProRes 4444 at the display's scale;
// record.ts composites it, and compiles this on demand (swiftc -parse-as-library).
//
//   recorder displays               the displays as JSON: CG global frame (top-left origin), scale
//   recorder record <pid> <out.mov> records that process's window until SIGINT or SIGTERM
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

func fail(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write("recorder: \(message)\n".data(using: .utf8)!)
  exit(code)
}

func say(_ message: String) {
  FileHandle.standardError.write("recorder: \(message)\n".data(using: .utf8)!)
}

func scale(of display: SCDisplay) -> Double {
  let screen = NSScreen.screens.first {
    ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID
  }
  return Double(screen?.backingScaleFactor ?? 1)
}

final class Writer: NSObject, SCStreamOutput, @unchecked Sendable {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  var started = false
  var frames = 0
  init(url: URL, width: Int, height: Int) throws {
    try? FileManager.default.removeItem(at: url)
    writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.proRes4444, AVVideoWidthKey: width, AVVideoHeightKey: height,
    ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue
    else { return }
    if !started {
      writer.startWriting()
      writer.startSession(atSourceTime: sb.presentationTimeStamp)
      started = true
    }
    if input.isReadyForMoreMediaData { input.append(sb); frames += 1 }
  }
}

/** Suspends until SIGINT or SIGTERM. The sources live as long as the wait does. */
func untilStopped() async {
  signal(SIGINT, SIG_IGN)
  signal(SIGTERM, SIG_IGN)
  await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
    let once = DispatchQueue(label: "stop")
    var resumed = false
    var sources: [DispatchSourceSignal] = []
    for sig in [SIGINT, SIGTERM] {
      let source = DispatchSource.makeSignalSource(signal: sig, queue: once)
      source.setEventHandler {
        guard !resumed else { return }
        resumed = true
        sources.forEach { $0.cancel() }
        c.resume()
      }
      source.resume()
      sources.append(source)
    }
  }
}

@main
struct Recorder {
  static func main() async throws {
    // A command-line program has no window-server connection until AppKit opens one.
    _ = await MainActor.run { NSApplication.shared }
    let args = CommandLine.arguments
    switch args.count > 1 ? args[1] : "" {
    case "displays":
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      let displays = content.displays.map { d -> [String: Any] in
        ["id": d.displayID, "x": d.frame.minX, "y": d.frame.minY, "width": d.frame.width, "height": d.frame.height, "scale": scale(of: d)]
      }
      print(String(data: try JSONSerialization.data(withJSONObject: displays), encoding: .utf8)!)

    case "record":
      guard args.count == 4, let pid = Int32(args[2]) else { fail("usage: recorder record <pid> <out.mov>", 2) }
      try await record(pid: pid, to: URL(fileURLWithPath: args[3]))

    default:
      fail("usage: recorder displays | recorder record <pid> <out.mov>", 2)
    }
  }

  static func record(pid: Int32, to url: URL) async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    // Its biggest window that is actually on screen: a window in another Space or behind a full-screen app isn't.
    guard let window = content.windows.filter({ $0.owningApplication?.processID == pid && $0.windowLayer == 0 })
      .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
    else { fail("process \(pid) has no window on screen: is it in another Space, or behind a full-screen app?", 3) }
    guard let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY)) })
    else { fail("no display under the window", 3) }
    let s = scale(of: display)
    let config = SCStreamConfiguration()
    config.sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    config.width = Int(window.frame.width * s)
    config.height = Int(window.frame.height * s)
    config.showsCursor = false
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    config.queueDepth = 8
    let writer = try Writer(url: url, width: config.width, height: config.height)
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: nil)
    try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
    try await stream.startCapture()
    say("recording window \(window.windowID) at \(config.width)x\(config.height)")

    await untilStopped()
    try await stream.stopCapture()
    // The file ends at the last change; record.ts holds that frame on for the closing pause.
    writer.input.markAsFinished()
    await writer.writer.finishWriting()
    say("wrote \(writer.frames) frames")
  }
}
