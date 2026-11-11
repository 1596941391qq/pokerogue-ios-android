// Co-op host, part 1 of 3: the link to the guest. Injected into the running game after coop.js.
// Streams the game canvas to the guest over WebRTC and turns the guest's button presses into keyboard
// input. host-game.js (turns, picks, party) and host-overlay.js (bubbles on the battlefield) talk to the
// guest through window.CoopLink. Room code comes from window.PRS_COOP_ROOM (default TEST).
window.CoopLink = (function () {
  const onMsg = [], onOpen = [], onClose = [];
  let gate = null, sendFn = null, up = false, ever = false;
  return {
    send: m => sendFn && sendFn(m),          // to the guest (dropped while not connected)
    on: fn => onMsg.push(fn),                  // every message from the guest
    onOpen: fn => onOpen.push(fn),             // the data channel just opened: send current state
    onClose: fn => onClose.push(fn),           // the guest dropped: nothing may wait for 2P any more
    online: () => up,                          // a guest is connected right now (data channel open)
    everJoined: () => ever,                    // a guest has been here at least once
    setGate: fn => { gate = fn; },             // (btn, down) => false drops a guest press
    press: null,                               // (btn, down) => synthetic key for the game; set below
    _bind: fn => { sendFn = fn; },
    _msg: m => onMsg.forEach(f => { try { f(m); } catch (e) { console.log('COOP handler error ' + e); } }),
    _open: () => { up = true; ever = true; onOpen.forEach(f => { try { f(); } catch (e) { console.log('COOP open error ' + e); } }); },
    _close: () => { if (!up) return; up = false; onClose.forEach(f => { try { f(); } catch (e) { console.log('COOP close error ' + e); } }); },
    _allow: (btn, down) => !gate || gate(btn, down),
  };
})();

