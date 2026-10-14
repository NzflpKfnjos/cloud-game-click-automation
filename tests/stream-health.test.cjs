'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '..', 'cloud-game-click-automation.user.js'), 'utf8');
// Export private helpers only in the VM copy; the installed userscript exposes no test API.
const instrumentedSource = source.replace("  if (document.readyState === 'loading') {",
  "  window.__streamTest = { sample: sampleStreamHealth, state: streamState, session: diagnosticSession, log: logDiagnostic, important: logImportantDiagnostic, exportLogs: exportDiagnostics };\n  if (document.readyState === 'loading') {");

class FakeEventTarget {
  constructor(tagName = 'DIV') {
    this.tagName = tagName.toUpperCase();
    this.listeners = new Map();
    this.children = [];
    this.nodes = new Map();
    this.dataset = {};
    this.style = { display: 'block', visibility: 'visible', opacity: '1' };
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.isConnected = true;
    this.events = [];
    this.rect = { left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 };
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== callback));
  }

  dispatch(type, detail = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, ...detail };
    for (const callback of [...(this.listeners.get(type) || [])]) callback(event);
    return event;
  }

  dispatchEvent(event) {
    this.events.push(event);
    this.dispatch(event.type, event);
    return true;
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  contains(node) { return node === this || this.children.includes(node); }
  getBoundingClientRect() { return this.rect; }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new FakeEventTarget());
    return this.nodes.get(selector);
  }
  closest(selector) {
    if (selector === '[data-action]') return this.dataset.action ? this : null;
    if (selector === 'canvas, video') return ['CANVAS', 'VIDEO'].includes(this.tagName) ? this : null;
    if (selector === '#cgca-panel') return this.id === 'cgca-panel' ? this : null;
    return null;
  }
}

class FakeClock {
  constructor() { this.now = 0; this.nextId = 1; this.timers = new Map(); }
  schedule(callback, delay, repeating = false) {
    const id = this.nextId++;
    delay = Math.max(1, Number(delay) || 0);
    this.timers.set(id, { callback, delay, repeating, due: this.now + delay });
    return id;
  }
  async flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
  async advance(milliseconds) {
    const end = this.now + milliseconds;
    let callbacks = 0;
    await this.flush();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++callbacks < 100000, 'timer loop must make progress');
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.repeating) timer.due += timer.delay;
      else this.timers.delete(id);
      timer.callback();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
}

