// ==UserScript==
// @name         云游戏点击脚本助手
// @namespace    local.cloud-game-clicker
// @version      1.1.0
// @description  记录并按顺序重放云游戏画布上的点击位置
// @match        https://start.qq.com/game/arm-game/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'cloud-game-click-automation-v1';
  const DEFAULT_POINTS = [
    { x: 0.8185719600340136, y: 0.8710210272606383, global: false },
    { x: 0.5320976828231293, y: 0.818842461768617, global: false },
    { x: 0.8715056335034014, y: 0.8637435588430851, global: false },
    { x: 0.8697119472789115, y: 0.8713690575132979, global: false },
    { x: 0.4544908588435374, y: 0.8035941475826972, global: false },
  ];
  const state = {
    points: loadPoints(),
    recording: false,
    running: false,
    stopRequested: false,
    loop: 0,
  };

  const panel = document.createElement('div');
  panel.id = 'cgca-panel';
  panel.innerHTML = `
    <div class="cgca-head">
      <strong>云游戏点击助手</strong>
      <button data-action="minimize" title="折叠面板">−</button>
    </div>
    <div class="cgca-body">
      <div class="cgca-status" data-role="status">就绪。先点击“记录”，再点击游戏画面。</div>
      <div class="cgca-row">
        <button class="primary" data-action="record">记录</button>
        <button class="success" data-action="run">运行</button>
        <button class="danger" data-action="stop">停止</button>
      </div>
      <div class="cgca-fields">
        <label>间隔(ms)<input data-role="interval" type="number" min="30" step="10" value="500"></label>
        <label>循环(0=无限)<input data-role="loops" type="number" min="0" step="1" value="1"></label>
      </div>
      <div class="cgca-row">
        <button data-action="clear">清空坐标</button>
        <button data-action="export">导出</button>
        <button data-action="import">导入</button>
      </div>
      <ol data-role="list"></ol>
      <div class="cgca-help">快捷键：F8 运行/停止，F9 记录，Esc 停止</div>
    </div>`;

  const style = document.createElement('style');
  style.textContent = `
    #cgca-panel { position:fixed; z-index:2147483647; top:58px; right:14px; width:292px; color:#eaf0f8;
      font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#18202b;
      border:1px solid #53657a; border-radius:8px; box-shadow:0 8px 30px #0008; user-select:none; }
    #cgca-panel * { box-sizing:border-box; }
    #cgca-panel .cgca-head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px;
      cursor:move; background:#243246; border-radius:8px 8px 0 0; }
    #cgca-panel .cgca-head button { width:24px; height:22px; padding:0; color:#fff; background:transparent; border:0; font-size:18px; cursor:pointer; }
    #cgca-panel .cgca-body { padding:9px; }
    #cgca-panel button { color:#edf3fa; background:#34465b; border:1px solid #5d7189; border-radius:4px; padding:5px 9px; cursor:pointer; }
    #cgca-panel button:hover { filter:brightness(1.2); }
    #cgca-panel button.primary { background:#2369a5; border-color:#398bd0; }
    #cgca-panel button.success { background:#28764e; border-color:#45aa76; }
    #cgca-panel button.danger { background:#873f47; border-color:#bb6872; }
    #cgca-panel button:disabled { opacity:.5; cursor:not-allowed; }
    #cgca-panel .cgca-row { display:flex; gap:6px; margin-top:8px; }
    #cgca-panel .cgca-row button { flex:1; }
    #cgca-panel .cgca-status { min-height:34px; padding:6px 7px; color:#bed0e4; background:#101721; border-radius:4px; }
    #cgca-panel .cgca-fields { display:flex; gap:7px; margin-top:8px; }
    #cgca-panel label { flex:1; color:#aabbd0; font-size:12px; }
    #cgca-panel input { display:block; width:100%; margin-top:3px; padding:5px 6px; color:#edf3fa; background:#0f1721; border:1px solid #53657a; border-radius:4px; }
    #cgca-panel ol { max-height:160px; margin:9px 0 0; padding:0 0 0 24px; overflow:auto; }
    #cgca-panel li { padding:3px 0; color:#dbe6f2; }
    #cgca-panel li button { float:right; padding:1px 6px; font-size:11px; }
    #cgca-panel .cgca-help { margin-top:8px; color:#8194aa; font-size:11px; }
    #cgca-panel.cgca-collapsed { width:168px; }
    #cgca-panel.cgca-collapsed .cgca-body { display:none; }
  `;
  document.documentElement.append(style, panel);

  const statusEl = panel.querySelector('[data-role="status"]');
  const listEl = panel.querySelector('[data-role="list"]');
  const intervalEl = panel.querySelector('[data-role="interval"]');
  const loopsEl = panel.querySelector('[data-role="loops"]');

  function loadPoints() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === null) return DEFAULT_POINTS.map((point) => ({ ...point }));
      const value = JSON.parse(saved);
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function savePoints() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.points));
  }

  function setStatus(text) { statusEl.textContent = text; }

  function renderList() {
    listEl.replaceChildren();
    state.points.forEach((point, index) => {
      const item = document.createElement('li');
      const scope = point.global ? '窗口' : '画布';
      item.append(document.createTextNode(`${index + 1}. ${scope} ${(point.x * 100).toFixed(1)}%, ${(point.y * 100).toFixed(1)}%`));
      const remove = document.createElement('button');
      remove.textContent = '删';
      remove.title = '删除这个坐标';
      remove.addEventListener('click', () => { state.points.splice(index, 1); savePoints(); renderList(); });
      item.append(remove);
      listEl.append(item);
    });
  }

  function getSurface() {
    const candidates = [...document.querySelectorAll('canvas, video')]
      .filter((node) => { const r = node.getBoundingClientRect(); return r.width > 100 && r.height > 100; });
    return candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0] || null;
  }

  function pointFromEvent(event) {
    const surface = getSurface();
    if (surface) {
      const rect = surface.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, global: false };
      }
    }
    return { x: event.clientX / innerWidth, y: event.clientY / innerHeight, global: true };
  }

  function eventPosition(point) {
    if (point.global) return { x: point.x * innerWidth, y: point.y * innerHeight };
    const surface = getSurface();
    if (!surface) return { x: point.x * innerWidth, y: point.y * innerHeight };
    const rect = surface.getBoundingClientRect();
    return { x: rect.left + point.x * rect.width, y: rect.top + point.y * rect.height };
  }

  function emitClick(point) {
    const { x, y } = eventPosition(point);
    const target = document.elementFromPoint(x, y) || getSurface() || document.body;
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventClass = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventClass(type, options));
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    if (state.running || !state.points.length) {
      if (!state.points.length) setStatus('还没有坐标，请先点击“记录”。');
      return;
    }
    state.running = true;
    state.stopRequested = false;
    state.loop = Math.max(0, Number.parseInt(loopsEl.value, 10) || 0);
    const interval = Math.max(30, Number.parseInt(intervalEl.value, 10) || 500);
    let completed = 0;
    setStatus('运行中，可按“停止”或 Esc 中止。');
    while (!state.stopRequested && (state.loop === 0 || completed < state.loop)) {
      for (const point of state.points) {
        if (state.stopRequested) break;
        emitClick(point);
        await wait(interval);
      }
      completed += 1;
      if (state.loop !== 0) setStatus(`运行中：第 ${completed}/${state.loop} 轮`);
    }
    state.running = false;
    state.stopRequested = false;
    setStatus('已停止。');
  }

  function stop() {
    state.stopRequested = true;
    if (state.running) setStatus('正在停止…');
  }

  document.addEventListener('pointerdown', (event) => {
    if (!state.recording || panel.contains(event.target)) return;
    state.points.push(pointFromEvent(event));
    savePoints();
    renderList();
    setStatus(`已记录第 ${state.points.length} 个坐标，继续点击可继续记录。`);
  }, true);

  panel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'record') {
      state.recording = !state.recording;
      event.target.textContent = state.recording ? '结束记录' : '记录';
      setStatus(state.recording ? '记录中：点击游戏画面添加坐标。' : '记录已结束。');
    } else if (action === 'run') run();
    else if (action === 'stop') stop();
    else if (action === 'clear') { stop(); state.points = []; savePoints(); renderList(); setStatus('坐标已清空。'); }
    else if (action === 'minimize') panel.classList.toggle('cgca-collapsed');
    else if (action === 'export') {
      navigator.clipboard?.writeText(JSON.stringify(state.points));
      setStatus('坐标 JSON 已复制，可保存到其他页面。');
    } else if (action === 'import') {
      const text = prompt('粘贴之前导出的坐标 JSON：');
      if (!text) return;
      try { const value = JSON.parse(text); if (!Array.isArray(value)) throw new Error(); state.points = value; savePoints(); renderList(); setStatus('坐标已导入。'); }
      catch (_) { setStatus('导入失败：JSON 格式不正确。'); }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (event.key === 'F8') { event.preventDefault(); state.running ? stop() : run(); }
    if (event.key === 'F9') { event.preventDefault(); panel.querySelector('[data-action="record"]').click(); }
    if (event.key === 'Escape') stop();
  });

  // 允许拖动标题栏，避免遮挡游戏中的固定按钮。
  let drag = null;
  panel.querySelector('.cgca-head').addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  panel.querySelector('.cgca-head').addEventListener('pointermove', (event) => {
    if (!drag) return;
    panel.style.left = `${Math.max(0, event.clientX - drag.dx)}px`;
    panel.style.top = `${Math.max(0, event.clientY - drag.dy)}px`;
    panel.style.right = 'auto';
  });
  panel.querySelector('.cgca-head').addEventListener('pointerup', () => { drag = null; });

  renderList();
})();
