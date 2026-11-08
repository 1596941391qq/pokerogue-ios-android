import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the bundled PokeRogue build (the `web` folder in the app bundle) to the
/// WKWebView under `pokerogue://localhost/`. This plays the same role as the
/// NanoHTTPD server in the Android app: ES modules, fetch() and localStorage all
/// need a real origin, which file:// URLs don't give.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "pokerogue"
    static let startURL = URL(string: "\(scheme)://localhost/index.html")!

    private let root: URL
    private let queue = DispatchQueue(label: "pokerogue.scheme", qos: .userInitiated, attributes: .concurrent)
    /// Tasks WebKit has cancelled; touching them afterwards raises an exception.
    private var stopped = Set<ObjectIdentifier>()

    override init() {
        root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let request = task.request
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.load(request)
            DispatchQueue.main.async {
                guard !self.stopped.contains(ObjectIdentifier(task)) else { return }
                task.didReceive(result.response)
                if !result.body.isEmpty { task.didReceive(result.body) }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    // MARK: - File loading

    private func load(_ request: URLRequest) -> (response: URLResponse, body: Data) {
        guard let url = request.url else {
            return reply(URL(string: "\(Self.scheme)://localhost/")!, status: 400, body: Data())
        }

        var path = url.path // already percent-decoded ("Comet Punch.mp3")
        if path.isEmpty || path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).standardizedFileURL

        // Never serve anything outside the bundled web folder.
        guard file.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe)
        else {
            return reply(url, status: 404, body: Data())
        }

        let mime = Self.mimeType(for: file.pathExtension)
        if let range = request.value(forHTTPHeaderField: "Range"),
           let (start, end) = Self.parseRange(range, length: data.count) {
            let slice = data.subdata(in: start..<(end + 1))
            return reply(url, status: 206, body: slice, mime: mime, extra: [
                "Content-Range": "bytes \(start)-\(end)/\(data.count)",
            ])
        }
        return reply(url, status: 200, body: data, mime: mime)
    }

    private func reply(
        _ url: URL, status: Int, body: Data, mime: String = "text/plain", extra: [String: String] = [:]
    ) -> (response: URLResponse, body: Data) {
        var headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        ]
        headers.merge(extra) { _, new in new }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        return (response, body)
    }

    private static func parseRange(_ header: String, length: Int) -> (Int, Int)? {
        guard length > 0, header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: ",").first ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map { String($0) }
        guard parts.count == 2 else { return nil }
        var start: Int
        var end: Int
        if parts[0].isEmpty { // suffix range: bytes=-500
            guard let suffix = Int(parts[1]), suffix > 0 else { return nil }
            start = max(0, length - suffix)
            end = length - 1
        } else {
            guard let s = Int(parts[0]) else { return nil }
            start = s
            end = Int(parts[1]) ?? (length - 1)
        }
        end = min(end, length - 1)
        guard start <= end else { return nil }
        return (start, end)
    }

    private static let mimeOverrides: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "webmanifest": "application/manifest+json",
        "wasm": "application/wasm",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "mp3": "audio/mpeg",
        "m4a": "audio/mp4",
        "ogg": "audio/ogg",
        "wav": "audio/wav",
        "ttf": "font/ttf",
        "otf": "font/otf",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "txt": "text/plain; charset=utf-8",
    ]

    static func mimeType(for ext: String) -> String {
        let ext = ext.lowercased()
        if let known = mimeOverrides[ext] { return known }
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }
}