function createGame({ loading = false, surface = 'video', hidden = false, online = true,
  recording = true, savedMap = new Map(), sessionMap = new Map(),
  standalone = false,
  importedPoints = [{ x: 0.5, y: 0.5, global: false }] } = {}) {
  const clock = new FakeClock();
  const document = new FakeEventTarget();
  document.readyState = loading ? 'loading' : 'complete';
  document.hidden = hidden;
  document.visibilityState = hidden ? 'hidden' : 'visible';
  document.documentElement = new FakeEventTarget('HTML');
  document.body = new FakeEventTarget('BODY');
  document.createElement = (tagName) => {
    const node = new FakeEventTarget(tagName);
    node.click = () => node.dispatch('click');
    return node;
  };
  document.createTextNode = (text) => ({ textContent: text });
  const parent = new FakeEventTarget();
  const messages = [];
  parent.postMessage = (data, origin) => messages.push({ at: clock.now, data, origin });
  const window = new FakeEventTarget();
  window.parent = standalone ? window : parent;
  const reloads = [];
  window.location = {
    href: 'https://start.qq.com/game/arm-game/?_reconnect=test-generation&_cgca_generation=test-generation#/game/700967',
    pathname: '/game/arm-game/', hash: '#/game/700967', search: '?_reconnect=test-generation&_cgca_generation=test-generation',
    origin: 'https://start.qq.com',
    reload: () => reloads.push(clock.now),
  };
  const saved = savedMap;
  saved.set('cloud-game-click-diagnostics-enabled-v1', String(recording));
  const exportedPayloads = [];
  class FakeBlob {
    constructor(parts, options) { this.parts = parts; this.options = options; }
  }
  class FakeURL extends URL {
    static createObjectURL(blob) {
      exportedPayloads.push(JSON.parse(blob.parts.join('')));
      return 'blob:diagnostic-export';
    }
    static revokeObjectURL() {}
  }
  const session = sessionMap;
  const storage = (map, failures = {}) => ({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (failures.writes) throw new Error('Storage quota exceeded for test');
      return map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  });

  class FakeVideo extends FakeEventTarget {
    constructor() {
      super('VIDEO');
      this.currentTime = 0;
      this.videoWidth = 800;
      this.videoHeight = 450;
      this.readyState = 4;
      this.paused = false;
      this.ended = false;
      this.srcObject = { getVideoTracks: () => [{ readyState: 'live', enabled: true, muted: false }] };
      this.totalVideoFrames = 0;
      this.frameCallbacks = new Map();
      this.nextFrameId = 1;
      this.playCalls = 0;
    }
    requestVideoFrameCallback(callback) {
      const id = this.nextFrameId++;
      this.frameCallbacks.set(id, callback);
      return id;
    }
    cancelVideoFrameCallback(id) { this.frameCallbacks.delete(id); }
    getVideoPlaybackQuality() { return { totalVideoFrames: this.totalVideoFrames, droppedVideoFrames: 0 }; }
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); }
    frame() {
      this.currentTime += 1;
      this.totalVideoFrames += 1;
      const callbacks = [...this.frameCallbacks.values()];
      this.frameCallbacks.clear();
      for (const callback of callbacks) callback(clock.now, { mediaTime: this.currentTime, presentedFrames: this.totalVideoFrames });
    }
  }

  class Fake2DContext {
    constructor(canvas) { this.canvas = canvas; }
    drawImage() {}
    putImageData() {}
    fillRect() {}
    clearRect() {}
  }
  class FakeWebGLContext {
    constructor(canvas) { this.canvas = canvas; this.lost = false; this.restores = 0; }
    drawArrays() {}
    drawElements() {}
    isContextLost() { return this.lost; }
    getExtension(name) {
      return name === 'WEBGL_lose_context' ? { restoreContext: () => { this.restores += 1; } } : null;
    }
  }
  class FakeWebGL2Context extends FakeWebGLContext {
    drawArraysInstanced() {}
    drawElementsInstanced() {}
  }
  class FakeCanvas extends FakeEventTarget {
    constructor() { super('CANVAS'); this.width = 800; this.height = 450; this.contexts = new Map(); }
    getContext(type) {
      if (!this.contexts.has(type)) this.contexts.set(type,
        type === '2d' ? new Fake2DContext(this) : type === 'webgl2' ? new FakeWebGL2Context(this) : new FakeWebGLContext(this));
      return this.contexts.get(type);
    }
  }
  class NativePeerConnection extends FakeEventTarget {
    static generateCertificate() { return Promise.resolve('native-certificate'); }
    constructor() {
      super(); this.connectionState = 'connected'; this.iceConnectionState = 'connected';
      this.signalingState = 'stable'; this.restartCalls = 0;
      this.reportId = 'video';
      this.signalingCalls = [];
      this.framesReceived = 1; this.framesDecoded = 1; this.bytesReceived = 100;
      this.track = { kind: 'video', readyState: 'live', enabled: true, muted: false };
    }
    getStats() {
      return Promise.resolve(new Map([[this.reportId, { id: this.reportId, type: 'inbound-rtp', kind: 'video',
        bytesReceived: this.bytesReceived, framesReceived: this.framesReceived, framesDecoded: this.framesDecoded }]]));
    }
    getReceivers() { return [{ track: this.track }]; }
    restartIce() { this.restartCalls += 1; }
    createOffer(...args) { this.signalingCalls.push(['createOffer', ...args]); return Promise.resolve({ type: 'offer', sdp: 'native-test' }); }
    setLocalDescription(...args) { this.signalingCalls.push(['setLocalDescription', ...args]); return Promise.resolve(); }
    setRemoteDescription(...args) { this.signalingCalls.push(['setRemoteDescription', ...args]); return Promise.resolve(); }
    addIceCandidate(...args) { this.signalingCalls.push(['addIceCandidate', ...args]); return Promise.resolve(); }
    close() { this.connectionState = 'closed'; this.iceConnectionState = 'closed'; this.dispatch('connectionstatechange'); }
    progress() { this.framesReceived += 1; this.framesDecoded += 1; this.bytesReceived += 100; }
  }
  window.RTCPeerConnection = NativePeerConnection;
  window.HTMLCanvasElement = FakeCanvas;
  window.HTMLVideoElement = FakeVideo;
  window.CanvasRenderingContext2D = Fake2DContext;
  window.WebGLRenderingContext = FakeWebGLContext;
  window.WebGL2RenderingContext = FakeWebGL2Context;
  const video = new FakeVideo();
  const canvas = new FakeCanvas();
  let surfaces = surface === 'canvas' ? [canvas] : surface === 'video' ? [video] : [];
  document.querySelectorAll = (selector) => surfaces.filter((node) => selector.includes(node.tagName.toLowerCase()));
  document.elementFromPoint = () => surfaces[0] || document.body;
  const navigator = { onLine: online };
  const storageFailures = { writes: false };
  class FakeMouseEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  window.PointerEvent = FakeMouseEvent;
  const context = vm.createContext({
    window, document, navigator, console: { debug() {}, warn() {}, error() {} }, URL: FakeURL, Blob: FakeBlob,
    localStorage: storage(saved, storageFailures), sessionStorage: storage(session),
    performance: { now: () => clock.now },
    Date: class extends Date { static now() { return clock.now; } },
    Math, innerWidth: 800, innerHeight: 450,
    getComputedStyle: (node) => node.style,
    setTimeout: (callback, delay) => clock.schedule(callback, delay),
    clearTimeout: (id) => clock.timers.delete(id),
    setInterval: (callback, delay) => clock.schedule(callback, delay, true),
    clearInterval: (id) => clock.timers.delete(id),
    requestAnimationFrame: (callback) => clock.schedule(callback, 16),
    cancelAnimationFrame: (id) => clock.timers.delete(id),
    PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent,
    HTMLCanvasElement: FakeCanvas, HTMLVideoElement: FakeVideo,
    CanvasRenderingContext2D: Fake2DContext, WebGLRenderingContext: FakeWebGLContext,
    WebGL2RenderingContext: FakeWebGL2Context, RTCPeerConnection: NativePeerConnection,
    prompt: () => JSON.stringify(importedPoints),
  });
  vm.runInContext(instrumentedSource, context, { filename: 'cloud-game-click-automation.user.js' });
  const panel = () => document.documentElement.children.find((node) => node.id === 'cgca-panel');
  const click = (action) => {
    const target = new FakeEventTarget('BUTTON');
    target.dataset.action = action;
    panel().dispatch('click', { target });
  };
  return {
    clock, context, document, navigator, window, parent, messages, video, canvas, saved, session, exportedPayloads, storageFailures, reloads,
    NativePeerConnection, panel, click,
    sample: () => window.__streamTest.sample(),
    control(generation = 'test-generation') {
      window.dispatch('message', { source: window.parent, origin: 'http://localhost:8000',
        data: { type: 'cgca-stream-control-v1', generation, appKey: 'jcc' } });
    },
    repair({ generation = 'test-generation', source = window.parent, appKey = 'jcc',
      session: recoverySession = window.__streamTest.session } = {}) {
      window.dispatch('message', { source, origin: 'http://localhost:8000',
        data: { type: 'cgca-stream-repair-v1', generation, appKey, session: recoverySession } });
    },
    health() { return messages.filter(({ data }) => data.type === 'cgca-stream-health-v1').map(({ data }) => data); },
    recoveries() { return this.health().filter(({ requestRecovery }) => requestRecovery); },
    ready() { document.readyState = 'complete'; document.dispatch('DOMContentLoaded'); },
    removeSurface() { surfaces = []; },
    showSurface(node = video) { surfaces = [node]; },
    setHidden(value) {
      document.hidden = value; document.visibilityState = value ? 'hidden' : 'visible';
      document.dispatch('visibilitychange');
    },
    setOnline(value) { navigator.onLine = value; window.dispatch(value ? 'online' : 'offline'); },
    records() { return JSON.parse(saved.get('cloud-game-click-diagnostics-v1') || '[]'); },
    eventNames() { return this.records().map(({ event }) => event); },
    importantRecords() { return JSON.parse(saved.get('cloud-game-click-incidents-v1') || '[]'); },
    importantEvents(event) { return this.importantRecords().filter((record) => record.event === event); },
    exportLogs() { window.__streamTest.exportLogs(); return exportedPayloads.at(-1); },
  };
}

async function establishFlow(game, peer) {
  game.control();
  await game.clock.advance(5000);
  game.video.frame();
  peer.progress();
  await game.sample();
  await game.clock.advance(5000);
  game.video.frame();
  peer.progress();
  await game.sample();
}

