'use strict';
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../cloud-game-click-automation.user.js'), 'utf8');
function boot(script = source, saved = new Map()) {
  class Element {
    constructor() { this.children = []; this.style = {}; this.dataset = {}; this.listeners = {}; this.nodes = new Map(); this.classList = { add() {}, toggle() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 }; }
  }
  const root = new Element();
  const document = new Element();
  document.readyState = 'complete'; document.visibilityState = 'visible'; document.documentElement = root;
  document.createElement = () => new Element(); document.createTextNode = (text) => text; document.querySelectorAll = () => [];
  const window = new Element(); window.location = { href: 'https://start.qq.com/game/arm-game/#/game/700967', pathname: '/game/arm-game/', hash: '#/game/700967' }; window.parent = window;
  const storage = { getItem: (key) => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
  const context = vm.createContext({ window, document, localStorage: storage, sessionStorage: storage, navigator: { onLine: true }, console: { debug() {} }, performance: { now: () => 0 }, Date, Math, innerWidth: 800, innerHeight: 450, setInterval() {}, setTimeout() {}, requestAnimationFrame() {} });
  vm.runInContext(script, context);
  const panel = root.children.find((node) => node.id === 'cgca-panel');
  function click(action) { const target = new Element(); target.dataset.action = action; target.closest = () => target; for (const callback of panel.listeners.click || []) callback({ target }); }
  return { panel, saved, click };
}
test('userscript initializes panel with logging disabled and retains original automation buttons', () => {
  const { panel, saved } = boot();
  assert.ok(panel);
  assert.match(panel.innerHTML, /data-action="run"/);
  assert.match(panel.innerHTML, /data-action="record"/);
  assert.equal(panel.querySelector('[data-role="diagnostic-status"]').textContent, '日志未记录');
  assert.equal(saved.has('cloud-game-click-diagnostics-v1'), false);
});
test('start/stop diagnostics visibly updates status, preserves records and survives refresh', () => {
  const page = boot();
  page.click('toggle-diagnostics');
  assert.equal(page.panel.querySelector('[data-role="diagnostic-status"]').textContent, '● 日志记录中');
  assert.equal(page.panel.querySelector('[data-action="toggle-diagnostics"]').textContent, '停止日志');
  assert.equal(JSON.parse(page.saved.get('cloud-game-click-diagnostics-v1'))[0].event, 'recording-started');
  const reloaded = boot(source, page.saved);
  assert.equal(reloaded.panel.querySelector('[data-role="diagnostic-status"]').textContent, '● 日志记录中');
  reloaded.click('toggle-diagnostics');
  assert.equal(reloaded.panel.querySelector('[data-role="diagnostic-status"]').textContent, '日志未记录');
  assert.equal(JSON.parse(page.saved.get('cloud-game-click-diagnostics-v1')).at(-1).event, 'recording-stopped');
});
// Optional standalone probe records the actual initializer result for saved transaction copies.
if (process.env.CGCA_PROBE_SOURCE) {
  try { const page = boot(readFileSync(process.env.CGCA_PROBE_SOURCE, 'utf8')); console.log('PROBE panel=' + Boolean(page.panel)); }
  catch (error) { console.log('PROBE ' + error.name + ': ' + error.message); }
}
