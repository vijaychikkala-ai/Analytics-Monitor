# Analytics Monitor

A single-file DevTools snippet that gives you a live, floating panel for
verifying analytics events as they fire — no more opening the Console tab,
scrolling through logs, and manually expanding collapsed objects one at a
time.

Paste it into the browser console once. It attaches a small, draggable
window to the page that streams every analytics event in real time, fully
expanded, with no extra clicks.

![theme](https://img.shields.io/badge/theme-light-blueviolet) ![size](https://img.shields.io/badge/dependencies-none-brightgreen)

---

## What it captures

| Source | What it hooks | Why it matters |
|---|---|---|
| **console** | `console.log/info/debug/warn` lines starting with `[Analytics …]`, `[BigQuery …]`, `[GTM …]`, etc. | Your app's own debug logging |
| **dataLayer** | `window.dataLayer.push(...)` | What GTM was actually told to push |
| **gtag** | `gtag('event', ...)` calls | What your code told `gtag.js` to send |
| **network** | Real network requests to Google Analytics (`fetch`, `XHR`, and `navigator.sendBeacon`, matching `/g/collect` and related endpoints) | **Ground truth** — decodes the actual GA4 hit into event name + parameters, batched hits included |

The network layer is the important one: your code can log an event without
GA ever receiving it (ad blockers, consent mode, a bad tag, a typo in a
trigger). This tool tells you whether the hit actually left the browser, not
just whether your code *thinks* it fired.

## Getting started

**Option A — one-off, per session**

1. Open DevTools → **Console**.
2. Paste the entire contents of `analytics-monitor.js` and press Enter.
3. The panel appears in the top-right corner of the page.

**Option B — reusable Snippet (recommended)**

1. DevTools → **Sources** → **Snippets** → **New snippet**.
2. Paste the file contents, name it `analytics-monitor`.
3. Run it any time with **Ctrl+Enter** (or **Cmd+Enter** on macOS) while the
   snippet is open, including after a hard reload.

**Option C — wired into the app for local development**

Import and run it only outside production:

```ts
if (!environment.production) {
  import('./analytics-monitor.js');
}
```

Do **not** ship this into a production bundle — see [Security notes](#security-notes).

## Using the panel

| Control | Does |
|---|---|
| **Priority / All events** tabs | Priority shows only the event names you've flagged as important (see [Customizing](#customizing-priority-events)); All events shows everything, filterable by source |
| Source chips (`console` / `dataLayer` / `gtag` / `network`) | Toggle which sources appear, in the **All events** tab |
| Filter box | Free-text search across event name, source, and full payload |
| **Follow** | Auto-scrolls to the newest event as they arrive |
| **Pause** | Freezes capture so you can inspect something without new events pushing it off-screen |
| **Clear** | Empties the current log (and its session cache) |
| **Save** | Downloads everything captured so far as a JSON file |
| **–** | Minimises the panel to just its header bar |
| **×** | Hides the panel — bring it back with **Alt+A** |
| Drag the header | Reposition the panel anywhere on screen |
| Drag the bottom-right corner | Resize the panel |

Click any event row to expand or collapse its payload. Events persist
across a page reload within the same tab session (restored from
`sessionStorage`, marked `·prev`).

## Customizing priority events

Priority events are matched by **name only**, ignoring any `Category ·`
prefix a console log might add — so an event named `module_engagement`
matches whether it arrived via `console`, `network`, `dataLayer`, or `gtag`.

To change which events show up in the Priority tab, edit the list near the
top of the file:

```js
const CONFIG = {
  // ...
  priorityNames: [
    'component_loaded',
    'module_engagement',
    'app_navigation',
    'component_interaction',
  ],
};
```

## Removing it

```js
window.__ANALYTICS_MONITOR__.destroy();
```

This restores every function it patched (`console.*`, `fetch`, `XHR`,
`sendBeacon`, `dataLayer.push`, `gtag`) to its original implementation and
removes the panel from the page.

## How it works

- The panel renders inside a **Shadow DOM** root, so its styles never leak
  into the host page and the page's styles never leak into it.
- It monkey-patches a small set of global functions (listed above) purely
  to *observe* calls — every original function is still invoked with the
  same arguments, so the app's actual behavior is never changed.
- GA4 network hits are decoded by parsing the request's query string /
  body according to the [Measurement
  Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4)
  parameter conventions (`en`, `ep.*`, `epn.*`, `up.*`, `upn.*`, etc.),
  including multi-event batched payloads.

## Security notes

- **No exfiltration.** The script never sends captured data anywhere. The
  only outbound request it makes on its own is a Google Fonts CSS
  `@import` for typography; it fails silently (falling back to system
  fonts) if blocked by a page's CSP.
- **XSS-safe rendering.** All captured text (event names, metadata, payload
  contents) is HTML-escaped before being inserted into the DOM.
- **No `eval`, no dynamic code execution.**
- **Be mindful of PII.** If your analytics events include personal data
  (e.g. a `user_email` parameter), that data will appear in the panel, in
  the `sessionStorage` cache (cleared when the tab closes), and in any file
  produced by **Save**. Treat exported JSON accordingly.
- Intended for local debugging. If wired into an app, gate it behind a
  non-production flag — see [Option C](#getting-started) above.

## Browser support

Built for Chromium-based DevTools (Chrome, Edge). Uses Shadow DOM, CSS
Grid, and standard Fetch/XHR/Beacon APIs — no external dependencies.

## License

Add your preferred license here (e.g. MIT) before publishing.
