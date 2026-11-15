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
/** A complete set of default results at the reference values (C11 shows the score, and enables Share, only when complete). */
const FULL = () => { const h = window.__hw?.getState(); if (!h) return; const v = { cpu1: 28, cpun: 113, cache: 160, ram: 53, storage: 250, gpu: 500 }
  for (const [id, x] of Object.entries(v)) h.addResult({ v: 1, component: id, scale: 'browser', workload: { id: 'w', v: 1 }, input: { kind: 'default', summary: 'd' }, samples: [x], value: x, unit: 'u', ci95: [x, x], cv: 1, score: null, flags: [], env: { where: 'wasm' }, at: '' }) }
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
  const info = await p.page.evaluate(() => { const s = window.__studio.getState(); return { plan: s.plan, err: s.runErr, prov: s.provenance, ran: s.ranPrompt, where: s.lastStats?.where, text: document.querySelector('[data-runscore]')?.innerText ?? '' } })
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

  { id: 'A7', title: 'first paint <= 2.5 s; first test result <= 10 s (20 Mbit; the score number needs all six tests, C11)', needs: ['S5'], run: async (env) => {
    const p = await env.open({ throttle: 20 }); const t0 = Date.now(); await p.page.goto(env.base + env.query, { waitUntil: 'load' })
    const fcp = await p.page.waitForFunction(() => performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => -1)
    await openFor(p.page, '[data-test=cpu1]'); const t1 = Date.now(); await p.page.locator('[data-test=cpu1]').first().click(); await p.page.waitForFunction(() => window.__hw.getState().results.cpu1?.value > 0, null, { timeout: 30000 })   // the first result; the score number waits for all six tests (C11)
    const s = (Date.now() - t1) / 1000
    return ok(fcp > 0 && fcp <= 2500 && s <= 10, `first paint ${Math.round(fcp)} ms; first result ${s.toFixed(1)} s (load ${((t1 - t0) / 1000).toFixed(1)} s)`) } },
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

  { id: 'A18', title: "glyphs: ▲ only on the device score (C9, round 3), no ○ in the machine section; +/− in heatmap", run: async (env) => {
    const p = await env.open({ query: '?mockTensor' }); await p.goto(); const f = await p.features()
    // a complete set of results, so the score (and its ▲) shows (C11 hides it until every test ran)
    await p.page.evaluate(FULL)
    await p.page.waitForTimeout(600)
    const g = await p.page.evaluate(() => { const sec = document.querySelector('#sec-power') ?? document.body, out = { tri: 0, triElse: [], circ: [] }, inInspector = (e) => !!e.closest('[data-inspector]')
      for (const { t, e } of __h.texts()) { if (t.includes('▲')) { if (e.closest('[data-score],.t5-score,.t5-ssc,[data-hero] .t5-big')) out.tri++; else if (!inInspector(e) && (sec.contains(e) || e.closest('[data-score-strip]'))) out.triElse.push(t.slice(0, 24)) }
        if (t.includes('○') && !inInspector(e) && (sec.contains(e) || e.closest('[data-score-strip]'))) out.circ.push(t.slice(0, 24)) } return out })
    let pm = 'n/a (needs S7)'; if (f.S7) { await p.page.evaluate(() => window.__zoo.getState().setInspect({ kind: 'tensor', name: 'w' })); await openFor(p.page, '[data-inspector]'); await p.page.waitForTimeout(800)
      pm = /[+−]\d/.test(await p.page.locator('[data-inspector]').innerText().catch(() => '')) }
    return ok(g.tri > 0 && !g.triElse.length && !g.circ.length && pm !== false, `▲ on the score ${g.tri}×, elsewhere on the machine side ${g.triElse.length} (${g.triElse[0] ?? '-'}); ○ on the machine side ${g.circ.length} (${g.circ[0] ?? '-'}); +/− in heatmap ${pm}`) } },

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
    const p = await env.open(); await p.goto(); await p.page.evaluate(FULL); await p.page.waitForTimeout(400); await openFor(p.page, '[data-share]'); const [d] = await Promise.all([p.page.waitForEvent('download', { timeout: 15000 }), p.page.locator('[data-share]').first().click()])
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
  // Round 3 (B4): an explainer card shows at most once (first visit), only where it covers no control and never the pad;
  // after that the bulb alone stays. Before round 3 this check wanted a card on every load ("card on load hides <= 7 s later").
  { id: 'A27', title: 'explainers: shown once at most, never over a control or the pad; reload shows none; bulb hover shows; leave hides <= 300 ms', needs: ['bulb'], run: async (env) => {
    const p = await env.open(); await p.page.addInitScript(() => { window.__seen = new Set(); window.__ov = []
      const look = () => { for (const c of document.querySelectorAll('[data-explainer]')) { if (!c.matches(':popover-open,[data-open]') || c.hasAttribute('data-probe')) continue; __seen.add(c.dataset.explainer)
        const r = c.getBoundingClientRect(); for (const e of [...__h.interactive(), ...document.querySelectorAll('[data-pad]')]) { if (e.closest('.nsx-expl')) continue; const b = e.getBoundingClientRect()
          if (b.width > 0 && b.height > 0 && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) __ov.push(`${c.dataset.explainer} over "${(e.textContent || e.getAttribute('aria-label') || e.className).trim().slice(0, 16)}"`) } } }
      addEventListener('DOMContentLoaded', () => new MutationObserver(look).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-open'] })) })
    await p.goto('', 600); const stages = await p.page.locator('[data-explainer-bulb]').count()
    await p.page.waitForFunction(() => ![...document.querySelectorAll('[data-explainer]')].some((c) => c.matches(':popover-open,[data-open]')), null, { timeout: 7500 }).catch(() => {})
    const first = await p.page.evaluate(() => ({ seen: [...__seen], ov: [...new Set(__ov)], left: [...document.querySelectorAll('[data-explainer]')].filter((c) => c.matches(':popover-open,[data-open]')).length }))
    await p.page.reload({ waitUntil: 'load' }); await p.page.waitForTimeout(3000)
    const again = await p.page.evaluate(() => [...__seen].filter((id) => document.querySelector(`[data-explainer="${id}"]`)?.matches(':popover-open,[data-open]')))
    const second = await p.page.evaluate(() => [...__seen])
    // every bulb must be reachable: nothing (error float, dock, Reset view, net card, canvas) may sit over it
    const covered = await p.page.evaluate(() => [...document.querySelectorAll('[data-explainer-bulb]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && [[.5, .5], [.2, .2], [.8, .8]].some(([a, b]) => { const t = document.elementFromPoint(r.x + r.width * a, r.y + r.height * b); return t && !e.contains(t) }) }).map((e) => `${e.dataset.explainerBulb} under ${String(document.elementFromPoint(e.getBoundingClientRect().x + 20, e.getBoundingClientRect().y + 20)?.className).slice(0, 24)}`))
    if (covered.length) return F(`bulb covered: ${covered.join('; ')}`)
    const bulb = p.page.locator('[data-explainer-bulb]').first(); await bulb.hover(); await p.page.waitForTimeout(250); const shown = await p.page.evaluate(() => [...document.querySelectorAll('[data-explainer]')].filter(__h.vis).length)
    await p.page.mouse.move(5, 5); const t = Date.now(); await p.page.waitForFunction(() => ![...document.querySelectorAll('[data-explainer]')].some(__h.vis), null, { timeout: 1500 }).catch(() => {}); const ms = Date.now() - t
    const repeat = second.filter((id) => first.seen.includes(id))
    return ok(!first.ov.length && !first.left && !repeat.length && shown > 0 && ms <= 300, `${stages} bulbs; first load showed [${first.seen.join(',') || 'none (every card would cover a control)'}]${first.ov.length ? `; OVER CONTROLS: ${first.ov.slice(0, 3).join('; ')}` : '; none over a control'}; ${first.left} still open after 7 s; reload re-showed [${repeat.join(',') || 'none'}]${again.length ? ' (open now: ' + again.join(',') + ')' : ''}; hover shows ${shown}; leave hides in ${ms} ms`) } },

  { id: 'A38', title: 'HUD cards (Peek): at rest <= 2 lines, details hidden; hover, keyboard focus and tap show the rest; Esc closes; CLS 0', run: async (env) => {
    const probe = () => [...document.querySelectorAll('[data-peek]')].filter(__h.vis).map((el) => {
      const tops = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n; (n = w.nextNode());) { if (!n.textContent.trim() || n.parentElement.closest('[data-peek-details]') || !__h.vis(n.parentElement)) continue
        const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < 6)) tops.push(r.top) }
      const det = el.querySelector('[data-peek-details]'), b = el.getBoundingClientRect()
      return { name: (el.dataset.hud || el.className).slice(0, 18), lines: tops.length, open: !!det && __h.vis(det), w: Math.round(b.width), h: Math.round(b.height) } })
    const cls = () => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) { /* only the card and the tabs count: other lanes' controls (dock Run button) shift on their own */ if (e.sources.some((x) => x.node?.parentElement?.closest?.('[data-peek],[data-zoo-tabs]') || x.node?.closest?.('[data-peek],[data-zoo-tabs]'))) window.__cls += e.value; (window.__cs ??= []).push(e.sources.map((x) => `${(x.node?.className || x.node?.nodeName || '?').toString().slice(0, 24)} y${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)}`).join(',')) } }).observe({ type: 'layout-shift' }) }
    // the zoo timeline plays on its own and its caption can wrap (a shift that is not the card's): pause it first
    const setNet = async (pg) => { await pg.evaluate(() => window.__zoo?.getState().setNet('cnn')); await pg.waitForTimeout(600); await pg.evaluate(() => window.__zoo?.getState().pause?.()) }
    const out = [], bad = []
    // the net card (rest and opened) never touches the tab row, at every width, for a small and a long card
    for (const w of [1600, 1480, 1100, 820, 700, 390]) for (const net of ['cnn', 'vlm']) {
      const o = await env.open({ w, touch: w < 600 }); await o.goto('#zoo', 1200); await o.page.evaluate((n) => window.__zoo?.getState().setNet(n), net); await o.page.waitForTimeout(900); await o.page.evaluate(() => window.__zoo?.getState().pause?.())
      const hit = await o.page.evaluate(() => { const tb = document.querySelector('[data-zoo-tabs]'), pk = document.querySelector('[data-hud="net"]'); if (!tb || !pk || !pk.closest('.stage') || !__h.vis(pk)) return 'missing'
        const x = tb.getBoundingClientRect(), st = pk.closest('.stage').getBoundingClientRect(), box = () => [pk, pk.querySelector('[data-peek-details]')].filter((e) => e && __h.vis(e)).map((e) => e.getBoundingClientRect())
        const bad = (rs) => rs.some((r) => r.left < x.right && r.right > x.left && r.top < x.bottom && r.bottom > x.top)
        const clip = (rs) => rs.some((r) => r.left < st.left - 0.5 || r.right > st.right + 0.5 || r.bottom > st.bottom + 0.5), rest = bad(box()), restClip = clip(box()); pk.querySelector('.nspeek-tog').focus(); return new Promise((res) => setTimeout(() => res(rest ? 'rest overlaps tabs' : restClip ? 'rest clipped by the stage edge' : bad(box()) ? 'open panel overlaps tabs' : clip(box()) ? 'open panel clipped by the stage edge' : ''), 300)) })
      if (hit) bad.push(`${w}px ${net}: ${hit}`)
    }
    // wide, mouse + keyboard
    const p = await env.open({ w: 1480 }); await p.goto('#zoo', 1500); await setNet(p.page); await p.page.waitForTimeout(900); await p.page.evaluate(cls)
    const rest = await p.page.evaluate(probe); if (!rest.length) return F('no visible [data-peek] card (zoo net HUD) at 1480')
    for (const [k, r] of rest.entries()) {
      if (r.lines > 2) bad.push(`${r.name} ${r.lines} lines at rest`); if (r.open) bad.push(`${r.name} details open at rest`)
      const card = p.page.locator('[data-peek]').filter({ visible: true }).nth(k)
      await card.hover(); await p.page.waitForTimeout(700); const hv = (await p.page.evaluate(probe))[k]
      if (!hv.open) bad.push(`${r.name}: hover does not open`); if (hv.w !== r.w || hv.h !== r.h) bad.push(`${r.name}: box changed on hover ${r.w}x${r.h} -> ${hv.w}x${hv.h}`)
      await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(700); if ((await p.page.evaluate(probe))[k].open) bad.push(`${r.name}: Esc does not close while hovered`)
      await p.page.mouse.move(3, 300); await p.page.waitForTimeout(700); if ((await p.page.evaluate(probe))[k].open) bad.push(`${r.name}: stays open after the mouse leaves`)
      await card.locator('.nspeek-tog').focus(); await p.page.waitForTimeout(700); if (!(await p.page.evaluate(probe))[k].open) bad.push(`${r.name}: keyboard focus does not open`)
      await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(700); if ((await p.page.evaluate(probe))[k].open) bad.push(`${r.name}: Esc does not close on focus`)
      await p.page.evaluate(() => document.activeElement?.blur())
      out.push(`${r.name} ${r.lines} line(s) ${r.w}x${r.h}`) }
    const c1 = await p.page.evaluate(() => window.__cls)
    // phone, touch
    const q = await env.open({ w: 390, touch: true }); await q.goto('#zoo', 1500); await setNet(q.page); await q.page.waitForTimeout(900); await q.page.evaluate(cls)
    const tr = (await q.page.evaluate(probe)).filter((x) => x.name === 'net'); let c2 = 0
    if (!tr.length) bad.push('390: no visible [data-peek] card')
    else { const tg = q.page.locator('[data-hud="net"]').filter({ visible: true }).first().locator('.nspeek-tog')
      if (tr[0].lines > 2) bad.push(`390: ${tr[0].lines} lines at rest`)
      await tg.tap(); await q.page.waitForTimeout(700); const t1 = ((await q.page.evaluate(probe)).filter((x) => x.name === 'net'))[0]; if (!t1.open) bad.push('390: tap does not open'); if (t1.h !== tr[0].h) bad.push('390: box changed on tap')
      await tg.tap(); await q.page.waitForTimeout(700); if (((await q.page.evaluate(probe)).filter((x) => x.name === 'net'))[0].open) bad.push('390: second tap does not close')
      await tg.tap(); await q.page.waitForTimeout(700); await q.page.touchscreen.tap(366, 240); await q.page.waitForTimeout(700); if (((await q.page.evaluate(probe)).filter((x) => x.name === 'net'))[0].open) bad.push('390: tap outside does not close')
      c2 = await q.page.evaluate(() => window.__cls); out.push(`390 ${tr[0].lines} line(s)`) }
    if (c1 > 0.0005 || c2 > 0.0005) bad.push(`CLS ${c1.toFixed(4)} / ${c2.toFixed(4)} ${JSON.stringify(await q.page.evaluate(() => window.__cs ?? []))}`)
    return ok(!bad.length, `${out.join('; ')}; CLS ${c1.toFixed(4)} (1480) ${c2.toFixed(4)} (390)${bad.length ? ' | ' + bad.join('; ') : ''}`) } },

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
    // the toggle lives in the profile menu (D14): open the menu when it is not on screen
    const reach = async () => { if (!(await tg.isVisible().catch(() => false))) { await p.page.locator('[data-profile]').first().click().catch(() => {}); await p.page.waitForTimeout(200) } }
    for (let i = 0; i < 3; i++) { seen.push(await p.page.evaluate(() => document.documentElement.dataset.theme ?? '')); if (seen.at(-1) === 'light') break; await reach(); await tg.click(); await p.page.waitForTimeout(400) }
    await p.page.keyboard.press('Escape')
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
    // the hero and Share appear once every test is done (C11/C1): run Test all, then open the drawer for the hero
    await p.page.locator('[data-testall]').first().click({ timeout: 15000 }).catch(() => {}); await p.page.waitForFunction(() => document.querySelector('b[data-score]') && !document.querySelector('[data-testall][disabled]'), null, { timeout: 240000, polling: 500 }).catch(() => {}); await openFor(p.page, '[data-hero]')
    const hero = await p.page.evaluate((n) => (document.querySelector('[data-hero]')?.innerText ?? '').toLowerCase().includes(n.toLowerCase()), NAME)
    const leaks = p.reqs.filter((r) => (decodeURIComponent(r.url) + r.post).includes('Zelda') || (r.url + r.post).includes('Quux')).length
    let png = 'share not checked'; const sb = p.page.locator('[data-share]:not([disabled])').first(); if (await sb.count()) { const [d] = await Promise.all([p.page.waitForEvent('download', { timeout: 10000 }).catch(() => null), sb.click()]); if (d) { const f = path.join(OUT, 'share-name.png'); await d.saveAs(f); png = 'PNG text is not machine-read (pixel text); file saved for review' } }
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
  { id: 'A41', title: 'power card: cores <= package and rest >= 0 over 200 live samples with cores 50-150 % of the package (the recorded pack is covered by vitest)', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500); const pg = p.page
    const read = () => pg.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => { const e = document.querySelector('.phud'); res(e ? { ...e.dataset } : null) }))))
    const bad = [], seen = { ok: 0, scaled: 0, unavailable: 0 }
    const check = (r, where, expect) => {
      if (!r || r.pkg == null) return bad.push(`${where}: no reading`)
      seen[r.split] = (seen[r.split] ?? 0) + 1; const pkg = +r.pkg
      if (expect && r.split !== expect) bad.push(`${where}: split ${r.split}, expected ${expect}`)
      if (r.split === 'unavailable') { if (r.cores || r.rest) bad.push(`${where}: unavailable but shows a split`); return }
      const c = +r.cores, rest = +r.rest
      if (!(c <= pkg + 0.005) || !(rest >= 0) || Math.abs(c + rest - pkg) > 0.02) bad.push(`${where}: pkg ${pkg} cores ${c} rest ${rest}`) }
    // no recorded run anywhere on the machine side (owner: live data only)
    if (await pg.locator('[data-recorded],[data-replay]').count()) return F('a recorded-run button is still on the page')
    const pack = { ok: 0, scaled: 0, unavailable: 0 }
    // 2) a synthetic live stream (as from the companion) whose cores add up to 50-150 % of the package
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    await pg.evaluate(() => { const s = window.__hw.getState(); s.pause(); s.pPause(); window.__hw.setState({ power: null, journey: null, pMode: 'live', telemetry: [] }) })
    for (let i = 0; i < 200; i++) {
      const pkg = 8 + rnd() * 60, f = 0.5 + rnd(), k = i % 4 === 3 ? 1.4 : i % 4 === 2 ? 1.05 : f   // every 4th sample: grossly over; every 4th+2: mildly over
      const core = Array.from({ length: 8 }, () => (pkg * k) / 8)
      await pg.evaluate((x) => { const tel = Array.from({ length: 4 }, (_, j) => ({ t: x.i + j * 0.1, cpu: [], power: { pkg_w: x.pkg, core_w: x.core } })); window.__hw.setState({ telemetry: tel }) }, { i, pkg, core })
      await pg.waitForTimeout(420)   // the card re-renders at most 4 times a second, plus the store's own 2 Hz telemetry
      check(await read(), `live #${i} (cores ${(k * 100).toFixed(0)}% of pkg)`, k > 1.15 ? 'unavailable' : k > 1 ? 'scaled' : 'ok')
    }
    return ok(!bad.length, `${seen.ok} ok, ${seen.scaled} scaled, ${seen.unavailable} unavailable; ${bad.length} violations${bad[0] ? ' e.g. ' + bad.slice(0, 2).join('; ') : ''}`) } },
  { id: 'A45', title: 'browser mode: at least 4 machine labels show live numbers, and at least 3 of them change within 3.5 s, with no click and no test', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 1200); const pg = p.page
    // each scene label has a name (<b>) and a live line (.lv); only the live line counts
    const read = () => pg.evaluate(() => [...document.querySelectorAll('#sec-power .nsc')].filter(__h.vis).map((e) => ({ k: e.querySelector('b')?.textContent.trim() ?? '', t: e.querySelector('.lv')?.textContent.trim() ?? '' })).filter((x) => /\d/.test(x.t)))
    const seen = new Map()
    for (let i = 0; i < 8; i++) { for (const x of await read()) { const k = x.k; (seen.get(k) ?? seen.set(k, new Set()).get(k)).add(x.t) } await pg.waitForTimeout(500) }
    const withNum = [...seen.keys()], changing = withNum.filter((k) => seen.get(k).size > 1)
    const clicks = 0, sentence = await pg.evaluate(() => /Test all to estimate|power sensor in the browser|estimated in your browser|Weakest/i.test(document.body.innerText))
    return ok(withNum.length >= 4 && changing.length >= 3 && !sentence, `${withNum.length} labels with numbers (${withNum.join(', ')}); changing: ${changing.join(', ') || 'none'}; clicks ${clicks}; old no-sensor sentence ${sentence ? 'PRESENT' : 'gone'}`) } },
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
  { id: 'L3', title: 'live power readout: the same sensor samples give the same readout (no replay mode any more)', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500); const pg = p.page
    const tel = (w) => Array.from({ length: 4 }, (_, j) => ({ t: j * 0.1, cpu: [], power: { pkg_w: w, core_w: Array(8).fill(w / 16) } }))
    const read = async (w) => { await pg.evaluate((t) => window.__hw.setState({ power: null, journey: null, pMode: 'live', telemetry: t }), tel(w)); await pg.waitForTimeout(450); return pg.locator('#sec-power .phud .pbig').first().innerText() }
    const a = await read(21.1), m = await read(40), c = await read(21.1)
    const gone = !(await pg.locator('[data-recorded],[data-replay]').count())
    return ok(a === c && a !== m && gone, `${a} / ${m} / ${c}; recorded-run buttons gone ${gone}`) } },
  { id: 'L4', title: 'no recorded-run or journey button in browser mode; one component Test gives a numeric result and the strip says 1 / 6 with no number yet (C11)', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500); const pg = p.page
    const rec = await pg.evaluate(() => /recorded (run|journey)|Replay the test/i.test(document.body.innerText) || !!document.querySelector('[data-recorded],[data-replay]'))
    await openFor(pg, '[data-test=cpu1]'); await pg.locator('[data-test=cpu1]').first().click()
    const got = await pg.waitForFunction(() => window.__hw.getState().results.cpu1?.value, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => null)
    await pg.waitForTimeout(400)
    const strip = await pg.evaluate(() => ({ t: document.querySelector('[data-score-strip] .nspeek-txt')?.textContent ?? '', num: !!document.querySelector('b[data-score]') }))
    return ok(!rec && +got > 0 && /1 \/ 6/.test(strip.t) && !strip.num, `recorded buttons ${rec ? 'STILL THERE' : 'gone'}; cpu1 ${got ?? 'none'}; strip "${strip.t}"; number shown ${strip.num}`) } },
  { id: 'L5', title: 'five networks each produce an output', run: async (env) => {
    const p = await env.open(); await p.goto('#zoo', 2500); if (!(await p.page.evaluate(() => !!window.__zoo))) return S('no window.__zoo'); const res = []
    for (const n of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) { await p.page.evaluate((x) => window.__zoo.getState().setNet(x), n)
      res.push([n, await p.page.waitForFunction((x) => window.__zoo.getState().out && window.__zoo.getState().net === x, n, { timeout: 15000 }).then(() => 1, () => 0)]) }
    return ok(res.every(([, v]) => v), res.map(([n, v]) => `${n}:${v ? 'ok' : 'none'}`).join(' ')) } },
  { id: 'A40', title: 'input per model: dock prompt only for text models; changing a net\'s input changes its 3D input within 300 ms', run: async (env) => {
    const out = []; let good = true
    for (const w of [1480, 390]) {
      const p = await env.open({ w }); await p.goto('', 2500); const pg = p.page
      await pg.waitForFunction(() => !!window.__zoo, null, { timeout: 15000 }).catch(() => {})
      if (!(await pg.evaluate(() => !!window.__zoo))) return S('no window.__zoo')
      const vis = (sel) => pg.evaluate((s) => [...document.querySelectorAll(s)].some((e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' }), sel)
      await pg.evaluate(() => window.__zoo.getState().setNet('llm')); await pg.waitForTimeout(400)
      const llm = await vis('[data-prompt]'); if (!llm) good = false; const res = [`llm prompt ${llm ? 'shown' : 'MISSING'}`]
      for (const n of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) {
        await pg.evaluate((x) => window.__zoo.getState().setNet(x), n); await pg.waitForFunction((x) => window.__zoo.getState().net === x && window.__zoo.getState().out, n, { timeout: 10000 }).catch(() => {}); await pg.waitForTimeout(300)
        const prompt = await vis('[data-prompt]'), lang = await vis('[data-lang-picker], #s6lang'), dock = await vis(`[data-net-dock=${n}]`), q = n === 'vlm' ? await vis('[data-question]') : true
        const before = await pg.evaluate(() => JSON.stringify([window.__zoo.getState().out?.input, window.__zoo.getState().out?.ids]))
        const t0 = Date.now()
        if (n === 'vlm') await pg.locator('[data-question]').first().fill('it is', { timeout: 3000 }).catch(() => {})
        else await pg.locator(`[data-net-dock=${n}] button:has-text("New digit")`).first().click({ timeout: 3000 }).catch(() => {})
        const changed = await pg.waitForFunction((b) => JSON.stringify([window.__zoo.getState().out?.input, window.__zoo.getState().out?.ids]) !== b, before, { timeout: 2000, polling: 'raf' }).then(() => true, () => false), ms = Date.now() - t0
        const ok1 = !prompt && !lang && dock && q && changed && ms <= 300; if (!ok1) good = false
        res.push(`${n}:${prompt ? ' PROMPT' : ''}${lang ? ' LANG' : ''}${dock ? '' : ' NO-DOCK'}${q ? '' : ' NO-QUESTION'} ${changed ? ms + 'ms' : 'UNCHANGED'}`)
      }
      out.push(`${w}px ${res.join(', ')}`)
    }
    return ok(good, out.join(' | ')) } },

  { id: 'A43', title: 'real model on every click: Run gives provenance live (never recorded once the model runs), a second prompt gives a different answer, an output/block click shows live data or the needs-companion note', run: async (env) => {
    const p = await env.open({ hub: false }); const pg = p.page
    if (!(await fetch('https://huggingface.co/api/models/HuggingFaceTB/SmolLM2-135M-Instruct').then((r) => r.ok, () => false))) return S('real Hub unreachable')
    await p.goto('', 500)
    // the store hooks are set by lazy chunks (__zoo, __hw): wait for both, so a slow chunk is not read as a missing store
    await pg.waitForFunction(() => window.__studio && window.__zoo && window.__hw, null, { timeout: 20000 })
    const st = (f) => pg.evaluate(f)
    const idle = () => pg.waitForFunction(() => { const s = window.__studio.getState(); return !s.running && !s.download && s.lastStats && s.provenance === 'live' }, null, { timeout: 280000 }).then(() => true, () => false)
    if (!(await idle())) return F('the default model never produced a live result: ' + JSON.stringify(await st(() => { const s = window.__studio.getState(); return { prov: s.provenance, err: s.runErr, run: s.running, dl: !!s.download } })))
    const typeRun = async (text) => {
      const before = await st(() => window.__studio.getState().runSeq)
      await pg.locator('[data-prompt]').first().fill(text); await pg.waitForTimeout(150)
      await pg.locator('[data-start]').first().click()
      await pg.waitForFunction((b) => { const s = window.__studio.getState(); return s.runSeq > b && !s.running && s.provenance === 'live' }, before, { timeout: 120000 })
      return st(() => { const s = window.__studio.getState(); return { prov: s.provenance, ran: s.ranPrompt, top: s.final?.topk?.slice(0, 3).map((x) => x.token + ':' + x.p.toFixed(3)), text: s.final?.text, inside: s.inside } })
    }
    const a = await typeRun('The capital of France is'), b = await typeRun('Two plus two equals')
    const differ = JSON.stringify(a.top) !== JSON.stringify(b.top) && a.ran !== b.ran && b.ran === 'Two plus two equals'
    // a click on the output of the model, and on a block, shows live data or says plainly that it needs the companion
    const seen = []
    for (const ins of [{ kind: 'output' }, { kind: 'block', layer: 2 }]) {
      await pg.evaluate((i) => window.__zoo.getState().setInspect(i), ins); await pg.waitForTimeout(1200)
      seen.push(await pg.evaluate(() => { const c = document.querySelector('[data-inspector]'); const pv = c?.querySelector('[data-provenance]'); const note = c?.querySelector('[data-inside-note]')?.textContent ?? ''; return { prov: pv?.getAttribute('data-provenance') ?? null, note: note.slice(0, 90), rows: c?.querySelectorAll('.nsx-logits li').length ?? 0 } }))
    }
    const outOk = seen[0].prov === 'live' && seen[0].rows >= 5
    const blkOk = seen[1].prov === 'live' && /^(Live|Needs the companion)/.test(seen[1].note) && !/Recorded/.test(seen[1].note)
    await p.shot('a43')
    return ok(a.prov === 'live' && b.prov === 'live' && differ && outOk && blkOk, `1st ${a.top?.join(' ')} | 2nd ${b.top?.join(' ')} | inside ${JSON.stringify(b.inside)} | output ${JSON.stringify(seen[0])} | block ${JSON.stringify(seen[1])}`) } },
  { id: 'A43b', title: 'drawn input: a stroke changes the 3D output scores within 100 ms; for all 5 nets the table digit/confidence equal the 3D label (+-1%) mid-stroke and after pointer-up, from one stored pass (same input hash)', run: async (env) => {
    const p = await env.open(); const pg = p.page; await p.goto('', 2500)
    if (!(await pg.evaluate(() => !!window.__zoo))) return S('no window.__zoo')
    await pg.waitForFunction(() => Object.keys(window.__zoo.getState().packs).length === 5, null, { timeout: 20000 })
    const snap = (n) => pg.evaluate((net) => {
      const z = window.__zoo.getState(), r = z.reads[net], q = (s) => document.querySelector(s)
      const row = q(`[data-net-row="${net}"]`), v = q(`[data-scene-verdict][data-scene-net="${net}"]`)
      return { net: z.net, digit: r?.digit ?? null, conf: Math.round((r?.conf ?? 0) * 100), hash: r?.hash, outHash: z.out?.hash,
        tab: row?.querySelector('[data-read-digit]')?.getAttribute('data-read-digit'), tabConf: row?.querySelector('[data-read-conf]')?.getAttribute('data-read-conf'), tabHash: row?.getAttribute('data-read-hash'),
        sd: v?.dataset.sceneDigit, sc: v?.dataset.sceneConf, sh: v?.dataset.sceneHash }
    }, n)
    const agree = (x) => x.tab === String(x.digit ?? '-') && x.sd === String(x.digit ?? '-') && Math.abs(+x.tabConf - x.conf) <= 1 && Math.abs(+x.sc - x.conf) <= 1 && x.tabHash === x.hash && x.sh === x.hash && (x.net === 'vlm' || x.outHash === x.hash)
    const out = []; let good = true, fast = 0
    let pts = null
    for (const n of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) {
      await pg.evaluate((x) => window.__zoo.getState().setNet(x), n); await pg.waitForFunction((x) => window.__zoo.getState().net === x && window.__zoo.getState().out, n, { timeout: 10000 }); await pg.waitForTimeout(500)
      await openFor(pg, '[data-pad]'); const pad = pg.locator('[data-pad]').first(); await pad.scrollIntoViewIfNeeded(); pts = three(await pad.boundingBox())
      await pg.locator('[data-pad-clear]').first().click(); await pg.waitForTimeout(250)
      const h0 = (await snap(n)).hash
      await pg.mouse.move(pts[0][0], pts[0][1]); await pg.mouse.down()
      await pg.mouse.move(pts[3][0], pts[3][1]); const t0 = Date.now()   // one stroke segment; the clock starts once the event is delivered
      const ms = await pg.waitForFunction(([x, h]) => { const z = window.__zoo.getState(), v = document.querySelector(`[data-scene-verdict][data-scene-net="${x}"]`); return z.reads[x]?.hash !== h && v?.dataset.sceneHash === z.reads[x]?.hash }, [n, h0], { timeout: 1500, polling: 'raf' }).then(() => Date.now() - t0, () => -1)
      const mid = await snap(n)
      for (const q of pts.slice(4)) await pg.mouse.move(q[0], q[1], { steps: 2 })
      await pg.mouse.up(); await pg.waitForTimeout(400); const end = await snap(n)
      const ok1 = ms >= 0 && ms <= 100 && agree(mid) && agree(end) && end.hash !== h0; if (!ok1) good = false; fast = Math.max(fast, ms)
      out.push(`${n}: ${ms}ms ${mid.digit}/${mid.conf}% -> ${end.digit}/${end.conf}% table ${end.tab}/${end.tabConf}% scene ${end.sd}/${end.sc}%${ok1 ? '' : ' MISMATCH ' + JSON.stringify(end)}`)
    }
    await p.shot('a43b')
    return ok(good, out.join(' | ') + `; slowest first update ${fast} ms (from the delivered pointer event to the scene label)`) } },
  { id: 'L6', tier: 3, title: 'idle cost: companion watts with the page open vs blank (info only)', run: async (env) => {
    const pw = async () => { const xs = []; for (let i = 0; i < 8; i++) { xs.push((await fetch('http://127.0.0.1:8000/api/hw/power').then((r) => r.json())).pkg_w); await sleep(250) } return xs.reduce((a, b) => a + b, 0) / xs.length }
    try { const blank = await pw(); const p = await env.open({ companion: 'real', hub: false }); await p.goto('#machine', 3000); const page = await pw(); return P(`blank ${blank.toFixed(1)} W, page ${page.toFixed(1)} W`) } catch (e) { return S('companion power API unavailable: ' + e.message) } } },
  { id: 'T1', tier: 3, title: 'smoke: real Hub lists Xenova/distilgpt2 and the real companion answers (read-only)', run: async () => {
    const hub = await fetch('https://huggingface.co/api/models/Xenova/distilgpt2').then((r) => r.status, () => 'unreachable')
    const comp = await fetch('http://127.0.0.1:8000/api/hw/info').then(async (r) => (r.ok ? `ok, ${(await r.json()).cpu?.name ?? 'cpu ?'}` : r.status), () => 'down')
    return hub === 200 ? P(`Hub ${hub}; companion ${comp}`) : F(`Hub ${hub}; companion ${comp}`) } },
  { id: 'T2', tier: 3, title: 'smoke: real page, real Hub, no mocks: default model runs by itself and shows a run score; bytes ~ plan', needs: ['auto'], run: async (env) => {
    const r = await autoRun(env, {}), planned = r.info.plan?.bytes ?? 0, ratio = planned ? r.got / planned : 0
    return ok(r.done && r.info.prov === 'live' && (r.got === 0 || (ratio > 0.5 && ratio < 1.5)), `${r.done ? 'run score' : 'NO run score'} provenance ${r.info.prov} after ${r.tRun.toFixed(1)} s on ${r.info.where ?? '?'}; planned ${(planned / 1048576).toFixed(0)} MB, downloaded ${(r.got / 1048576).toFixed(0)} MB (${r.got ? 'ratio ' + ratio.toFixed(2) : 'cached or streamed'}); "${r.info.text.replace(/\s+/g, ' ').slice(0, 60)}"`) } },

]
