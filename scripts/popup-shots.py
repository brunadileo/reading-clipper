#!/usr/bin/env python3
"""READ-236: headless screenshots of the built popup and Settings page.

Serves dist/ over http, injects a stubbed browser/chrome API plus fixture data
before the page scripts run, and shoots each state. No headed browser, no real
network (the capture call is answered by the stub).

  python3 scripts/popup-shots.py --out DIR --prefix before [--scheme light|dark|both] [--only name,name] [--contrast]

Names: popup-ready popup-saving popup-saved popup-failed popup-signin popup-error
       settings-connection settings-disconnected settings-sync settings-shortcuts settings-about
--contrast also prints the smallest text contrast ratio on each page (text >= 4.5).
"""
import argparse, functools, http.server, json, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_URL = "https://justyn.ai/stop-the-slop"
FIXTURE_TITLE = "Stop the Slop: 12 Design Tools for AI Builders"
FIXTURE_TEXT = "Most AI builders ship the first thing the model draws. These twelve tools fix that. " * 6

STUB = r"""
(() => {
  const cfg = %CFG%;
  const store = { local: Object.assign({}, cfg.local), sync: {} };
  const listeners = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; } });
  const pick = (area, keys) => {
    if (keys == null) return Object.assign({}, store[area]);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in store[area]) out[k] = store[area][k];
    return out;
  };
  const areaApi = (area) => ({
    get: async (keys) => pick(area, keys),
    set: async (obj) => { Object.assign(store[area], obj); },
    remove: async (keys) => { [].concat(keys).forEach(k => delete store[area][k]); },
    onChanged: listeners(),
  });
  const content = {
    content: '<p>' + cfg.text + '</p>', selectedHtml: '', extractedContent: {}, schemaOrgData: null,
    fullHtml: '<html><body><p>' + cfg.text + '</p></body></html>', highlights: [], title: cfg.title,
    author: 'Justyn', description: 'Twelve tools.', domain: 'justyn.ai', favicon: '', image: '',
    parseTime: 1, published: '2026-10-01', site: 'justyn.ai', wordCount: 120, language: 'en', metaTags: [],
  };
  const onMessage = async (msg) => {
    switch (msg && msg.action) {
      case 'getActiveTab': return { tabId: 1 };
      case 'getTabInfo': return { success: true, tab: { id: 1, url: cfg.tabUrl } };
      case 'getHighlighterMode': return { isActive: false };
      case 'sendMessageToTab':
        if (msg.message && msg.message.action === 'getPageContent') return content;
        if (msg.message && msg.message.action === 'getReaderModeState') return { isActive: false };
        return { success: true };
      case 'sendToReading':
        window.__sent = msg.body;
        if (cfg.capture === 'hang') return new Promise(() => {});
        if (cfg.capture === 'ok') return { ok: true, status: 200, data: { readUrl: 'https://lazyreader.app/read/1' } };
        if (cfg.capture === '401') return { ok: false, status: 401, error: 'not-connected' };
        return { ok: false, status: 500, error: 'Server error, try again' };
      case 'syncStatus': case 'getSyncStatus': return { success: true };
      default: return { success: true };
    }
  };
  const browser = {
    runtime: {
      id: 'stub-extension-id',
      sendMessage: onMessage,
      connect: () => ({ onMessage: listeners(), onDisconnect: listeners(), postMessage() {}, disconnect() {} }),
      onMessage: listeners(), onConnect: listeners(), onInstalled: listeners(),
      getManifest: () => ({ version: cfg.version, name: 'Lazy Reader Clipper', permissions: ['offscreen'], optional_permissions: [], optional_host_permissions: [] }),
      getURL: (p) => p,
      onUpdateAvailable: listeners(),
    },
    storage: { local: areaApi('local'), sync: areaApi('sync'), onChanged: listeners() },
    i18n: { getMessage: (k) => k, getUILanguage: () => 'en' },
    tabs: { create: async () => ({}), query: async () => [{ id: 1, url: cfg.tabUrl }], get: async () => ({ id: 1, url: cfg.tabUrl }), onUpdated: listeners(), onActivated: listeners() },
    permissions: { contains: async () => false, request: async () => false, onAdded: listeners(), onRemoved: listeners() },
    commands: { getAll: async () => [{ name: '_execute_action', description: 'Open the clipper', shortcut: 'Alt+Shift+O' }] },
    extension: { getViews: () => [] },
    action: {}, alarms: { get: async () => null, create() {}, onAlarm: listeners() },
  };
  window.browser = browser;
  window.chrome = Object.assign(window.chrome || {}, browser);
  window.close = () => { window.__closed = true; };
})();
"""

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve(dist):
    handler = functools.partial(Quiet, directory=str(dist))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

