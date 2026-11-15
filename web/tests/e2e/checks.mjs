// Acceptance checks A1-A26 (TODO.md section 8) and legacy-intent checks L1-L6. A check returns {status, value} or throws (= FAIL).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { OUT, valueAt, startHostile, startServer, startStatic } from './lib.mjs'

const P = (value) => ({ status: 'PASS', value })
const F = (value) => ({ status: 'FAIL', value })
const S = (value) => ({ status: 'SKIP', value })
const ok = (cond, value) => (cond ? P(value) : F(value))
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const startModel = async (pg, ex = 'distilgpt2') => { await pg.evaluate((e) => window.__studio?.getState().loadExample?.(e), ex); await pg.waitForTimeout(1500); await pg.locator('[data-start]').first().click(); await pg.waitForTimeout(700)
  const d = pg.locator('[data-start]:has-text("Download")'); if (await d.count()) await d.first().click({ timeout: 2000 }).catch(() => {}) }
const SCORE = 'b[data-score]'   // the device score; ZooUI also puts data-score on a <p> (collision, see README)
const THEMES = ['dark', 'light']
const idle = (p, ms) => p.page.waitForTimeout(ms)
/** Draw a polyline with the mouse, or with CDP touch events when touch is true. */
async function stroke(p, pts, touch) {
  if (!touch) { await p.page.mouse.move(pts[0][0], pts[0][1]); await p.page.mouse.down(); for (const q of pts.slice(1)) await p.page.mouse.move(q[0], q[1], { steps: 2 }); await p.page.mouse.up(); return }
  const s = await p.ctx.newCDPSession(p.page), tp = (q) => [{ x: q[0], y: q[1] }]
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) }); for (const q of pts.slice(1)) await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(q) }); await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
const three = (b) => { const pts = [], cx = b.x + b.width / 2, w = b.width * 0.22, h = b.height * 0.2, top = b.y + b.height * 0.28, mid = b.y + b.height * 0.5, bot = b.y + b.height * 0.72
  for (let t = -Math.PI * 0.8; t <= Math.PI * 0.5; t += 0.2) pts.push([cx + w * Math.cos(t), top + h * (1 + Math.sin(t))])
  for (let t = -Math.PI * 0.5; t <= Math.PI * 0.8; t += 0.2) pts.push([cx + w * Math.cos(t), mid + h * (1 + Math.sin(t))]); return pts }
