import Foundation
import Network

/// LAN co-op: a small HTTP server inside the app, so a room hosted on this device works with no internet at
/// all (the friend is on the same Wi-Fi or on this device's hotspot). It serves the 2P page (coop/guest2.html
/// + coop.js from the bundled web folder) and the signaling, with the same protocol as the online server
/// (server/signal.js in the co-op project), the desktop app's coop-lan.mjs and the Android app's CoopLan:
/// each side listens with Server-Sent Events and POSTs messages that are relayed to the other side.
/// Plain http on purpose: a browser accepts no certificate for a LAN address, and the 2P page needs nothing
/// that requires https. Started the first time the game asks for `coop/api/lan` (BundleSchemeHandler).
final class LanCoopServer {
    static let shared = LanCoopServer()

    private static let ports: [UInt16] = [8790, 8791, 8792, 0] // fixed ports first, then any free one
    private static let files = ["guest2.html": "text/html; charset=utf-8", "coop.js": "text/javascript; charset=utf-8"] // nothing else is served
    private static let maxRequest = 80 * 1024

    private let queue = DispatchQueue(label: "pokerogue.lan")
    private let startLock = NSLock()
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web/coop", isDirectory: true)
    private var listener: NWListener?
    private var listenPort: UInt16 = 0
    // everything below is touched on `queue` only
    private var room: String?            // set when the game on this device takes the host seat
    private var seats: [String: Seat] = [:] // "host" / "guest"
    private var pingTimer: DispatchSourceTimer?

    private final class Seat {
        let id: String, role: String, ip: String, conn: NWConnection
        init(id: String, role: String, ip: String, conn: NWConnection) { self.id = id; self.role = role; self.ip = ip; self.conn = conn }
    }

    private struct Request {
        let method: String, path: String, query: [String: String], body: Data
    }

    /// Starts the server if it is not running. Returns its port, or nil when it could not start.
    /// Not to be called on the server's own queue (it waits for the listener).
    func ensureStarted() -> UInt16? {
        startLock.lock(); defer { startLock.unlock() }
        if listener != nil, listenPort != 0 { return listenPort }
        for p in Self.ports {
            guard let l = try? NWListener(using: .tcp, on: p == 0 ? .any : NWEndpoint.Port(rawValue: p)!) else { continue }
            let ready = DispatchSemaphore(value: 0)
            var ok = false
            l.stateUpdateHandler = { state in
                switch state {
                case .ready: ok = true; ready.signal()
                case .failed, .cancelled: ready.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.start(queue: queue)
            _ = ready.wait(timeout: .now() + 3)
            if ok, let port = l.port?.rawValue, port != 0 {
                // If the system takes the listener away later (app in the background for long), start again next time.
                l.stateUpdateHandler = { [weak self, weak l] state in
                    guard let self, case .failed = state else { return }
                    l?.cancel()
                    self.startLock.lock(); if self.listener === l { self.listener = nil; self.listenPort = 0 }; self.startLock.unlock()
                }
                listener = l; listenPort = port
                queue.async { self.startPings() }
                return port
            }
            l.stateUpdateHandler = nil
            l.cancel()
        }
        return nil
    }

    /// This device's addresses on Wi-Fi and on its own hotspot, most likely one first.
    static func lanAddresses() -> [String] {
        var found: [(rank: Int, address: String)] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { return [] }
        defer { freeifaddrs(list) }
        var at = list
        while let p = at {
            defer { at = p.pointee.ifa_next }
            let flags = Int32(p.pointee.ifa_flags)
            guard let sa = p.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            let name = String(cString: p.pointee.ifa_name)
            // en0 is Wi-Fi, bridge* is the personal hotspot; mobile data (pdp_ip*) and VPN tunnels cannot be reached by a friend
            let rank: Int
            if name == "en0" { rank = 0 } else if name.hasPrefix("bridge") || name.hasPrefix("ap") { rank = 1 } else if name.hasPrefix("en") { rank = 2 } else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let address = String(cString: host)
            if address.hasPrefix("169.254.") || address.hasPrefix("127.") { continue }
            found.append((rank, address))
        }
        var out: [String] = []
        for f in found.sorted(by: { $0.rank < $1.rank }) where !out.contains(f.address) { out.append(f.address) }
        return out
    }

    // MARK: - Connections

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        read(conn, Data())
    }

    private func read(_ conn: NWConnection, _ buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, error in
            guard let self else { conn.cancel(); return }
            var buffer = buffer
            if let data { buffer.append(data) }
            switch Self.parse(buffer) {
            case .some(.some(let request)): self.route(conn, request)
            case .some(.none): conn.cancel() // not HTTP
            case .none: // not all here yet
                if done || error != nil || buffer.count > Self.maxRequest { conn.cancel() } else { self.read(conn, buffer) }
            }
        }
    }