test('a single-coordinate infinite run yields to timers and can be stopped', async () => {
  const game = createGame();
  game.click('import');
  game.panel().querySelector('[data-role="interval"]').value = '100';
  game.panel().querySelector('[data-role="loops"]').value = '0';
  vm.runInContext(`document.documentElement.children.find((node) => node.id === 'cgca-panel').dispatch('click', {
    target: { closest: () => ({ dataset: { action: 'run' } }) }
  });`, game.context, { timeout: 1000 });
  await game.clock.advance(350);
  assert.ok(game.video.events.length > 0, 'the run emits clicks');
  assert.ok(game.video.events.length < 36, 'the interval applies between repeated single-coordinate loops');
  game.click('stop');
  await game.clock.advance(200);
  const clicks = game.video.events.length;
  await game.clock.advance(1000);
  assert.equal(game.video.events.length, clicks);
  assert.match(game.panel().querySelector('[data-role="status"]').textContent, /已停止/);
});

test('disappearing game surface suspends clicks instead of targeting the viewport', async () => {
  const game = createGame({ recording: false });
  game.click('import');
  game.panel().querySelector('[data-role="loops"]').value = '0';
  game.click('run');
  await game.clock.advance(100);
  game.removeSurface();
  const clicks = game.video.events.length;
  await game.clock.advance(1000);
  assert.equal(game.video.events.length, clicks);
  assert.equal(game.document.body.events.length, 0, 'no synthetic click falls back to document.body');
  const blocked = game.importantEvents('click-surface');
  assert.equal(blocked.length, 1, 'a missing surface logs a transition, not every waiting loop');
  assert.equal(blocked[0].data.state, 'blocked');
  assert.equal(blocked[0].data.reason, 'surface-missing');
  game.showSurface();
  await game.clock.advance(400);
  const transitions = game.importantEvents('click-surface');
  assert.equal(game.video.events.length, clicks, 'a returning surface does not prove that the game is still logged in');
  await game.sample();
  game.video.frame();
  await game.sample();
  assert.equal(game.video.events.length, clicks, 'fresh frames still require explicit login confirmation');
  game.click('confirm-resume');
  await game.clock.advance(400);
  assert.ok(game.video.events.length > clicks, 'clicks resume only after explicit login confirmation');
  assert.ok(transitions.length >= 1);
  game.click('stop');
  await game.clock.advance(100);
});

test('RTCPeerConnection is observed at document-start, before the UI exists', async () => {
  const game = createGame({ loading: true });
  assert.equal(game.panel(), undefined);
  assert.notEqual(game.window.RTCPeerConnection, game.NativePeerConnection);
  const peer = new game.window.RTCPeerConnection();
  assert.ok(peer instanceof game.NativePeerConnection, 'constructor hook preserves native prototype behavior');
  assert.equal(game.window.RTCPeerConnection.prototype, game.NativePeerConnection.prototype);
  assert.equal(await game.window.RTCPeerConnection.generateCertificate(), 'native-certificate');
  class DerivedConnection extends game.window.RTCPeerConnection {}
  const derived = new DerivedConnection();
  assert.ok(derived instanceof DerivedConnection, 'constructor hook preserves subclass newTarget');
  game.ready();
  await establishFlow(game, peer);
  assert.ok(game.health().some(({ status }) => status === 'healthy'));
  assert.equal(game.recoveries().length, 0);
});

test('decoding new frames cannot hide a frozen video presentation', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  const decoderTimer = game.clock.schedule(() => peer.progress(), 1000, true);
  await game.clock.advance(40000);
  assert.equal(game.health().at(-1).status, 'blocked', 'decode advances while rVFC/video frame counter stays still');
  assert.equal(game.recoveries().length, 0);
  game.clock.timers.delete(decoderTimer);
});

test('a canvas redraw loop cannot hide frozen inbound video frames', async () => {
  const game = createGame({ surface: 'canvas' });
  const peer = new game.window.RTCPeerConnection();
  game.control();
  const context = game.canvas.getContext('webgl');
  const redrawTimer = game.clock.schedule(() => context.drawArrays(4, 0, 6), 1000, true);
  await game.clock.advance(5000);
  peer.progress();
  await game.sample();
  await game.clock.advance(5000);
  peer.progress();
  await game.sample();
  await game.clock.advance(40000);
  assert.equal(game.health().at(-1).status, 'blocked', 'drawing the same frame does not count as decoded stream progress');
  assert.equal(game.recoveries().length, 0);
  game.clock.timers.delete(redrawTimer);
});

test('a stopped canvas renderer with advancing decoded frames blocks after same-page repair', async () => {
  const game = createGame({ surface: 'canvas' });
  const peer = new game.window.RTCPeerConnection();
  game.control();
  const context = game.canvas.getContext('webgl');
  context.drawArrays(4, 0, 6);
  await game.clock.advance(5000);
  context.drawArrays(4, 0, 6);
  peer.progress();
  await game.sample();
  await game.clock.advance(5000);
  context.drawArrays(4, 0, 6);
  peer.progress();
  await game.sample();
  const decoderTimer = game.clock.schedule(() => peer.progress(), 1000, true);
  await game.clock.advance(40000);
  assert.equal(game.health().at(-1).status, 'blocked', 'new decoded frames with a previously active renderer that stops drawing prove render stall');
  assert.equal(game.recoveries().length, 0);
  game.clock.timers.delete(decoderTimer);
});

test('an RTC report replacement and reset frame counters receive a fresh grace period', async () => {
  const game = createGame({ surface: 'canvas' });
  const peer = new game.window.RTCPeerConnection();
  game.control();
  await game.clock.advance(5000);
  peer.progress();
  await game.sample();
  await game.clock.advance(5000);
  peer.progress();
  await game.sample();
  await game.clock.advance(25000);
  peer.reportId = 'replacement-video';
  peer.framesDecoded = 0; peer.framesReceived = 0; peer.bytesReceived = 0;
  await game.sample();
  await game.clock.advance(20000);
  assert.equal(game.recoveries().length, 0, 'old stale counters do not survive stream replacement');
});

test('healthy video and inbound RTC progression prevents recovery', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  const progressTimer = game.clock.schedule(() => { game.video.frame(); peer.progress(); }, 1000, true);
  await game.clock.advance(90000);
  assert.equal(game.recoveries().length, 0);
  assert.equal(peer.restartCalls, 0);
  assert.equal(game.video.playCalls, 0);
  game.clock.timers.delete(progressTimer);
});

