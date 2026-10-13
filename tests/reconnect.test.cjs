'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const pageScript = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(pageScript, 'index.html must contain its application script');

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
    this.textContent = '';
    this.attributes = new Map();
    this.selectors = new Map();
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  dispatch(type, detail = {}) {
    const event = { type, target: this, currentTarget: this, ...detail };
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimer(callback, delay, repeating) {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay, repeating, due: this.now + delay });
    return id;
  }

  clearTimer(id) {
    this.timers.delete(id);
  }

  advance(milliseconds) {
    const end = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.repeating) timer.due += timer.delay;
      else this.timers.delete(id);
      timer.callback();
    }
    this.now = end;
  }
}

let pageSequence = 0;
function createPage({ hidden = false, online = true, storage = new Map(), storageThrows = false, observeLongTasks = false } = {}) {
  const clock = new FakeClock();
  const document = new FakeEventTarget();
  document.hidden = hidden;
  document.visibilityState = hidden ? 'hidden' : 'visible';
  document.title = '金铲铲自动对战';
  const window = new FakeEventTarget();
  const appSelect = new FakeEventTarget();
  appSelect.value = 'jcc';
  const windowGrid = new FakeEventTarget();
  const gameWindow = new FakeEventTarget();
  const state = new FakeEventTarget();
  const frame = new FakeEventTarget();
  frame.contentWindow = new FakeEventTarget();
  const frameMessages = [];
  frame.contentWindow.postMessage = (data, origin) => frameMessages.push({ data, origin });
  const windowTitle = new FakeEventTarget();
  const heading = new FakeEventTarget();
  const reconnectButton = new FakeEventTarget();
  const diagnosticStatus = new FakeEventTarget();
  const diagnosticToggle = new FakeEventTarget();
  const diagnosticExport = new FakeEventTarget();
  const exportedPayloads = [];
  document.createElement = () => ({ click() {} });
  const loads = [];
  Object.defineProperty(frame, 'src', {
    get: () => loads.at(-1)?.url,
    set: (url) => loads.push({ at: clock.now, url }),
  });
  gameWindow.selectors.set('iframe', frame);
  gameWindow.selectors.set('.window-state', state);
  gameWindow.selectors.set('[data-role="window-title"]', windowTitle);
  document.selectors.set('#app-select', appSelect);
  document.selectors.set('.window-grid', windowGrid);
  document.selectors.set('h1', heading);
  document.selectors.set('[data-action="reconnect"]', reconnectButton);
  document.selectors.set('[data-role="diagnostic-status"]', diagnosticStatus);
  document.selectors.set('[data-action="toggle-diagnostics"]', diagnosticToggle);
  document.selectors.set('[data-action="export-diagnostics"]', diagnosticExport);
  document.querySelectorAll = (selector) => selector === '.game-window' ? [gameWindow] : [];
  let randomSequence = ++pageSequence * 10;
  const fakeMath = Object.create(Math);
  fakeMath.random = () => (++randomSequence % 997) / 997;
  const networkRequests = [];
  const navigator = { onLine: online, userAgent: 'Test Browser', platform: 'Test Platform' };
  let longTaskObserver;
  class FakeURL extends URL {
    static createObjectURL() { return 'blob:diagnostics'; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    window, document, navigator, URL: FakeURL, console: { debug() {} },
    Math: fakeMath,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    },
    Blob: class { constructor(parts) { exportedPayloads.push(JSON.parse(parts.join(''))); } },
    localStorage: {
      getItem: (key) => { if (storageThrows) throw new Error('storage unavailable'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageThrows) throw new Error('storage unavailable'); storage.set(key, value); },
    },
    ...(observeLongTasks ? { PerformanceObserver: class {
      constructor(callback) { longTaskObserver = callback; }
      observe() {}
    } } : {}),
    setInterval: (callback, delay) => clock.setTimer(callback, delay, true),
    clearInterval: (id) => clock.clearTimer(id),
    setTimeout: (callback, delay) => clock.setTimer(callback, delay, false),
    clearTimeout: (id) => clock.clearTimer(id),
    fetch: (...args) => { networkRequests.push(args); return Promise.resolve({ ok: true }); },
  });
  vm.runInContext(pageScript, context, { filename: 'index.html' });
  return { clock, document, window, navigator, appSelect, windowGrid, state, frame,
    windowTitle, heading, reconnectButton, loads, networkRequests, frameMessages,
    storage, diagnosticStatus, diagnosticToggle, diagnosticExport, exportedPayloads,
    emitLongTask: (entry) => longTaskObserver?.({ getEntries: () => [entry] }) };
}