    /// nil: need more bytes; .some(nil): malformed; otherwise the request.
    private static func parse(_ data: Data) -> Request?? {
        guard let headEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[data.startIndex..<headEnd.lowerBound], encoding: .utf8) else { return .some(nil) }
        let lines = head.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count >= 2, let parts = URLComponents(string: String(first[1])) else { return .some(nil) }
        var length = 0
        for line in lines.dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].lowercased() == "content-length" { length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? -1 }
        }
        guard length >= 0, length <= maxRequest else { return .some(nil) }
        let bodyStart = headEnd.upperBound
        guard data.endIndex - bodyStart >= length else { return nil }
        var query: [String: String] = [:]
        for item in parts.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(first[0]), path: parts.path, query: query, body: data.subdata(in: bodyStart..<(bodyStart + length)))
    }

    private func route(_ conn: NWConnection, _ r: Request) {
        if r.method == "OPTIONS" { return send(conn, 204, Data()) }
        switch (r.method, r.path) {
        case ("GET", "/coop/api/events"): events(conn, r)
        case ("POST", "/coop/api/send"): relay(conn, r)
        case ("POST", "/coop/api/report"): json(conn, 200, ["ok": true]) // nothing is collected on a LAN
        // No STUN or relay on a LAN: the two devices reach each other directly.
        case ("GET", "/coop/api/ice"): json(conn, 200, ["iceServers": [Any](), "lan": true])
        case ("GET", "/coop/api/health"): json(conn, 200, ["ok": true, "lan": true])
        default:
            let name = r.path.hasPrefix("/coop/") ? String(r.path.dropFirst(6)) : ""
            if r.method == "GET", let type = Self.files[name], let data = try? Data(contentsOf: root.appendingPathComponent(name)) {
                send(conn, 200, data, type: type)
            } else {
                json(conn, 404, ["error": "not found"])
            }
        }
    }

    // MARK: - Signaling

    private func events(_ conn: NWConnection, _ r: Request) {
        let code = (r.query["room"] ?? "").uppercased(), role = r.query["role"] ?? "", id = r.query["id"] ?? ""
        guard code.range(of: "^[A-Z0-9]{4,8}$", options: .regularExpression) != nil, role == "host" || role == "guest",
              id.range(of: "^[a-z0-9-]{8,40}$", options: .regularExpression) != nil else { return json(conn, 400, ["error": "bad params"]) }
        let ip = Self.remoteAddress(conn)
        if role == "host" {
            // The host seat belongs to the game on this device; taking it is what opens the room.
            guard ip.loopback else { return json(conn, 403, ["error": "host must be local"]) }
            if room != code { room = code; drop("guest") }
        } else {
            guard room == code else { return json(conn, 404, ["error": "room not found"]) }
            // A 2P who reloads the page may take their own seat over; anyone else finds it taken.
            if let old = seats[role], old.id != id, old.ip != ip.text { return json(conn, 409, ["error": "guest already in room"]) }
        }
        if let old = seats[role], old.id != id { drop(role) }
        let me = Seat(id: id, role: role, ip: ip.text, conn: conn)
        seats[role] = me
        let other = seats[role == "host" ? "guest" : "host"]
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n" +
            "Access-Control-Allow-Origin: *\r\n\r\n: connected\n\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        push(me, "hello", ["room": code, "role": role, "peer": other?.role ?? NSNull()])
        if let other { push(other, "peer-joined", ["role": role]) }
        watch(me)
    }

    /// Notice when a listener goes away: nothing more is expected from it, so any end of its input is the end.
    private func watch(_ seat: Seat) {
        seat.conn.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] _, _, done, error in
            guard let self else { return }
            if done || error != nil { self.left(seat) } else { self.watch(seat) }
        }
    }

    private func left(_ seat: Seat) {
        seat.conn.cancel()
        guard seats[seat.role] === seat else { return } // already replaced
        seats[seat.role] = nil
        if let other = seats[seat.role == "host" ? "guest" : "host"] { push(other, "peer-left", ["role": seat.role]) }
    }

    /// Empty a seat without telling the other side (the caller is putting someone new in it).
    private func drop(_ role: String) {
        seats.removeValue(forKey: role)?.conn.cancel()
    }

    private func relay(_ conn: NWConnection, _ r: Request) {
        guard (r.query["room"] ?? "").uppercased() == room, let me = seats.values.first(where: { $0.id == r.query["id"] }) else {
            return json(conn, 403, ["error": "not in room"])
        }
        guard let text = String(data: r.body, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
              !text.contains("\n"), !text.contains("\r") else { return json(conn, 400, ["error": "bad body"]) }
        guard let peer = seats[me.role == "host" ? "guest" : "host"] else { return json(conn, 409, ["error": "peer not connected"]) }
        peer.conn.send(content: Data("event: message\ndata: \(text)\n\n".utf8), completion: .contentProcessed { _ in })
        json(conn, 200, ["ok": true])
    }

    private func push(_ seat: Seat, _ event: String, _ data: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: data), let text = String(data: body, encoding: .utf8) else { return }
        seat.conn.send(content: Data("event: \(event)\ndata: \(text)\n\n".utf8), completion: .contentProcessed { _ in })
    }

    private func startPings() {
        guard pingTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 15, repeating: 15)
        timer.setEventHandler { [weak self] in
            for seat in (self?.seats ?? [:]).values { seat.conn.send(content: Data(": ping\n\n".utf8), completion: .contentProcessed { _ in }) }
        }
        timer.resume()
        pingTimer = timer
    }

    // MARK: - Replies

    private func json(_ conn: NWConnection, _ status: Int, _ object: [String: Any]) {
        send(conn, status, (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8), type: "application/json")
    }

    /// One reply per connection, then the connection is closed (requests are few and small).
    private func send(_ conn: NWConnection, _ status: Int, _ body: Data, type: String = "text/plain") {
        let reasons = [200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict"]
        var head = "HTTP/1.1 \(status) \(reasons[status] ?? "Error")\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n"
        head += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n\r\n"
        conn.send(content: Data(head.utf8) + body, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
    }

    private static func remoteAddress(_ conn: NWConnection) -> (text: String, loopback: Bool) {
        guard case let .hostPort(host, _) = conn.endpoint else { return ("?", false) }
        switch host {
        case .ipv4(let a): return ("\(a)", a.isLoopback)
        case .ipv6(let a):
            if let v4 = a.asIPv4 { return ("\(v4)", v4.isLoopback) }
            return ("\(a)", a.isLoopback)
        case .name(let n, _): return (n, false)
        @unknown default: return ("?", false)
        }
    }
}