CONTRAST_JS = r"""
() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({r,g,b}) => { const f = v => { v/=255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }; return .2126*f(r)+.7152*f(g)+.0722*f(b); };
  const over = (top, bot) => ({ r: top.r*top.a+bot.r*(1-top.a), g: top.g*top.a+bot.g*(1-top.a), b: top.b*top.a+bot.b*(1-top.a), a: 1 });
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; if (!stack.length || stack[stack.length-1].a < 1) base = parse(getComputedStyle(document.documentElement).backgroundColor) || base; if (base.a === 0) base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = stack.length-1; i >= 0; i--) base = over(stack[i], base); return base; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    if (el.closest('[hidden]') || el.closest('script,style')) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el); const f = over(fg, bg);
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
    out.push({ ratio: Math.round(ratio*100)/100, text: n.textContent.trim().slice(0, 40), tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') });
  }
  out.sort((a,b) => a.ratio - b.ratio);
  return out.slice(0, 5);
}
"""

OVERFLOW_JS = r"""
() => { const w = document.documentElement.clientWidth; const bad = []; document.querySelectorAll('body *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && (r.right > w + 1 || r.left < -1) && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none') bad.push(e.tagName + '.' + e.className + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }); return { scrollW: document.documentElement.scrollWidth, clientW: w, bad: bad.slice(0, 6) }; }
"""

def states():
    # name: (page, hash, token, tabUrl, capture, width)
    return {
        "popup-ready": ("popup.html", "", True, FIXTURE_URL, None, 360),
        "popup-saving": ("popup.html", "", True, FIXTURE_URL, "hang", 360),
        "popup-saved": ("popup.html", "", True, FIXTURE_URL, "ok", 360),
        "popup-failed": ("popup.html", "", True, FIXTURE_URL, "fail", 360),
        "popup-signin": ("popup.html", "", False, FIXTURE_URL, "401", 360),
        "popup-error": ("popup.html", "", True, "chrome://extensions", None, 360),
        "settings-connection": ("settings.html", "#connection", True, FIXTURE_URL, None, 1100),
        "settings-disconnected": ("settings.html", "#connection", False, FIXTURE_URL, None, 1100),
        "settings-sync": ("settings.html", "#sync", True, FIXTURE_URL, None, 1100),
        "settings-shortcuts": ("settings.html", "#shortcuts", True, FIXTURE_URL, None, 1100),
        "settings-about": ("settings.html", "#about", True, FIXTURE_URL, None, 1100),
    }

def run(args):
    dist = (ROOT / args.dist).resolve()
    version = json.loads((dist / "manifest.json").read_text())["version"]
    srv = serve(dist)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    wanted = set(args.only.split(",")) if args.only else None
    schemes = ["light", "dark"] if args.scheme == "both" else [args.scheme]
    problems = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for scheme in schemes:
            for name, (page_file, frag, token, tab_url, capture, width) in states().items():
                if wanted and name not in wanted: continue
                ctx = browser.new_context(viewport={"width": width, "height": 520 if width == 360 else 900}, color_scheme=scheme, device_scale_factor=2)
                cfg = {"local": {"readingToken": "a" * 48} if token else {}, "tabUrl": tab_url, "title": FIXTURE_TITLE, "text": FIXTURE_TEXT, "version": version, "capture": capture}
                ctx.add_init_script(STUB.replace("%CFG%", json.dumps(cfg)))
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.goto(f"{base}/{page_file}{frag}")
                page.wait_for_timeout(1200)
                if capture:
                    if name == "popup-saved" and page.query_selector('[data-value="read-later"]'):
                        page.click('[data-value="read-later"]')  # proves the tab writes #vault-select
                    page.click("#clip-btn")
                    page.wait_for_timeout(1000)
                if page_file == "settings.html" and name == "settings-about":
                    pass
                page.wait_for_timeout(300)
                shot = out / f"{args.prefix}-{name}-{scheme}.png"
                page.screenshot(path=str(shot), full_page=True)
                line = f"{shot.name}"
                if args.contrast:
                    c = page.evaluate(CONTRAST_JS)
                    o = page.evaluate(OVERFLOW_JS)
                    line += f"  min-contrast={c[0]['ratio'] if c else 'n/a'} ({c[0]['text']!r} {c[0]['tag']})" if c else ""
                    line += f"  scrollW={o['scrollW']}/{o['clientW']}"
                    if o['bad']: line += f"  OVERFLOW={o['bad']}"
                    if c and c[0]['ratio'] < 4.5: problems += 1
                sent = page.evaluate("window.__sent") if capture else None
                if sent: line += f"  sent: lane={sent.get('lane')} title={sent.get('title')!r} text_len={len(sent.get('text') or '')}"
                if errors: line += f"  CONSOLE-ERRORS={errors[:3]}"
                print(line)
                ctx.close()
        browser.close()
    srv.shutdown()
    return problems

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default="dist"); ap.add_argument("--out", required=True)
    ap.add_argument("--prefix", default="shot"); ap.add_argument("--scheme", default="light")
    ap.add_argument("--only"); ap.add_argument("--contrast", action="store_true")
    sys.exit(0 if run(ap.parse_args()) == 0 else 1)
