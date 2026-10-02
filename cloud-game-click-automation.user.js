// ==UserScript==
// @name         云游戏点击脚本助手
// @namespace    local.cloud-game-clicker
// @version      1.5.0
// @description  记录并按顺序重放云游戏画布上的点击位置，并上报画面/连接诊断信息
// @match        https://start.qq.com/game/arm-game/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'cloud-game-click-automation-v1';
  const RUN_STATE_KEY = 'cloud-game-click-run-v1';
  const DIAGNOSTIC_MESSAGE_TYPE = 'cgca-diagnostic-v1';
  const trackedPeerConnections = new Set();
  const diagnosticState = {
    heartbeatSequence: 0,
    lastLongTask: null,
    lastError: null,
    accountExpired: false,
  };

  function reportDiagnostic(event, details = {}) {
    const message = {
      type: DIAGNOSTIC_MESSAGE_TYPE,
      event,
      timestamp: Date.now(),
      url: location.href,
      visibility: document.visibilityState,
      ...details,
    };
    if (window.parent !== window) window.parent.postMessage(message, '*');
    if (event !== 'heartbeat') console.info('[CGCA diagnostic]', message);
  }

  function installPeerConnectionMonitor(propertyName) {
    const NativePeerConnection = window[propertyName];
    if (typeof NativePeerConnection !== 'function' || NativePeerConnection.__cgcaWrapped) return;

    function MonitoredPeerConnection(...args) {
      const connection = new NativePeerConnection(...args);
      trackedPeerConnections.add(connection);
      connection.addEventListener('connectionstatechange', () => {
        reportDiagnostic('peer-connection-state', {
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
        });
        if (['closed', 'failed'].includes(connection.connectionState)) trackedPeerConnections.delete(connection);
      });
      connection.addEventListener('iceconnectionstatechange', () => {
        reportDiagnostic('ice-connection-state', {
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
        });
      });
      return connection;
    }

    try {
      MonitoredPeerConnection.prototype = NativePeerConnection.prototype;
      Object.setPrototypeOf(MonitoredPeerConnection, NativePeerConnection);
      Object.defineProperty(MonitoredPeerConnection, '__cgcaWrapped', { value: true });
      window[propertyName] = MonitoredPeerConnection;
    } catch (error) {
      console.warn(`[CGCA diagnostic] 无法监控 ${propertyName}`, error);
    }
  }

  installPeerConnectionMonitor('RTCPeerConnection');
  installPeerConnectionMonitor('webkitRTCPeerConnection');

  window.addEventListener('error', (event) => {
    diagnosticState.lastError = {
      message: event.message || 'Unknown window error',
      source: event.filename || '',
      line: event.lineno || 0,
      column: event.colno || 0,
    };
    reportDiagnostic('window-error', { error: diagnosticState.lastError });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}`
      : String(event.reason);
    diagnosticState.lastError = { message: reason };
    reportDiagnostic('unhandled-rejection', { error: diagnosticState.lastError });
  });

  function detectAccountExpired() {
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
    const matched = /(账号|账户|登录|登入).{0,24}(过期|失效|超时|重新登录|请登录)|(过期|失效).{0,24}(登录|账号|账户)/i.test(text);
    if (matched && !diagnosticState.accountExpired) {
      diagnosticState.accountExpired = true;
      reportDiagnostic('account-expired', {
        matchedText: text.slice(0, 500),
        action: '需要在内嵌页面重新登录，不能通过网络重连解决',
      });
    } else if (!matched && diagnosticState.accountExpired) {
      diagnosticState.accountExpired = false;
      reportDiagnostic('account-restored');
    }
    return diagnosticState.accountExpired;
  }

  function installAccountExpiredMonitor() {
    const check = () => detectAccountExpired();
    if (document.body) {
      check();
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    } else {
      document.addEventListener('DOMContentLoaded', check, { once: true });
    }
    setInterval(check, 3000);
  }

  installAccountExpiredMonitor();

  if (typeof PerformanceObserver === 'function') {
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries[entries.length - 1];
        if (!latest) return;
        diagnosticState.lastLongTask = {
          startTime: Math.round(latest.startTime),
          duration: Math.round(latest.duration),
          observedAt: Date.now(),
        };
        if (latest.duration >= 1000) reportDiagnostic('long-task', { longTask: diagnosticState.lastLongTask });
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch (_) { /* 浏览器不支持 longtask 监控时忽略。 */ }
  }

  async function collectMediaDiagnostics() {
    const media = [...document.querySelectorAll('video')].map((video, index) => {
      let quality = null;
      try {
        const value = video.getVideoPlaybackQuality?.();
        if (value) quality = {
          totalVideoFrames: value.totalVideoFrames,
          droppedVideoFrames: value.droppedVideoFrames,
          corruptedVideoFrames: value.corruptedVideoFrames,
        };
      } catch (_) { /* 某些浏览器不开放播放质量。 */ }
      return {
        index,
        currentTime: Number(video.currentTime.toFixed(3)),
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        ended: video.ended,
        width: video.videoWidth,
        height: video.videoHeight,
        quality,
      };
    });

    const webrtc = { connections: 0, inboundVideo: 0, bytesReceived: 0, packetsReceived: 0, framesDecoded: 0, framesDropped: 0 };
    const connections = [...trackedPeerConnections].filter((connection) => connection.connectionState !== 'closed');
    webrtc.connections = connections.length;
    await Promise.all(connections.map(async (connection) => {
      try {
        const reports = await connection.getStats();
        reports.forEach((report) => {
          if (report.type !== 'inbound-rtp' || report.kind !== 'video') return;
          webrtc.inboundVideo += 1;
          webrtc.bytesReceived += Number(report.bytesReceived || 0);
          webrtc.packetsReceived += Number(report.packetsReceived || 0);
          webrtc.framesDecoded += Number(report.framesDecoded || 0);
          webrtc.framesDropped += Number(report.framesDropped || 0);
        });
      } catch (error) {
        reportDiagnostic('stats-error', { error: { message: String(error) } });
      }
    }));

    return { media, webrtc };
  }

  async function sendHeartbeat() {
    try {
      const diagnostics = await collectMediaDiagnostics();
      reportDiagnostic('heartbeat', {
        sequence: ++diagnosticState.heartbeatSequence,
        diagnostics,
        accountExpired: detectAccountExpired(),
        lastLongTask: diagnosticState.lastLongTask,
        lastError: diagnosticState.lastError,
      });
    } catch (error) {
      reportDiagnostic('heartbeat-error', { error: { message: String(error) } });
    }
  }

  setInterval(sendHeartbeat, 5000);
  window.addEventListener('pageshow', () => reportDiagnostic('pageshow'));
  window.addEventListener('pagehide', () => reportDiagnostic('pagehide'));
  document.addEventListener('visibilitychange', () => reportDiagnostic('visibility-change'));
  setTimeout(sendHeartbeat, 1000);

  function initAutomationUI() {
    const APP_CONFIGS = {
    jcc: {
      name: '金铲铲',
      defaultInterval: 10000,
      defaultPoints: [
        { x: 0.8185719600340136, y: 0.8710210272606383, global: false },
        { x: 0.5320976828231293, y: 0.818842461768617, global: false },
        { x: 0.8715056335034014, y: 0.8637435588430851, global: false },
        { x: 0.8697119472789115, y: 0.8713690575132979, global: false },
        { x: 0.4544908588435374, y: 0.8035941475826972, global: false },
        { x: 0.6525787965616046, y: 0.37830507957329185, global: true },
        { x: 0.8916428122374139, y: 0.1155932203440343, global: false, surfaceRatio: 1.7745762711864406 },
      ],
    },
    naruto: {
      name: '火影忍者',
      defaultInterval: 50,
      defaultPoints: [
        { x: 0.8977554802210875, y: 0.24033899340084044, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.8962273277989886, y: 0.40711864407284787, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.8969914040100381, y: 0.59152545476869, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.7930754653348053, y: 0.6823728710160417, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.78085007107218, y: 0.8003389830558987, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.8633715260663597, y: 0.7596610169542037, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.860315221222162, y: 0.7569491422024824, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.6799904372411448, y: 0.826101715610189, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.8610792974332114, y: 0.7569491422024824, global: false, surfaceRatio: 1.7745762711864406 },
        { x: 0.8610792974332114, y: 0.7569491422024824, global: false, surfaceRatio: 1.7745762711864406 },
      ],
    },
  };
  function detectAppKey() {
    const route = `${window.location.pathname}${window.location.hash}`;
    if (/\/game\/700724(?:[/?#]|$)/.test(route)) return 'naruto';
    if (/\/game\/700967(?:[/?#]|$)/.test(route)) return 'jcc';
    return 'jcc';
  }

  const initialAppKey = detectAppKey();
  const state = {
    appKey: initialAppKey,
    points: loadPoints(initialAppKey),
    recording: false,
    running: false,
    stopRequested: false,
    loop: 0,
  };

  function loadRunIntent() {
    try {
      const value = JSON.parse(sessionStorage.getItem(RUN_STATE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      if (value.appKey !== state.appKey || value.running !== true) return null;
      return {
        interval: Math.max(30, Number.parseInt(value.interval, 10) || 500),
        loops: Math.max(0, Number.parseInt(value.loops, 10) || 0),
      };
    } catch (_) {
      return null;
    }
  }

  function saveRunIntent(interval, loops) {
    try {
      sessionStorage.setItem(RUN_STATE_KEY, JSON.stringify({
        appKey: state.appKey,
        running: true,
        interval,
        loops,
      }));
    } catch (_) { /* 存储不可用时不影响点击运行。 */ }
  }

  function clearRunIntent() {
    try { sessionStorage.removeItem(RUN_STATE_KEY); } catch (_) { /* 忽略存储异常。 */ }
  }

  const panel = document.createElement('div');
  panel.id = 'cgca-panel';
  panel.innerHTML = `
    <div class="cgca-head">
      <strong>云游戏点击助手 · <span data-role="app-name"></span></strong>
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
        <label>间隔(ms)<input data-role="interval" type="number" min="30" step="10" value="10000"></label>
        <label>循环(0=无限)<input data-role="loops" type="number" min="0" step="1" value="0"></label>
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
    #cgca-panel { position:fixed; z-index:2147483647; top:14px; left:14px; width:168px; color:#eaf0f8;
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
    #cgca-panel.cgca-running { border-color:#ffbd45; box-shadow:0 0 0 2px #ffbd4533, 0 8px 30px #0008; }
    #cgca-panel.cgca-running .cgca-head { background:linear-gradient(90deg,#7a4a12,#a35d0f); }
    #cgca-panel.cgca-running .cgca-status { color:#fff4d6; background:#4b2d08; border:1px solid #d38a20; font-weight:600; animation:cgca-pulse 1.4s ease-in-out infinite; }
    #cgca-panel.cgca-running .cgca-status::before { content:'●'; display:inline-block; margin-right:6px; color:#ffd166; animation:cgca-blink .8s step-end infinite; }
    #cgca-panel.cgca-running [data-action="run"] { background:#9a681c; border-color:#ffc45c; }
    @keyframes cgca-pulse { 50% { box-shadow:inset 0 0 0 1px #ffc45c66; } }
    @keyframes cgca-blink { 50% { opacity:.25; } }
    #cgca-panel .cgca-fields { display:flex; gap:7px; margin-top:8px; }
    #cgca-panel label { flex:1; color:#aabbd0; font-size:12px; }
    #cgca-panel input { display:block; width:100%; margin-top:3px; padding:5px 6px; color:#edf3fa; background:#0f1721; border:1px solid #53657a; border-radius:4px; }
    #cgca-panel ol { max-height:160px; margin:9px 0 0; padding:0 0 0 24px; overflow:auto; }
    #cgca-panel li { padding:3px 0; color:#dbe6f2; }
    #cgca-panel li button { float:right; padding:1px 6px; font-size:11px; }
    #cgca-panel .cgca-help { margin-top:8px; color:#8194aa; font-size:11px; }
    #cgca-panel.cgca-collapsed { width:168px; }
    #cgca-panel.cgca-collapsed .cgca-body { display:none; }
    #cgca-panel.cgca-collapsed [data-role="app-name"] { display:none; }
    #cgca-markers { position:fixed; inset:0; z-index:2147483646; pointer-events:none; overflow:hidden; }
    #cgca-markers .cgca-marker { position:fixed; width:26px; height:26px; transform:translate(-50%,-50%); border:2px solid #43d9ff;
      border-radius:50%; background:#087a9caa; box-shadow:0 0 0 2px #06253299, 0 0 12px #43d9ff; color:#fff; font:bold 12px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      text-align:center; text-shadow:0 1px 2px #000; transition:width .12s,height .12s,background .12s,border-color .12s,box-shadow .12s; }
    #cgca-markers .cgca-marker::before, #cgca-markers .cgca-marker::after { content:""; position:absolute; background:#43d9ff; opacity:.85; }
    #cgca-markers .cgca-marker::before { width:38px; height:1px; left:-8px; top:11px; }
    #cgca-markers .cgca-marker::after { width:1px; height:38px; left:11px; top:-8px; }
    #cgca-markers .cgca-marker.cgca-active { width:36px; height:36px; line-height:32px; background:#d66c08dd; border-color:#ffd166; box-shadow:0 0 0 3px #ff9f1c88, 0 0 24px #ff9f1c; animation:cgca-marker-pulse .65s ease-in-out infinite alternate; }
    #cgca-markers .cgca-marker.cgca-active::before, #cgca-markers .cgca-marker.cgca-active::after { background:#ffd166; }
    #cgca-markers .cgca-marker .cgca-marker-label { position:absolute; left:50%; top:29px; transform:translateX(-50%); white-space:nowrap; padding:2px 5px; border-radius:3px; background:#062532dd; color:#dff8ff; font:11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    @keyframes cgca-marker-pulse { to { transform:translate(-50%,-50%) scale(1.12); } }
  `;
  const markerLayer = document.createElement('div');
  markerLayer.id = 'cgca-markers';
  document.documentElement.append(style, markerLayer, panel);
  panel.classList.add('cgca-collapsed');

  const statusEl = panel.querySelector('[data-role="status"]');
  const appNameEl = panel.querySelector('[data-role="app-name"]');
  const listEl = panel.querySelector('[data-role="list"]');
  const intervalEl = panel.querySelector('[data-role="interval"]');
  intervalEl.value = String(APP_CONFIGS[state.appKey].defaultInterval);
  const loopsEl = panel.querySelector('[data-role="loops"]');
  const recordButton = panel.querySelector('[data-action="record"]');
  const runButton = panel.querySelector('[data-action="run"]');
  const stopButton = panel.querySelector('[data-action="stop"]');
  let markerNodes = [];

  function updateAppLabel() {
    appNameEl.textContent = APP_CONFIGS[state.appKey].name;
  }

  function loadPoints(appKey = 'jcc') {
    // 每次脚本加载都从应用默认配置开始，不使用上一次保存的坐标覆盖默认值。
    return APP_CONFIGS[appKey].defaultPoints.map((point) => ({ ...point }));
  }

  function savePoints() {
    let saved = {};
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (value && !Array.isArray(value) && typeof value === 'object') saved = value;
    } catch (_) { /* 使用空配置覆盖无效存储。 */ }
    saved[state.appKey] = state.points;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }

  function setStatus(text) { statusEl.textContent = text; }

  function syncAppFromUrl() {
    const appKey = detectAppKey();
    if (!APP_CONFIGS[appKey] || appKey === state.appKey) return;
    if (state.running) stop();
    clearRunIntent();
    savePoints();
    state.appKey = appKey;
    state.points = loadPoints(appKey);
    intervalEl.value = String(APP_CONFIGS[appKey].defaultInterval);
    state.recording = false;
    renderList();
    setStatus(`已根据网页切换到${APP_CONFIGS[appKey].name}。`);
  }


  function markerPosition(point) {
    if (point.global) return { x: point.x * innerWidth, y: point.y * innerHeight };
    const surface = getSurface(point);
    if (!surface) return { x: point.x * innerWidth, y: point.y * innerHeight };
    const rect = surface.getBoundingClientRect();
    return {
      x: rect.left + point.x * rect.width,
      y: rect.top + point.y * rect.height,
    };
  }

  function positionMarkers() {
    markerNodes.forEach(({ node, point }) => {
      const { x, y } = markerPosition(point);
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    });
  }

  function renderMarkers() {
    markerLayer.replaceChildren();
    markerNodes = state.points.map((point, index) => {
      const marker = document.createElement('div');
      marker.className = 'cgca-marker';
      marker.dataset.index = String(index);
      marker.textContent = String(index + 1);
      const label = document.createElement('span');
      label.className = 'cgca-marker-label';
      label.textContent = point.global ? '窗口' : '画布';
      marker.append(label);
      markerLayer.append(marker);
      return { node: marker, point };
    });
    positionMarkers();
  }

  function setActiveMarker(index) {
    markerNodes.forEach(({ node }, markerIndex) => {
      node.classList.toggle('cgca-active', markerIndex === index);
    });
  }

  function updateRunningUI() {
    panel.classList.toggle('cgca-running', state.running);
    recordButton.disabled = state.running;
    runButton.disabled = state.running;
    stopButton.disabled = !state.running;
    intervalEl.disabled = state.running;
    loopsEl.disabled = state.running;
    runButton.textContent = state.running ? '运行中…' : '运行';
    if (state.running && state.recording) {
      state.recording = false;
      recordButton.textContent = '记录';
    }
  }

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
    renderMarkers();
  }

  function getSurface(referencePoint = null) {
    const candidates = [...document.querySelectorAll('canvas, video')]
      .map((node) => ({ node, rect: node.getBoundingClientRect(), style: getComputedStyle(node) }))
      .filter(({ rect, style }) => rect.width > 100 && rect.height > 100
        && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0);
    if (!candidates.length) return null;
    const referenceRatio = Number(referencePoint?.surfaceRatio);
    return candidates.sort((a, b) => {
      const areaScore = (item) => item.rect.width * item.rect.height;
      const matchScore = (item) => {
        if (!Number.isFinite(referenceRatio)) return 0;
        return Math.abs(item.rect.width / item.rect.height - referenceRatio);
      };
      return (matchScore(a) - matchScore(b)) || (areaScore(b) - areaScore(a));
    })[0].node;
  }

  function pointFromEvent(event) {
    const eventSurface = event.target?.closest?.('canvas, video');
    const surface = eventSurface || getSurface();
    if (surface) {
      const rect = surface.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, global: false, surfaceRatio: rect.width / rect.height };
      }
    }
    return { x: event.clientX / innerWidth, y: event.clientY / innerHeight, global: true };
  }

  function eventPosition(point) {
    if (point.global) return { x: point.x * innerWidth, y: point.y * innerHeight };
    const surface = getSurface(point);
    if (!surface) return { x: point.x * innerWidth, y: point.y * innerHeight };
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + point.x * rect.width)),
      y: Math.min(rect.bottom - 1, Math.max(rect.top + 1, rect.top + point.y * rect.height)),
    };
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

  function waitWhileRunning(ms) {
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (state.stopRequested || performance.now() - started >= ms) resolve();
        else setTimeout(tick, Math.min(50, ms));
      };
      tick();
    });
  }

  async function waitForSurface(timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (getSurface()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return Boolean(getSurface());
  }

  async function run() {
    if (state.running || !state.points.length) {
      if (!state.points.length) setStatus('还没有坐标，请先点击“记录”。');
      return;
    }
    state.running = true;
    state.stopRequested = false;
    state.loop = Math.max(0, Number.parseInt(loopsEl.value, 10) || 0);
    const interval = Math.max(30, Number.parseInt(intervalEl.value, 10) || 500);
    saveRunIntent(interval, state.loop);
    const points = state.points.map((point) => ({ ...point }));
    let completed = 0;
    updateRunningUI();
    setStatus(state.loop === 0 ? '运行中 · 无限循环 · 准备开始' : `运行中 · 第 1/${state.loop} 轮`);
    try {
      while (!state.stopRequested && (state.loop === 0 || completed < state.loop)) {
        for (let index = 0; index < points.length; index += 1) {
          if (state.stopRequested) break;
          setActiveMarker(index);
          emitClick(points[index]);
          setStatus(state.loop === 0
            ? `运行中 · 第 ${completed + 1} 轮 · 坐标 ${index + 1}/${points.length}`
            : `运行中 · 第 ${completed + 1}/${state.loop} 轮 · 坐标 ${index + 1}/${points.length}`);
          if (index < points.length - 1) await waitWhileRunning(interval);
        }
        completed += 1;
      }
    } finally {
      const wasStopped = state.stopRequested;
      state.running = false;
      state.stopRequested = false;
      clearRunIntent();
      setActiveMarker(-1);
      updateRunningUI();
      setStatus(wasStopped ? `已停止 · 已完成 ${completed} 轮` : `运行完成 · 共 ${completed} 轮`);
    }
  }

  function stop() {
    if (!state.running) {
      clearRunIntent();
      return;
    }
    state.stopRequested = true;
    clearRunIntent();
    setStatus('正在停止…');
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
      recordButton.textContent = state.recording ? '结束记录' : '记录';
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

  let markerFrame = 0;
  const refreshMarkers = () => {
    if (markerFrame) return;
    markerFrame = requestAnimationFrame(() => {
      markerFrame = 0;
      positionMarkers();
    });
  };
  window.addEventListener('resize', refreshMarkers, { passive: true });
  window.addEventListener('scroll', refreshMarkers, { passive: true, capture: true });
  setInterval(positionMarkers, 500);

    updateRunningUI();
    renderList();
    updateAppLabel();
    window.addEventListener('hashchange', syncAppFromUrl);
    window.addEventListener('popstate', syncAppFromUrl);
    setInterval(syncAppFromUrl, 2000);

    const runIntent = loadRunIntent();
    if (runIntent) {
      intervalEl.value = String(runIntent.interval);
      loopsEl.value = String(runIntent.loops);
      setStatus('连接恢复后准备继续运行…');
      setTimeout(async () => {
        if (!loadRunIntent() || state.running) return;
        if (await waitForSurface() && loadRunIntent()) run();
      }, 1000);
    } else {
      clearRunIntent();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutomationUI, { once: true });
  } else {
    initAutomationUI();
  }
})();