test('confirmed stopped frames get a soft recovery and then block without requesting a reload', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(30000);
  assert.ok(game.video.playCalls >= 1, 'try to resume the existing media element');
  assert.equal(game.recoveries().length, 0, 'soft recovery has a grace period');
  await game.clock.advance(5000);
  assert.equal(game.recoveries().length, 0);
  await game.clock.advance(5000);
  const recovery = game.health().at(-1);
  assert.equal(game.recoveries().length, 0, 'persistent confirmed stalls preserve the existing cloud session');
  assert.equal(recovery.generation, 'test-generation');
  assert.equal(recovery.appKey, 'jcc');
  assert.equal(recovery.status, 'blocked');
  assert.ok(recovery.evidence.staleForMs >= 30000);
  assert.ok(recovery.evidence.softRecoveryWaitMs >= 10000);
  assert.ok(game.importantEvents('stream-recovery-blocked').length > 0);
  assert.equal(game.reloads.length, 0);
});

test('frames resuming during soft recovery are healthy without requesting a reload', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(30000);
  game.video.frame();
  peer.progress();
  await game.sample();
  const progressTimer = game.clock.schedule(() => { game.video.frame(); peer.progress(); }, 1000, true);
  await game.clock.advance(20000);
  assert.equal(game.recoveries().length, 0);
  assert.equal(game.health().at(-1).status, 'healthy');
  game.clock.timers.delete(progressTimer);
});

test('background and offline time does not count towards a frozen-frame recovery', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  game.setHidden(true);
  await game.clock.advance(60000);
  assert.equal(game.recoveries().length, 0);
  assert.equal(game.video.playCalls, 0);
  game.setHidden(false);
  await game.clock.advance(20000);
  assert.equal(game.recoveries().length, 0, 'foreground gets a new grace period');
  game.setOnline(false);
  await game.clock.advance(60000);
  assert.equal(game.recoveries().length, 0);
  game.setOnline(true);
  await game.clock.advance(20000);
  assert.equal(game.recoveries().length, 0, 'network restoration gets a new grace period');
});

test('an intentionally paused video without a confirmed connection failure is not reloaded', async () => {
  const game = createGame();
  game.control();
  await game.clock.advance(5000);
  game.video.frame();
  await game.sample();
  game.video.paused = true;
  await game.clock.advance(60000);
  assert.equal(game.recoveries().length, 0);
});

test('an intentionally paused video with an established healthy RTC is not reloaded', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  game.video.paused = true;
  await game.clock.advance(60000);
  assert.equal(game.recoveries().length, 0);
  assert.equal(peer.restartCalls, 0);
  assert.equal(game.video.playCalls, 0, 'do not undo an intentional pause');
});

test('a paused presentation does not mask a confirmed failure of the active RTC peer', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  game.video.paused = true;
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  await game.clock.advance(40000);
  assert.ok(peer.restartCalls > 0, 'known RTC failure is evaluated independently of the paused presentation');
  assert.equal(game.video.playCalls, 0, 'an intentional pause is not undone by unrelated repair');
  assert.equal(game.reloads.length, 0);
});

test('a static canvas alone cannot prove a freeze', async () => {
  const game = createGame({ surface: 'canvas' });
  game.control();
  const context = game.canvas.getContext('2d');
  context.drawImage(game.video, 0, 0);
  await game.clock.advance(5000);
  context.drawImage(game.video, 0, 0);
  await game.sample();
  await game.clock.advance(60000);
  assert.equal(game.recoveries().length, 0, 'an unchanged game scene must not trigger an iframe reload');
});

test('canvas context loss is observable and restoration cancels recovery', async () => {
  const game = createGame({ surface: 'canvas', recording: false });
  game.control();
  const context = game.canvas.getContext('webgl');
  context.drawArrays(4, 0, 6);
  await game.clock.advance(5000);
  context.lost = true;
  const lost = game.canvas.dispatch('webglcontextlost', { defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; } });
  assert.equal(lost.defaultPrevented, true, 'permit browser WebGL restoration');
  await game.clock.advance(30000);
  assert.equal(game.recoveries().length, 0);
  context.lost = false;
  game.canvas.dispatch('webglcontextrestored');
  context.drawArrays(4, 0, 6);
  await game.sample();
  await game.clock.advance(20000);
  assert.equal(game.recoveries().length, 0);
  const contextLost = game.importantEvents('render-context-lost').at(-1);
  const contextRestored = game.importantEvents('render-context-restored').at(-1);
  assert.ok(contextLost, 'GPU failure evidence does not require normal logging');
  assert.equal(contextLost.data.surface.tag, 'canvas');
  assert.ok(contextRestored);
  assert.equal(contextRestored.data.lostForMs, 30000);
});

test('a persistent WebGL context loss blocks without replacing the cloud session', async () => {
  const game = createGame({ surface: 'canvas' });
  game.control();
  const context = game.canvas.getContext('webgl');
  context.drawArrays(4, 0, 6);
  await game.clock.advance(5000);
  context.lost = true;
  game.canvas.dispatch('webglcontextlost');
  await game.clock.advance(40000);
  assert.equal(game.health().at(-1).status, 'blocked');
  assert.ok(context.restores > 0);
  assert.equal(game.recoveries().length, 0);
});

test('a sustained failed peer gets an ICE restart and blocks without requesting a new session', async () => {
  const game = createGame({ surface: 'canvas' });
  const peer = new game.window.RTCPeerConnection();
  game.control();
  await game.clock.advance(5000);
  peer.progress();
  await game.sample();
  await game.clock.advance(5000);
  peer.progress();
  await game.sample();
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  await game.clock.advance(30000);
  assert.ok(peer.restartCalls > 0);
  assert.equal(game.recoveries().length, 0);
  await game.clock.advance(10000);
  assert.equal(game.health().at(-1).status, 'blocked');
  assert.equal(game.recoveries().length, 0);
});

test('an earlier presentation stall does not mask a later failure of the active RTC connection', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(5000);
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  await game.clock.advance(35000);
  assert.ok(game.video.playCalls > 0, 'presentation repair is attempted');
  assert.ok(peer.restartCalls > 0, 'the actual failed peer is repaired independently of the earlier presentation failure');
  assert.equal(game.recoveries().length, 0);
  assert.equal(game.reloads.length, 0);
  assert.deepEqual(peer.signalingCalls, [], 'the page owns signaling; the helper does not manufacture SDP or ICE messages');
});

