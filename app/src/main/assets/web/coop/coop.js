// Shared co-op client: signaling over SSE + POST, WebRTC helpers, stats reporting.
// Used by the guest page (this folder) and injected into the game for the host.
window.Coop = (function () {
  // The 2P page talks to whatever served it (the online server, or a host's own LAN server); the host is told
  // through window.COOP_ORIGIN (a LAN room uses the server inside the host app).
  const served = /^https?:$/.test(location.protocol) && location.pathname.indexOf('/coop/') === 0;
  const ORIGIN = window.COOP_ORIGIN || (served ? location.origin : 'https://192.220.36.155:8790');
  const API = ORIGIN + '/coop/api';
  const ICE = window.COOP_ICE || [{ urls: 'stun:192.220.36.155:3478' }];

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).toLowerCase();

  class Signal {
    constructor(room, role) { this.room = room.toUpperCase(); this.role = role; this.id = uid(); this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; return this; }
    open() {
      return new Promise((resolve, reject) => {
        let ready = false;
        const es = new EventSource(`${API}/events?room=${this.room}&role=${this.role}&id=${this.id}`);
        this.es = es;
        const bind = name => es.addEventListener(name, e => {
          const data = JSON.parse(e.data);
          if (name === 'hello') { ready = true; resolve(data); }
          this.h[name] && this.h[name](data);
        });
        ['hello', 'peer-joined', 'peer-left', 'message'].forEach(bind);
        es.onerror = () => {
          if (!ready && es.readyState === 2) reject(new Error('cannot join room'));
          this.h.error && this.h.error(es.readyState);
        };
      });
    }
    send(msg) {
      return fetch(`${API}/send?room=${this.room}&id=${this.id}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(msg) });
    }
    close() { this.es && this.es.close(); }
  }

  // Queue ICE candidates that arrive before the remote description is set.
  function iceQueue(pc) {
    const q = [];
    return {
      add(c) { pc.remoteDescription ? pc.addIceCandidate(c).catch(() => {}) : q.push(c); },
      flush() { while (q.length) pc.addIceCandidate(q.shift()).catch(() => {}); },
    };
  }

  const NEAR_RELAY_IP = '182.16.109.94'; // the near coturn (P302's Hong Kong box; was 103.70.77.178 before 11-17)
  async function stats(pc) {
    const st = await pc.getStats(), by = {};
    st.forEach(s => { by[s.id] = s; });
    let pair = null, inV = null, outV = null;
    st.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = by[s.selectedCandidatePairId]; });
    if (!pair) st.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = pair || s; });
    st.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inV = s;
      if (s.type === 'outbound-rtp' && s.kind === 'video') outV = s;
    });
    const l = pair ? by[pair.localCandidateId] || {} : {}, r = pair ? by[pair.remoteCandidateId] || {} : {};
    // 11-16: which relay carries the call (hk = the near coturn, cf = Cloudflare) and how this side reaches it
    // (udp / tcp / tls), plus the round trip of every candidate pair that answered, keyed the same way, so one
    // report compares the relays for the same two players.
    const relayOf = c => !c || c.candidateType !== 'relay' ? null
      : String(c.url || '').includes(NEAR_RELAY_IP) || (c.address || c.ip) === NEAR_RELAY_IP ? 'hk' : 'cf';
    const keyOf = (a, b) => (relayOf(a) ? relayOf(a) + '-' + (a.relayProtocol || '?') : a.candidateType || '?') + '>' + (relayOf(b) || b.candidateType || '?');
    const alt = {};
    st.forEach(s => {
      if (s.type !== 'candidate-pair' || !s.responsesReceived || !s.totalRoundTripTime) return;
      const k = keyOf(by[s.localCandidateId] || {}, by[s.remoteCandidateId] || {}), ms = Math.round(s.totalRoundTripTime / s.responsesReceived * 1000);
      if (!(k in alt) || ms < alt[k]) alt[k] = ms;
    });
    return {
      path: pair ? `${l.candidateType || '?'}(${l.protocol || '?'}) -> ${r.candidateType || '?'}` : null,
      via: pair ? relayOf(l) || relayOf(r) || 'direct' : undefined, viaProto: l.candidateType === 'relay' ? l.relayProtocol : undefined,
      alt: Object.keys(alt).length ? alt : undefined,
      // 11-16: public IPv6 candidates on each side ([mine, peer's]). Host addresses are hidden behind mDNS names,
      // so srflx/prflx count too. With IPv6 on both ends a direct path is often possible where IPv4 behind carrier
      // NAT is not, so this says how many relayed rooms could go direct.
      v6: [0, 0].map((_, i) => { let n = 0; st.forEach(c => { if (c.type === (i ? 'remote-candidate' : 'local-candidate') && c.candidateType !== 'relay' && String(c.address || c.ip || '').includes(':')) n++; }); return n; }),
      rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      inFps: inV ? inV.framesPerSecond : undefined, inSize: inV && inV.frameWidth ? `${inV.frameWidth}x${inV.frameHeight}` : undefined,
      inKB: inV ? Math.round(inV.bytesReceived / 1024) : undefined, lost: inV ? inV.packetsLost : undefined,
      // 11-18: what the 2P actually saw: freezes [count, seconds], frames dropped, resend requests, average buffer
      inFreeze: inV && inV.freezeCount != null ? [inV.freezeCount, Math.round((inV.totalFreezesDuration || 0) * 10) / 10] : undefined,
      inGot: inV ? inV.packetsReceived : undefined, inDropped: inV ? inV.framesDropped : undefined, nack: inV ? inV.nackCount : undefined,
      jbAvgMs: inV && inV.jitterBufferEmittedCount ? Math.round(inV.jitterBufferDelay / inV.jitterBufferEmittedCount * 1000) : undefined,
      outFps: outV ? outV.framesPerSecond : undefined, outSize: outV && outV.frameWidth ? `${outV.frameWidth}x${outV.frameHeight}` : undefined,
      outKB: outV ? Math.round(outV.bytesSent / 1024) : undefined,
    };
  }

  // STUN always; TURN relay credentials too while the relay is switched on.
  async function iceServersFor(sig) {
    try {
      const r = await fetch(`${API}/ice?room=${sig.room}&id=${sig.id}`);
      const j = await r.json();
      if (j.lan) return []; // LAN room: no STUN, no relay, the two devices reach each other directly
      return j.iceServers && j.iceServers.length ? j.iceServers : ICE;
    } catch { return ICE; }
  }

  function report(payload) {
    return fetch(API + '/report', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) }).catch(() => {});
  }

  function device() {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'other';
    const app = /MicroMessenger/.test(ua) ? 'WeChat' : /QQ\//.test(ua) ? 'QQ' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'WebView';
    const net = navigator.connection ? navigator.connection.effectiveType : undefined;
    return { os, app, net };
  }

  return { ORIGIN, API, ICE, Signal, iceQueue, iceServersFor, stats, report, device };
})();
