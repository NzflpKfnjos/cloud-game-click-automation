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

function createPage({ hidden = false, online = true } = {}) {
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
  const windowTitle = new FakeEventTarget();
  const heading = new FakeEventTarget();
  const reconnectButton = new FakeEventTarget();
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
  document.querySelectorAll = (selector) => selector === '.game-window' ? [gameWindow] : [];
  let randomSequence = 0;
  const fakeMath = Object.create(Math);
  fakeMath.random = () => (++randomSequence % 997) / 997;
  const networkRequests = [];
  const navigator = { onLine: online };
  const context = vm.createContext({
    window, document, navigator, URL, console,
    Math: fakeMath,
    Date: class extends Date { static now() { return clock.now; } },
    setInterval: (callback, delay) => clock.setTimer(callback, delay, true),
    clearInterval: (id) => clock.clearTimer(id),
    setTimeout: (callback, delay) => clock.setTimer(callback, delay, false),
    clearTimeout: (id) => clock.clearTimer(id),
    fetch: (...args) => { networkRequests.push(args); return Promise.resolve({ ok: true }); },
  });
  vm.runInContext(pageScript, context, { filename: 'index.html' });
  return { clock, document, window, navigator, appSelect, windowGrid, state, frame,
    windowTitle, heading, reconnectButton, loads, networkRequests };
}

function reconnectToken(load) {
  return new URL(load.url).searchParams.get('_reconnect');
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