test('soft repair preserves native signaling behavior and never manufactures SDP', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  assert.equal(peer.createOffer, game.NativePeerConnection.prototype.createOffer);
  assert.equal(peer.setLocalDescription, game.NativePeerConnection.prototype.setLocalDescription);
  assert.equal(peer.setRemoteDescription, game.NativePeerConnection.prototype.setRemoteDescription);
  assert.equal(peer.addIceCandidate, game.NativePeerConnection.prototype.addIceCandidate);
  const offer = await peer.createOffer({ iceRestart: false });
  assert.deepEqual(offer, { type: 'offer', sdp: 'native-test' });
  peer.signalingCalls = [];
  await establishFlow(game, peer);
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  await game.clock.advance(45000);
  assert.ok(peer.restartCalls > 0);
  assert.deepEqual(peer.signalingCalls, []);
  assert.equal(game.recoveries().length, 0);
});

test('standalone and legacy hosted stalls never navigate or reload the session', async () => {
  for (const standalone of [true, false]) {
    const game = createGame({ standalone, recording: false });
    const peer = new game.window.RTCPeerConnection();
    await establishFlow(game, peer);
    const originalLocation = game.window.location.href;
    peer.connectionState = 'failed';
    peer.iceConnectionState = 'failed';
    peer.dispatch('connectionstatechange');
    await game.clock.advance(180000);
    assert.deepEqual(game.reloads, [], 'preserve the session even when all soft recovery attempts fail');
    assert.equal(game.window.location.href, originalLocation);
    assert.equal(game.recoveries().length, 0, 'do not send the legacy host requestRecovery reload command');
    assert.ok(game.importantEvents('stream-recovery-blocked').length > 0);
  }
});

test('failed ICE repair records unavailable or rejected actions and ends blocked', async () => {
  for (const unavailable of [true, false]) {
    const game = createGame({ recording: false });
    const peer = new game.window.RTCPeerConnection();
    await establishFlow(game, peer);
    if (unavailable) peer.restartIce = undefined;
    else peer.restartIce = () => Promise.reject(vm.runInContext("new Error('ICE restart rejected for test')", game.context));
    peer.connectionState = 'failed';
    peer.iceConnectionState = 'failed';
    peer.dispatch('connectionstatechange');
    await game.clock.advance(40000);
    const actions = game.importantEvents('stream-recovery-action').filter(({ data }) => data.action === 'rtc.restartIce');
    if (unavailable) assert.ok(actions.some(({ data }) => data.outcome === 'unavailable'));
    else assert.ok(actions.some(({ data }) => data.outcome === 'failed' && data.error.message === 'ICE restart rejected for test'));
    assert.ok(game.importantEvents('stream-recovery-soft').length > 0);
    assert.ok(game.importantEvents('stream-recovery-blocked').length > 0);
    assert.equal(game.recoveries().length, 0);
    assert.equal(game.reloads.length, 0);
  }
});

test('soft repair attempts respect a one-minute cooldown and three-attempt rolling budget', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  await game.clock.advance(30000);
  assert.equal(peer.restartCalls, 1);
  game.repair();
  await game.clock.flush();
  assert.equal(peer.restartCalls, 1, 'manual repair does not bypass the cooldown');
  await game.clock.advance(60000);
  game.repair();
  await game.clock.flush();
  assert.equal(peer.restartCalls, 2);
  await game.clock.advance(60000);
  game.repair();
  await game.clock.flush();
  assert.equal(peer.restartCalls, 3);
  await game.clock.advance(60000);
  game.repair();
  await game.clock.flush();
  assert.equal(peer.restartCalls, 3, 'three failed repairs do not loop indefinitely');
  await game.clock.advance(600000);
  game.repair();
  await game.clock.flush();
  assert.ok(peer.restartCalls > 3, 'expired attempts leave the rolling budget');
  assert.equal(game.reloads.length, 0);
  assert.equal(game.recoveries().length, 0);
});

test('manual same-page repair accepts only the current host, game, and navigation generation', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  game.repair({ source: new FakeEventTarget() });
  game.repair({ generation: 'previous-generation' });
  game.repair({ appKey: 'naruto' });
  await game.clock.flush();
  assert.equal(peer.restartCalls, 0, 'unrelated messages cannot operate a connection');
  game.repair();
  await game.clock.flush();
  assert.equal(peer.restartCalls, 1);
  assert.ok(game.video.playCalls > 0);
  assert.equal(game.recoveries().length, 0);
  assert.equal(game.reloads.length, 0);
});

test('manual same-page repair rejects a recovery command bound to another stream session', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.dispatch('connectionstatechange');
  game.repair({ session: 'old-stream-session' });
  await game.clock.flush();
  assert.equal(peer.restartCalls, 0);
  game.repair();
  await game.clock.flush();
  assert.equal(peer.restartCalls, 1);
});

test('closed stale peers are never restarted when the current peer fails', async () => {
  const game = createGame({ recording: false });
  const stalePeer = new game.window.RTCPeerConnection();
  await establishFlow(game, stalePeer);
  stalePeer.close();
  const activePeer = new game.window.RTCPeerConnection();
  await game.clock.advance(5000);
  game.video.frame();
  activePeer.progress();
  await game.sample();
  await game.clock.advance(5000);
  game.video.frame();
  activePeer.progress();
  await game.sample();
  activePeer.connectionState = 'failed';
  activePeer.iceConnectionState = 'failed';
  activePeer.dispatch('connectionstatechange');
  await game.clock.advance(35000);
  assert.equal(stalePeer.restartCalls, 0);
  assert.ok(activePeer.restartCalls > 0, 'the current failing connection gets the repair attempt');
  assert.ok(game.importantRecords().some(({ event, data }) => event === 'stream-recovery-attempt'
    && data.trigger === 'automatic'));
});

test('a replaced video source latches automation until fresh frames and user confirmation', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  game.click('import');
  game.panel().querySelector('[data-role="loops"]').value = '0';
  game.click('run');
  await game.clock.advance(500);
  const clicks = game.video.events.length;
  game.video.srcObject = { getVideoTracks: () => [{ readyState: 'live', enabled: true, muted: false }] };
  game.video.frame();
  await game.sample();
  await game.clock.advance(500);
  assert.equal(game.video.events.length, clicks, 'a replacement stream is not evidence that login survived');
  assert.equal(game.panel().querySelector('[data-action="confirm-resume"]').hidden, false,
    'a source replacement exposes the login confirmation latch');
  game.video.frame();
  await game.sample();
  game.click('confirm-resume');
  await game.clock.advance(200);
  assert.ok(game.video.events.length > clicks);
  game.click('stop');
  await game.clock.advance(100);
});