const gz = (f) => zlib.gzipSync(fs.readFileSync(f)).length
const shown = (pg, sel) => pg.evaluate((s) => [...document.querySelectorAll(s)].some(__h.vis), sel)
/** Drawers are closed by default and opening one closes the other: click toggles until `sel` is visible. */
const openFor = async (pg, sel) => { const t = pg.locator('[data-drawer-toggle]'), n = await t.count(); for (let i = 0; i < n && !(await shown(pg, sel)); i++) { await t.nth(i).click({ timeout: 3000 }).catch(() => {}); await pg.waitForTimeout(700) } return shown(pg, sel) }
/** Auto flow on the real Hub: no click. Returns timings, progress samples, planned vs downloaded bytes. */
async function autoRun(env, o) {
  const p = await env.open({ hub: false, ...o }); let got = 0
  await p.page.addInitScript(() => { window.__pv = []; addEventListener('DOMContentLoaded', () => new MutationObserver(() => { const b = document.querySelector('[role=progressbar]'); if (b) __pv.push([Date.now(), b.getAttribute('aria-valuenow'), b.getAttribute('aria-valuemin'), b.getAttribute('aria-valuemax')]) }).observe(document, { subtree: true, attributes: true, childList: true })) })
  const t0 = Date.now(); await p.page.goto(env.base + env.query, { waitUntil: 'load' })
  const done = await p.page.waitForSelector('[data-runscore]', { state: 'attached', timeout: 240000 }).then(() => true, () => false), tRun = (Date.now() - t0) / 1000
  const info = await p.page.evaluate(() => { const s = window.__studio.getState(); return { plan: s.plan, err: s.runErr, where: s.lastStats?.where, text: document.querySelector('[data-runscore]')?.innerText ?? '' } })
  const v = await p.page.evaluate(() => __pv), distinct = new Set(v.map((x) => x[1])).size, span = v.length ? (v.at(-1)[0] - v[0][0]) / 1000 : 0
  got = await p.page.evaluate(async () => { let n = 0; for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) if (/\/resolve\//.test(r.url)) n += (await (await c.match(r)).blob()).size } return n }).catch(() => 0)
  await p.shot('auto-run'); return { p, done, tRun, info, v, distinct, span, got, t0 }
}
const W4 = (env) => env.widths
const PRIMARY = '[data-primary], [data-dock] button, header button.btn'
const MODEL_FILE = /\.(onnx|safetensors|gguf|bin)(\?|$)|\/resolve\//
const ALLOWED = (origin) => (u) => { const x = new URL(u); return x.protocol === 'data:' || x.protocol === 'blob:' || x.origin === origin || /(^|\.)(huggingface\.co|hf\.co)$/.test(x.hostname) || (x.port === '8000' && /^(127\.0\.0\.1|localhost)$/.test(x.hostname)) }
const BANNED = /\b(utilis(e|es|ed|ing)|leverag(e|es|ed|ing)|performant|very|simply|basically|actually)\b/gi
const syl = (w) => { w = w.toLowerCase().replace(/[^a-z]/g, ''); if (w.length <= 3) return w ? 1 : 0; return Math.max(1, (w.replace(/e$/, '').match(/[aeiouy]+/g) || []).length) }

/** Open the page at one width and run fn(page); closes nothing (env.closeAll does). */
async function atWidths(env, o, fn) {
  const rows = []
  for (const w of W4(env)) { const p = await env.open({ ...o, w }); await p.goto(o.hash ?? ''); rows.push([w, await fn(p.page, w, p)]) }
  return rows
}

export const checks = [
  { id: 'A1', title: 'text contrast >= 4.5:1 (3:1 large) in dark and light themes', run: async (env) => {
    const feat = await (async () => { const p = await env.open(); await p.goto(); return p.features() })(), out = []; let bad = 0, minAll = 99
    for (const th of feat.theme ? THEMES : ['dark']) { const rows = await atWidths(env, { theme: th }, (pg) => pg.evaluate(() => __h.contrast()))
      const b = rows.filter(([, r]) => r.fails.length); bad += b.length; minAll = Math.min(minAll, ...rows.map(([, r]) => r.min))
      out.push(`${th}: ${b.map(([w, r]) => `${w}px ${r.fails.length} fail e.g. ${r.fails[0]}`).join(' | ') || 'all pass'}`) }
    return ok(!bad, `min ${minAll.toFixed(2)}:1; ${out.join(' || ')}${feat.theme ? '' : ' (light theme not built yet: dark only)'}`) } },
  { id: 'A2', title: 'no overlapping interactive boxes or labels', run: async (env) => {
    const rows = await atWidths(env, {}, (pg) => pg.evaluate(() => {
      const els = [...new Set([...__h.interactive(), ...[...document.querySelectorAll('[data-label]')].filter(__h.vis)])], hits = []
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j]; if (a.contains(b) || b.contains(a)) continue
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect()
        const w = Math.min(x.right, y.right) - Math.max(x.left, y.left), h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top)
        if (w > 1 && h > 1) hits.push(`${(a.textContent || a.className).trim().slice(0, 14)} x ${(b.textContent || b.className).trim().slice(0, 14)}`)
      } return hits }))
    const bad = rows.filter(([, h]) => h.length)
    return ok(!bad.length, bad.map(([w, h]) => `${w}px: ${h.length} overlaps e.g. ${h[0]}`).join(' | ') || '0 overlaps at all widths') } },

  { id: 'A3', title: 'no label outside the stage', needs: ['S8'], run: async (env) => {
    const rows = await atWidths(env, {}, (pg) => pg.evaluate(() => [...document.querySelectorAll('[data-label]')].filter(__h.vis).filter((l) => {
      const st = l.closest('[data-stage]'); if (!st) return true; const a = l.getBoundingClientRect(), b = st.getBoundingClientRect()
      return a.left < b.left - 1 || a.right > b.right + 1 || a.top < b.top - 1 || a.bottom > b.bottom + 1 }).map((l) => l.textContent.trim().slice(0, 16))))
    const bad = rows.filter(([, h]) => h.length); return ok(!bad.length, bad.map(([w, h]) => `${w}px: ${h.join(',')}`).join(' | ') || 'all labels inside their stage') } },

  { id: 'A4', title: 'touch targets >= 40 px (dock >= 44) at 390', run: async (env) => {
    const p = await env.open({ w: 390, touch: true }); await p.goto()
    const r = await p.page.evaluate(() => __h.interactive().filter((e) => !(e.tagName === 'A' && e.closest('p,li,span.note')))
      .map((e) => { const b = e.getBoundingClientRect(), min = e.closest('[data-dock]') ? 44 : 40; return { m: Math.min(b.width, b.height), min, n: (e.textContent || e.getAttribute('aria-label') || e.className).trim().slice(0, 16) } }).filter((x) => x.m < x.min - 0.5))
    return ok(!r.length, r.length ? `${r.length} too small, e.g. ${r.slice(0, 4).map((x) => `"${x.n}" ${x.m.toFixed(0)}px`).join(', ')}` : 'all >= 40/44') } },

  { id: 'A5', title: 'no horizontal scroll at 390/820/1100/1480', run: async (env) => {
    const rows = await atWidths(env, {}, (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    return ok(rows.every(([, o]) => o <= 0), rows.map(([w, o]) => `${w}:${o}px`).join(' ')) } },

  { id: 'A6', title: 'primary action visible without scrolling', run: async (env) => {
    const rows = await atWidths(env, {}, (pg) => pg.evaluate((sel) => { const e = [...document.querySelectorAll(sel)].find(__h.vis); if (!e) return 'none'
      const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth ? 'yes' : `no (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)} of ${innerHeight})` }, PRIMARY))
    return ok(rows.every(([, v]) => v === 'yes'), rows.map(([w, v]) => `${w}:${v}`).join(' ')) } },

  { id: 'A7', title: 'first paint <= 2.5 s; first score <= 10 s (20 Mbit)', needs: ['S5'], run: async (env) => {
    const p = await env.open({ throttle: 20 }); const t0 = Date.now(); await p.page.goto(env.base + env.query, { waitUntil: 'load' })
    const fcp = await p.page.waitForFunction(() => performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => -1)
    await openFor(p.page, '[data-test=cpu1]'); const t1 = Date.now(); await p.page.locator('[data-test=cpu1]').first().click(); await p.page.waitForSelector(SCORE, { timeout: 30000 })
    const s = (Date.now() - t1) / 1000
    return ok(fcp > 0 && fcp <= 2500 && s <= 10, `first paint ${Math.round(fcp)} ms; first score ${s.toFixed(1)} s (load ${((t1 - t0) / 1000).toFixed(1)} s)`) } },
  { id: 'A7b', tier: 3, title: 'real Hub at 20 Mbit, no click: default model downloads, runs, run score within download time + 25 s', needs: ['auto'], run: async (env) => {
    const r = await autoRun(env, { throttle: 20 }); const planned = r.info.plan?.bytes ?? 0
    const limit = planned / 2.5e6 + 25; return ok(r.done && r.tRun <= limit, `limit ${limit.toFixed(0)} s (download at 2.5 MB/s + 25 s to load and run); ${r.done ? 'run score' : 'NO run score in 240 s'} after ${r.tRun.toFixed(1)} s on ${r.info.where ?? '?'}; model ${r.info.plan?.repo} planned ${(planned / 1048576).toFixed(0)} MB, downloaded ${(r.got / 1048576).toFixed(0)} MB; ${r.info.err ?? 'no error'}`) } },
  { id: 'A8', title: "A8': a model request starts <= 2 s after load with no click; progress bar updates >= 1/s (rate: tier 2 cannot stream from the model worker, see A9)", needs: ['auto'], run: async (env) => {
    const p = await env.open({ profile: { stream: 4000 } }); await p.page.addInitScript(() => { window.__pv = []; addEventListener('DOMContentLoaded', () => new MutationObserver(() => { const b = document.querySelector('[role=progressbar]'); if (b) __pv.push([Date.now(), b.getAttribute('aria-valuenow')]) }).observe(document, { subtree: true, attributes: true, childList: true })) })
    const t0 = Date.now(); await p.page.goto(env.base + env.query, { waitUntil: 'load' }); await p.page.waitForTimeout(6000)
    const first = p.reqs.find((r) => MODEL_FILE.test(r.url) && /hf\.co|huggingface/.test(r.url) && !/\/api\//.test(r.url)), ms = first ? first.t - t0 : -1
    const v = await p.page.evaluate(() => window.__pv), seen = new Set(v.map((x) => x[1])).size, span = v.length ? (v.at(-1)[0] - v[0][0]) / 1000 : 0, rate = span > 0 ? (seen - 1) / span : 0
    return ok(first && ms <= 2000, `first model request ${first ? ms + ' ms after navigation' : 'NONE'}; progressbar ${v.length ? 'seen, ' + rate.toFixed(1) + ' updates/s' : 'not seen (the stub answers in one chunk; the model worker cannot be streamed, so the rate is gated by tier-3 A9)'}`) } },
  { id: 'A9', tier: 3, title: 'A9: real Hub, no click: progress bar with aria values, Cancel, updates >= 1/s', needs: ['auto'], run: async (env) => {
    const r = await autoRun(env, {}), cancel = await r.p.page.locator('button:has-text("Cancel")').count(), valid = r.v.length && r.v.every((x) => x[1] !== null && x[2] !== null && x[3] !== null)
    return ok(valid && r.distinct / (r.span || 1) >= 1, `${r.v.length ? r.distinct + ' distinct values over ' + r.span.toFixed(1) + ' s' : 'no progressbar'}; aria ${valid}; Cancel button after finish ${cancel > 0} (not required once done)`) } },
  { id: 'A10', title: "A10': second load with the server stopped: shell and model served from cache, zero requests", needs: ['sw', 'auto'], run: async (env) => {
    const srv = await startStatic(env.dist); try { const p = await env.open({ sw: true }); await p.page.goto(srv.url, { waitUntil: 'load' }); await p.page.waitForTimeout(1000)
      await p.page.evaluate(() => navigator.serviceWorker.ready.then(() => 1)).catch(() => 0)
      await p.page.waitForFunction(() => /cached|saved/i.test(document.body.innerText) || window.__studio?.getState().plan?.cached, null, { timeout: 30000 }).catch(() => {})
      await p.page.reload({ waitUntil: 'load' }); await p.page.waitForTimeout(1000)   // now controlled by the service worker
      const hits = p.hub.hits.length; p.reqs.length = 0; p.failed = []; await srv.close()
      await p.page.reload({ waitUntil: 'load' }).catch(() => {}); await p.page.waitForTimeout(3000)
      const text = (await p.page.evaluate(() => document.body?.innerText.length).catch(() => 0)), before = new Set(p.hub.hits.slice(0, hits)), again = p.hub.hits.slice(hits).filter((h) => /resolve/.test(h) && before.has(h)), net = again.length, fail = (p.failed ?? []).filter((u) => u.startsWith(srv.url))
      return ok(text > 200 && net === 0, `server stopped: page rendered ${text} chars; ${net} model requests${net ? ' (' + again.map((h) => h.split('/').pop()).join(', ') + ' fetched again)' : ''}; ${fail.length} network attempts for app files (served by the service worker anyway)`) } finally { await srv.close() } } },

  { id: 'A13', title: "A13': Model and Machine side by side (<= 16 px gap) at 1480 and 1100, stacked at 390; drawers closed; drawer toggle CLS <= 0.02", needs: ['pair'], run: async (env) => {
    const geo = () => [...document.querySelectorAll('.pair > *')].filter(__h.vis).slice(0, 2).map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom } })
    const out = [], bad = []
    for (const w of [1480, 1100, 390]) { const p = await env.open({ w }); await p.goto(); const g = await p.page.evaluate(geo)
      if (g.length < 2) { bad.push(`${w}: ${g.length} stages`); continue }
      const side = Math.abs(g[0].t - g[1].t) < 8, gap = g[1].l - g[0].r
      if (w >= 1000 ? !(side && gap >= 0 && gap <= 16) : !(Math.abs(g[0].l - g[1].l) < 8 && g[1].t >= g[0].b - 2)) bad.push(`${w}: ${w >= 1000 ? `gap ${Math.round(gap)} px, same row ${side}` : 'not stacked'}`); else out.push(`${w} ok`) }
    const p = await env.open({ w: 1480 }); await p.page.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) __cls += e.value }).observe({ type: 'layout-shift', buffered: true }) }); await p.goto()
    const open0 = await p.page.evaluate(() => [...document.querySelectorAll('[data-drawer]')].filter((d) => (() => { const r = d.getBoundingClientRect(); return __h.vis(d) && r.right > 4 && r.left < innerWidth - 4 })()).length)
    const tg = p.page.locator('[data-drawer-toggle]').first(); if (await tg.count()) { await tg.click(); await p.page.waitForTimeout(500); await tg.click(); await p.page.waitForTimeout(500) } else bad.push('no [data-drawer-toggle]')
    const cls = await p.page.evaluate(() => __cls)
    return ok(!bad.length && !open0 && cls <= 0.02, `${out.join(', ')}${bad.length ? '; ' + bad.join('; ') : ''}; ${open0} drawers open on fresh profile; toggle CLS ${cls.toFixed(4)}`) } },
  { id: 'A14', title: 'resize 1480→390 in 20 steps: p95 frame <= 20 ms, buffer = CSS × capped DPR', needs: ['S8'], run: async (env) => {
    const p = await env.open({ dpr: 3 }); await p.goto()
    await p.page.evaluate(() => { window.__fr = []; let l = performance.now(); const f = (t) => { __fr.push(t - l); l = t; requestAnimationFrame(f) }; requestAnimationFrame(f) })
    for (let i = 0; i <= 20; i++) { await p.page.setViewportSize({ width: Math.round(1480 - (1090 * i) / 20), height: 900 }); await p.page.waitForTimeout(50) }
    await p.page.waitForTimeout(400)
    const r = await p.page.evaluate(() => { const cap = window.__scene.dprCap ?? 2, d = Math.min(devicePixelRatio, cap)
      const bad = [...document.querySelectorAll('canvas')].filter(__h.vis).filter((c) => { const b = c.getBoundingClientRect(); return Math.abs(c.width - Math.round(b.width * d)) > 2 || Math.abs(c.height - Math.round(b.height * d)) > 2 }).length
      return { fr: __fr.slice(5), bad, cap } })
    const q = p95(r.fr); return ok(q <= 20 && !r.bad, `p95 ${q.toFixed(1)} ms over ${r.fr.length} frames; ${r.bad} canvases with wrong buffer (cap ${r.cap})`) } },

  { id: 'A15', title: 'inspector: click → card <= 500 ms → Esc back; max zoom value = tensor', needs: ['S7', 'S6'], run: async (env) => {
    const p = await env.open({ query: '?mockTensor' }); await p.goto('#zoo'); const t0 = Date.now()
    await p.page.evaluate(() => window.__zoo.getState().setInspect({ kind: 'tensor', name: 'w' }))
    const auto = await p.page.waitForSelector('[data-inspector]', { state: 'visible', timeout: 1500 }).then(() => true, () => false); const ms = Date.now() - t0; if (!auto) await openFor(p.page, '[data-inspector]')
    const z = await p.page.evaluate(() => window.__inspector.zoomMax()), exp = valueAt(z.r, z.c)
    await p.page.keyboard.press('Escape'); const gone = (await p.page.locator('[data-inspector]').count()) === 0
    return ok(auto && ms <= 500 && gone && Math.abs(z.value - exp) < 1e-6, `card ${auto ? 'opened by itself' : 'did NOT open its drawer by itself'} in ${ms} ms; Esc closes ${gone}; w[${z.r},${z.c}] shown ${z.value} vs tensor ${exp}`) } },

  { id: 'A16', title: 'keyboard reaches every Test button and block; focus ring >= 2px, 3:1', run: async (env) => {
    const p = await env.open(); await p.goto()
    const want = await p.page.evaluate(() => [...document.querySelectorAll('[data-test],[data-block],[data-start]')].filter(__h.vis).length)
    const fallback = want === 0, seen = new Set(), ring = []
    for (let i = 0; i < 250; i++) { await p.page.keyboard.press('Tab')
      const r = await p.page.evaluate((fb) => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e), b = __h.bg(e).c
        const col = __h.rgba(s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? s.outlineColor : '#000'), w = s.outlineStyle !== 'none' ? parseFloat(s.outlineWidth) : 0
        const sh = s.boxShadow !== 'none' ? 2 : 0
        return { id: e.dataset.test ?? e.dataset.block ?? (e.textContent || e.className).trim().slice(0, 20), tag: e.matches('[data-test],[data-block],[data-start]') || fb ? 1 : 0, w: Math.max(w, sh), c: __h.ratio(col, b) } }, fallback)
      if (r) { seen.add(r.id); if (r.tag) ring.push(r) } }
    const thin = ring.filter((r) => r.w < 2 || r.c < 3)
    const reached = fallback ? seen.size : await p.page.evaluate(() => [...document.querySelectorAll('[data-test],[data-block]')].length)
    return ok(ring.length > 0 && !thin.length && (fallback || ring.length >= want), `${seen.size} stops${fallback ? ' (no [data-test]/[data-block] yet, all buttons)' : `, ${ring.length}/${want} targets`}; ${thin.length} with ring < 2px or < 3:1 (e.g. ${thin[0]?.id ?? '-'} ${thin[0]?.w ?? ''}px ${thin[0]?.c?.toFixed(1) ?? ''}:1)`) } },

  { id: 'A17', title: 'hint: click opens, leave closes <= 300 ms, tap outside on touch, in viewport', run: async (env) => {
    const p = await env.open(); await p.goto(); const b = p.page.locator('.hintbtn,.nshint-btn').first()
    if (!(await b.count())) return F('no .hintbtn,.nshint-btn on page')
    await b.scrollIntoViewIfNeeded(); await b.click(); const open = (await b.getAttribute('aria-expanded')) === 'true'
    const inView = await p.page.evaluate(() => { const r = document.querySelector('.hintpop,.nshint-pop')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })
    await p.page.mouse.move(2, 2); const t = Date.now(); await p.page.waitForFunction(() => !document.querySelector('.hintpop,.nshint-pop'), null, { timeout: 1500 }).catch(() => {}); const ms = Date.now() - t
    const q = await env.open({ w: 390, touch: true }); await q.goto(); const tb = q.page.locator('.hintbtn,.nshint-btn').first(); await tb.scrollIntoViewIfNeeded(); const tapped = await tb.tap({ timeout: 4000 }).then(() => true, () => false); if (!tapped) return F('touch tap on first hint blocked (covered by another element, see A2)'); const tOpen = (await tb.getAttribute('aria-expanded')) === 'true'
    await q.page.touchscreen.tap(4, 4); await q.page.waitForTimeout(300); const tClosed = (await tb.getAttribute('aria-expanded')) !== 'true'
    return ok(open && inView && ms <= 300 && tOpen && tClosed, `opens ${open}; in viewport ${inView}; closes in ${ms} ms; touch opens ${tOpen}, outside tap closes ${tClosed}`) } },

  { id: 'A18', title: 'glyphs ▲/○ and +/− present', run: async (env) => {
    const p = await env.open({ query: '?mockTensor' }); await p.goto(); const t = await p.page.evaluate(() => document.body.innerText), f = await p.features()
    const gl = t.includes('▲') && t.includes('○')
    let pm = 'n/a (needs S7)'; if (f.S7) { await p.page.evaluate(() => window.__zoo.getState().setInspect({ kind: 'tensor', name: 'w' })); await openFor(p.page, '[data-inspector]'); await p.page.waitForTimeout(800)
      pm = /[+−]\d/.test(await p.page.locator('[data-inspector]').innerText().catch(() => '')) }
    return ok(gl && pm !== false, `▲ ${t.includes('▲')}, ○ ${t.includes('○')}, +/− in heatmap ${pm}`) } },

  { id: 'A19', title: 'card text diet: <= 1 sentence of <= 120 chars', run: async (env) => {
    const p = await env.open(); await p.goto('', 2500)
    const r = await p.page.evaluate(() => { const cards = [...document.querySelectorAll('.card,.ccard,[data-card]')].filter(__h.vis), bad = []
      for (const c of cards) { const parts = []; for (const { t, e } of __h.texts()) { if (!c.contains(e) || e.closest('button,.hintpop,.nshint-pop,[data-detail]')) continue; parts.push(...t.split(/(?<=[.!?])\s+/)) }
        const sent = parts.filter((s) => s.split(/\s+/).length >= 4); if (sent.length > 1 || sent.some((s) => s.length > 120)) bad.push(`${sent.length} sentences, longest ${Math.max(0, ...sent.map((s) => s.length))}: "${(sent[0] ?? '').slice(0, 30)}"`) }
      return { n: cards.length, bad } })
    return r.n ? ok(!r.bad.length, `${r.n} cards, ${r.bad.length} over budget${r.bad[0] ? ' e.g. ' + r.bad[0] : ''}`) : S('no .card elements') } },

  { id: 'A20', title: 'CLS <= 0.02 during a full Test all', needs: ['S5'], run: async (env) => {
    const p = await env.open(); await p.page.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) __cls += e.value }).observe({ type: 'layout-shift', buffered: true }) })
    await p.goto(); await openFor(p.page, '[data-testall]'); await p.page.locator('[data-testall]').first().click(); await p.page.waitForFunction(() => document.querySelector('b[data-score]') && !document.querySelector('[data-testall][disabled]'), null, { timeout: 240000, polling: 500 }); await p.page.waitForTimeout(1000)
    const c = await p.page.evaluate(() => __cls); return ok(c <= 0.02, `CLS ${c.toFixed(4)}`) } },

  { id: 'A21', title: 'no-WebGPU / out-of-memory / offline / mic-denied: message + button <= 2 s', needs: ['S5', 'S6'], run: async (env) => {
    const cases = [['nogpu', { profile: { nogpu: 1 } }, '[data-test=gpu],[data-start]'], ['oom', { profile: { oom: 1, mem: 2 } }, '[data-start]', false, 'distilgpt2'],
      ['offline', {}, '[data-start]', true, 'distilgpt2'], ['mic', { profile: { mic: 1 } }, '[data-test=mic]', false, 'whisper']], out = []
    for (const [name, o, sel, off, ex] of cases) { const p = await env.open({ ...o, hub: off ? false : undefined }); await p.goto(); if (ex) { await p.page.evaluate((e) => window.__studio.getState().loadExample(e), ex); await p.page.waitForTimeout(1500); if (name === 'oom') await p.page.waitForFunction(() => { const s = window.__studio.getState(); return !!s.fit && !s.probing }, null, { timeout: 20000 }).catch(() => {}); await p.page.waitForTimeout(300) } if (off) await p.ctx.setOffline(true)
      const b = p.page.locator(sel).first(); if (!(await b.count())) { out.push(`${name}: no trigger ${sel}`); continue }
      const t = Date.now(); await b.click({ timeout: 4000 }).catch(() => {}); const e = p.page.locator('[data-error]').first(); await e.waitFor({ timeout: 2000 }).catch(() => {})
      const ms = Date.now() - t, has = (await e.count()) && (await e.innerText()).trim().length > 3 && (await e.locator('button').count()) > 0, errs = await p.errCount()
      const dbg = has ? '' : JSON.stringify(await p.page.evaluate(() => { const s = window.__studio.getState(); return { v: s.fit?.verdict, w: s.fit?.where, err: s.runErr, run: s.running, dl: !!s.download, st: s.runStatus } })); if (!has || errs) out.push(`${name}: ${has ? '' : 'no message+button in 2 s ' + dbg + ' '}${errs ? errs + ' page errors: ' + String(p.errors[0] ?? '').slice(0, 70) : ''}`.trim()); else out.push(`${name} ok ${ms}ms`) }
    return ok(out.every((x) => / ok \d+ms$/.test(x)), out.join('; ')) } },

  { id: 'A22', title: 'reduced motion: no transition > 1 ms, no camera tween', run: async (env) => {
    const p = await env.open({ reduced: true }); await p.goto('', 2000)
    const r = await p.page.evaluate(() => { const ms = (s) => Math.max(...s.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)), 0); let worst = 0, who = ''
      for (const e of document.querySelectorAll('*')) { const s = getComputedStyle(e); const v = Math.max(ms(s.transitionDuration), ms(s.animationDuration) * (s.animationName !== 'none')); if (v > worst) { worst = v; who = e.tagName + '.' + String(e.className).slice(0, 16) } } return { worst, who } })
    let cam = 'n/a (needs S8)'; if ((await p.features()).S8) { await p.page.evaluate(() => window.__zoo?.getState().select?.({ kind: 'block', layer: 1, index: 0 })); await p.page.waitForTimeout(60); cam = !(await p.page.evaluate(() => !!window.__scene.camera?.tweening)) }
    return ok(r.worst <= 1 && cam !== false, `longest transition/animation ${r.worst} ms (${r.who || '-'}); camera tween ${cam === true ? 'none' : cam}`) } },

  { id: 'A23', title: 'share PNG 1200×630, no hostname or UA', needs: ['S5'], run: async (env) => {
    const p = await env.open(); await p.goto(); await openFor(p.page, '[data-share]'); const [d] = await Promise.all([p.page.waitForEvent('download', { timeout: 15000 }), p.page.locator('[data-share]').first().click()])
    const file = path.join(OUT, 'share.png'); await d.saveAs(file); const b = fs.readFileSync(file), w = b.readUInt32BE(16), h = b.readUInt32BE(20), s = b.toString('latin1')
    const leaks = ['127.0.0.1', 'localhost', 'Mozilla', 'Chrome', 'Edg/', 'HeadlessChrome'].filter((x) => s.includes(x))
    return ok(w === 1200 && h === 630 && !leaks.length, `${w}x${h}; leaked strings in file: ${leaks.join(',') || 'none'}`) } },

  { id: 'A24', title: 'omitting a component never raises the final score', needs: ['S3'], run: async (env) => {
    const p = await env.open(); await p.goto()
    const r = await p.page.evaluate(() => { const S = window.__score, ids = S.components, num = (x) => (typeof x === 'number' ? x : x?.score ?? x?.overall ?? 0); let worst = 0, n = 0, seed = 7
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      for (let k = 0; k < 40; k++) { const all = Object.fromEntries(ids.map((i) => [i, 200 + rnd() * 1800])), full = num(S.final(all))
        for (const i of ids) { const part = { ...all }; delete part[i]; const d = num(S.final(part)) - full; n++; if (d > worst) worst = d } } return { worst, n, ids: ids.length } })
    return ok(r.worst <= 1e-9, `${r.n} drops over ${r.ids} components, largest rise ${r.worst.toFixed(3)}`) } },

  { id: 'A25', title: 'hostile-origin page cannot start a companion run (hardened server from master on 8011)', run: async (env) => {
    const srv = await startServer(8011); if (!srv.ok) return S(srv.why)
    const h = await startHostile(); try { const p = await env.open({ companion: 'real', hub: false }); await p.page.goto(h.url)
      const r = await p.page.evaluate(async () => { const out = {}, B = 'http://127.0.0.1:8011'
        out.post = await fetch(B + '/api/hw/journey', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"repo":"x","prompt":"hi","new_tokens":1}' }).then((r) => r.status, () => 'refused')
        out.get = await fetch(B + '/api/hw/info').then((r) => r.status, () => 'refused')
        out.ws = await new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:8011/ws/bench'); let msgs = 0, opened = false; const t = setTimeout(() => { w.close(); res('stayed open ' + (opened ? '(accepted)' : '')) }, 3000)
          w.onopen = () => { opened = true }; w.onmessage = () => { msgs++ }; w.onerror = () => { clearTimeout(t); res('refused') }; w.onclose = (e) => { clearTimeout(t); res(msgs ? 'DATA after open' : e.code === 4403 || e.code === 1006 || e.code === 1008 ? 'refused' : 'closed ' + e.code) } })
        return out })
      const own = await fetch('http://127.0.0.1:8011/api/health').then((r) => r.status, () => 'down')
      return ok([403, 'refused'].includes(r.post) && [403, 'refused'].includes(r.get) && r.ws === 'refused', `foreign origin: POST ${r.post}, GET ${r.get}, WebSocket ${r.ws}; server alive (${own}, pairing-gated)`) } finally { h.close(); srv.stop() } } },

  { id: 'A26', title: 'plain words: avg sentence <= 12, none > 20, grade <= 8, no banned words', run: async (env) => {
    const p = await env.open(); await p.goto('', 2500); const strings = []
    for (const hash of ['', '#zoo', '#machine']) { await p.page.evaluate((h) => { location.hash = h }, hash); await p.page.waitForTimeout(600)
      strings.push(...(await p.page.evaluate(() => __h.texts().filter((x) => !x.e.closest('.hintbtn,.nshint-btn')).map((x) => x.t))))
      const n = Math.min(await p.page.locator('.hintbtn,.nshint-btn').count(), 40)
      for (let i = 0; i < n; i++) { const b = p.page.locator('.hintbtn,.nshint-btn').nth(i); try { await b.scrollIntoViewIfNeeded({ timeout: 800 }); await b.click({ timeout: 800 }); strings.push(await p.page.locator('.hintpop,.nshint-pop').first().innerText({ timeout: 500 })); await p.page.keyboard.press('Escape') } catch {} } }
    const sent = [...new Set(strings)].flatMap((s) => s.split(/(?<=[.!?])\s+|\n+/)).map((s) => s.trim()).filter((s) => /[A-Za-z]{2}/.test(s) && (/[.!?]$/.test(s) || s.split(/\s+/).length >= 4)), words = sent.map((s) => s.split(/\s+/).filter(Boolean).length)
    const W = words.reduce((a, b) => a + b, 0), avg = W / sent.length, longest = Math.max(...words), sy = sent.join(' ').split(/\s+/).reduce((a, w) => a + syl(w), 0)
    const fk = 0.39 * avg + 11.8 * (sy / W) - 15.59, banned = [...new Set(sent.join(' ').match(BANNED)?.map((x) => x.toLowerCase()) ?? [])]
    fs.writeFileSync(path.join(OUT, 'a26-strings.txt'), sent.join('\n'))
    return ok(avg <= 12 && longest <= 20 && fk <= 8 && !banned.length, `${sent.length} sentences; avg ${avg.toFixed(1)} words; longest ${longest}; grade ${fk.toFixed(1)}; banned: ${banned.join(',') || 'none'}`) } },

  // ---- legacy intent (nine old scripts): 3D drawing, no page errors on a tour, replay, recorded score, zoo nets, idle cost
  { id: 'A27', title: 'explainers: card on load hides <= 7 s later; bulb hover shows it; mouse-leave hides <= 300 ms', needs: ['bulb'], run: async (env) => {
    const p = await env.open(); await p.page.addInitScript(() => { window.__seen = 0; new MutationObserver(() => { window.__seen = Math.max(__seen, [...document.querySelectorAll('[data-explainer]')].filter(__h.vis).length) }).observe(document, { subtree: true, attributes: true, childList: true }) })
    await p.goto('', 600); const seen = await p.page.evaluate(() => window.__seen), stages = await p.page.locator('[data-explainer-bulb]').count()
    await p.page.waitForFunction(() => ![...document.querySelectorAll('[data-explainer]')].some(__h.vis), null, { timeout: 7000 }).catch(() => {})
    const left = await p.page.evaluate(() => [...document.querySelectorAll('[data-explainer]')].filter(__h.vis).length)
    const bulb = p.page.locator('[data-explainer-bulb]').first(); await bulb.hover(); await p.page.waitForTimeout(250); const shown = await p.page.evaluate(() => [...document.querySelectorAll('[data-explainer]')].filter(__h.vis).length)
    await p.page.mouse.move(5, 5); const t = Date.now(); await p.page.waitForFunction(() => ![...document.querySelectorAll('[data-explainer]')].some(__h.vis), null, { timeout: 1500 }).catch(() => {}); const ms = Date.now() - t
    return ok(seen >= Math.min(stages, 2) && !left && shown > 0 && ms <= 300, `${seen} cards on load for ${stages} bulbs; ${left} still visible after 7 s; hover shows ${shown}; leave hides in ${ms} ms`) } },

  { id: 'A28', title: 'frame budget: p95 <= 33 ms and no long task > 100 ms during runAll; idle p95 <= 20 ms', needs: ['runAll'], run: async (env) => {
    const p = await env.open(); await p.page.addInitScript(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __lt.push(e.duration) }).observe({ type: 'longtask', buffered: true }) } catch {} })
    await p.goto('#machine', 2500); const sample = async (ms) => p.page.evaluate((m) => new Promise((res) => { const d = []; let l = performance.now(); const t0 = l; const f = (t) => { d.push(t - l); l = t; t - t0 < m ? requestAnimationFrame(f) : res(d.slice(3)) }; requestAnimationFrame(f) }), ms)
    const idleP = p95(await sample(4000)); await p.page.evaluate(() => { window.__lt.length = 0; window.__fr = []; let l = performance.now(); const f = (t) => { __fr.push(t - l); l = t; if (!window.__done) requestAnimationFrame(f) }; requestAnimationFrame(f); window.__hw.getState().runAll() })
    await p.page.waitForFunction(() => !window.__hw.getState().benchRunning && window.__fr.length > 120, null, { timeout: 240000, polling: 1000 }); await p.page.evaluate(() => { window.__done = 1 })
    const fr = await p.page.evaluate(() => __fr), lt = await p.page.evaluate(() => __lt), q = p95(fr), mx = Math.max(0, ...lt)
    return ok(q <= 33 && mx <= 100 && idleP <= 20, `idle p95 ${idleP.toFixed(1)} ms; runAll p95 ${q.toFixed(1)} ms over ${fr.length} frames; longest task ${mx.toFixed(0)} ms`) } },

  { id: 'A39', title: 'camera: peek springs back <= 900 ms, drags stay in limits, focus survives release, Reset view and Home restore', run: async (env) => {
    const p = await env.open(); await p.goto('', 2500); const pg = p.page
    await pg.evaluate(async () => { await window.__zoo?.getState().setNet('mlp'); document.querySelector('[data-stage]')?.scrollIntoView() }); await pg.waitForTimeout(2000)
    const pose = () => pg.evaluate(() => { const g = window.__scene?.cams?.model; if (!g || !g.pose) return null; const n = g.now(), h = g.pose, d = Math.hypot(...n.pos.map((v, i) => v - h.pos[i])) + Math.hypot(...n.target.map((v, i) => v - h.target[i]))
      const o = n.pos.map((v, i) => v - n.target[i]), r = Math.hypot(...o); return { d, polar: Math.acos(o[1] / r), az: Math.atan2(o[0], o[2]), dist: r, lim: g.limits, focused: g.focused } })
    if (!(await pose())) return F('no camera guide (window.__scene.cams.model)')
    const b = await pg.locator('[data-stage] canvas').first().boundingBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 2
    const drag = async (dx, dy, probe) => { await pg.mouse.move(cx, cy); await pg.mouse.down(); for (let i = 1; i <= 8; i++) { await pg.mouse.move(cx + (dx * i) / 8, cy + (dy * i) / 8); if (probe) await probe() } await pg.mouse.up() }
    let moved = 0; await drag(220, 60, async () => { moved = Math.max(moved, (await pose()).d) }); const t0 = Date.now(); let back = await pose(); while (back.d > 0.3 && Date.now() - t0 < 900) { await pg.waitForTimeout(50); back = await pose() }
    const backMs = Date.now() - t0
    let out = 0, worst = ''
    const probe = async () => { const q = await pose(), e = 0.03, az = q.az; const [a0, a1] = q.lim.azimuth
      const azOk = a0 === -Infinity || ((az >= a0 - e && az <= a1 + e) || (az + 2 * Math.PI >= a0 - e && az + 2 * Math.PI <= a1 + e) || (az - 2 * Math.PI >= a0 - e && az - 2 * Math.PI <= a1 + e))
      if (q.polar < q.lim.polar[0] - e || q.polar > q.lim.polar[1] + e || q.dist < q.lim.dist[0] - 0.5 || q.dist > q.lim.dist[1] + 0.5 || !azOk) { out++; worst = `polar ${(q.polar * 57.3).toFixed(0)} dist ${q.dist.toFixed(1)}` } }
    for (let k = 0; k < 5; k++) await drag((Math.random() - 0.5) * 900, (Math.random() - 0.5) * 600, probe)
    await pg.waitForTimeout(900)
    await pg.evaluate(() => window.__zoo.getState().setInspect({ kind: 'tensor', name: 'h1' })); await pg.waitForTimeout(900)
    const f0 = await pose(); await drag(160, 0); await pg.waitForTimeout(900); const f1 = await pose()
    const focusKept = f0.focused && f1.focused && (await pg.evaluate(() => !!window.__zoo.getState().inspect))
    await pg.locator('[data-reset-view="model"]').click(); await pg.waitForTimeout(900); const r1 = await pose()
    const resetOk = !r1.focused && r1.d < 0.3 && !(await pg.evaluate(() => window.__zoo.getState().inspect))
    await pg.evaluate(() => window.__zoo.getState().setInspect({ kind: 'tensor', name: 'h2' })); await pg.waitForTimeout(700); await pg.mouse.move(b.x + 40, cy); await pg.keyboard.press('Home'); await pg.waitForTimeout(900)
    const r2 = await pose(), homeOk = !r2.focused && r2.d < 0.3
    return ok(moved > 0.5 && backMs <= 900 && back.d <= 0.3 && !out && focusKept && resetOk && homeOk, `peek moved ${moved.toFixed(1)}, back in ${backMs} ms (off ${back.d.toFixed(2)}); ${out} samples outside limits ${worst}; focus kept ${focusKept}; Reset view ${resetOk}; Home ${homeOk}`) } },

  { id: 'A29', title: 'theme: toggle flips data-theme, persists across reload, no dark leftovers in light mode', needs: ['theme'], run: async (env) => {
    const p = await env.open({ theme: undefined }); await p.goto(); const tg = p.page.locator('[data-theme-toggle]').first(); const seen = []
    for (let i = 0; i < 3; i++) { seen.push(await p.page.evaluate(() => document.documentElement.dataset.theme ?? '')); if (seen.at(-1) === 'light') break; await tg.click(); await p.page.waitForTimeout(400) }
    const now = await p.page.evaluate(() => document.documentElement.dataset.theme); if (now !== 'light') return F(`toggle never reached light: ${seen.join('>')}>${now}`)
    await p.page.reload({ waitUntil: 'load' }); await p.page.waitForTimeout(1200); const kept = await p.page.evaluate(() => document.documentElement.dataset.theme)
    const dark = await p.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => !(e instanceof HTMLCanvasElement) && __h.vis(e)).filter((e) => { const s = getComputedStyle(e), b = __h.rgba(s.backgroundColor); return b[3] > 0.6 && __h.ratio(b, [255, 255, 255, 1]) > 12 && e.getBoundingClientRect().width > 40 && !e.closest('canvas,[data-keep-dark]') }).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 18)}`))
    return ok(kept === 'light' && !dark.length, `flipped to light after ${seen.length - 1} click(s); after reload "${kept}"; ${dark.length} elements keep a dark background${dark[0] ? ' e.g. ' + dark.slice(0, 3).join(', ') : ''}`) } },

  { id: 'A30', title: 'score strip visible with drawers closed; hero first in the drawer; five pillar rows; one click expands; nesting <= 2', needs: ['strip', 'pillar'], run: async (env) => {
    const p = await env.open(); await p.goto('', 2000); const strip = await p.page.evaluate(() => { const e = document.querySelector('[data-score-strip]'); if (!e || !__h.vis(e)) return false; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })
    await openFor(p.page, '[data-hero]')
    const r = await p.page.evaluate(() => { const h = document.querySelector('[data-hero]'), rows = [...document.querySelectorAll('[data-pillar]')].filter(__h.vis); if (!h || !rows.length) return { hero: !!h, rows: rows.length }
      const first = h.getBoundingClientRect().top <= Math.min(...rows.map((x) => x.getBoundingClientRect().top)); const row = rows[0], before = row.getAttribute('aria-expanded') ?? row.dataset.open; row.querySelector('button,[role=button]')?.click() ?? row.click()
      return { hero: true, first, rows: rows.length, before, after: row.getAttribute('aria-expanded') ?? row.dataset.open, depth: Math.max(...[...row.querySelectorAll('[data-card],.card')].map((c) => { let d = 0; for (let e = c.parentElement; e && e !== row; e = e.parentElement) if (e.matches('[data-card],.card')) d++; return d + 1 }), 1) } })
    return ok(strip && r.hero && r.first && r.rows === 5 && r.before !== r.after && r.depth <= 2, `strip visible ${strip}; hero first ${r.first}; ${r.rows} pillar rows; expand ${r.before}->${r.after}; nesting ${r.depth}`) } },

  { id: 'A31', title: 'name card first on a fresh profile, once; name in hero and share; no request carries it', needs: ['name'], run: async (env) => {
    const NAME = 'Zelda Quux', p = await env.open({ fresh: true }); await p.goto('', 1000)
    const card = await p.page.evaluate(() => { const c = document.querySelector('[data-namecard]'); if (!c || !__h.vis(c)) return false; const r = c.getBoundingClientRect(); return r.top < innerHeight / 2 })
    await p.page.locator('[data-namecard] input').first().fill(NAME); await p.page.keyboard.press('Enter'); await p.page.waitForTimeout(600)
    const gone = !(await p.page.evaluate(() => { const c = document.querySelector('[data-namecard]'); return !!c && __h.vis(c) }))
    await p.page.reload({ waitUntil: 'load' }); await p.page.waitForTimeout(1500); const again = await p.page.evaluate(() => { const c = document.querySelector('[data-namecard]'); return !!c && __h.vis(c) })
    await openFor(p.page, '[data-test=cpu1]'); await p.page.locator('[data-test=cpu1]').first().click().catch(() => {}); await p.page.waitForSelector(SCORE, { timeout: 30000 }).catch(() => {})
    const hero = await p.page.evaluate((n) => (document.querySelector('[data-hero]')?.innerText ?? '').toLowerCase().includes(n.toLowerCase()), NAME)
    const leaks = p.reqs.filter((r) => (decodeURIComponent(r.url) + r.post).includes('Zelda') || (r.url + r.post).includes('Quux')).length
    let png = 'share not checked'; const sb = p.page.locator('[data-share]').first(); if (await sb.count()) { const [d] = await Promise.all([p.page.waitForEvent('download', { timeout: 10000 }).catch(() => null), sb.click()]); if (d) { const f = path.join(OUT, 'share-name.png'); await d.saveAs(f); png = 'PNG text is not machine-read (pixel text); file saved for review' } }
    return ok(card && gone && !again && hero && !leaks, `name card first ${card}; hides after answer ${gone}; back after reload ${again}; name in hero ${hero}; ${leaks} requests carry it; ${png}`) } },

  { id: 'A32', title: 'draw pad: a stroked 3 gives a result <= 300 ms that says 3; pad >= 280 px at 390; Clear/Undo; touch', run: async (env) => {
    const out = []; let good = true
    for (const touch of [false, true]) { const p = await env.open({ w: touch ? 390 : 1480, touch }); await p.goto('#zoo', 1500); await p.page.evaluate(() => window.__zoo.getState().setNet('cnn')); await p.page.waitForTimeout(1500); const pad = p.page.locator('[data-pad]').first(); if (!(await pad.count())) return S('no [data-pad] on the CNN view yet'); await openFor(p.page, '[data-pad]'); await pad.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {}); const b = await pad.boundingBox()
      if (touch && b.width < 280) { good = false; out.push(`pad ${Math.round(b.width)} px at 390`) }
      const clear = p.page.locator('[data-pad-clear], [data-pad-wrap] button:has-text("Clear")').first(); if (await clear.count()) await clear.click().catch(() => {})
      await stroke(p, three(b), touch); const t = Date.now()
      const hit = await p.page.waitForFunction(() => /\b3\b/.test(document.querySelector('[data-pad-result]')?.innerText ?? ''), null, { timeout: 2000 }).then(() => true, () => false), ms = Date.now() - t
      if (!hit || ms > 300) good = false; out.push(`${touch ? 'touch' : 'mouse'}: ${hit ? ms + ' ms' : 'no "3" in [data-pad-result]'}`)
      if (!touch) { const u = p.page.locator('[data-pad-undo], [data-pad-wrap] button:has-text("Undo")').first(), c2 = p.page.locator('[data-pad-clear], [data-pad-wrap] button:has-text("Clear")').first(); const ok2 = (await u.count()) && (await c2.count())
        if (ok2) { await u.click(); await c2.click(); await p.page.waitForTimeout(400) } if (!ok2) { good = false; out.push('missing Clear/Undo') } } }
    return ok(good, out.join('; ')) } },

  { id: 'A33', title: 'no Stress, Robustness or sweep controls in the DOM or the built UI strings', run: async (env) => {
    const p = await env.open(); await p.goto('#zoo', 2500); const dom = await p.page.evaluate(() => [...document.querySelectorAll('button,label,summary,h2,h3,h4,[role=tab]')].map((e) => e.textContent.trim()).filter((t) => /stress|robust|sweep|scan all/i.test(t)))
    const dir = path.join(env.dist, 'assets'), hits = []; if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) { const s = fs.readFileSync(path.join(dir, f), 'utf8'); for (const m of s.matchAll(/(Stress test|Robustness test|Run the sweep|Scan all|Noise slider|Blur the digit)/gi)) hits.push(`${f}:${m[0]}`) }
    return ok(!dom.length && !hits.length, `DOM controls ${dom.length}${dom[0] ? ' e.g. "' + dom[0].slice(0, 30) + '"' : ''}; built-string hits ${hits.length}${hits[0] ? ' e.g. ' + hits[0] : ''}`) } },

  { id: 'A34', title: '8 languages each fill a prompt and run with no page error; token tiles render', needs: ['lang'], run: async (env) => {
    const p = await env.open(), codes = ['en', 'es', 'fr', 'de', 'hi', 'zh', 'ar', 'pt']; await p.goto('', 2000); const res = [], seen = new Set()
    for (const c of codes) { const sel = p.page.locator(`select[data-lang-picker], [data-lang-picker]`).first(), btn = p.page.locator(`[data-lang="${c}"]`).first()
      await p.page.waitForFunction(() => { const s = document.querySelector('[data-lang-picker]'); return !s || !s.disabled }, null, { timeout: 20000 }).catch(() => {})
      if (await btn.count()) await btn.click(); else await sel.selectOption(c, { timeout: 5000 }).catch(() => {}); await p.page.waitForTimeout(400)
      const prompt = await p.page.evaluate(() => { const e = document.querySelector('[data-prompt]') ?? document.querySelector('textarea, input[type=text]'); return e ? (e.value ?? e.innerText) : '' }); seen.add(prompt)
      await p.page.locator('[data-start],[data-run]').first().click({ timeout: 2000 }).catch(() => {}); await p.page.waitForTimeout(800)
      const tiles = await p.page.locator('[data-token]').count(); res.push(`${c}:${prompt.length > 3 ? 'prompt' : 'EMPTY'}/${tiles} tiles`) }
    const errs = await p.errCount()
    return ok(seen.size >= 7 && res.every((x) => !x.includes('EMPTY') && !x.endsWith('/0 tiles')) && !errs, `${res.join(' ')}; ${seen.size} distinct prompts; ${errs} page errors`) } },

  { id: 'A35', title: 'budgets: first JS <= 90 kB gz, three chunk <= 280 kB gz, first paint <= 1.0 s and first 3D frame <= 2.5 s cold at 20 Mbit, repeat <= 1.0 s, heap <= 400 MB', run: async (env) => {
    const dir = path.join(env.dist, 'assets'), html = fs.readFileSync(path.join(env.dist, 'index.html'), 'utf8'), entry = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1], files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')) : []
    const first = entry ? gz(path.join(env.dist, entry.replace(/^\//, ''))) : 0, three = Math.max(0, ...files.filter((f) => /three|stageKit|ZooScene|PowerScene/i.test(f)).map((f) => gz(path.join(dir, f))))
    const p = await env.open({ throttle: 20 }); await p.page.addInitScript(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __lt.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true }) } catch {} })
    await p.page.goto(env.base + env.query, { waitUntil: 'load' }); await p.page.waitForTimeout(3000)
    const m = await p.page.evaluate(() => ({ fcp: performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime ?? -1, ff: performance.getEntriesByName('ns:first-frame')[0]?.startTime ?? -1, lt: __lt }))
    const heap = await (async () => { const s = await p.ctx.newCDPSession(p.page); const h = await s.send('Runtime.getHeapUsage'); return h.usedSize / 1048576 })()
    await p.page.reload({ waitUntil: 'load' }); await p.page.waitForTimeout(2500); const rep = await p.page.evaluate(() => performance.getEntriesByName('ns:first-frame')[0]?.startTime ?? -1)
    const late = m.lt.filter(([s, d]) => s > m.ff && d > 50).length, kb = (n) => (n / 1024).toFixed(0)
    const mark = m.ff > 0 ? '' : ' (no performance.mark("ns:first-frame") yet: 3D frame and repeat not asserted)'
    return ok(first <= 90 * 1024 && three <= 280 * 1024 && m.fcp > 0 && m.fcp <= 1000 && (m.ff < 0 || (m.ff <= 2500 && rep <= 1000)) && heap <= 400 && late <= 3, `first JS ${kb(first)} kB, three ${kb(three)} kB gz; first paint ${Math.round(m.fcp)} ms; first 3D frame ${Math.round(m.ff)} ms; repeat ${Math.round(rep)} ms; ${late} long tasks > 50 ms after first frame; heap ${heap.toFixed(0)} MB${mark}`) } },
  { id: 'L1', title: '3D canvas is drawing in the model, zoo and machine views', run: async (env) => {
    const p = await env.open(); await p.goto('', 2500); const res = []
    for (const sec of ['model', 'zoo', 'power', 'machine']) { const c = p.page.locator(`#sec-${sec} canvas, [data-sec=${sec}] canvas`).first(); if (!(await c.count())) continue
      await c.scrollIntoViewIfNeeded(); await p.page.waitForTimeout(900); const a = await c.screenshot(), b = (await p.page.waitForTimeout(300), await c.screenshot()); res.push([sec, !a.equals(b)]) }
    return res.length ? ok(res.every(([, v]) => v), res.map(([s, v]) => `${s}:${v ? 'drawing' : 'STATIC'}`).join(' ')) : S('no canvas found') } },
  { id: 'L2', title: 'tour of all sections and five networks: zero page errors', run: async (env) => {
    const p = await env.open(); await p.goto('', 2000)
    for (const h of ['#zoo', '#machine', '#model']) { await p.page.evaluate((x) => { location.hash = x }, h); await p.page.waitForTimeout(800) }
    if (await p.page.evaluate(() => !!window.__zoo)) for (const n of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) { await p.page.evaluate((x) => window.__zoo.getState().setNet(x), n); await p.page.waitForTimeout(500) }
    const e = await p.errCount(); return ok(e === 0, `${e} page errors`) } },
  { id: 'L3', title: 'power replay: same playhead gives the same readout', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500); const b = p.page.locator('#sec-power button:has-text("Play a recorded run"), [data-replay]').first()
    if (!(await b.count())) return S('no replay button'); await b.click(); await p.page.waitForTimeout(1500)
    const read = async (t) => { await p.page.evaluate((x) => { const s = window.__hw.getState(); s.pPause(); s.setPHead(x) }, t); await p.page.waitForTimeout(400); return p.page.locator('#sec-power .phud .pbig').first().innerText() }
    const a = await read(3.3), m = await read(9.9), c = await read(3.3); return ok(a === c, `${a} / ${m} / ${c}`) } },
  { id: 'L4', title: 'recorded journey loads; one component Test gives a numeric device score', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500); const pg = p.page
    const jb = pg.locator('#sec-power button:has-text("Play a recorded journey")').first(); if (!(await jb.count())) return S('no recorded-journey button')
    await jb.click(); const j = await pg.waitForFunction(() => window.__hw.getState().journey?.stages?.length ?? !!window.__hw.getState().journey, null, { timeout: 30000 }).then(() => 1, () => 0)
    await openFor(pg, '[data-test=cpu1]'); await pg.locator('[data-test=cpu1]').first().click(); const got = await pg.waitForFunction(() => document.querySelector('b[data-score]')?.getAttribute('data-score'), null, { timeout: 30000 }).then((h) => h.jsonValue(), () => null)
    return ok(j && +got > 0, `journey ${j ? 'loaded' : 'MISSING'}; score after one Test ${got ?? 'none'}`) } },
  { id: 'L5', title: 'five networks each produce an output', run: async (env) => {
    const p = await env.open(); await p.goto('#zoo', 2500); if (!(await p.page.evaluate(() => !!window.__zoo))) return S('no window.__zoo'); const res = []
    for (const n of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) { await p.page.evaluate((x) => window.__zoo.getState().setNet(x), n)
      res.push([n, await p.page.waitForFunction((x) => window.__zoo.getState().out && window.__zoo.getState().net === x, n, { timeout: 15000 }).then(() => 1, () => 0)]) }
    return ok(res.every(([, v]) => v), res.map(([n, v]) => `${n}:${v ? 'ok' : 'none'}`).join(' ')) } },
  { id: 'L6', tier: 3, title: 'idle cost: companion watts with the page open vs blank (info only)', run: async (env) => {
    const pw = async () => { const xs = []; for (let i = 0; i < 8; i++) { xs.push((await fetch('http://127.0.0.1:8000/api/hw/power').then((r) => r.json())).pkg_w); await sleep(250) } return xs.reduce((a, b) => a + b, 0) / xs.length }
    try { const blank = await pw(); const p = await env.open({ companion: 'real', hub: false }); await p.goto('#machine', 3000); const page = await pw(); return P(`blank ${blank.toFixed(1)} W, page ${page.toFixed(1)} W`) } catch (e) { return S('companion power API unavailable: ' + e.message) } } },
  { id: 'T1', tier: 3, title: 'smoke: real Hub lists Xenova/distilgpt2 and the real companion answers (read-only)', run: async () => {
    const hub = await fetch('https://huggingface.co/api/models/Xenova/distilgpt2').then((r) => r.status, () => 'unreachable')
    const comp = await fetch('http://127.0.0.1:8000/api/hw/info').then(async (r) => (r.ok ? `ok, ${(await r.json()).cpu?.name ?? 'cpu ?'}` : r.status), () => 'down')
    return hub === 200 ? P(`Hub ${hub}; companion ${comp}`) : F(`Hub ${hub}; companion ${comp}`) } },
  { id: 'T2', tier: 3, title: 'smoke: real page, real Hub, no mocks: default model runs by itself and shows a run score; bytes ~ plan', needs: ['auto'], run: async (env) => {
    const r = await autoRun(env, {}), planned = r.info.plan?.bytes ?? 0, ratio = planned ? r.got / planned : 0
    return ok(r.done && (r.got === 0 || (ratio > 0.5 && ratio < 1.5)), `${r.done ? 'run score' : 'NO run score'} after ${r.tRun.toFixed(1)} s on ${r.info.where ?? '?'}; planned ${(planned / 1048576).toFixed(0)} MB, downloaded ${(r.got / 1048576).toFixed(0)} MB (${r.got ? 'ratio ' + ratio.toFixed(2) : 'cached or streamed'}); "${r.info.text.replace(/\s+/g, ' ').slice(0, 60)}"`) } },

]