function reconnectToken(load) {
  return new URL(load.url).searchParams.get('_reconnect');
}

function streamControl(page) {
  return page.frameMessages.filter(({ data }) => data.type === 'cgca-stream-control-v1').at(-1)?.data;
}

function streamHealth(page, overrides = {}, eventOverrides = {}) {
  page.window.dispatch('message', {
    origin: 'https://start.qq.com', source: page.frame.contentWindow,
    data: {
      type: 'cgca-stream-health-v1', generation: streamControl(page)?.generation,
      appKey: page.appSelect.value, session: 'stream-session', status: 'healthy', reason: null,
      evidence: {}, requestRecovery: false, ...overrides,
    }, ...eventOverrides,
  });
}

function frozenStream(page, overrides = {}) {
  streamHealth(page, {
    status: 'recovering', reason: 'video-frame-stalled',
    evidence: { staleForMs: 40000, softRecoveryWaitMs: 10000 }, requestRecovery: true, ...overrides,
  });
}

function loadAndBindStream(page) {
  page.frame.dispatch('load');
  streamHealth(page);
}

test('initial load selects the correct game without scheduling automatic reconnects', () => {
  const page = createPage();
  assert.equal(page.loads.length, 1);
  assert.equal(new URL(page.frame.src).origin, 'https://start.qq.com');
  assert.match(new URL(page.frame.src).hash, /^#\/game\/700967\?/);
  assert.ok(reconnectToken(page.loads[0]));
  assert.equal(page.state.textContent, '加载中...');
  assert.equal(page.clock.timers.size, 0);

  page.frame.dispatch('load');
  assert.equal(page.state.textContent, '已加载');
  page.clock.advance(60000);
  assert.equal(page.loads.length, 1);
  assert.equal(page.clock.timers.size, 0);
});

test('hidden and offline pages do not refresh automatically', () => {
  const page = createPage({ hidden: true, online: false });
  page.clock.advance(60000);
  assert.deepEqual(page.loads.map(({ at }) => at), [0]);
  assert.equal(page.clock.timers.size, 0);
  assert.equal(page.networkRequests.length, 0);
});

test('errors, network events, and diagnostic messages never add extra reloads', () => {
  const page = createPage();
  page.clock.advance(10000);
  page.frame.dispatch('error');
  page.window.dispatch('error', { message: 'iframe failed' });
  page.window.dispatch('unhandledrejection', { reason: new Error('network failed') });
  page.navigator.onLine = false;
  page.window.dispatch('offline');
  page.navigator.onLine = true;
  page.window.dispatch('online');
  page.document.hidden = true;
  page.document.visibilityState = 'hidden';
  page.document.dispatch('visibilitychange');
  for (const event of ['peer-connection-state', 'heartbeat', 'account-expired']) {
    page.window.dispatch('message', {
      origin: 'https://start.qq.com', source: page.frame.contentWindow,
      data: { type: 'cgca-diagnostic-v1', event, connectionState: 'failed', diagnostics: {} },
    });
  }
  page.clock.advance(60000);
  assert.equal(page.loads.length, 1);
  assert.equal(page.networkRequests.length, 0);
  assert.equal(page.clock.timers.size, 0);
});

test('manual reconnect reloads immediately without scheduling a countdown', () => {
  const page = createPage();
  page.clock.advance(60000);
  page.reconnectButton.dispatch('click');
  page.reconnectButton.dispatch('click');
  assert.deepEqual(page.loads.map(({ at }) => at), [0, 60000, 60000]);
  assert.equal(new Set(page.loads.map(reconnectToken)).size, 3);
  assert.equal(page.clock.timers.size, 0);
});

test('switching games updates the game hash and titles without scheduling a countdown', () => {
  const page = createPage();
  page.clock.advance(60000);
  page.appSelect.value = 'naruto';
  page.appSelect.dispatch('change');
  assert.equal(page.loads.length, 2);
  assert.match(new URL(page.frame.src).hash, /^#\/game\/700724\?/);
  assert.equal(page.document.title, '火影忍者');
  assert.equal(page.heading.textContent, '火影忍者');
  assert.equal(page.windowTitle.textContent, '火影忍者');
  assert.equal(page.frame.title, '火影忍者');
  assert.equal(page.windowGrid.getAttribute('aria-label'), '火影忍者');
  assert.equal(page.clock.timers.size, 0);

  page.appSelect.value = 'jcc';
  page.appSelect.dispatch('change');
  assert.equal(page.loads.length, 3);
  assert.match(new URL(page.frame.src).hash, /^#\/game\/700967\?/);
  assert.equal(page.document.title, '金铲铲自动对战');
  assert.equal(page.heading.textContent, '金铲铲自动对战');
  assert.equal(page.windowTitle.textContent, '金铲铲自动对战');
  assert.equal(page.frame.title, '金铲铲自动对战');
  assert.equal(page.windowGrid.getAttribute('aria-label'), '金铲铲自动对战');
  assert.equal(page.clock.timers.size, 0);
});

test('stream control handshake survives userscript readiness after iframe load', () => {
  const page = createPage();
  page.window.dispatch('message', {
    origin: 'https://start.qq.com', source: page.frame.contentWindow,
    data: { type: 'cgca-stream-ready-v1', appKey: 'jcc' },
  });
  assert.equal(streamControl(page), undefined, 'do not handshake before the navigation loads');
  page.frame.dispatch('load');
  const control = streamControl(page);
  assert.equal(control.appKey, 'jcc');
  assert.equal(typeof control.generation, 'string');
  assert.equal(control.generation, new URL(page.frame.src).searchParams.get('_cgca_generation'),
    'bind the control to the document navigation URL');
  const sent = page.frameMessages.length;
  for (const data of [
    { type: 'cgca-stream-ready-v1', appKey: 'naruto' },
    { type: 'cgca-stream-ready-v1', appKey: 'jcc', generation: 'stale-navigation' },
  ]) page.window.dispatch('message', { origin: 'https://start.qq.com', source: page.frame.contentWindow, data });
  assert.equal(page.frameMessages.length, sent, 'ready messages from prior games and navigations cannot handshake');
  page.window.dispatch('message', {
    origin: 'https://start.qq.com', source: page.frame.contentWindow,
    data: { type: 'cgca-stream-ready-v1', appKey: 'jcc' },
  });
  assert.equal(page.frameMessages.length, sent + 1);
  assert.equal(streamControl(page).generation, control.generation, 'ready retries reuse the load generation');
  assert.equal(page.frameMessages.at(-1).origin, 'https://start.qq.com');
});

test('a confirmed freeze reconnects even when diagnostic recording is disabled', () => {
  const page = createPage();
  const originalFrameWindow = page.frame.contentWindow;
  loadAndBindStream(page);
  assert.equal(page.state.textContent, '画面正常');
  streamHealth(page, { status: 'suspect', reason: 'video-frame-stalled' });
  assert.equal(page.loads.length, 1);
  frozenStream(page);
  assert.equal(page.loads.length, 2);
  assert.equal(page.state.textContent, '正在重新连接...');
  assert.equal(page.frame.contentWindow, originalFrameWindow, 'reuse the iframe WindowProxy');
  assert.equal(page.clock.timers.size, 0);
});

test('forged and stale stream health cannot request a reconnect', () => {
  const page = createPage();
  loadAndBindStream(page);
  const generation = streamControl(page).generation;
  const request = {
    type: 'cgca-stream-health-v1', generation, appKey: 'jcc', session: 'stream-session',
    status: 'recovering', reason: 'video-frame-stalled',
    evidence: { staleForMs: 40000, softRecoveryWaitMs: 10000 }, requestRecovery: true,
  };
  for (const event of [
    { origin: 'https://example.com', source: page.frame.contentWindow, data: request },
    { origin: 'https://start.qq.com', source: {}, data: request },
    { origin: 'https://start.qq.com', source: page.frame.contentWindow, data: { ...request, appKey: 'naruto' } },
    { origin: 'https://start.qq.com', source: page.frame.contentWindow, data: { ...request, generation: 'old' } },
    { origin: 'https://start.qq.com', source: page.frame.contentWindow, data: { ...request, session: 'other-session' } },
  ]) page.window.dispatch('message', event);
  assert.equal(page.loads.length, 1);
  frozenStream(page);
  assert.equal(page.loads.length, 2);
  frozenStream(page, { generation });
  assert.equal(page.loads.length, 2, 'invalidate health immediately when navigation starts');
  page.frame.dispatch('load');
  assert.notEqual(streamControl(page).generation, generation);
  frozenStream(page, { generation });
  assert.equal(page.loads.length, 2, 'old generation remains invalid after loading');
});

test('the first message must establish a session before a recovery request', () => {
  const page = createPage();
  page.frame.dispatch('load');
  frozenStream(page);
  assert.equal(page.loads.length, 1);
  streamHealth(page);
  frozenStream(page);
  assert.equal(page.loads.length, 2);
});

test('recovery requires both prolonged stall evidence and a soft recovery wait', () => {
  const page = createPage();
  loadAndBindStream(page);
  for (const overrides of [
    { status: 'suspect' },
    { reason: null },
    { evidence: null },
    { evidence: { staleForMs: 29999, softRecoveryWaitMs: 10000 } },
    { evidence: { staleForMs: 40000, softRecoveryWaitMs: 9999 } },
    { evidence: { staleForMs: Infinity, softRecoveryWaitMs: 10000 } },
    { evidence: { staleForMs: 40000, softRecoveryWaitMs: '10000' } },
  ]) frozenStream(page, overrides);
  assert.equal(page.loads.length, 1);
  frozenStream(page, { evidence: { staleForMs: 30000, softRecoveryWaitMs: 10000 } });
  assert.equal(page.loads.length, 2);
});

test('background and offline freezes defer recovery without spending retry budget', () => {
  const page = createPage({ hidden: true, online: false });
  loadAndBindStream(page);
  frozenStream(page);
  assert.equal(page.state.textContent, '后台已暂停画面恢复');
  page.document.hidden = false;
  frozenStream(page);
  assert.equal(page.state.textContent, '网络离线，等待恢复');
  assert.equal(page.loads.length, 1);
  page.navigator.onLine = true;
  frozenStream(page);
  assert.equal(page.loads.length, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    page.clock.advance(60000);
    loadAndBindStream(page);
    frozenStream(page);
  }
  assert.equal(page.loads.length, 4, 'all three recovery attempts remain available after defer');
  assert.equal(page.clock.timers.size, 0);
});

test('automatic reconnects respect cooldown and rolling attempt limits', () => {
  const page = createPage();
  loadAndBindStream(page);
  frozenStream(page);
  loadAndBindStream(page);
  page.clock.advance(59999);
  frozenStream(page);
  assert.equal(page.loads.length, 2);
  assert.equal(page.state.textContent, '画面仍停滞，等待重连冷却');
  page.clock.advance(1);
  frozenStream(page);
  assert.equal(page.loads.length, 3);
  loadAndBindStream(page);
  page.clock.advance(60000);
  frozenStream(page);
  assert.equal(page.loads.length, 4);
  loadAndBindStream(page);
  page.clock.advance(60000);
  frozenStream(page);
  assert.equal(page.loads.length, 4);
  assert.equal(page.state.textContent, '画面仍停滞，请手动重新连接');
  page.clock.advance(420000);
  frozenStream(page);
  assert.equal(page.loads.length, 5, 'retry allowed after the oldest attempt leaves the 10 minute window');
  assert.equal(page.clock.timers.size, 0);
});

test('manual reconnect and switching games reset recovery budget and session association', () => {
  const page = createPage();
  for (let attempt = 0; attempt < 3; attempt++) {
    loadAndBindStream(page);
    frozenStream(page);
    page.clock.advance(60000);
  }
  loadAndBindStream(page);
  frozenStream(page);
  assert.equal(page.loads.length, 4);
  page.reconnectButton.dispatch('click');
  assert.equal(page.loads.length, 5);
  loadAndBindStream(page);
  frozenStream(page);
  assert.equal(page.loads.length, 6, 'manual reconnect resets the cooldown and retry limit');
  const oldGeneration = streamControl(page).generation;
  page.appSelect.value = 'naruto';
  page.appSelect.dispatch('change');
  loadAndBindStream(page);
  frozenStream(page, { appKey: 'jcc', generation: oldGeneration });
  assert.equal(page.loads.length, 7, 'prior game messages are invalid');
  frozenStream(page);
  assert.equal(page.loads.length, 8, 'switching games resets the cooldown');
  assert.match(new URL(page.frame.src).hash, /^#\/game\/700724\?/);
});

function importantRecords(page) {
  return page.window.__CGCA_DIAGNOSTICS.readImportant();
}

function sendIncident(page, recordOverrides = {}, eventOverrides = {}) {
  const record = {
    id: 'stream-session-incident-1', ts: '1970-01-01T00:00:00.000Z', mono: 10,
    source: 'userscript', scriptVersion: '1.7.1', session: 'stream-session', appKey: page.appSelect.value,
    event: 'stream-freeze-detected', data: { generation: new URL(page.frame.src).searchParams.get('_cgca_generation'), staleForMs: 30000 },
    ...recordOverrides,
  };
  page.window.dispatch('message', { origin: 'https://start.qq.com', source: page.frame.contentWindow,
    data: { type: 'cgca-incident-v1', record }, ...eventOverrides });
  return record;
}

test('protected recovery logs include source evidence and iframe identities with ordinary recording off', () => {
  const page = createPage();
  loadAndBindStream(page);
  const previousGeneration = streamControl(page).generation;
  page.clock.advance(40000);
  frozenStream(page, { incidentId: 'freeze-request-1' });
  const decision = importantRecords(page).find((record) => record.event === 'host-recovery-decision');
  assert.equal(decision.source, 'page');
  assert.equal(decision.scriptVersion, '1.7.1');
  assert.equal(decision.data.generation, previousGeneration);
  assert.equal(decision.data.iframeSession, 'stream-session');
  assert.equal(decision.data.decision, 'reconnect');
  assert.equal(decision.data.sourceIncidentId, 'freeze-request-1');
  assert.equal(decision.data.evidence.staleForMs, 40000);
  assert.equal(decision.data.attempt, 1);
  assert.equal(page.window.__CGCA_DIAGNOSTICS.read().length, 0);
  page.clock.advance(5000);
  page.frame.dispatch('load');
  streamHealth(page, { session: 'stream-session-new' });
  const outcome = importantRecords(page).find((record) => record.event === 'host-recovery-outcome');
  assert.equal(outcome.data.result, 'frames-resumed');
  assert.equal(outcome.data.previousGeneration, previousGeneration);
  assert.equal(outcome.data.previousSession, 'stream-session');
  assert.equal(outcome.data.newGeneration, streamControl(page).generation);
  assert.equal(outcome.data.newSession, 'stream-session-new');
  assert.equal(outcome.data.sourceIncidentId, 'freeze-request-1');
  assert.equal(outcome.data.recoveryDurationMs, 5000);
  assert.equal(page.clock.timers.size, 0);
});

test('critical records survive routine log flood, refresh and export while ordinary recording is off', () => {
  const storage = new Map();
  const page = createPage({ storage });
  page.window.dispatch('error', { message: 'renderer failed' });
  page.diagnosticToggle.dispatch('click');
  for (let index = 0; index < 2100; index++) page.window.__CGCA_DIAGNOSTICS.log('run-step', { index });
  page.diagnosticToggle.dispatch('click');
  assert.equal(page.window.__CGCA_DIAGNOSTICS.read().length, 2000);
  assert.ok(importantRecords(page).some((record) => record.event === 'window-error'));
  const reloaded = createPage({ storage });
  reloaded.diagnosticExport.dispatch('click');
  const exported = reloaded.exportedPayloads.at(-1);
  assert.equal(exported.version, 2);
  assert.equal(exported.source, 'page');
  assert.equal(exported.scriptVersion, '1.7.1');
  assert.equal(exported.recording, false);
  assert.equal(exported.retention.importantRecords, 200);
  assert.equal(exported.retention.importantAlwaysOn, true);
  assert.ok(exported.importantRecords.some((record) => record.event === 'window-error'));
  assert.equal(exported.environment.userAgent, 'Test Browser');
  assert.equal(exported.streams[0].generation, new URL(reloaded.frame.src).searchParams.get('_cgca_generation'));
  assert.equal(reloaded.diagnosticStatus.textContent, '故障日志自动保留');
});

test('incident ingestion preserves source identity and rejects duplicate, forged and stale navigation records', () => {
  const page = createPage();
  const record = sendIncident(page);
  assert.equal(importantRecords(page).filter((entry) => entry.id === record.id).length, 1,
    'early hook incidents are kept before stream handshake');
  loadAndBindStream(page);
  sendIncident(page);
  assert.equal(importantRecords(page).filter((entry) => entry.id === record.id).length, 1);
  const kept = importantRecords(page).find((entry) => entry.id === record.id);
  assert.equal(kept.ts, record.ts);
  assert.equal(kept.mono, record.mono);
  assert.equal(kept.session, record.session);
  for (const [overrides, eventOverrides] of [
    [{ id: 'wrong-app', appKey: 'naruto' }, {}],
    [{ id: 'wrong-generation', data: { generation: 'old' } }, {}],
    [{ id: 'missing-generation', data: {} }, {}],
    [{ id: 'wrong-session', session: 'other' }, {}],
    [{ id: 'wrong-source', source: 'page' }, {}],
    [{ id: 'wrong-origin' }, { origin: 'https://example.com' }],
    [{ id: 'wrong-window' }, { source: {} }],
  ]) sendIncident(page, overrides, eventOverrides);
  assert.equal(importantRecords(page).length, 2);
  page.reconnectButton.dispatch('click');
  sendIncident(page, { id: 'previous-navigation', data: record.data });
  assert.equal(importantRecords(page).some((entry) => entry.id === 'previous-navigation'), false);
});

test('deferred recovery decision logs are bounded by reason and thirty-second cadence', () => {
  const page = createPage({ hidden: true, online: false });
  loadAndBindStream(page);
  for (let index = 0; index < 100; index++) frozenStream(page);
  assert.equal(importantRecords(page).filter((record) => record.event === 'host-recovery-decision').length, 1);
  page.clock.advance(30000);
  frozenStream(page);
  page.document.hidden = false;
  frozenStream(page);
  const decisions = importantRecords(page).filter((record) => record.event === 'host-recovery-decision');
  assert.deepEqual(Array.from(decisions, (record) => record.data.deferReason), ['hidden', 'hidden', 'offline']);
  assert.equal(page.loads.length, 1);
  assert.equal(page.clock.timers.size, 0);
});

test('critical ring is capped and remains exportable if persistent storage is unavailable', () => {
  const page = createPage({ storageThrows: true });
  for (let index = 0; index < 205; index++) page.window.dispatch('error', { message: `failure-${index}` });
  assert.equal(importantRecords(page).length, 200);
  page.diagnosticExport.dispatch('click');
  const exported = page.exportedPayloads.at(-1);
  assert.equal(exported.importantRecords.length, 200);
  assert.equal(exported.importantRecords.at(-1).data.message, 'failure-204');
  assert.equal(exported.recording, false);
});

test('same-origin tabs merge protected logs instead of overwriting another tab evidence', () => {
  const storage = new Map();
  const first = createPage({ storage });
  const second = createPage({ storage });
  first.clock.advance(1);
  first.window.dispatch('error', { message: 'first-tab-error' });
  second.clock.advance(2);
  second.window.dispatch('error', { message: 'second-tab-error' });
  const messages = importantRecords(first).filter((record) => record.event === 'window-error').map((record) => record.data.message);
  assert.deepEqual(Array.from(messages), ['first-tab-error', 'second-tab-error']);
});

test('fault logs record iframe errors and severe long tasks without reload and redact sensitive data', () => {
  const page = createPage({ observeLongTasks: true });
  page.frame.dispatch('error', { error: new Error('https://start.qq.com/frame?token=private#session') });
  page.emitLongTask({ duration: 1001, startTime: 10 });
  page.emitLongTask({ duration: 1000, startTime: 20 });
  sendIncident(page, { data: { generation: new URL(page.frame.src).searchParams.get('_cgca_generation'),
    authToken: 'secret', endpoint: 'https://start.qq.com/game?token=private#session',
    message: 'request Bearer secret123 access_token=private credential=secret' } });
  const records = importantRecords(page);
  assert.equal(records.filter((record) => record.event === 'iframe-error').length, 1);
  assert.equal(records.filter((record) => record.event === 'long-task').length, 1);
  assert.ok(records.find((record) => record.event === 'iframe-error').data.generation);
  assert.equal(records.find((record) => record.event === 'iframe-error').data.error.message, 'https://start.qq.com/frame');
  const incident = records.find((record) => record.source === 'userscript');
  assert.equal(incident.data.authToken, '[redacted]');
  assert.equal(incident.data.endpoint, 'https://start.qq.com/game');
  assert.equal(incident.data.message, 'request Bearer [redacted] access_token=[redacted] credential=[redacted]');
  assert.equal(JSON.stringify(records).includes('token=private'), false);
  assert.equal(page.loads.length, 1);
  assert.equal(page.clock.timers.size, 0);
});

test('export identifies pending reconnects when the replacement iframe has not reported healthy frames', () => {
  const page = createPage();
  loadAndBindStream(page);
  const previousGeneration = streamControl(page).generation;
  page.clock.advance(40000);
  frozenStream(page, { incidentId: 'pending-freeze-1' });
  page.clock.advance(5000);
  page.diagnosticExport.dispatch('click');
  const stream = page.exportedPayloads.at(-1).streams[0];
  assert.equal(stream.loaded, false);
  assert.equal(stream.iframeSession, null);
  assert.equal(stream.lastHealthAt, null);
  assert.equal(stream.pendingRecovery.generation, previousGeneration);
  assert.equal(stream.pendingRecovery.session, 'stream-session');
  assert.equal(stream.pendingRecovery.sourceIncidentId, 'pending-freeze-1');
  assert.equal(stream.pendingRecovery.startedAt, 40000);
  assert.notEqual(stream.generation, previousGeneration);
  assert.equal(importantRecords(page).some((record) => record.event === 'host-recovery-outcome'), false);
});

test('export sanitizes legacy diagnostics that predate URL and secret redaction', () => {
  const storage = new Map([
    ['cloud-game-click-diagnostics-v1', JSON.stringify([{ ts: '1970-01-01T00:00:00.000Z', event: 'page-start',
      data: { href: 'https://start.qq.com/game?token=private#session', password: 'secret' } }])],
    ['cloud-game-click-incidents-v1', JSON.stringify([{ id: 'legacy-error', source: 'page', ts: '1970-01-01T00:00:00.000Z',
      event: 'window-error', data: { filename: 'https://start.qq.com/client.js?token=private', authToken: 'secret' } }])],
  ]);
  const page = createPage({ storage });
  page.diagnosticExport.dispatch('click');
  const exported = page.exportedPayloads.at(-1);
  assert.equal(exported.records[0].data.href, 'https://start.qq.com/game');
  assert.equal(exported.records[0].data.password, '[redacted]');
  const legacy = exported.importantRecords.find((record) => record.id === 'legacy-error');
  assert.equal(legacy.data.filename, 'https://start.qq.com/client.js');
  assert.equal(legacy.data.authToken, '[redacted]');
  assert.equal(JSON.stringify(exported).includes('token=private'), false);
});

test('export includes a safe current stream snapshot even with ordinary recording disabled', () => {
  const page = createPage();
  loadAndBindStream(page);
  const evidence = { receivedFrames: 50, progressAges: { decodedMs: 1000 },
    statsHealth: { inboundVideo: true }, viewport: { width: 1280, height: 720 }, accessToken: 'private' };
  page.clock.advance(3000);
  streamHealth(page, { evidence });
  evidence.receivedFrames = 0;
  evidence.progressAges.decodedMs = 9999;
  page.clock.advance(2000);
  page.diagnosticExport.dispatch('click');
  const exported = page.exportedPayloads.at(-1);
  assert.equal(exported.recording, false);
  assert.equal(exported.records.length, 0);
  assert.equal(exported.streams[0].lastHealthAgeMs, 2000);
  assert.equal(exported.streams[0].currentEvidence.receivedFrames, 50);
  assert.equal(exported.streams[0].currentEvidence.progressAges.decodedMs, 1000);
  assert.equal(exported.streams[0].currentEvidence.statsHealth.inboundVideo, true);
  assert.equal(exported.streams[0].currentEvidence.accessToken, '[redacted]');
});