test('clicks stay paused after rendering returns until the user confirms login', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  game.click('import');
  game.panel().querySelector('[data-role="interval"]').value = '100';
  game.panel().querySelector('[data-role="loops"]').value = '0';
  game.click('run');
  await game.clock.advance(30000);
  const pausedClicks = game.video.events.length;
  await game.clock.advance(10000);
  assert.equal(game.video.events.length, pausedClicks, 'freeze recovery pauses the click job');
  const progressTimer = game.clock.schedule(() => { game.video.frame(); peer.progress(); }, 1000, true);
  await game.clock.advance(10000);
  assert.equal(game.video.events.length, pausedClicks, 'resumed rendering does not establish login');
  assert.match(game.panel().innerHTML, /确认登录并继续/);
  game.click('confirm-resume');
  await game.clock.advance(500);
  assert.ok(game.video.events.length > pausedClicks);
  game.click('stop');
  await game.clock.advance(100);
  game.clock.timers.delete(progressTimer);
});

test('a message from another frame cannot install a recovery generation', async () => {
  const game = createGame();
  game.window.dispatch('message', { source: new FakeEventTarget(), origin: 'http://localhost:8000',
    data: { type: 'cgca-stream-control-v1', generation: 'attacker-generation', appKey: 'jcc' } });
  await game.sample();
  assert.equal(game.health().some(({ generation }) => generation === 'attacker-generation'), false);
  game.control();
  await game.sample();
  assert.equal(game.health().at(-1).generation, 'test-generation');
});

test('control from a previous navigation cannot install its stale generation', async () => {
  const game = createGame();
  game.control('previous-navigation');
  await game.sample();
  assert.equal(game.health().some(({ generation }) => generation === 'previous-navigation'), false);
  game.control();
  await game.sample();
  assert.equal(game.health().at(-1).generation, 'test-generation');
});

test('saved custom coordinates and remaining finite loops wait for login confirmation', async () => {
  const point = { x: 0.25, y: 0.75, global: false, surfaceRatio: 800 / 450 };
  const game = createGame({ importedPoints: [point] });
  game.click('import');
  game.panel().querySelector('[data-role="interval"]').value = '100';
  game.panel().querySelector('[data-role="loops"]').value = '10';
  game.click('run');
  await game.clock.advance(250);
  game.window.__streamTest.state.holdAutomation('test-stall');
  game.window.__streamTest.state.prepareRecovery();
  const intent = JSON.parse(game.session.get('cloud-game-click-run-v1'));
  assert.equal(intent.loops, 8);
  assert.deepEqual(intent.points, [point]);
  const resumed = createGame({ sessionMap: game.session });
  await resumed.clock.advance(2000);
  assert.equal(resumed.video.events.length, 0, 'a video element alone never confirms login');
  assert.ok(resumed.session.has('cloud-game-click-run-v1'), 'the pending job remains available for confirmation');
  resumed.click('run');
  await resumed.clock.advance(100);
  resumed.document.dispatch('keydown', { key: 'F8', target: resumed.document.body, preventDefault() {} });
  await resumed.clock.advance(100);
  assert.equal(resumed.video.events.length, 0, 'Run and F8 cannot bypass pending login confirmation');
  await resumed.sample();
  resumed.video.frame();
  await resumed.sample();
  assert.equal(resumed.video.events.length, 0, 'rendered frames are still not permission to click');
  resumed.click('confirm-resume');
  await resumed.clock.advance(2000);
  const clicks = resumed.video.events.filter(({ type }) => type === 'click');
  assert.equal(clicks.length, 8);
  assert.ok(clicks.every(({ clientX, clientY }) => clientX === 200 && clientY === 337.5));
  assert.match(resumed.panel().querySelector('[data-role="status"]').textContent, /运行完成.*8/);
  assert.equal(resumed.session.has('cloud-game-click-run-v1'), false);
});

test('user stop clears run intent and wins against recovery snapshots and pending resume', async () => {
  const game = createGame();
  game.click('import');
  game.panel().querySelector('[data-role="loops"]').value = '0';
  game.click('run');
  await game.clock.advance(150);
  game.click('stop');
  game.window.__streamTest.state.prepareRecovery();
  assert.equal(game.session.has('cloud-game-click-run-v1'), false);
  await game.clock.advance(100);
  const resumeSession = new Map([['cloud-game-click-run-v1', JSON.stringify({ appKey: 'jcc', running: true,
    interval: 100, loops: 8, points: [{ x: 0.25, y: 0.75, global: false }] })],
  ['cloud-game-click-resume-confirmation-v1', JSON.stringify({ appKey: 'jcc', reason: 'stream-stalled', pendingRun: true })]]);
  const resumed = createGame({ sessionMap: resumeSession });
  resumed.click('stop');
  await resumed.clock.advance(2000);
  assert.equal(resumed.video.events.length, 0);
  assert.equal(resumed.session.has('cloud-game-click-run-v1'), false);
  assert.equal(resumed.session.has('cloud-game-click-resume-confirmation-v1'), false,
    'Stop clears the saved login-confirmation latch as well as the run intent');
});

test('hanging RTC stats time out while video monitoring continues without overlapping requests', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  let statsCalls = 0;
  peer.getStats = () => { statsCalls += 1; return new Promise(() => {}); };
  const progressTimer = game.clock.schedule(() => game.video.frame(), 1000, true);
  await game.clock.advance(30000);
  assert.equal(statsCalls, 1, 'do not stack requests on an unresolved getStats promise');
  assert.equal(game.window.__streamTest.state.sampling, false, 'monitor was not left hung');
  assert.equal(game.recoveries().length, 0);
  assert.equal(game.health().at(-1).status, 'healthy');
  const timeout = game.importantEvents('rtc-stats-timeout').at(-1);
  assert.ok(timeout, 'the missing RTC evidence is visible even when ordinary recording is off');
  assert.equal(timeout.data.waitMs, 1500);
  assert.equal(timeout.data.connectionState, 'connected');
  const statsHealth = game.health().at(-1).evidence.statsHealth;
  assert.equal(statsHealth.length, 1);
  assert.equal(statsHealth[0].status, 'timeout');
  assert.equal(statsHealth[0].pending, true);
  game.clock.timers.delete(progressTimer);
});

test('a late RTC report cannot request recovery after the page becomes hidden', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(35000);
  let resolveStats;
  peer.getStats = () => new Promise((resolve) => { resolveStats = resolve; });
  await game.clock.advance(5000);
  assert.equal(typeof resolveStats, 'function');
  game.setHidden(true);
  resolveStats(new Map([[peer.reportId, { id: peer.reportId, type: 'inbound-rtp', kind: 'video',
    framesReceived: peer.framesReceived, framesDecoded: peer.framesDecoded, bytesReceived: peer.bytesReceived }]]));
  await game.clock.flush();
  assert.equal(game.recoveries().length, 0);
});

