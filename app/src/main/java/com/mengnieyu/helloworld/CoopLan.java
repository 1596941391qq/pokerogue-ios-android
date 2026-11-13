package com.mengnieyu.helloworld;

import static org.nanohttpd.protocols.http.response.Response.newChunkedResponse;
import static org.nanohttpd.protocols.http.response.Response.newFixedLengthResponse;

import org.json.JSONArray;
import org.json.JSONObject;
import org.nanohttpd.protocols.http.IHTTPSession;
import org.nanohttpd.protocols.http.request.Method;
import org.nanohttpd.protocols.http.response.Response;

import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * LAN co-op: the signaling for a room hosted on this phone, answered by the app's own local server
 * (CanvasGameServer), so a room works with no internet at all: the friend joins over the same Wi-Fi or this
 * phone's hotspot. Same protocol as the online server (server/signal.js in the co-op project) and as the
 * desktop app's coop-lan.mjs: each side listens with Server-Sent Events and POSTs messages that are relayed to
 * the other side. The 2P page itself (coop/guest2.html) is one of the game's bundled files.
 */
final class CoopLan {
    private static final Pattern ROOM_RE = Pattern.compile("^[A-Z0-9]{4,8}$"), ID_RE = Pattern.compile("^[a-z0-9-]{8,40}$");
    private static final int MAX_BODY = 64 * 1024;
    private static final long PING_SECONDS = 5; // also how soon a closed connection is noticed (the write fails)
    private static final byte[] PING = ": ping\n\n".getBytes(StandardCharsets.UTF_8);
    // mobile data, VPNs and other interfaces a friend on the same Wi-Fi cannot reach
    private static final Pattern SKIP_IF = Pattern.compile("^(rmnet|ccmni|pdp|v4-|clat|dummy|tun|ppp|wwan|seth|usb_rmnet|ip6|sit|gre).*");

    private static final Object lock = new Object();
    private static String room;       // the room this phone hosts: set when the game on this phone takes the host seat
    private static Seat host, guest;

    private CoopLan() {}

    private static final class Seat {
        final String id, role, ip;
        final EventStream out = new EventStream(this);
        Seat(String id, String role, String ip) { this.id = id; this.role = role; this.ip = ip; }
    }

    /** The body of one event stream: blocks until there is something to send, a comment line every few seconds. */
    private static final class EventStream extends InputStream {
        private final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
        private final Seat seat;
        private byte[] rest;
        private int restAt;
        private volatile boolean closed;

        EventStream(Seat seat) { this.seat = seat; }

        void push(String event, JSONObject data) { pushRaw(event, data.toString()); }
        void pushRaw(String event, String json) { queue.offer(("event: " + event + "\ndata: " + json + "\n\n").getBytes(StandardCharsets.UTF_8)); }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (rest == null) {
                if (closed) return -1;
                try {
                    rest = queue.poll(PING_SECONDS, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return -1;
                }
                if (closed) return -1;
                if (rest == null) rest = PING;
                restAt = 0;
            }
            int n = Math.min(len, rest.length - restAt);
            System.arraycopy(rest, restAt, b, off, n);
            restAt += n;
            if (restAt >= rest.length) rest = null;
            return n;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
        }

        /** Called by the server when the connection is gone, and by {@link #kick} to end the stream. */
        @Override
        public void close() {
            if (closed) return;
            closed = true;
            queue.offer(new byte[0]); // wake a blocked read
            left(seat);
        }
    }

    /** Answers /coop/api/* requests; null for any other path. */
    static Response handle(IHTTPSession session, String path, int port) {
        if (!path.startsWith("/coop/api/")) return null;
        try {
            Method method = session.getMethod();
            if (method == Method.OPTIONS) return reply(204, "{}");
            String body = method == Method.POST ? readBody(session) : null; // always read it: the connection is reused
            Map<String, String> q = session.getParms();
            String what = path.substring("/coop/api/".length());
            boolean local = "127.0.0.1".equals(session.getRemoteIpAddress());
            if (method == Method.GET && what.equals("lan")) {
                // asked by the game on this phone before it opens a room: where can a friend reach this server?
                if (!local) return error(403, "local only");
                return reply(200, new JSONObject().put("port", port).put("addresses", new JSONArray(lanAddresses())).toString());
            }
            if (method == Method.GET && what.equals("events")) return events(q, session.getRemoteIpAddress(), local);
            if (method == Method.POST && what.equals("send")) return relay(q, body);
            if (method == Method.POST && what.equals("report")) return reply(200, "{\"ok\":true}"); // nothing is collected on a LAN
            // No STUN or relay on a LAN: the two devices reach each other directly.
            if (method == Method.GET && what.equals("ice")) return reply(200, "{\"iceServers\":[],\"lan\":true}");
            if (method == Method.GET && what.equals("health")) return reply(200, "{\"ok\":true,\"lan\":true}");
            return error(404, "not found");
        } catch (Exception e) {
            return error(500, "server error");
        }
    }

