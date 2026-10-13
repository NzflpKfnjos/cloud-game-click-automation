// ==UserScript==
// @name         云游戏点击脚本助手
// @namespace    local.cloud-game-clicker
// @version      1.7.1
// @description  记录并按顺序重放云游戏画布上的点击位置，重连后恢复运行
// @match        https://start.qq.com/game/arm-game/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'cloud-game-click-automation-v1';
  const RUN_STATE_KEY = 'cloud-game-click-run-v1';
  const DIAGNOSTIC_KEY = 'cloud-game-click-diagnostics-v1';
  const DIAGNOSTIC_LIMIT = 3000;
  const SCRIPT_VERSION = '1.7.1';
  const IMPORTANT_DIAGNOSTIC_KEY = 'cloud-game-click-incidents-v1';
  const IMPORTANT_DIAGNOSTIC_LIMIT = 200;
  const diagnosticSession = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let importantSequence = 0;
  let importantMemory = [];
  const importantThrottle = new Map();
  function safeDiagnosticData(value, depth = 0) {
    if (value instanceof Error) value = { name: value.name, message: value.message, stack: value.stack };
    else if (value && typeof value === 'object' && typeof value.message === 'string' && typeof value.name === 'string') {
      value = { name: value.name, message: value.message, stack: typeof value.stack === 'string' ? value.stack : null };
    }
    if (typeof value === 'string') return value.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
      try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch (_) { return '[url]'; }
    }).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
      .replace(/((?:access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)\s*[=:]\s*)[^\s,;&]+/gi, '$1[redacted]').slice(0, 4000);
    if (value == null || typeof value === 'boolean') return value ?? null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (depth >= 7 || typeof value !== 'object') return String(value).slice(0, 200);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeDiagnosticData(item, depth + 1));
    const result = {};
    for (const key of Object.keys(value).slice(0, 50)) {
      if (/token|password|authorization|cookie|credential|secret|^sdp$/i.test(key)) continue;
      try { result[key] = safeDiagnosticData(value[key], depth + 1); } catch (_) { result[key] = '[unavailable]'; }
    }
    return result;
  }
  function diagnosticValue(value) {
    try { return safeDiagnosticData(value); } catch (_) { return '[unavailable]'; }
  }
  function readDiagnostics() {
    try {
      const value = JSON.parse(localStorage.getItem(DIAGNOSTIC_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }
  function readImportantDiagnostics() {
    let saved = [];
    try { const parsed = JSON.parse(localStorage.getItem(IMPORTANT_DIAGNOSTIC_KEY) || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch (_) {}
    const records = new Map();
    for (const record of [...saved, ...importantMemory]) if (record && typeof record.id === 'string') records.set(`${record.source}:${record.id}`, diagnosticValue(record));
    importantMemory = [...records.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-IMPORTANT_DIAGNOSTIC_LIMIT);
    return importantMemory;
  }
  function postImportantDiagnostic(record) {
    try { if (window.parent !== window) window.parent.postMessage({ type: 'cgca-incident-v1', record }, '*'); } catch (_) {}
  }
  function logImportantDiagnostic(event, data = {}, throttleKey = null) {
    const now = Date.now();
    if (throttleKey && now - (importantThrottle.get(throttleKey) ?? -Infinity) < 30000) return null;
    if (throttleKey) {
      importantThrottle.set(throttleKey, now);
      if (importantThrottle.size > 200) importantThrottle.delete(importantThrottle.keys().next().value);
    }
    const record = { id: `${diagnosticSession}:${++importantSequence}`, ts: new Date(now).toISOString(),
      mono: typeof performance !== 'undefined' ? Math.round(performance.now()) : null,
      source: 'userscript', scriptVersion: SCRIPT_VERSION, session: diagnosticSession, appKey: streamAppKey(), event,
      data: diagnosticValue({ generation: streamState.generation || navigationGeneration,
        visibility: document.visibilityState, online: navigator.onLine, ...data }) };
    const records = readImportantDiagnostics();
    importantMemory = [...records, record].slice(-IMPORTANT_DIAGNOSTIC_LIMIT);
    try { localStorage.setItem(IMPORTANT_DIAGNOSTIC_KEY, JSON.stringify(importantMemory)); } catch (_) { /* 内存副本仍可导出。 */ }
    postImportantDiagnostic(record);
    return record;
  }
  let diagnosticAppKey = null;
  const DIAGNOSTIC_ENABLED_KEY = 'cloud-game-click-diagnostics-enabled-v1';
  let diagnosticsEnabled = false;
  try { diagnosticsEnabled = localStorage.getItem(DIAGNOSTIC_ENABLED_KEY) === 'true'; } catch (_) {}
  let diagnosticControls = null;
  function setDiagnosticsEnabled(enabled) {
    if (diagnosticsEnabled && !enabled) logDiagnostic('recording-stopped');
    diagnosticsEnabled = enabled;
    try { localStorage.setItem(DIAGNOSTIC_ENABLED_KEY, String(enabled)); } catch (_) {}
    if (enabled) logDiagnostic('recording-started');
    updateDiagnosticControls();
  }
  function updateDiagnosticControls() {
    if (!diagnosticControls) return;
    diagnosticControls.button.textContent = diagnosticsEnabled ? '停止日志' : '开始日志';
    diagnosticControls.status.textContent = diagnosticsEnabled ? '● 日志记录中' : '日志未记录';
    diagnosticControls.status.style.color = diagnosticsEnabled ? '#7cf0a0' : '#aabbd0';
    try { if (window.parent !== window) window.parent.postMessage({ type: 'cgca-diagnostic-status-v1', recording: diagnosticsEnabled }, '*'); } catch (_) {}
  }
  const diagnosticCounters = Object.create(null);
  function logDiagnostic(event, data = {}) {
    if (!diagnosticsEnabled) return null;
    diagnosticCounters[event] = (diagnosticCounters[event] || 0) + 1;
    if ((event === 'click-emitted' || event === 'run-step') && diagnosticCounters[event] % 100 !== 1) return null;
    if (event === 'status' && diagnosticCounters[event] % 20 !== 1) return null;
    const entry = { ts: new Date().toISOString(), mono: typeof performance !== 'undefined' ? Math.round(performance.now()) : null,
      session: diagnosticSession, appKey: diagnosticAppKey, event, data: diagnosticValue(data) };
    try {
      const records = readDiagnostics();
      records.push(entry);
      localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(records.slice(-DIAGNOSTIC_LIMIT)));
    } catch (_) { /* 存储不可用时仍输出控制台日志。 */ }
    try { console.debug('[CGCA]', entry); } catch (_) { /* 忽略控制台异常。 */ }
    try {
      if (window.parent !== window) window.parent.postMessage({ type: 'cgca-diagnostic-v1', event, appKey: entry.appKey, diagnostics: entry.data }, '*');
    } catch (_) { /* 跨域或沙箱限制不影响本地日志。 */ }
    return entry;
  }
  function exportDiagnostics() {
    const payload = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), source: 'userscript',
      scriptVersion: SCRIPT_VERSION, session: diagnosticSession, recording: diagnosticsEnabled,
      browser: { userAgent: navigator.userAgent || null, platform: navigator.platform || null },
      retention: { records: DIAGNOSTIC_LIMIT, importantRecords: IMPORTANT_DIAGNOSTIC_LIMIT, importantAlwaysOn: true },
      monitor: { sampleMs: STREAM_SAMPLE_MS, staleMs: STREAM_STALE_MS, softWaitMs: STREAM_SOFT_WAIT_MS, capabilities: streamState.capabilities },
      currentStream: diagnosticValue({ status: streamState.status, reason: streamState.reason, evidence: streamState.evidence }),
      recentSamples: streamState.samples,
      records: readDiagnostics().map((record) => diagnosticValue(record)), importantRecords: readImportantDiagnostics() }, null, 2);
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `cloud-game-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (_) { try { navigator.clipboard?.writeText(payload); } catch (__) { /* 忽略导出失败。 */ } }
    logDiagnostic('diagnostics-exported', { count: readDiagnostics().length });
  }

  // 必须在 document-start 安装：平台启动时会缓存原生 RTC 构造器。
  const STREAM_SAMPLE_MS = 5000;
  const STREAM_STALE_MS = 30000;
  const STREAM_SOFT_WAIT_MS = 10000;
  const STREAM_RETRY_KEY = 'cloud-game-stream-recovery-v1';
  let navigationGeneration = null;
  try { navigationGeneration = new URL(window.location.href).searchParams.get('_cgca_generation'); } catch (_) {}
  const streamState = {
    generation: null, peers: new Map(), canvases: new WeakMap(), signals: new Map(), nextPeer: 0,
    surface: null, mediaSource: null, videoWatch: null, getSurface: () => null, getAutomationSnapshot: () => null,
    prepareRecovery: () => {}, softAt: null, softReason: null, suspended: false, sampling: false,
    status: 'unobserved', reason: null, evidence: {}, lastLogAt: -Infinity, lastLoggedStatus: null, lastSampleAt: null,
    incidentId: null, incidentStartedAt: null, samples: [], capabilities: { rtcHook: false, canvasHooks: [], videoFrameCallback: false },
  };
  function streamAppKey() {
    return /\/game\/700724(?:[/?#]|$)/.test(`${window.location.pathname}${window.location.hash}`) ? 'naruto' : 'jcc';
  }
  function resetStreamGrace() {
    const now = Date.now();
    streamState.signals.forEach((signal) => { signal.at = now; });
    streamState.peers.forEach((info) => { if (info.failureAt !== null) info.failureAt = now; });
    if (streamState.surface) {
      const canvas = streamState.canvases.get(streamState.surface);
      if (canvas?.lost) canvas.lostAt = now;
    }
    streamState.softAt = null;
    streamState.softReason = null;
  }
  function streamSignal(key, value, now) {
    if (!Number.isFinite(value) || value < 0) return null;
    let signal = streamState.signals.get(key);
    if (!signal || value < signal.value) {
      if (signal) logImportantDiagnostic('stream-counter-reset', { metric: key.split(':').pop(), previous: signal.value, value }, `counter-reset:${key}`);
      signal = { value, at: now, seen: false, delta: null };
      streamState.signals.set(key, signal);
    } else {
      signal.delta = value - signal.value;
      if (value > signal.value) {
        signal.value = value;
        signal.at = now;
        signal.seen = true;
      }
    }
    return signal;
  }
  function stopVideoWatch() {
    const watch = streamState.videoWatch;
    if (watch?.id != null) {
      try { watch.node.cancelVideoFrameCallback?.(watch.id); } catch (_) {}
    }
    if (watch) for (const [target, type, callback] of watch.listeners) target.removeEventListener?.(type, callback);
    streamState.videoWatch = null;
  }
  function describeSurface(node) {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const description = { tag: node.tagName?.toLowerCase() || 'canvas', width: Math.round(rect.width), height: Math.round(rect.height),
      left: Math.round(rect.left), top: Math.round(rect.top), connected: node.isConnected !== false };
    if (node.tagName?.toLowerCase() === 'video') {
      let quality = null;
      try { quality = node.getVideoPlaybackQuality?.(); } catch (_) {}
      description.video = { readyState: node.readyState, networkState: node.networkState ?? null,
        paused: node.paused, ended: node.ended, currentTime: node.currentTime, videoWidth: node.videoWidth, videoHeight: node.videoHeight,
        totalVideoFrames: quality?.totalVideoFrames ?? null, droppedVideoFrames: quality?.droppedVideoFrames ?? null,
        error: node.error ? { code: node.error.code, message: node.error.message } : null,
        tracks: node.srcObject?.getVideoTracks?.().map((track) => ({ readyState: track.readyState, enabled: track.enabled, muted: track.muted })) || [] };
    }
    return description;
  }
  function signalEvidence(signal, now) {
    return signal ? { value: signal.value, delta: signal.delta, progressAgeMs: now - signal.at, observedProgress: signal.seen } : null;
  }
  function recoveryAction(action, operation, available = true) {
    const incidentId = streamState.incidentId;
    const generation = streamState.generation || navigationGeneration;
    if (!available) { logImportantDiagnostic('stream-recovery-action', { generation, incidentId, action, outcome: 'unavailable' }); return; }
    logImportantDiagnostic('stream-recovery-action', { generation, incidentId, action, outcome: 'attempt' });
    try {
      Promise.resolve(operation()).then(() => {
        logImportantDiagnostic('stream-recovery-action', { generation, incidentId, action, outcome: 'completed' });
      }, (error) => { logImportantDiagnostic('stream-recovery-action', { generation, incidentId, action, outcome: 'failed', error }); });
    } catch (error) { logImportantDiagnostic('stream-recovery-action', { generation, incidentId, action, outcome: 'failed', error }); }
  }
  function watchVideo(node) {
    stopVideoWatch();
    if (!node) return;
    const watch = { node, frames: 0, id: null, listeners: [], frameCallbackSupported: typeof node.requestVideoFrameCallback === 'function' };
    streamState.videoWatch = watch;
    for (const type of ['waiting', 'stalled', 'error', 'pause', 'playing', 'ended', 'emptied', 'resize']) {
      const callback = () => logImportantDiagnostic('video-event', { type, surface: describeSurface(node), incidentId: streamState.incidentId }, `video-event:${type}`);
      node.addEventListener?.(type, callback);
      watch.listeners.push([node, type, callback]);
    }
    for (const track of node.srcObject?.getVideoTracks?.() || []) {
      for (const type of ['mute', 'unmute', 'ended']) {
        const callback = () => logImportantDiagnostic('video-track-event', { type, readyState: track.readyState, enabled: track.enabled, muted: track.muted }, `track-event:${type}`);
        track.addEventListener?.(type, callback);
        watch.listeners.push([track, type, callback]);
      }
    }
    if (!watch.frameCallbackSupported) return;
    streamState.capabilities.videoFrameCallback = true;
    const frame = () => {
      if (streamState.videoWatch !== watch) return;
      watch.frames += 1;
      try { watch.id = node.requestVideoFrameCallback(frame); } catch (_) { stopVideoWatch(); }
    };
    try { watch.id = node.requestVideoFrameCallback(frame); } catch (_) { stopVideoWatch(); }
  }
  function sendStreamHealth(requestRecovery = false) {
    const payload = { type: 'cgca-stream-health-v1', generation: streamState.generation,
      session: diagnosticSession, appKey: streamAppKey(), status: streamState.status,
      reason: streamState.reason, evidence: streamState.evidence, incidentId: streamState.incidentId, requestRecovery };
    try { if (window.parent !== window) window.parent.postMessage(payload, '*'); } catch (_) {}
    const now = Date.now();
    if (streamState.lastLoggedStatus !== payload.status || now - streamState.lastLogAt >= 30000 || requestRecovery) {
      logDiagnostic('stream-health', payload);
      streamState.lastLoggedStatus = payload.status;
      streamState.lastLogAt = now;
    }
  }
  function observePeer(pc) {
    const info = { id: ++streamState.nextPeer, connected: false, failureAt: null, pending: false, reports: new Set(), statsStatus: 'not-sampled' };
    streamState.peers.set(pc, info);
    const change = () => {
      const connection = pc.connectionState || pc.iceConnectionState;
      if (connection === 'closed') {
        streamState.peers.delete(pc);
        for (const key of streamState.signals.keys()) if (key.startsWith(`rtc:${info.id}:`)) streamState.signals.delete(key);
      } else if (['connected', 'completed'].includes(connection)) {
        info.connected = true;
        info.failureAt = null;
      } else if (info.connected && ['failed', 'disconnected'].includes(connection)) {
        if (info.failureAt === null) info.failureAt = Date.now();
      }
      const evidence = { peer: info.id, connectionState: pc.connectionState || null, iceConnectionState: pc.iceConnectionState || null,
        signalingState: pc.signalingState || null };
      logDiagnostic('peer-connection-state', evidence);
      if (['failed', 'disconnected', 'closed'].includes(connection)) logImportantDiagnostic('peer-connection-state', evidence, `peer-state:${info.id}:${connection}`);
    };
    pc.addEventListener?.('connectionstatechange', change);
    pc.addEventListener?.('iceconnectionstatechange', change);
    change();
  }
  const NativePeer = window.RTCPeerConnection;
  if (typeof NativePeer === 'function') {
    try {
      const ObservedPeer = new Proxy(NativePeer, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget);
          try { observePeer(pc); } catch (_) { /* 观测失败不能改变平台构造行为。 */ }
          return pc;
        },
      });
      window.RTCPeerConnection = ObservedPeer;
      streamState.capabilities.rtcHook = window.RTCPeerConnection === ObservedPeer;
      if (window.webkitRTCPeerConnection === NativePeer) window.webkitRTCPeerConnection = ObservedPeer;
    } catch (error) { logImportantDiagnostic('stream-hook-unavailable', { api: 'RTCPeerConnection', error }); }
  }
  function observeCanvas(canvas) {
    let info = streamState.canvases.get(canvas);
    if (info) return info;
    info = { draws: 0, lost: false, lostAt: null, context: null };
    streamState.canvases.set(canvas, info);
    const lost = (event) => {
      if (event.type === 'webglcontextlost') event.preventDefault();
      info.lost = true;
      info.lostAt = Date.now();
      logImportantDiagnostic('render-context-lost', { surface: describeSurface(canvas), incidentId: streamState.incidentId });
    };
    const restored = () => {
      logImportantDiagnostic('render-context-restored', { lostForMs: info.lostAt === null ? null : Date.now() - info.lostAt,
        incidentId: streamState.incidentId, surface: describeSurface(canvas) });
      info.lost = false; info.lostAt = null; resetStreamGrace();
    };
    canvas.addEventListener?.('webglcontextlost', lost);
    canvas.addEventListener?.('contextlost', lost);
    canvas.addEventListener?.('webglcontextrestored', restored);
    canvas.addEventListener?.('contextrestored', restored);
    return info;
  }
  function wrapNativeMethod(prototype, name, after) {
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value !== 'function') return;
    const original = descriptor.value;
    try {
      Object.defineProperty(prototype, name, { ...descriptor, value: function (...args) {
        const result = Reflect.apply(original, this, args);
        try { after(this, result); } catch (_) { /* 观测失败不改变原生绘制结果。 */ }
        return result;
      } });
      streamState.capabilities.canvasHooks.push(name);
    } catch (error) { logImportantDiagnostic('stream-hook-unavailable', { api: name, error }); }
  }
  wrapNativeMethod(window.HTMLCanvasElement?.prototype, 'getContext', (canvas, context) => {
    if (context) observeCanvas(canvas).context = context;
  });
  for (const [prototype, methods] of [
    [window.CanvasRenderingContext2D?.prototype, ['drawImage', 'putImageData']],
    [window.WebGLRenderingContext?.prototype, ['drawArrays', 'drawElements']],
    [window.WebGL2RenderingContext?.prototype, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']],
  ]) {
    for (const method of methods) wrapNativeMethod(prototype, method, (context) => {
      if (context.canvas) observeCanvas(context.canvas).draws += 1;
    });
  }
  async function readPeerHealth(pc, info, now) {
    if (info.pending || typeof pc.getStats !== 'function') return null;
    // 挂起的 getStats 不阻塞 video 检测，也不叠加新的请求。
    info.pending = true;
    info.statsStatus = 'pending';
    let timeoutId;
    const result = Promise.resolve().then(() => pc.getStats()).then((stats) => {
      info.pending = false;
      if (info.statsStatus === 'timeout') logImportantDiagnostic('rtc-stats-resumed', { peer: info.id, waitMs: Date.now() - now });
      info.statsStatus = 'ok';
      return stats;
    }, (error) => {
      info.pending = false;
      info.statsStatus = 'error';
      logImportantDiagnostic('rtc-stats-error', { peer: info.id, error }, `rtc-stats-error:${info.id}`);
      return null;
    });
    const report = await Promise.race([result, new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        info.statsStatus = 'timeout';
        logImportantDiagnostic('rtc-stats-timeout', { peer: info.id, waitMs: 1500, connectionState: pc.connectionState || null }, `rtc-stats-timeout:${info.id}`);
        resolve(null);
      }, 1500);
    })]);
    clearTimeout(timeoutId);
    if (!report || !streamState.peers.has(pc)) return null;
    const receivers = pc.getReceivers?.() || [];
    const videoTracks = receivers.map((receiver) => receiver.track).filter((track) => track?.kind === 'video');
    if (videoTracks.length && !videoTracks.some((track) => track.readyState === 'live' && track.enabled !== false)) return null;
    const visibleTrackIds = streamState.mediaSource?.getVideoTracks?.().map((track) => track.id).filter(Boolean) || [];
    if (visibleTrackIds.length && videoTracks.some((track) => track.id)
      && !videoTracks.some((track) => visibleTrackIds.includes(track.id))) return null;
    const rows = [];
    const ids = new Set();
    report.forEach((stat) => {
      if (stat.type !== 'inbound-rtp' || (stat.kind || stat.mediaType) !== 'video' || stat.isRemote) return;
      const trackIdentifier = stat.trackIdentifier || report.get?.(stat.trackId)?.trackIdentifier;
      if (visibleTrackIds.length && trackIdentifier && !visibleTrackIds.includes(trackIdentifier)) return;
      ids.add(stat.id);
      const prefix = `rtc:${info.id}:${stat.id}:`;
      rows.push({ pc, info, connectionState: pc.connectionState || pc.iceConnectionState || null,
        stats: { framesDropped: stat.framesDropped ?? null, packetsLost: stat.packetsLost ?? null,
          jitterSeconds: stat.jitter ?? null, freezeCount: stat.freezeCount ?? null, totalFreezesDuration: stat.totalFreezesDuration ?? null,
          totalDecodeTimeSeconds: stat.totalDecodeTime ?? null, framesPerSecond: stat.framesPerSecond ?? null,
          frameWidth: stat.frameWidth ?? null, frameHeight: stat.frameHeight ?? null },
        received: streamSignal(`${prefix}received`, stat.framesReceived, now),
        decoded: streamSignal(`${prefix}decoded`, stat.framesDecoded, now),
        bytes: streamSignal(`${prefix}bytes`, stat.bytesReceived, now) });
    });
    for (const oldId of info.reports) {
      if (!ids.has(oldId)) for (const key of streamState.signals.keys()) {
        if (key.startsWith(`rtc:${info.id}:${oldId}:`)) streamState.signals.delete(key);
      }
    }
    info.reports = ids;
    return rows;
  }
  function requestStandaloneRecovery() {
    let attempts = [];
    try { attempts = JSON.parse(sessionStorage.getItem(STREAM_RETRY_KEY) || '[]'); } catch (_) {}
    const now = Date.now();
    attempts = Array.isArray(attempts) ? attempts.filter((at) => Number.isFinite(at) && now - at < 600000) : [];
    if (attempts.length >= 3 || (attempts.length && now - attempts[attempts.length - 1] < 60000)) {
      const reason = attempts.length >= 3 ? 'retry-limit' : 'cooldown';
      logImportantDiagnostic('stream-recovery-deferred', { incidentId: streamState.incidentId, reason, attempts: attempts.length }, `standalone:${reason}`);
      return;
    }
    try {
      // 先持久化预算；存储不可用时不自动刷新，防止无限循环。
      sessionStorage.setItem(STREAM_RETRY_KEY, JSON.stringify([...attempts, now]));
      logImportantDiagnostic('stream-recovery-reload', { incidentId: streamState.incidentId, attempt: attempts.length + 1, evidence: streamState.evidence });
      window.location.reload();
    } catch (error) { logImportantDiagnostic('stream-recovery-deferred', { incidentId: streamState.incidentId, reason: 'storage-or-reload-error', error }, 'standalone-error'); }
  }
  async function sampleStreamHealth() {
    if (streamState.sampling || streamState.suspended) return;
    streamState.sampling = true;
    try {
      const now = Date.now();
      // 浏览器休眠或主线程曾被挂起时重新观察，休眠时长不当作停帧证据。
      if (streamState.lastSampleAt !== null && now - streamState.lastSampleAt > STREAM_SAMPLE_MS * 3) {
        logImportantDiagnostic('stream-sample-gap', { gapMs: now - streamState.lastSampleAt, incidentId: streamState.incidentId });
        resetStreamGrace();
      }
      streamState.lastSampleAt = now;
      if (document.visibilityState === 'hidden' || navigator.onLine === false) {
        resetStreamGrace();
        streamState.status = 'suspended';
        streamState.reason = document.visibilityState === 'hidden' ? 'hidden' : 'offline';
        streamState.evidence = {};
        sendStreamHealth();
        return;
      }
      const surface = streamState.getSurface();
      const isVideo = surface?.tagName?.toLowerCase() === 'video';
      const mediaSource = isVideo ? (surface.srcObject || surface.currentSrc || null) : null;
      if (surface !== streamState.surface || mediaSource !== streamState.mediaSource) {
        logImportantDiagnostic('stream-surface-change', { previous: describeSurface(streamState.surface), current: describeSurface(surface),
          mediaSourceChanged: mediaSource !== streamState.mediaSource, viewport: { width: innerWidth, height: innerHeight } });
        streamState.surface = surface;
        streamState.mediaSource = mediaSource;
        streamState.signals.delete('presented');
        streamState.signals.delete('canvas');
        resetStreamGrace();
        watchVideo(isVideo ? surface : null);
      }
      let peerRows = (await Promise.all([...streamState.peers].map(([pc, info]) => readPeerHealth(pc, info, now)))).flat().filter(Boolean);
      // 隐藏/离线或页面隐藏可能发生在异步 getStats 期间。
      if (streamState.suspended || document.visibilityState === 'hidden' || navigator.onLine === false) { resetStreamGrace(); return; }
      if (streamState.getSurface() !== surface || (isVideo && (surface.srcObject || surface.currentSrc || null) !== mediaSource)) {
        resetStreamGrace();
        return;
      }
      let presented = null;
      if (isVideo) {
        const watch = streamState.videoWatch;
        let frames = watch?.frameCallbackSupported ? watch.frames : null;
        if (!watch?.frameCallbackSupported) {
          try { frames = surface.getVideoPlaybackQuality?.().totalVideoFrames ?? surface.webkitDecodedFrameCount ?? surface.currentTime; } catch (_) { frames = surface.currentTime; }
        }
        presented = streamSignal('presented', frames, now);
      }
      const canvas = surface && streamState.canvases.get(surface);
      const drawn = canvas && streamSignal('canvas', canvas.draws, now);
      // 没有 track 对应关系的自定义解码器使用最近活动的连接，避免旧连接误触发恢复。
      if (new Set(peerRows.map((row) => row.pc)).size > 1) {
        const latest = peerRows.reduce((best, row) => {
          const at = Math.max(...[row.decoded, row.received, row.bytes].filter((signal) => signal?.seen).map((signal) => signal.at), -Infinity);
          return at > best.at ? { pc: row.pc, at } : best;
        }, { pc: null, at: -Infinity });
        if (latest.pc) peerRows = peerRows.filter((row) => row.pc === latest.pc);
      }
      const failures = [];
      const addFailure = (reason, at, pc = null) => { if (at !== null && now - at >= STREAM_STALE_MS) failures.push({ reason, at, pc }); };
      if (canvas?.lost) addFailure('render-context-lost', canvas.lostAt);
      const tracks = isVideo ? surface.srcObject?.getVideoTracks?.() : null;
      const videoActive = isVideo && !surface.paused && !surface.ended
        && (!tracks?.length || tracks.some((track) => track.readyState === 'live' && track.enabled !== false));
      if (isVideo && !videoActive) resetStreamGrace();
      if (videoActive && presented?.seen) addFailure('video-presentation-stalled', presented.at);
      for (const row of peerRows) {
        if (isVideo && (!videoActive || (presented?.seen && now - presented.at < STREAM_STALE_MS))) continue;
        if (row.info.failureAt !== null) addFailure('peer-connection-stalled', row.info.failureAt, row.pc);
        const frameSignal = row.decoded?.seen ? row.decoded : row.received?.seen ? row.received : null;
        if (frameSignal) addFailure(row.decoded?.seen ? 'video-decode-stalled' : 'video-receive-stalled', frameSignal.at, row.pc);
        else if (row.bytes?.seen) addFailure('video-transport-stalled', row.bytes.at, row.pc);
      }
      // 自定义解码器不一定更新原生 framesDecoded；RTC 接收继续而画布停止才认定渲染停滞。
      if (drawn?.seen && peerRows.some((row) => row.bytes?.seen && now - row.bytes.at < STREAM_STALE_MS)) addFailure('canvas-render-stalled', drawn.at);
      failures.sort((a, b) => a.at - b.at);
      const failure = failures[0];
      const seen = presented?.seen || peerRows.some((row) => row.decoded?.seen || row.received?.seen);
      streamState.evidence = { surface: surface?.tagName?.toLowerCase() || null,
        surfaceDetails: describeSurface(surface), viewport: { width: innerWidth, height: innerHeight },
        presented: signalEvidence(presented, now), drawn: signalEvidence(drawn, now),
        observation: !surface ? 'surface-missing' : isVideo && !videoActive ? 'video-inactive' : seen ? 'progress-observed' : 'awaiting-progress',
        automation: streamState.getAutomationSnapshot(),
        memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize } : null,
        statsHealth: [...streamState.peers.values()].map((info) => ({ peer: info.id, status: info.statsStatus, pending: info.pending })),
        presentedFrames: presented?.value ?? null, canvasDraws: drawn?.value ?? null,
        peers: peerRows.map((row) => ({ peer: row.info.id, connectionState: row.connectionState, iceConnectionState: row.pc.iceConnectionState || null,
          framesReceived: row.received?.value ?? null, framesDecoded: row.decoded?.value ?? null, bytesReceived: row.bytes?.value ?? null,
          received: signalEvidence(row.received, now), decoded: signalEvidence(row.decoded, now), bytes: signalEvidence(row.bytes, now), stats: row.stats })),
        stalledStages: failures.map(({ reason, at }) => ({ reason, staleForMs: now - at })),
        staleForMs: failure ? now - failure.at : 0, softRecoveryWaitMs: 0 };
      streamState.samples.push({ ts: new Date(now).toISOString(), evidence: diagnosticValue(streamState.evidence) });
      streamState.samples = streamState.samples.slice(-12);
      if (!failure) {
        if (streamState.incidentId) {
          logImportantDiagnostic('stream-recovery-resolved', { incidentId: streamState.incidentId,
            result: ((videoActive && presented?.delta > 0) || (!isVideo && peerRows.some((row) => row.decoded?.delta > 0 || row.received?.delta > 0) && (!canvas || drawn?.delta > 0)))
              ? 'frames-resumed' : 'monitor-reset',
            durationMs: now - streamState.incidentStartedAt, evidence: streamState.evidence });
          streamState.incidentId = null;
          streamState.incidentStartedAt = null;
        }
        streamState.softAt = null;
        streamState.softReason = null;
        streamState.status = seen ? 'healthy' : 'unobserved';
        streamState.reason = null;
        sendStreamHealth();
        return;
      }
      if (streamState.softAt === null || streamState.softReason !== failure.reason) {
        if (!streamState.incidentId) {
          const onset = logImportantDiagnostic('stream-stall-detected', { reason: failure.reason, evidence: streamState.evidence, recentSamples: streamState.samples });
          streamState.incidentId = onset.id;
          streamState.incidentStartedAt = now;
        }
        streamState.softAt = now;
        streamState.softReason = failure.reason;
        logImportantDiagnostic('stream-recovery-soft', { incidentId: streamState.incidentId, reason: failure.reason, evidence: streamState.evidence });
        if (isVideo) {
          recoveryAction('video.play', () => surface.play(), typeof surface.play === 'function');
        }
        if (canvas?.lost) {
          let extension;
          try { extension = canvas.context?.getExtension?.('WEBGL_lose_context'); } catch (_) {}
          recoveryAction('webgl.restoreContext', () => extension.restoreContext(), typeof extension?.restoreContext === 'function');
        }
        if (failure.pc && /peer-connection|transport|receive/.test(failure.reason)) {
          recoveryAction('rtc.restartIce', () => failure.pc.restartIce(), typeof failure.pc.restartIce === 'function');
        }
      }
      streamState.status = 'recovering';
      streamState.reason = failure.reason;
      streamState.evidence.softRecoveryWaitMs = now - streamState.softAt;
      const request = now - streamState.softAt >= STREAM_SOFT_WAIT_MS;
      if (request) {
        streamState.prepareRecovery();
        logImportantDiagnostic('stream-recovery-request', { incidentId: streamState.incidentId, reason: failure.reason, evidence: streamState.evidence }, `request:${streamState.incidentId}`);
      }
      sendStreamHealth(request);
      if (request && window.parent === window) requestStandaloneRecovery();
    } catch (error) { logImportantDiagnostic('stream-monitor-error', { error }, 'stream-monitor-error'); }
    finally { streamState.sampling = false; }
  }
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window.parent || data?.type !== 'cgca-stream-control-v1'
      || data.appKey !== streamAppKey() || typeof data.generation !== 'string' || !data.generation
      || (navigationGeneration && navigationGeneration !== data.generation)) return;
    streamState.generation = data.generation;
    // 每次握手先发送不带刷新请求的消息，随后监测周期再决定是否恢复。
    sendStreamHealth(false);
    // 启动时产生的诊断可能早于父页监听；握手后重发本次会话，父页按 ID 去重。
    readImportantDiagnostics().filter((record) => record.session === diagnosticSession).forEach(postImportantDiagnostic);
  });
  document.addEventListener('visibilitychange', () => {
    logImportantDiagnostic('visibility-change', { incidentId: streamState.incidentId }, `visibility:${document.visibilityState}`);
    resetStreamGrace();
  });
  for (const type of ['online', 'offline']) window.addEventListener(type, () => {
    logImportantDiagnostic(`network-${type}`, { incidentId: streamState.incidentId }, `network:${type}`);
    resetStreamGrace();
  });
  window.addEventListener('pagehide', () => {
    logImportantDiagnostic('page-hide', { incidentId: streamState.incidentId });
    streamState.suspended = true; stopVideoWatch(); resetStreamGrace();
  });
  window.addEventListener('pageshow', (event) => {
    streamState.suspended = false; streamState.surface = null; resetStreamGrace();
    logImportantDiagnostic('page-show', { persisted: event.persisted });
  });
  window.addEventListener('error', (event) => logImportantDiagnostic('window-error', { message: event.message, filename: event.filename,
    line: event.lineno, column: event.colno, error: event.error, incidentId: streamState.incidentId }, `window-error:${event.filename}:${event.lineno}`));
  window.addEventListener('unhandledrejection', (event) => logImportantDiagnostic('unhandled-rejection', { reason: event.reason, incidentId: streamState.incidentId }, 'unhandled-rejection'));
  setInterval(sampleStreamHealth, STREAM_SAMPLE_MS);
  logImportantDiagnostic('stream-monitor-start', { capabilities: streamState.capabilities,
    sampleMs: STREAM_SAMPLE_MS, staleMs: STREAM_STALE_MS, softWaitMs: STREAM_SOFT_WAIT_MS });

  function initAutomationUI() {
    logDiagnostic('userscript-start', { href: window.location.href, visibility: document.visibilityState, online: navigator.onLine });
    const APP_CONFIGS = {
    jcc: {
      name: '金铲铲',
      defaultInterval: 100,
      defaultPoints: [
        { x: 0.8185719600340136, y: 0.8710210272606383, global: false },
        { x: 0.5320976828231293, y: 0.818842461768617, global: false },
        { x: 0.4544908588435374, y: 0.8035941475826972, global: false },
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
        { x: 0.5615769941289822, y: 0.6056173390339028, global: false, surfaceRatio: 1.7775305895439377 },
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
  diagnosticAppKey = initialAppKey;
  const state = {
    appKey: initialAppKey,
    points: loadPoints(initialAppKey),
    recording: false,
    running: false,
    stopRequested: false,
    loop: 0,
    activePoints: [],
    completed: 0,
    interval: 100,
  };

  function loadRunIntent() {
    try {
      const value = JSON.parse(sessionStorage.getItem(RUN_STATE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      if (value.appKey !== state.appKey || value.running !== true) return null;
      return {
        interval: Math.max(30, Number.parseInt(value.interval, 10) || 500),
        loops: Math.max(0, Number.parseInt(value.loops, 10) || 0),
        points: Array.isArray(value.points) && value.points.length && value.points.every((point) =>
          Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
          ? value.points.map((point) => ({ ...point })) : null,
      };
    } catch (_) {
      return null;
    }
  }

  function saveRunIntent(interval, loops, points = state.points) {
    logDiagnostic('run-intent-save', { interval, loops });
    try {
      sessionStorage.setItem(RUN_STATE_KEY, JSON.stringify({
        appKey: state.appKey,
        running: true,
        interval,
        loops,
        points,
      }));
    } catch (_) { /* 存储不可用时不影响点击运行。 */ }
  }

  function clearRunIntent() {
    logDiagnostic('run-intent-clear');
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
        <label>间隔(ms)<input data-role="interval" type="number" min="30" step="10" value="${APP_CONFIGS[state.appKey].defaultInterval}"></label>
        <label>循环(0=无限)<input data-role="loops" type="number" min="0" step="1" value="0"></label>
      </div>
      <div class="cgca-row">
        <button data-action="clear">清空坐标</button>

        <button data-action="export">导出</button>
        <button data-action="import">导入</button>
      </div>
      <div class="cgca-row"><button data-action="toggle-diagnostics">开始日志</button><button data-action="export-diagnostics">导出日志</button></div>
      <div data-role="diagnostic-status" aria-live="polite">日志未记录</div>
      <div class="cgca-help">异常日志自动保留，可随时导出。</div>
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

  function setStatus(text) { statusEl.textContent = text; if (!text.startsWith('运行中')) logDiagnostic('status', { text }); }

  function syncAppFromUrl() {
    const appKey = detectAppKey();
    if (!APP_CONFIGS[appKey] || appKey === state.appKey) return;
    if (state.running) stop();
    clearRunIntent();
    savePoints();
    state.appKey = appKey;
    diagnosticAppKey = appKey;
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
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + point.x * rect.width)),
      y: Math.min(rect.bottom - 1, Math.max(rect.top + 1, rect.top + point.y * rect.height)),
    };
  }

  let clickBlockedReason = null;
  function recordClickAvailability(reason) {
    if (reason === clickBlockedReason) return;
    logImportantDiagnostic('click-surface', { state: reason ? 'blocked' : 'resumed', reason,
      previousReason: clickBlockedReason, surface: describeSurface(getSurface()), viewport: { width: innerWidth, height: innerHeight } });
    clickBlockedReason = reason;
  }
  function emitClick(point) {
    const position = eventPosition(point);
    if (!position) { recordClickAvailability('surface-missing'); return false; }
    const { x, y } = position;
    const target = document.elementFromPoint(x, y);
    if (!target || panel.contains(target)) { recordClickAvailability(target ? 'helper-panel' : 'target-missing'); return false; }
    recordClickAvailability(null);
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventClass = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventClass(type, { ...options, buttons: ['pointerdown', 'mousedown'].includes(type) ? 1 : 0 }));
    }
    logDiagnostic('click-emitted', { point, x: Math.round(x), y: Math.round(y), target: target.tagName || null,
      surface: point.global ? 'window' : getSurface(point)?.tagName || null,
      viewport: { width: innerWidth, height: innerHeight }, synthetic: true });
    return true;
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
    logDiagnostic('run-request', { running: state.running, points: state.points.length, interval: intervalEl.value, loops: loopsEl.value });
    if (state.running || !state.points.length) {
      if (!state.points.length) setStatus('还没有坐标，请先点击“记录”。');
      return;
    }
    state.running = true;
    state.stopRequested = false;
    state.loop = Math.max(0, Number.parseInt(loopsEl.value, 10) || 0);
    const interval = Math.max(30, Number.parseInt(intervalEl.value, 10) || 500);
    state.interval = interval;
    saveRunIntent(interval, state.loop);
    const points = state.points.map((point) => ({ ...point }));
    state.activePoints = points;
    state.completed = 0;
    let completed = 0;
    updateRunningUI();
    setStatus(state.loop === 0 ? '运行中 · 无限循环 · 准备开始' : `运行中 · 第 1/${state.loop} 轮`);
    try {
      while (!state.stopRequested && (state.loop === 0 || completed < state.loop)) {
        for (let index = 0; index < points.length; index += 1) {
          while (!state.stopRequested && !points[index].global && !getSurface(points[index])) {
            recordClickAvailability('surface-missing');
            setStatus('画布暂不可用，等待画面恢复…');
            await waitWhileRunning(250);
          }
          if (state.stopRequested) break;
          setActiveMarker(index);
          logDiagnostic('run-step', { loop: completed + 1, index, total: points.length });
          emitClick(points[index]);
          setStatus(state.loop === 0
            ? `运行中 · 第 ${completed + 1} 轮 · 坐标 ${index + 1}/${points.length}`
            : `运行中 · 第 ${completed + 1}/${state.loop} 轮 · 坐标 ${index + 1}/${points.length}`);
          // 跨轮点击也保持间隔；单点无限循环必须让出主线程以便停止和监测。
          if (!state.stopRequested && (index < points.length - 1 || state.loop === 0 || completed + 1 < state.loop)) await waitWhileRunning(interval);
        }
        completed += 1;
        state.completed = completed;
      }
    } finally {
      const wasStopped = state.stopRequested;
      state.running = false;
      state.stopRequested = false;
      clearRunIntent();
      setActiveMarker(-1);
      updateRunningUI();
      setStatus(wasStopped ? `已停止 · 已完成 ${completed} 轮` : `运行完成 · 共 ${completed} 轮`);
      logDiagnostic('run-finished', { stopped: wasStopped, completed });
    }
  }

  function stop() {
    logDiagnostic('stop-request', { running: state.running });
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
    const point = pointFromEvent(event);
    state.points.push(point);
    logDiagnostic('point-recorded', { index: state.points.length - 1, point });
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
    else if (action === 'toggle-diagnostics') setDiagnosticsEnabled(!diagnosticsEnabled);
    else if (action === 'export-diagnostics') exportDiagnostics();
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
  window.addEventListener('offline', () => logDiagnostic('network-offline'));
  window.addEventListener('online', () => logDiagnostic('network-online'));
  document.addEventListener('visibilitychange', () => logDiagnostic('visibility-change', { visibility: document.visibilityState }));
  window.addEventListener('pagehide', () => logDiagnostic('page-hide'));
  window.addEventListener('pageshow', (event) => logDiagnostic('page-show', { persisted: event.persisted }));
  if (typeof PerformanceObserver !== 'undefined') {
    try { new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
      const data = { duration: Math.round(entry.duration), startTime: Math.round(entry.startTime) };
      logDiagnostic('long-task', data);
      if (entry.duration >= 1000) logImportantDiagnostic('long-task', data, 'long-task');
    })).observe({ type: 'longtask', buffered: true }); } catch (_) { /* 忽略不支持的浏览器。 */ }
  }
  window.addEventListener('resize', refreshMarkers, { passive: true });
  window.addEventListener('scroll', refreshMarkers, { passive: true, capture: true });
  setInterval(positionMarkers, 500);
  let watchdogAt = Date.now();
  setInterval(() => {
    const now = Date.now();
    const delayMs = Math.max(0, now - watchdogAt - 10000);
    watchdogAt = now;
    logDiagnostic('watchdog', { delayMs, running: state.running, points: state.points.length,
      visibility: document.visibilityState, online: navigator.onLine,
      memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize } : null });
  }, 10000);
  diagnosticControls = { button: panel.querySelector('[data-action="toggle-diagnostics"]'), status: panel.querySelector('[data-role="diagnostic-status"]') };
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'cgca-diagnostic-control-v1' || typeof event.data.recording !== 'boolean') return;
    setDiagnosticsEnabled(event.data.recording);
  });
  updateDiagnosticControls();

    updateRunningUI();
    renderList();
    updateAppLabel();
    window.addEventListener('hashchange', syncAppFromUrl);
    window.addEventListener('popstate', syncAppFromUrl);
    setInterval(syncAppFromUrl, 2000);

    streamState.getSurface = getSurface;
    streamState.getAutomationSnapshot = () => ({ running: state.running, stopRequested: state.stopRequested,
      points: state.points.length, loopLimit: state.loop, completed: state.completed, intervalMs: state.interval });
    streamState.prepareRecovery = () => {
      if (state.running && !state.stopRequested) {
        saveRunIntent(state.interval, state.loop === 0 ? 0 : Math.max(1, state.loop - state.completed), state.activePoints);
      }
    };
    try {
      if (window.parent !== window) window.parent.postMessage({ type: 'cgca-stream-ready-v1',
        generation: navigationGeneration, appKey: state.appKey }, '*');
    } catch (_) {}

    logDiagnostic('ui-ready', { points: state.points.length });
    const runIntent = loadRunIntent();
    if (runIntent) {
      logDiagnostic('run-intent-found', runIntent);
      intervalEl.value = String(runIntent.interval);
      loopsEl.value = String(runIntent.loops);
      if (runIntent.points) { state.points = runIntent.points; renderList(); }
      setStatus('连接恢复后准备继续运行…');
      setTimeout(async () => {
        if (!loadRunIntent() || state.running) return;
        const surfaceReady = await waitForSurface();
        logDiagnostic('surface-wait-finished', { surfaceReady, runIntent: Boolean(loadRunIntent()) });
        if (surfaceReady && loadRunIntent()) run();
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