test('a late RTC report cannot recover a video that has already been replaced', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(35000);
  let resolveStats;
  peer.getStats = () => new Promise((resolve) => { resolveStats = resolve; });
  await game.clock.advance(5000);
  assert.equal(typeof resolveStats, 'function');
  game.showSurface(game.canvas);
  resolveStats(new Map([[peer.reportId, { id: peer.reportId, type: 'inbound-rtp', kind: 'video',
    framesReceived: peer.framesReceived, framesDecoded: peer.framesDecoded, bytesReceived: peer.bytesReceived }]]));
  await game.clock.flush();
  assert.equal(game.recoveries().length, 0);
});

test('a frame stall is persisted and exportable when routine diagnostic recording is disabled', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(40000);
  assert.equal(game.records().length, 0, 'routine logs remain opt-in');
  const soft = game.importantEvents('stream-recovery-soft').at(-1);
  const blocked = game.importantEvents('stream-recovery-blocked').at(-1);
  assert.ok(soft, 'the confirmed fault is recorded automatically');
  assert.ok(blocked, 'a blocked same-page repair is recorded automatically');
  assert.equal(typeof soft.id, 'string');
  assert.equal(soft.source, 'userscript');
  assert.equal(soft.scriptVersion, '1.8.0');
  assert.equal(typeof soft.session, 'string');
  assert.equal(soft.appKey, 'jcc');
  assert.equal(soft.data.incidentId, blocked.data.incidentId, 'soft recovery and blocked state share an incident');
  assert.ok(game.messages.some(({ data }) => data.type === 'cgca-incident-v1' && data.record.id === soft.id));
  const exported = game.exportLogs();
  assert.equal(exported.version, 2);
  assert.equal(exported.source, 'userscript');
  assert.equal(exported.scriptVersion, '1.8.0');
  assert.deepEqual(exported.importantRecords, game.importantRecords());
  assert.deepEqual(exported.records, []);
});

test('routine log churn cannot evict a recorded recovery incident', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(30000);
  const fault = game.importantEvents('stream-recovery-soft').at(-1);
  assert.ok(fault);
  game.saved.set('cloud-game-click-diagnostics-v1', JSON.stringify(Array.from({ length: 2999 }, (_, index) =>
    ({ event: 'earlier-routine-record', data: { index } }))));
  for (let index = 0; index < 101; index += 1) game.window.__streamTest.log('routine-flood', { index });
  assert.equal(game.records().length, 3000);
  assert.ok(game.importantRecords().some(({ id }) => id === fault.id), 'critical records have an independent ring');
  const reloaded = createGame({ recording: false, savedMap: game.saved });
  assert.ok(reloaded.importantRecords().some(({ id }) => id === fault.id), 'fault history survives a new userscript session');
  assert.ok(reloaded.exportLogs().importantRecords.some(({ id }) => id === fault.id));
});

test('an asynchronous video.play failure is recorded before repair blocks without a reload', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  const blockedError = vm.runInContext("new Error('Autoplay blocked for test')", game.context);
  game.video.play = () => {
    game.video.playCalls += 1;
    return Promise.reject(blockedError);
  };
  await game.clock.advance(40000);
  const soft = game.importantEvents('stream-recovery-soft').at(-1);
  const action = game.importantEvents('stream-recovery-action').find((entry) =>
    JSON.stringify(entry.data).includes('Autoplay blocked for test'));
  assert.ok(action, 'the rejected play promise retains its actual error message');
  assert.equal(action.data.incidentId, soft.data.incidentId);
  assert.ok(game.importantEvents('stream-recovery-blocked').length > 0);
  assert.equal(game.recoveries().length, 0);
  assert.equal(game.reloads.length, 0);
  assert.equal(game.window.__streamTest.state.sampling, false);
});

test('a recovery resolution records resumed frames and retains its incident correlation', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(30000);
  const soft = game.importantEvents('stream-recovery-soft').at(-1);
  assert.ok(soft);
  game.video.frame();
  peer.progress();
  await game.sample();
  const resolved = game.importantEvents('stream-recovery-resolved').at(-1);
  assert.ok(resolved, 'the recovery attempt has a recorded outcome');
  assert.equal(resolved.data.incidentId, soft.data.incidentId);
  assert.equal(resolved.data.result, 'frames-resumed');
  assert.ok(resolved.data.evidence.presented.delta > 0);
  assert.equal(game.health().at(-1).status, 'healthy');
  await game.clock.advance(5000);
  assert.equal(game.importantEvents('stream-recovery-resolved').length, 1, 'continued health does not repeat the outcome');
  assert.equal(game.recoveries().length, 0);
});

test('periodic stream evidence distinguishes frame receipt, decode, and presentation without clicking', async () => {
  const game = createGame();
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  const progressTimer = game.clock.schedule(() => { game.video.frame(); peer.progress(); }, 1000, true);
  await game.clock.advance(65000);
  const healthRecords = game.records().filter(({ event }) => event === 'stream-health');
  assert.ok(healthRecords.length >= 3, 'stream samples continue on their own schedule while the click runner is idle');
  const evidence = healthRecords.at(-1).data.evidence;
  assert.equal(evidence.observation, 'progress-observed');
  assert.equal(evidence.viewport.width, 800);
  assert.equal(evidence.surfaceDetails.video.paused, false);
  assert.equal(evidence.surfaceDetails.video.readyState, 4);
  assert.ok(evidence.surfaceDetails.video.totalVideoFrames > 0);
  assert.ok(evidence.presented.delta > 0);
  assert.ok(evidence.presented.progressAgeMs <= 5000);
  assert.equal(evidence.presented.observedProgress, true);
  assert.ok(evidence.peers[0].received.delta > 0);
  assert.ok(evidence.peers[0].decoded.delta > 0);
  assert.ok(evidence.peers[0].bytes.delta > 0);
  assert.equal(game.video.events.length, 0);
  assert.equal(game.recoveries().length, 0);
  game.clock.timers.delete(progressTimer);
});

test('a rejected RTC stats request records the actual failure and allows the next sample', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  const statsError = vm.runInContext("new Error('RTC stats unavailable for test')", game.context);
  const nativeGetStats = peer.getStats;
  let statsCalls = 0;
  peer.getStats = () => { statsCalls += 1; return Promise.reject(statsError); };
  await game.clock.advance(5000);
  const failure = game.importantEvents('rtc-stats-error').at(-1);
  assert.ok(failure);
  assert.equal(failure.data.error.message, 'RTC stats unavailable for test');
  assert.equal(game.window.__streamTest.state.sampling, false);
  assert.equal(game.health().at(-1).evidence.statsHealth[0].status, 'error');
  peer.getStats = () => { statsCalls += 1; return nativeGetStats.call(peer); };
  game.video.frame();
  peer.progress();
  await game.clock.advance(5000);
  assert.equal(statsCalls, 2, 'a rejected request does not leave the peer pending forever');
  assert.equal(game.health().at(-1).evidence.statsHealth[0].status, 'ok');
});

