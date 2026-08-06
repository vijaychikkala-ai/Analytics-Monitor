/* =============================================================================
 * Analytics Monitor — live floating panel for verifying analytics events
 * -----------------------------------------------------------------------------
 * Paste into the DevTools console once (or save as a DevTools Snippet).
 * Captures, in real time and fully expanded:
 *   • console.log entries matching [Analytics …], [BigQuery …], [GTM …], etc.
 *   • window.dataLayer.push(...)
 *   • gtag(...) calls
 *   • Actual network hits to Google Analytics (/g/collect), decoded into
 *     event name + parameters — this is the ground truth that a hit was SENT.
 *
 * Toggle the panel with Alt+A. Re-run this script to reset it.
 * ========================================================================== */

(function () {
  'use strict';

  if (window.__ANALYTICS_MONITOR__) window.__ANALYTICS_MONITOR__.destroy();

  // ---------------------------------------------------------------- config --
  const CONFIG = {
    // Console lines whose first argument matches any of these are captured.
    consolePatterns: [/^(?:%[a-zA-Z]\s*)*\[\s*(analytics|bigquery|ga4?|gtm|segment|mixpanel|amplitude)\b/i],
    // Network requests whose URL matches any of these are captured.
    networkPatterns: [/google-analytics\.com/i, /analytics\.google\.com/i, /\/g\/collect/i, /\/collect\?/i],
    maxEvents: 600,
    storageKey: '__analytics_monitor_log__',
    // Core GA4 event names shown in the "Priority" tab. Console-sourced events
    // arrive as "Category · name" (e.g. "Analytics · module_engagement"), while
    // network/dataLayer/gtag events arrive as just the plain name — matching
    // strips any "Category · " prefix so both forms resolve to the same event.
    priorityNames: [
      'component_loaded',
      'module_engagement',
      'app_navigation',
      'component_interaction',
    ],
  };

  const SOURCES = {
    console:   { label: 'console',   color: '#1E27C9' },
    dataLayer: { label: 'dataLayer', color: '#C32CF2' },
    gtag:      { label: 'gtag',      color: '#19C6BE' },
    network:   { label: 'network',   color: '#181C7A' },
  };

  // ------------------------------------------------------------- utilities --
  const now = () => performance.now();
  const clock = (d) => d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');

  function safeStringify(value, space) {
    const seen = new WeakSet();
    return JSON.stringify(value, function (key, val) {
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
      if (typeof val === 'bigint') return val.toString() + 'n';
      if (typeof Element !== 'undefined' && val instanceof Element) return '<' + val.tagName.toLowerCase() + '>';
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, space === undefined ? 2 : space);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Pretty-printed, syntax-highlighted, always fully expanded.
  function highlight(value) {
    let text;
    try { text = safeStringify(value, 2); } catch (e) { text = String(value); }
    if (text === undefined) text = String(value);
    return escapeHtml(text).replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'num';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'key' : 'str';
        else if (/true|false/.test(match)) cls = 'bool';
        else if (/null/.test(match)) cls = 'null';
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  const matchesNetwork = (url) => !!url && CONFIG.networkPatterns.some((r) => r.test(url));

  // ------------------------------------------------------------- event log --
  const events = [];
  let lastStamp = null;
  let paused = false;

  function addEvent(source, name, payload, extra) {
    if (paused) return;
    const t = now();
    const ev = {
      id: events.length + 1,
      source,
      name: name || '(unnamed)',
      payload,
      meta: extra || null,
      time: new Date(),
      delta: lastStamp === null ? 0 : t - lastStamp,
    };
    lastStamp = t;
    events.push(ev);
    if (events.length > CONFIG.maxEvents) events.shift();
    persist();
    if (ui) ui.onEvent(ev);
  }

  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        sessionStorage.setItem(CONFIG.storageKey, safeStringify(
          events.slice(-150).map((e) => ({
            id: e.id, source: e.source, name: e.name, meta: e.meta,
            payload: e.payload, time: e.time.toISOString(), delta: e.delta,
          })), 0));
      } catch (e) { /* quota or circular — history is best-effort */ }
    }, 400);
  }

  function restore() {
    try {
      const raw = sessionStorage.getItem(CONFIG.storageKey);
      if (!raw) return;
      JSON.parse(raw).forEach((e) => {
        events.push({ ...e, time: new Date(e.time), restored: true });
      });
    } catch (e) { /* ignore malformed history */ }
  }

  // ------------------------------------------------------ GA4 hit decoding --
  function paramsToObject(sp) {
    const out = {};
    sp.forEach((v, k) => { out[k] = v; });
    return out;
  }

  function buildGaEvent(raw) {
    const params = {}, userProps = {}, meta = {};
    Object.keys(raw).forEach((k) => {
      const v = raw[k];
      if (k === 'en') return;
      if (k.startsWith('ep.')) params[k.slice(3)] = v;
      else if (k.startsWith('epn.')) params[k.slice(4)] = Number(v);
      else if (k.startsWith('up.')) userProps[k.slice(3)] = v;
      else if (k.startsWith('upn.')) userProps[k.slice(4)] = Number(v);
      else meta[k] = v;
    });
    const payload = {};
    if (Object.keys(params).length) payload.event_params = params;
    if (Object.keys(userProps).length) payload.user_properties = userProps;
    payload._hit = {
      measurement_id: meta.tid, client_id: meta.cid, session_id: meta.sid,
      page: meta.dl, title: meta.dt, engagement_time_msec: meta._et,
    };
    return { name: raw.en || raw.t || 'collect', payload };
  }

  function decodeCollect(url, body) {
    const results = [];
    let common = {};
    try { common = paramsToObject(new URL(url, location.href).searchParams); } catch (e) { /* relative or odd URL */ }

    if (typeof body === 'string' && body.trim()) {
      body.split('\n').forEach((line) => {
        if (!line.trim()) return;
        results.push(buildGaEvent(Object.assign({}, common, paramsToObject(new URLSearchParams(line)))));
      });
    }
    if (!results.length) results.push(buildGaEvent(common));
    return results;
  }

  function recordNetwork(method, url, body) {
    const emit = (b) => decodeCollect(url, b).forEach((e) =>
      addEvent('network', e.name, e.payload, method + ' → ' + String(url).split('?')[0]));

    if (body && typeof Blob !== 'undefined' && body instanceof Blob) {
      body.text().then(emit).catch(() => emit(null));
    } else if (body && typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      try { emit(new TextDecoder().decode(body)); } catch (e) { emit(null); }
    } else {
      emit(typeof body === 'string' ? body : null);
    }
  }

  // --------------------------------------------------------- interceptors ---
  const restorers = [];

  // 1. console
  ['log', 'info', 'debug', 'warn'].forEach((method) => {
    const original = console[method];
    console[method] = function (...args) {
      try {
        const head = typeof args[0] === 'string' ? args[0] : '';
        if (head && CONFIG.consolePatterns.some((r) => r.test(head))) {
          const directives = head.match(/^(?:%[a-zA-Z]\s*)*/)[0];
          const styleArgCount = (directives.match(/%c/g) || []).length;
          const rest = args.slice(1 + styleArgCount);
          const cleanName = head
            .slice(directives.length)
            .replace(/^\s*\[|\]\s*$/g, '')
            .trim();
          addEvent('console', cleanName,
            rest.length === 0 ? null : rest.length === 1 ? rest[0] : rest);
        }
      } catch (e) { /* never break the host console */ }
      return original.apply(console, args);
    };
    restorers.push(() => { console[method] = original; });
  });

  // 2. dataLayer
  try {
    window.dataLayer = window.dataLayer || [];
    const originalPush = window.dataLayer.push;
    window.dataLayer.push = function (...args) {
      try {
        args.forEach((entry) => {
          const name = entry && (entry.event || entry[0] || entry['0']) || 'dataLayer.push';
          addEvent('dataLayer', String(name), entry);
        });
      } catch (e) { /* keep GTM working regardless */ }
      return originalPush.apply(window.dataLayer, args);
    };
    restorers.push(() => { window.dataLayer.push = originalPush; });
  } catch (e) { /* dataLayer may be frozen */ }

  // 3. gtag
  try {
    if (typeof window.gtag === 'function') {
      const originalGtag = window.gtag;
      window.gtag = function (...args) {
        try {
          if (args[0] === 'event') addEvent('gtag', String(args[1]), args[2] || null);
          else addEvent('gtag', String(args[0]), args.slice(1));
        } catch (e) { /* pass through */ }
        return originalGtag.apply(this, args);
      };
      restorers.push(() => { window.gtag = originalGtag; });
    }
  } catch (e) { /* ignore */ }

  // 4. fetch
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (matchesNetwork(url)) {
          recordNetwork((init && init.method) || (input && input.method) || 'GET', url, init && init.body);
        }
      } catch (e) { /* ignore */ }
      return originalFetch.apply(this, arguments);
    };
    restorers.push(() => { window.fetch = originalFetch; });
  }

  // 5. XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__amUrl = url; this.__amMethod = method;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { if (matchesNetwork(this.__amUrl)) recordNetwork(this.__amMethod, this.__amUrl, body); } catch (e) { /* ignore */ }
    return originalSend.apply(this, arguments);
  };
  restorers.push(() => {
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
  });

  // 6. sendBeacon (GA4's default transport)
  if (navigator.sendBeacon) {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { if (matchesNetwork(url)) recordNetwork('BEACON', url, data); } catch (e) { /* ignore */ }
      return originalBeacon(url, data);
    };
    restorers.push(() => { navigator.sendBeacon = originalBeacon; });
  }

  // ------------------------------------------------------------------- UI ---
  const host = document.createElement('div');
  host.id = 'analytics-monitor-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

      :host, * { box-sizing: border-box; }
      :host { --ease: cubic-bezier(.4,0,.2,1); }

      .panel {
        position: fixed; top: 16px; right: 16px; width: 460px; height: 560px;
        min-width: 320px; min-height: 44px; resize: both; overflow: hidden;
        display: flex; flex-direction: column;
        background: #FFFFFF; color: #23265C;
        border: 1px solid #E7E2F7; border-radius: 14px;
        box-shadow: 0 4px 10px rgba(24,28,122,.06), 0 20px 44px rgba(24,28,122,.14);
        font: 12px/1.5 'Plus Jakarta Sans', ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
        transition: box-shadow .25s var(--ease), height .28s var(--ease);
      }

      .head {
        position: relative; display:flex; align-items:center; gap:9px;
        padding:0 8px 0 14px; height:44px; flex:0 0 44px; cursor:grab; user-select:none;
        background:#FFFFFF; border-bottom:1px solid #F0ECFB;
      }
      .head.drag { cursor:grabbing; }

      .dot { width:9px; height:9px; border-radius:50%; background:#19C6BE; flex:0 0 auto;
        transition: background .2s var(--ease); }
      .dot.off { background:#B8B6DC; }

      .title { font-weight:700; letter-spacing:.02em; font-size:12.5px; color:#181C7A; white-space:nowrap; }
      .count { margin-left:auto; font-size:11px; color:#8B8FBE; white-space:nowrap;
        transition: color .2s var(--ease); }

      .btn {
        background:transparent; border:1px solid transparent; color:#6B6F9E;
        border-radius:7px; padding:4px 9px; cursor:pointer; font:inherit; font-weight:600; font-size:11px;
        transition: background .18s var(--ease), color .18s var(--ease), border-color .18s var(--ease), transform .12s var(--ease);
      }
      .btn:hover { background:#F5F1FC; color:#181C7A; }
      .btn:active { transform: scale(.94); }
      .btn:focus-visible { outline:2px solid #19C6BE; outline-offset:1px; }
      .btn.on { background:#181C7A; border-color:#181C7A; color:#FFFFFF; }
      .btn.on:hover { background:#23265C; color:#FFFFFF; }
      .btn.icon { padding:4px 8px; font-size:13px; line-height:1; }

      .content { flex:1 1 auto; min-height:0; display:grid; grid-template-rows: 1fr; transition: grid-template-rows .3s var(--ease); }
      .content > .content-inner { overflow:hidden; display:flex; flex-direction:column; min-height:0; height:100%; }
      .panel.min { height:44px !important; min-height:44px; resize:none; }
      .panel.min .content { grid-template-rows: 0fr; }

      .toolbar { display:flex; align-items:center; gap:7px; flex-wrap:wrap;
        padding:9px 10px; background:#FBF9FE; border-bottom:1px solid #F0ECFB; }
      .filter {
        flex:1 1 130px; min-width:110px; background:#FFFFFF; border:1px solid #E7E2F7;
        color:#23265C; border-radius:8px; padding:6px 10px; font:inherit; font-size:11.5px;
        transition: border-color .18s var(--ease), box-shadow .18s var(--ease);
      }
      .filter::placeholder { color:#ACAAD6; }
      .filter:focus { outline:none; border-color:#C32CF2; box-shadow: 0 0 0 3px rgba(195,44,242,.12); }

      .chips { display:flex; gap:7px; flex-wrap:wrap; transition: opacity .18s var(--ease); }
      .chip {
        border:1.5px solid transparent; border-radius:20px; padding:4px 11px; cursor:pointer;
        font-size:10.5px; font-weight:600; letter-spacing:.02em; background:#F2EEFB; color:#9A9AC4;
        transition: background .2s var(--ease), color .2s var(--ease), border-color .2s var(--ease), transform .12s var(--ease);
      }
      .chip.active { color:#FFFFFF; }

      .tabs { display:flex; gap:4px; padding:8px 10px 0; background:#FBF9FE; }
      .tab {
        border:none; background:transparent; color:#9A9AC4; cursor:pointer;
        font:inherit; font-weight:600; font-size:11.5px; padding:6px 12px 8px;
        border-bottom:2px solid transparent;
        transition: color .18s var(--ease), border-color .18s var(--ease);
      }
      .tab:hover { color:#181C7A; }
      .tab.active { color:#181C7A; border-color:#C32CF2; }
      .tab:focus-visible { outline:2px solid #19C6BE; outline-offset:1px; }

      .list { flex:1 1 auto; overflow-y:auto; overflow-x:hidden; padding:8px; background:#FFFFFF;
        scroll-behavior:smooth; }
      .list::-webkit-scrollbar { width:9px; }
      .list::-webkit-scrollbar-thumb { background:#E7E2F7; border-radius:9px; }
      .list::-webkit-scrollbar-thumb:hover { background:#D6CFF0; }

      .ev {
        border:1px solid #EFEBFA; border-left-width:3px; border-radius:9px;
        margin-bottom:7px; background:#FBFAFE;
        animation: enter .2s var(--ease) both;
      }
      @keyframes enter { from { opacity:0; } to { opacity:1; } }
      @media (prefers-reduced-motion: reduce) { .ev { animation:none; } }

      .ev-head { display:flex; align-items:baseline; gap:8px; padding:8px 10px; cursor:pointer; }
      .caret { color:#C3C2E4; font-size:9px; transition: transform .25s var(--ease); flex:0 0 auto; }
      .ev.collapsed .caret { transform: rotate(-90deg); }
      .badge { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
      .name { font-weight:600; color:#23265C; word-break:break-all; }
      .stamp { margin-left:auto; color:#B8B6DC; font-size:10.5px; white-space:nowrap; }
      .delta { color:#19C6BE; font-size:10.5px; font-weight:600; white-space:nowrap; }
      .via { padding:0 10px 5px 27px; color:#ACAAD6; font-size:10.5px; word-break:break-all; }

      .ev-body { display:grid; grid-template-rows:1fr; transition: grid-template-rows .28s var(--ease), opacity .22s var(--ease); opacity:1; }
      .ev.collapsed .ev-body { grid-template-rows:0fr; opacity:0; }
      .ev-body-inner { overflow:hidden; min-height:0; }
      pre { margin:0; padding:2px 10px 10px 27px; white-space:pre-wrap; word-break:break-word;
        color:#5C5F8F; font: 11.5px/1.55 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
      .key { color:#1E27C9; } .str { color:#0E9F7A; } .num { color:#B8790A; }
      .bool { color:#C32CF2; } .null { color:#ACAAD6; }

      .foot { flex:0 0 auto; padding:7px 12px; background:#FBF9FE; border-top:1px solid #F0ECFB;
        color:#ACAAD6; font-size:10.5px; display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
      .foot b { color:#6B6F9E; font-weight:700; }
      .empty { padding:30px 16px; text-align:center; color:#B8B6DC; line-height:1.7; font-size:12px; }
    </style>

    <div class="panel" part="panel">
      <div class="head">
        <span class="dot" id="dot"></span>
        <span class="title">Analytics Monitor</span>
        <span class="count" id="count">0 events</span>
        <button class="btn" id="pause" title="Pause capture">Pause</button>
        <button class="btn" id="clear" title="Clear list">Clear</button>
        <button class="btn" id="save" title="Download as JSON">Save</button>
        <button class="btn icon" id="min" title="Minimise">–</button>
        <button class="btn icon" id="close" title="Close (Alt+A to reopen)">×</button>
      </div>

      <div class="content"><div class="content-inner">
        <div class="tabs">
          <button class="tab active" id="tab-priority" data-view="priority">Priority</button>
          <button class="tab" id="tab-all" data-view="all">All events</button>
        </div>
        <div class="toolbar">
          <input class="filter" id="filter" placeholder="Filter by name or payload…" />
          <span class="chips" id="chips">
            <span class="chip active" data-src="console">console</span>
            <span class="chip active" data-src="dataLayer">dataLayer</span>
            <span class="chip active" data-src="gtag">gtag</span>
            <span class="chip active" data-src="network">network</span>
          </span>
          <button class="btn on" id="follow" title="Auto-scroll to newest">Follow</button>
        </div>

        <div class="list" id="list"></div>
        <div class="foot" id="foot"></div>
      </div></div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const panel = $('.panel'), list = $('#list'), foot = $('#foot'), head = $('.head');
  const active = new Set(['console', 'dataLayer', 'gtag', 'network']);
  let follow = true, filterText = '', view = 'priority';
  $('#chips').style.display = 'none';

  root.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.view === view) return;
      root.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      view = tab.dataset.view;
      $('#chips').style.display = view === 'priority' ? 'none' : '';
      render();
    });
  });

  root.querySelectorAll('.chip').forEach((chip) => {
    const src = chip.dataset.src;
    const c = SOURCES[src].color;
    chip.style.background = c;
    chip.style.borderColor = c;
    chip.addEventListener('click', () => {
      if (active.has(src)) {
        active.delete(src);
        chip.classList.remove('active');
        chip.style.background = '#F2EEFB';
        chip.style.borderColor = 'transparent';
        chip.style.color = '#9A9AC4';
      } else {
        active.add(src);
        chip.classList.add('active');
        chip.style.background = c;
        chip.style.borderColor = c;
        chip.style.color = '#FFFFFF';
      }
      render();
    });
  });

  // Reduces "Analytics · module_engagement" and "module_engagement" to the
  // same value, so the Priority tab catches an event no matter which source
  // (console, network, dataLayer, gtag) reported it.
  const coreName = (s) => {
    const parts = String(s).split(/\s*[·•∙‧]\s*/);
    return parts[parts.length - 1].trim();
  };
  const PRIORITY_SET = new Set(CONFIG.priorityNames.map(coreName));

  const visible = (ev) => {
    if (view === 'priority') {
      if (!PRIORITY_SET.has(coreName(ev.name))) return false;
    } else if (!active.has(ev.source)) {
      return false;
    }
    if (!filterText) return true;
    const hay = (ev.name + ' ' + (ev.meta || '') + ' ' + safeStringify(ev.payload, 0)).toLowerCase();
    return hay.includes(filterText);
  };

  function rowHtml(ev) {
    const c = SOURCES[ev.source].color;
    const delta = ev.delta > 1 ? '+' + (ev.delta >= 1000 ? (ev.delta / 1000).toFixed(1) + 's' : Math.round(ev.delta) + 'ms') : '';
    return '<div class="ev" style="border-left-color:' + c + '">' +
      '<div class="ev-head">' +
        '<span class="caret">▾</span>' +
        '<span class="badge" style="color:' + c + '">' + SOURCES[ev.source].label + '</span>' +
        '<span class="name">' + escapeHtml(ev.name) + '</span>' +
        '<span class="delta">' + delta + '</span>' +
        '<span class="stamp">' + clock(ev.time) + (ev.restored ? ' ·prev' : '') + '</span>' +
      '</div>' +
      (ev.meta ? '<div class="via">' + escapeHtml(ev.meta) + '</div>' : '') +
      '<div class="ev-body"><div class="ev-body-inner">' +
        (ev.payload === null || ev.payload === undefined ? '' : '<pre>' + highlight(ev.payload) + '</pre>') +
      '</div></div>' +
    '</div>';
  }

  function appendRow(ev) {
    const wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(ev);
    const node = wrap.firstElementChild;
    node.querySelector('.ev-head').addEventListener('click', () => node.classList.toggle('collapsed'));
    list.appendChild(node);
  }

  function updateStats() {
    const tally = {};
    events.forEach((e) => { tally[e.name] = (tally[e.name] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
    foot.innerHTML = '<span><b>' + Object.keys(tally).length + '</b> unique</span>' +
      top.map(([n, c]) => '<span>' + escapeHtml(n) + ' <b>' + c + '</b></span>').join('');
    $('#count').textContent = events.length + ' event' + (events.length === 1 ? '' : 's');
  }

  function render() {
    list.innerHTML = '';
    const rows = events.filter(visible);
    if (!rows.length) {
      list.innerHTML = view === 'priority'
        ? '<div class="empty">No priority events yet.<br>Waiting for component_loaded, module_engagement, or app_navigation.</div>'
        : '<div class="empty">No events captured yet.<br>Navigate the app — everything shows up here, already expanded.</div>';
    } else {
      rows.forEach(appendRow);
    }
    updateStats();
    if (follow) list.scrollTop = list.scrollHeight;
  }

  const ui = {
    onEvent(ev) {
      if (visible(ev)) {
        const empty = list.querySelector('.empty');
        if (empty) empty.remove();
        appendRow(ev);
        while (list.children.length > CONFIG.maxEvents) list.removeChild(list.firstChild);
        if (follow) list.scrollTop = list.scrollHeight;
      }
      updateStats();
    },
  };

  // controls
  $('#filter').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); render(); });
  $('#follow').addEventListener('click', (e) => { follow = !follow; e.target.classList.toggle('on', follow); if (follow) list.scrollTop = list.scrollHeight; });
  $('#pause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? 'Resume' : 'Pause';
    $('#dot').classList.toggle('off', paused);
  });
  $('#clear').addEventListener('click', () => {
    events.length = 0; lastStamp = null;
    try { sessionStorage.removeItem(CONFIG.storageKey); } catch (err) { /* ignore */ }
    render();
  });
  $('#save').addEventListener('click', () => {
    const blob = new Blob([safeStringify(events.map((e) => ({
      time: e.time.toISOString(), source: e.source, name: e.name, meta: e.meta, payload: e.payload,
    })), 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'analytics-events-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#min').addEventListener('click', (e) => {
    const willMin = !panel.classList.contains('min');
    panel.classList.toggle('min');
    e.target.textContent = willMin ? '▢' : '–';
  });
  $('#close').addEventListener('click', () => { host.style.display = 'none'; });

  // drag by header
  (function enableDrag() {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.btn')) return;
      const r = panel.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.transition = 'none';
      panel.style.right = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      head.classList.add('drag');
      e.preventDefault();
    });
    const move = (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(innerWidth - 120, ox + e.clientX - sx)) + 'px';
      panel.style.top = Math.max(0, Math.min(innerHeight - 44, oy + e.clientY - sy)) + 'px';
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      head.classList.remove('drag');
      panel.style.transition = '';
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    restorers.push(() => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); });
  })();

  // Alt+A toggles visibility
  const onKey = (e) => {
    if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      host.style.display = host.style.display === 'none' ? '' : 'none';
    }
  };
  addEventListener('keydown', onKey);
  restorers.push(() => removeEventListener('keydown', onKey));

  restore();
  render();

  // -------------------------------------------------------------- teardown --
  window.__ANALYTICS_MONITOR__ = {
    events,
    config: CONFIG,
    destroy() {
      restorers.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
      host.remove();
      delete window.__ANALYTICS_MONITOR__;
    },
  };

  console.info('%c Analytics Monitor ready ', 'background:#19C6BE;color:#181C7A;font-weight:600;border-radius:3px',
    '— Alt+A toggles the panel, window.__ANALYTICS_MONITOR__.destroy() removes it.');
})();