(async function () {
  const log = (...a) => console.log('COOP', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const room = (window.PRS_COOP_ROOM || 'TEST').toUpperCase();

  let canvas;
  for (let i = 0; i < 240 && !(canvas = document.querySelector('canvas')); i++) await sleep(500);
  if (!canvas) return log('no canvas');
  await sleep(3000);
  const stream = canvas.captureStream(30);

  // The game's sound for the guest: tap Phaser's WebAudio master (before the host's own master-volume
  // node, so the host turning the game down does not silence the guest) into a MediaStream track.
  let audioTrack = null;
  function gameAudio() {
    if (audioTrack && audioTrack.readyState === 'live') return audioTrack;
    try {
      const sm = (window.PRS_SCENE && window.PRS_SCENE.sound) || (window.Phaser && Phaser.GAMES && Phaser.GAMES[0] && Phaser.GAMES[0].sound);
      const ctx = sm && sm.context, src = sm && (sm.masterMuteNode || sm.masterVolumeNode);
      if (!ctx || !src || !ctx.createMediaStreamDestination) return null;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      audioTrack = dest.stream.getAudioTracks()[0] || null;
      if (audioTrack) { stream.addTrack(audioTrack); log('game audio tapped, context ' + ctx.state); }
    } catch (e) { log('game audio not available', String(e)); }
    return audioTrack;
  }

  // Guest buttons -> the game's default keyboard layout (keyCode, key, code).
  const KEYS = {
    up: [38, 'ArrowUp', 'ArrowUp'], down: [40, 'ArrowDown', 'ArrowDown'], left: [37, 'ArrowLeft', 'ArrowLeft'],
    right: [39, 'ArrowRight', 'ArrowRight'], a: [32, ' ', 'Space'], b: [8, 'Backspace', 'Backspace'], menu: [27, 'Escape', 'Escape'],
    stats: [67, 'c', 'KeyC'], submit: [13, 'Enter', 'Enter'], shiny: [82, 'r', 'KeyR'], form: [70, 'f', 'KeyF'],
    gender: [71, 'g', 'KeyG'], ability: [69, 'e', 'KeyE'], nature: [78, 'n', 'KeyN'], tera: [86, 'v', 'KeyV'],
  };
  function press(btn, down) {
    const k = KEYS[btn]; if (!k) return;
    const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k[1], code: k[2], bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => k[0] });
    Object.defineProperty(ev, 'which', { get: () => k[0] });
    window.dispatchEvent(ev);
  }
  CoopLink.press = press;

  // Which game screen is up: the game writes it to #touchControls[data-ui-mode] for its own touch buttons.
  // The guest gets it so the phone shows only the keys that screen uses.
  const tc = document.getElementById('touchControls');
  const uiMode = () => (tc && tc.dataset.uiMode) || null;
  if (tc) new MutationObserver(() => CoopLink.send({ ui: uiMode() })).observe(tc, { attributes: true, attributeFilter: ['data-ui-mode'] });

  let pc = null, ice = null, timer = null, gathered = {}, startGen = 0;
  // guest keys held right now, released when the guest drops so nothing sticks
  const held = new Set();
  function dropped(why) {
    if (!CoopLink.online()) return;
    log('guest link down: ' + why);
    held.forEach(b => press(b, false)); held.clear();
    CoopLink._close();
  }
  const sig = new Coop.Signal(room, 'host');

  async function start() {
    if (pc) { const old = pc; pc = null; old.close(); }
    dropped('new offer');
    clearInterval(timer);
    gathered = {};
    gameAudio();
    const gen = ++startGen, servers = await Coop.iceServersFor(sig);
    if (gen !== startGen) return; // a newer start() took over while we waited
    const mine = pc = new RTCPeerConnection({ iceServers: servers });
    ice = Coop.iceQueue(pc);
    mine.onicecandidate = e => {
      if (!e.candidate) return;
      gathered[e.candidate.type] = (gathered[e.candidate.type] || 0) + 1;
      sig.send({ type: 'ice', candidate: e.candidate.toJSON() });
    };
    mine.onconnectionstatechange = () => {
      if (mine !== pc) return;
      log('state', mine.connectionState);
      if (['disconnected', 'failed', 'closed'].includes(mine.connectionState)) dropped(mine.connectionState);
      else if (mine.connectionState === 'connected' && dc.readyState === 'open' && !CoopLink.online()) { dc.send(JSON.stringify({ ui: uiMode() })); CoopLink._open(); }
      if (mine.connectionState === 'connected') {
        let n = 0;
        const send = async () => Coop.report({ role: 'host', room, n: n++, state: mine.connectionState, gathered, device: Coop.device(), ...(await Coop.stats(mine)) });
        setTimeout(send, 5000);
        timer = setInterval(() => { if (n < 12) send(); }, 30000);
      }
      if (mine.connectionState === 'failed') Coop.report({ role: 'host', room, state: 'failed', gathered, device: Coop.device() });
    };
    const dc = mine.createDataChannel('input', { ordered: true });
    dc.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      // a press can be refused by the turn rules (host-game.js); releases always pass so no key sticks
      if (m.btn && (!m.down || CoopLink._allow(m.btn, m.down))) { press(m.btn, m.down); m.down ? held.add(m.btn) : held.delete(m.btn); }
      if (m.ping) dc.send(JSON.stringify({ pong: m.ping }));
      CoopLink._msg(m);
    };
    CoopLink._bind(m => { if (dc.readyState === 'open') dc.send(JSON.stringify(m)); });
    window.PRS_COOP_SEND = CoopLink.send; // older test scripts
    dc.onopen = () => { if (mine !== pc) return; dc.send(JSON.stringify({ ui: uiMode() })); CoopLink._open(); };
    dc.onclose = () => { if (mine === pc) dropped('channel closed'); };
    stream.getTracks().forEach(t => mine.addTrack(t, stream));
    const offer = await mine.createOffer();
    await mine.setLocalDescription(offer);
    if (mine !== pc) return; // replaced while the offer was being made
    sig.send({ type: 'offer', sdp: offer.sdp, n: gen }); // n: the guest echoes it in its answer
    setTimeout(() => { if (mine === pc && mine.connectionState !== 'connected') Coop.report({ role: 'host', room, state: 'stuck-' + mine.iceConnectionState, gathered, device: Coop.device() }); }, 20000);
    log('offer sent');
  }

  sig.on('peer-joined', () => log('guest joined'))
    .on('peer-left', () => { log('guest left'); clearInterval(timer); const old = pc; pc = null; if (old) old.close(); dropped('guest left'); })
    .on('message', async m => {
      if (m.type === 'ready') start().catch(e => log('offer failed', String(e)));
      else if (m.type === 'answer' && pc) {
        if (m.n != null && m.n !== startGen) return; // answer to an offer that has been replaced
        try { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); ice.flush(); } catch (e) { log('answer not applied', String(e)); }
      }
      else if (m.type === 'ice' && ice) ice.add(m.candidate);
    });
  const hello = await sig.open();
  log('room open', room, 'guest already here:', !!hello.peer);
  // Host restarted while the guest page stayed open: offer straight away instead of waiting for 'ready'.
  if (hello.peer) start().catch(e => log('offer failed', String(e)));
})().catch(e => console.log('COOP FAIL ' + (e && e.stack || e)));