test('edge clicks stay inside the selected surface and logs identify the synthetic target', async () => {
  const game = createGame({ importedPoints: [
    { x: 0, y: 0, global: false }, { x: 1, y: 1, global: false },
  ] });
  game.video.rect = { left: 120, top: 30, width: 400, height: 225, right: 520, bottom: 255 };
  game.click('import');
  game.panel().querySelector('[data-role="loops"]').value = '1';
  game.click('run');
  await game.clock.advance(300);
  const clicks = game.video.events.filter(({ type }) => type === 'click');
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks.map(({ clientX, clientY }) => [clientX, clientY]), [[121, 31], [519, 254]]);
  assert.ok(clicks.every(({ clientX, clientY }) => clientX > game.video.rect.left && clientX < game.video.rect.right
    && clientY > game.video.rect.top && clientY < game.video.rect.bottom));
  const clickRecord = game.records().find(({ event }) => event === 'click-emitted');
  assert.equal(clickRecord.data.target, 'VIDEO');
  assert.equal(clickRecord.data.surface, 'VIDEO');
  assert.equal(clickRecord.data.synthetic, true);
  assert.equal(clickRecord.data.viewport.width, 800);
});

test('a video without frame callbacks falls back to playback quality and still detects later stalls', async () => {
  const game = createGame({ recording: false });
  game.video.requestVideoFrameCallback = undefined;
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  const progressTimer = game.clock.schedule(() => { game.video.frame(); peer.progress(); }, 1000, true);
  await game.clock.advance(45000);
  assert.equal(game.health().at(-1).status, 'healthy', 'playback counter progress works without requestVideoFrameCallback');
  assert.ok(game.health().at(-1).evidence.presented.delta > 0);
  assert.equal(game.recoveries().length, 0);
  game.clock.timers.delete(progressTimer);
  await game.sample();
  await game.clock.advance(40000);
  assert.equal(game.health().at(-1).status, 'blocked', 'the fallback counter also recognizes a stopped presentation');
  assert.equal(game.recoveries().length, 0);
});

test('a foreground grace reset without new frames is not logged as resumed rendering', async () => {
  const game = createGame({ recording: false });
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(30000);
  const soft = game.importantEvents('stream-recovery-soft').at(-1);
  assert.ok(soft);
  game.setHidden(true);
  await game.clock.advance(5000);
  game.setHidden(false);
  await game.clock.advance(5000);
  const resolved = game.importantEvents('stream-recovery-resolved').at(-1);
  assert.ok(resolved);
  assert.equal(resolved.data.incidentId, soft.data.incidentId);
  assert.equal(resolved.data.result, 'monitor-reset', 'a visibility reset provides grace, not evidence that frames resumed');
  assert.equal(game.recoveries().length, 0);
});

test('the protected incident ring keeps the latest 200 critical events', () => {
  const game = createGame({ recording: false });
  const early = game.window.__streamTest.important('early-critical-event', { index: -1 });
  let latest;
  for (let index = 0; index < 205; index += 1) latest = game.window.__streamTest.important('critical-event', { index });
  const records = game.importantRecords();
  assert.equal(records.length, 200);
  assert.equal(records.some(({ id }) => id === early.id), false, 'old critical records expire when the critical ring fills');
  assert.equal(records.at(-1).id, latest.id);
  assert.equal(records.at(-1).data.index, 204);
  assert.equal(game.records().length, 0);
});

test('storage quota failure retains fault evidence in memory for export and host delivery', async () => {
  const game = createGame({ recording: false });
  game.storageFailures.writes = true;
  const peer = new game.window.RTCPeerConnection();
  await establishFlow(game, peer);
  await game.clock.advance(40000);
  assert.equal(game.importantEvents('stream-recovery-soft').length, 0, 'storage was not successfully written');
  const exported = game.exportLogs();
  const soft = exported.importantRecords.find(({ event }) => event === 'stream-recovery-soft');
  assert.ok(soft, 'export falls back to the retained memory ring');
  assert.ok(exported.importantRecords.some(({ event }) => event === 'stream-recovery-blocked'));
  assert.ok(game.messages.some(({ data }) => data.type === 'cgca-incident-v1' && data.record.id === soft.id));
  assert.ok(exported.importantRecords.some(({ event }) => event === 'stream-recovery-attempt'),
    'diagnostic persistence failure does not stop in-page repair');
  assert.equal(game.recoveries().length, 0, 'storage failure never falls back to a page reload');
  assert.equal(game.reloads.length, 0);
});

test('exports redact sensitive fields and URL query or hash values from new and legacy logs', () => {
  const game = createGame();
  const legacy = { event: 'legacy-event', data: {
    href: 'https://start.qq.com/game/arm-game/?ticket=legacy-query-secret#access_token=legacy-hash-secret',
    token: 'legacy-field-secret', cookie: 'legacy-cookie-secret',
    message: 'Authorization=legacy-message-secret Bearer legacy-bearer-secret',
  } };
  game.saved.set('cloud-game-click-diagnostics-v1', JSON.stringify([legacy]));
  game.saved.set('cloud-game-click-incidents-v1', JSON.stringify([
    { id: 'legacy-incident', source: 'userscript', ts: '2026-10-13T01:00:00.000Z', ...legacy },
  ]));
  game.window.__streamTest.log('new-sensitive-event', {
    secret: 'new-field-secret', nested: { password: 'new-password-secret' },
    href: 'https://start.qq.com/game/arm-game/?ticket=new-query-secret#ticket=new-hash-secret',
  });
  const exported = game.exportLogs();
  const serialized = JSON.stringify(exported);
  for (const secret of ['legacy-query-secret', 'legacy-hash-secret', 'legacy-field-secret', 'legacy-cookie-secret',
    'legacy-message-secret', 'legacy-bearer-secret', 'new-field-secret', 'new-password-secret', 'new-query-secret', 'new-hash-secret']) {
    assert.equal(serialized.includes(secret), false, `export must not contain ${secret}`);
  }
  assert.ok(serialized.includes('https://start.qq.com/game/arm-game/'), 'redaction keeps the useful page identity');
  assert.ok(exported.importantRecords.some(({ id }) => id === 'legacy-incident'), 'older stored incidents remain exportable');
});