    private static Response events(Map<String, String> q, String ip, boolean local) throws Exception {
        String r = upper(q.get("room")), role = q.get("role"), id = q.get("id") == null ? "" : q.get("id");
        if (!ROOM_RE.matcher(r).matches() || !("host".equals(role) || "guest".equals(role)) || !ID_RE.matcher(id).matches()) return error(400, "bad params");
        Seat me, other, old = null;
        synchronized (lock) {
            if (role.equals("host")) {
                // The host seat belongs to the game on this phone; taking it is what opens the room.
                if (!local) return error(403, "host must be local");
                if (!r.equals(room)) { old = guest; guest = null; room = r; }
                if (host != null && !host.id.equals(id)) { Seat h = host; host = null; kick(h); }
                me = host = new Seat(id, role, ip);
                other = guest;
            } else {
                if (!r.equals(room)) return error(404, "room not found");
                if (guest != null && !guest.id.equals(id)) {
                    // A closed connection is only noticed at the next ping, so a 2P who reloads the page would
                    // find their own seat still taken: the same device may take it over.
                    if (!guest.ip.equals(ip)) return error(409, "guest already in room");
                    old = guest;
                }
                me = guest = new Seat(id, role, ip);
                other = host;
            }
        }
        if (old != null) kick(old);
        me.out.queue.offer(": connected\n\n".getBytes(StandardCharsets.UTF_8));
        me.out.push("hello", new JSONObject().put("room", r).put("role", role).put("peer", other == null ? JSONObject.NULL : other.role));
        if (other != null) other.out.push("peer-joined", new JSONObject().put("role", role));
        Response res = newChunkedResponse(new CustomStatus(200, "OK"), "text/event-stream", me.out);
        res.setUseGzip(false); // gzip would hold the events back
        res.addHeader("Cache-Control", "no-store");
        res.addHeader("Access-Control-Allow-Origin", "*");
        return res;
    }

    private static Response relay(Map<String, String> q, String body) {
        String r = upper(q.get("room")), id = q.get("id");
        Seat me = null, peer = null;
        synchronized (lock) {
            if (r.equals(room)) {
                if (host != null && host.id.equals(id)) { me = host; peer = guest; }
                else if (guest != null && guest.id.equals(id)) { me = guest; peer = host; }
            }
        }
        if (me == null) return error(403, "not in room");
        if (body == null || body.isEmpty() || body.indexOf('\n') >= 0 || body.indexOf('\r') >= 0) return error(400, "bad body");
        if (peer == null) return error(409, "peer not connected");
        peer.out.pushRaw("message", body);
        return reply(200, "{\"ok\":true}");
    }

    /** End a seat's stream without telling the other side (the caller has already replaced the seat). */
    private static void kick(Seat s) { s.out.close(); }

    private static void left(Seat s) {
        Seat other;
        synchronized (lock) {
            if (host == s) { host = null; other = guest; }
            else if (guest == s) { guest = null; other = host; }
            else return; // already replaced
        }
        try {
            if (other != null) other.out.push("peer-left", new JSONObject().put("role", s.role));
        } catch (Exception ignored) {}
    }

    private static String readBody(IHTTPSession session) throws IOException {
        int length;
        try {
            length = Integer.parseInt(session.getHeaders().get("content-length"));
        } catch (Exception e) {
            return "";
        }
        if (length < 0 || length > MAX_BODY) throw new IOException("too large");
        byte[] buf = new byte[length];
        InputStream in = session.getInputStream();
        int got = 0;
        while (got < length) {
            int n = in.read(buf, got, length - got);
            if (n < 0) break;
            got += n;
        }
        return new String(buf, 0, got, StandardCharsets.UTF_8).trim();
    }

    private static String upper(String s) { return s == null ? "" : s.toUpperCase(); }

    private static Response reply(int code, String json) {
        Response res = newFixedLengthResponse(new CustomStatus(code, code == 200 ? "OK" : code == 204 ? "No Content" : "Error"), "application/json", json.getBytes(StandardCharsets.UTF_8));
        res.setUseGzip(false);
        res.addHeader("Cache-Control", "no-store");
        res.addHeader("Access-Control-Allow-Origin", "*");
        res.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.addHeader("Access-Control-Allow-Headers", "Content-Type");
        return res;
    }

    private static Response error(int code, String message) {
        return reply(code, "{\"error\":\"" + message + "\"}");
    }

    /** This phone's addresses on Wi-Fi and on its own hotspot, most likely one first. */
    static List<String> lanAddresses() {
        final List<String[]> found = new ArrayList<>(); // { rank, address }
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                String name = nif.getName() == null ? "" : nif.getName().toLowerCase();
                if (!nif.isUp() || nif.isLoopback() || SKIP_IF.matcher(name).matches()) continue;
                int rank = name.startsWith("wlan") ? 0 : name.startsWith("ap") || name.startsWith("swlan") || name.startsWith("softap") ? 1
                        : name.startsWith("eth") || name.startsWith("usb") || name.startsWith("rndis") ? 2 : 5;
                for (InetAddress a : Collections.list(nif.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    found.add(new String[]{String.valueOf(rank + (a.isSiteLocalAddress() ? 0 : 3)), a.getHostAddress()});
                }
            }
        } catch (Exception ignored) {}
        Collections.sort(found, new Comparator<String[]>() {
            @Override
            public int compare(String[] x, String[] y) { return Integer.parseInt(x[0]) - Integer.parseInt(y[0]); }
        });
        List<String> out = new ArrayList<>();
        for (String[] f : found) if (!out.contains(f[1])) out.add(f[1]);
        return out;
    }
}
