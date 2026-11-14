// Acceptance checks A1-A26 (TODO.md section 8) and legacy-intent checks L1-L6. A check returns {status, value} or throws (= FAIL).
import fs from 'node:fs'
import path from 'node:path'
import { OUT, valueAt, startHostile } from './lib.mjs'

const P = (value) => ({ status: 'PASS', value })
const F = (value) => ({ status: 'FAIL', value })
const S = (value) => ({ status: 'SKIP', value })
const ok = (cond, value) => (cond ? P(value) : F(value))
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  { id: 'A1', title: 'text contrast >= 4.5:1 (3:1 large)', run: async (env) => {
    const rows = await atWidths(env, {}, (pg) => pg.evaluate(() => __h.contrast()))
    const bad = rows.filter(([, r]) => r.fails.length), minAll = Math.min(...rows.map(([, r]) => r.min))
    return ok(!bad.length, `min ${minAll.toFixed(2)}:1; ${bad.map(([w, r]) => `${w}px:${r.fails.length} fail e.g. ${r.fails[0]}`).join(' | ') || 'all pass'} (skipped ${rows[0][1].unknown} on gradients)`) } },

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
    const fcp = await p.page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1)
    const t1 = Date.now(); await p.page.locator('[data-test]').first().click(); await p.page.waitForSelector('[data-score]', { timeout: 30000 })
    const s = (Date.now() - t1) / 1000
    return ok(fcp > 0 && fcp <= 2500 && s <= 10, `first paint ${Math.round(fcp)} ms; first score ${s.toFixed(1)} s (load ${((t1 - t0) / 1000).toFixed(1)} s)`) } },
  { id: 'A7b', tier: 3, title: '82 MB model first score <= 60 s at 20 Mbit (real Hub)', needs: ['S4'], run: async (env) => {
    const p = await env.open({ throttle: 20, hub: false }); await p.goto(); const t = Date.now()
    await p.page.locator('[data-start]').first().click(); await p.page.waitForSelector('[data-score]', { timeout: 90000 })
    const s = (Date.now() - t) / 1000; return ok(s <= 60, `${s.toFixed(1)} s`) } },

  { id: 'A8', title: 'zero model-file requests before Start; size shown first', needs: ['S4'], run: async (env) => {
    const p = await env.open(); await p.goto(); await p.page.waitForTimeout(1500)
    const early = p.reqs.filter((r) => MODEL_FILE.test(r.url)), txt = await p.page.locator('[data-start]').first().innerText()
    return ok(!early.length && /\d(\.\d+)?\s?(MB|GB|KB)/i.test(txt), `${early.length} model requests before click; button "${txt.replace(/\s+/g, ' ').slice(0, 40)}"`) } },

  { id: 'A9', title: 'download progress: role=progressbar, updates >= 1/s', needs: ['S4'], run: async (env) => {
    const p = await env.open({ hubDelay: 2500 }); await p.goto()
    await p.page.evaluate(() => { window.__pv = []; new MutationObserver(() => { const b = document.querySelector('[role=progressbar]'); if (b) __pv.push([Date.now(), b.getAttribute('aria-valuenow'), b.getAttribute('aria-valuemin'), b.getAttribute('aria-valuemax')]) }).observe(document.body, { subtree: true, attributes: true, childList: true }) })
    await p.page.locator('[data-start]').first().click(); await p.page.waitForSelector('[role=progressbar]', { timeout: 5000 }); await p.page.waitForTimeout(3500)
    const v = await p.page.evaluate(() => __pv), valid = v.length && v.every((x) => x[1] !== null && x[2] !== null && x[3] !== null)
    const rate = v.length > 1 ? (new Set(v.map((x) => x[1])).size - 1) / ((v.at(-1)[0] - v[0][0]) / 1000 || 1) : 0
    return ok(valid, `progressbar ${valid ? 'has valuenow/min/max' : 'missing aria values'}; ${rate.toFixed(1)} updates/s (mock cannot stream, rate gated in tier 3 A9b)`) } },
  { id: 'A9b', tier: 3, title: 'real download updates >= 1/s', needs: ['S4'], run: async (env) => {
    const p = await env.open({ hub: false }); await p.goto()
    await p.page.evaluate(() => { window.__pv = []; new MutationObserver(() => { const b = document.querySelector('[role=progressbar]'); if (b) __pv.push([Date.now(), b.getAttribute('aria-valuenow')]) }).observe(document.body, { subtree: true, attributes: true }) })
    await p.page.locator('[data-start]').first().click(); await p.page.waitForSelector('[data-score]', { timeout: 120000 })
    const v = await p.page.evaluate(() => __pv), sec = (v.at(-1)[0] - v[0][0]) / 1000, n = new Set(v.map((x) => x[1])).size
    return ok(n / sec >= 1, `${n} distinct values in ${sec.toFixed(1)} s`) } },

  { id: 'A10', title: 'second load: zero model requests and "cached"', needs: ['S4'], run: async (env) => {
    const p = await env.open(); await p.goto(); await p.page.locator('[data-start]').first().click(); await p.page.waitForSelector('[data-score]', { timeout: 60000 })
    p.reqs.length = 0; await p.page.reload({ waitUntil: 'load' }); await p.page.waitForTimeout(2000)
    const n = p.reqs.filter((r) => MODEL_FILE.test(r.url) && /hf\.co|huggingface/.test(r.url)).length, cached = await p.page.locator('[data-cached]').count()
    return ok(n === 0 && cached > 0, `${n} model requests; [data-cached] x${cached}`) } },

  { id: 'A11', title: 'every browser W/J value says estimated/≈', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500)
    const r = await p.page.evaluate(() => { const bad = []; let n = 0
      for (const { t, e } of __h.texts()) { if (!/(^|[\s≈~])\d[\d.,]*\s?(mW|kW|W|J|kJ|Wh|kWh)\b/.test(t)) continue; n++
        const box = e.closest('.card,.ccard,[data-card],section,li,.phud') ?? e.parentElement; const s = (box.innerText + (e.closest('[data-est]') ? ' estimated' : '')).toLowerCase()
        if (!/estimated|≈/.test(s) && !e.closest('[data-est]')) bad.push(t.slice(0, 24)) } return { n, bad } })
    return ok(!r.bad.length, `${r.n} W/J values, ${r.bad.length} unlabelled${r.bad.length ? ' e.g. ' + r.bad.slice(0, 3).join(', ') : ''}`) } },

  { id: 'A12', title: 'requests only to origin, allowlisted hosts, user URLs', run: async (env) => {
    const p = await env.open(); await p.goto('', 3000); await p.goto('#machine', 2500)
    const ok2 = ALLOWED(new URL(env.base).origin), bad = [...new Set(p.reqs.map((r) => r.url).filter((u) => !ok2(u)).map((u) => new URL(u).host))]
    return ok(!bad.length, `${p.reqs.length} requests; off-list hosts: ${bad.join(', ') || 'none'}`) } },

  { id: 'A13', title: 'panels side by side at 1100, stacked at 390', needs: ['S1'], run: async (env) => {
    const get = async (w) => { const p = await env.open({ w }); await p.goto(); return p.page.evaluate(() => [...document.querySelectorAll('[data-panel]')].filter(__h.vis).slice(0, 2).map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width } })) }
    const a = await get(1100), b = await get(390)
    if (a.length < 2 || b.length < 2) return F(`found ${a.length}/${b.length} [data-panel]`)
    const side = Math.abs(a[0].t - a[1].t) < 8 && a[1].l > a[0].l + 100, stacked = Math.abs(b[0].l - b[1].l) < 8 && b[1].t > b[0].t
    return ok(side && stacked, `1100: ${side ? 'side by side' : 'not'}; 390: ${stacked ? 'stacked' : 'not'}`) } },

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
    const p = await env.open(); await p.goto('#zoo'); const t0 = Date.now()
    await p.page.evaluate(() => window.__zoo.getState().select({ kind: 'block', layer: 0, index: 0, name: 'w' }))
    await p.page.waitForSelector('[data-inspector]', { timeout: 2000 }); const ms = Date.now() - t0
    const z = await p.page.evaluate(() => window.__inspector.zoomMax()), exp = valueAt(z.r, z.c)
    await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(300); const gone = (await p.page.locator('[data-inspector]').count()) === 0
    return ok(ms <= 500 && gone && Math.abs(z.value - exp) < 1e-6, `card in ${ms} ms; Esc closes ${gone}; w[${z.r},${z.c}] shown ${z.value} vs tensor ${exp}`) } },

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
    const p = await env.open(); await p.goto(); const b = p.page.locator('.hintbtn').first()
    if (!(await b.count())) return F('no .hintbtn on page')
    await b.scrollIntoViewIfNeeded(); await b.click(); const open = (await b.getAttribute('aria-expanded')) === 'true'
    const inView = await p.page.evaluate(() => { const r = document.querySelector('.hintpop')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })
    await p.page.mouse.move(2, 2); const t = Date.now(); await p.page.waitForFunction(() => !document.querySelector('.hintpop'), null, { timeout: 1500 }).catch(() => {}); const ms = Date.now() - t
    const q = await env.open({ w: 390, touch: true }); await q.goto(); const tb = q.page.locator('.hintbtn').first(); await tb.scrollIntoViewIfNeeded(); const tapped = await tb.tap({ timeout: 4000 }).then(() => true, () => false); if (!tapped) return F('touch tap on first hint blocked (covered by another element, see A2)'); const tOpen = (await tb.getAttribute('aria-expanded')) === 'true'
    await q.page.touchscreen.tap(4, 4); await q.page.waitForTimeout(300); const tClosed = (await tb.getAttribute('aria-expanded')) !== 'true'
    return ok(open && inView && ms <= 300 && tOpen && tClosed, `opens ${open}; in viewport ${inView}; closes in ${ms} ms; touch opens ${tOpen}, outside tap closes ${tClosed}`) } },

  { id: 'A18', title: 'glyphs ▲/○ and +/− present', run: async (env) => {
    const p = await env.open(); await p.goto(); const t = await p.page.evaluate(() => document.body.innerText), f = await p.features()
    const gl = t.includes('▲') && t.includes('○')
    let pm = 'n/a (needs S7)'; if (f.S7) { await p.page.evaluate(() => window.__zoo.getState().select({ kind: 'block', layer: 0, index: 0, name: 'w' })); await p.page.waitForTimeout(500)
      pm = /[+−]\d/.test(await p.page.locator('[data-inspector]').innerText().catch(() => '')) }
    return ok(gl && pm !== false, `▲ ${t.includes('▲')}, ○ ${t.includes('○')}, +/− in heatmap ${pm}`) } },

  { id: 'A19', title: 'card text diet: <= 1 sentence of <= 120 chars', run: async (env) => {
    const p = await env.open(); await p.goto('', 2500)
    const r = await p.page.evaluate(() => { const cards = [...document.querySelectorAll('.card,.ccard,[data-card]')].filter(__h.vis), bad = []
      for (const c of cards) { const parts = []; for (const { t, e } of __h.texts()) { if (!c.contains(e) || e.closest('button,.hintpop,[data-detail]')) continue; parts.push(...t.split(/(?<=[.!?])\s+/)) }
        const sent = parts.filter((s) => s.split(/\s+/).length >= 4); if (sent.length > 1 || sent.some((s) => s.length > 120)) bad.push(`${sent.length} sentences, longest ${Math.max(0, ...sent.map((s) => s.length))}: "${(sent[0] ?? '').slice(0, 30)}"`) }
      return { n: cards.length, bad } })
    return r.n ? ok(!r.bad.length, `${r.n} cards, ${r.bad.length} over budget${r.bad[0] ? ' e.g. ' + r.bad[0] : ''}`) : S('no .card elements') } },

  { id: 'A20', title: 'CLS <= 0.02 during a full Test all', needs: ['S5'], run: async (env) => {
    const p = await env.open(); await p.page.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) __cls += e.value }).observe({ type: 'layout-shift', buffered: true }) })
    await p.goto(); await p.page.locator('[data-testall]').first().click(); await p.page.waitForSelector('[data-score]', { timeout: 200000 }); await p.page.waitForTimeout(1000)
    const c = await p.page.evaluate(() => __cls); return ok(c <= 0.02, `CLS ${c.toFixed(4)}`) } },

  { id: 'A21', title: 'no-WebGPU / out-of-memory / offline / mic-denied: message + button <= 2 s', needs: ['S5', 'S6'], run: async (env) => {
    const cases = [['nogpu', { profile: { nogpu: 1 } }, '[data-test=gpu],[data-start]'], ['oom', { profile: { oom: 1, mem: 2 } }, '[data-start]'],
      ['offline', {}, '[data-start]', true], ['mic', { profile: { mic: 1 } }, '[data-test=mic]']], out = []
    for (const [name, o, sel, off] of cases) { const p = await env.open({ ...o, hub: off ? false : undefined }); await p.goto(); if (off) await p.ctx.setOffline(true)
      const b = p.page.locator(sel).first(); if (!(await b.count())) { out.push(`${name}: no trigger ${sel}`); continue }
      const t = Date.now(); await b.click(); const e = await p.page.waitForSelector('[data-error]', { timeout: 2000 }).catch(() => null)
      const ms = Date.now() - t, has = e && (await e.innerText()).trim().length > 3 && (await e.locator('button').count()) > 0, errs = await p.errCount()
      if (!has || errs) out.push(`${name}: ${has ? '' : 'no message+button in 2 s '}${errs ? errs + ' page errors' : ''}`.trim()); else out.push(`${name} ok ${ms}ms`) }
    return ok(out.every((x) => / ok \d+ms$/.test(x)), out.join('; ')) } },

  { id: 'A22', title: 'reduced motion: no transition > 1 ms, no camera tween', run: async (env) => {
    const p = await env.open({ reduced: true }); await p.goto('', 2000)
    const r = await p.page.evaluate(() => { const ms = (s) => Math.max(...s.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)), 0); let worst = 0, who = ''
      for (const e of document.querySelectorAll('*')) { const s = getComputedStyle(e); const v = Math.max(ms(s.transitionDuration), ms(s.animationDuration) * (s.animationName !== 'none')); if (v > worst) { worst = v; who = e.tagName + '.' + String(e.className).slice(0, 16) } } return { worst, who } })
    let cam = 'n/a (needs S8)'; if ((await p.features()).S8) { await p.page.evaluate(() => window.__zoo?.getState().select?.({ kind: 'block', layer: 1, index: 0 })); await p.page.waitForTimeout(60); cam = !(await p.page.evaluate(() => !!window.__scene.camera?.tweening)) }
    return ok(r.worst <= 1 && cam !== false, `longest transition/animation ${r.worst} ms (${r.who || '-'}); camera tween ${cam === true ? 'none' : cam}`) } },

  { id: 'A23', title: 'share PNG 1200×630, no hostname or UA', needs: ['S5'], run: async (env) => {
    const p = await env.open(); await p.goto(); const [d] = await Promise.all([p.page.waitForEvent('download', { timeout: 15000 }), p.page.locator('[data-share]').first().click()])
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

  { id: 'A25', title: 'hostile-origin page cannot start a companion run', run: async (env) => {
    const up = await fetch('http://127.0.0.1:8000/api/health').then((r) => r.ok).catch(() => false); if (!up) return S('companion not running on 8000')
    const h = await startHostile(); try { const p = await env.open({ companion: 'real', hub: false }); await p.page.goto(h.url)
      const r = await p.page.evaluate(async () => { const out = {}
        out.post = await fetch('http://127.0.0.1:8000/api/hw/journey', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"repo":"x","prompt":"hi","new_tokens":1}' }).then((r) => r.status, () => 'refused')
        out.ws = await new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:8000/ws/bench'); const t = setTimeout(() => { w.close(); res('timeout-open?') }, 3000); w.onopen = () => { clearTimeout(t); w.close(); res('OPENED') }; w.onerror = () => { clearTimeout(t); res('refused') } })
        return out })
      return ok((r.post === 'refused' || r.post >= 400) && r.ws !== 'OPENED', `POST ${r.post}; WebSocket ${r.ws}`) } finally { h.close() } } },

  { id: 'A26', title: 'plain words: avg sentence <= 12, none > 20, grade <= 8, no banned words', run: async (env) => {
    const p = await env.open(); await p.goto('', 2500); const strings = []
    for (const hash of ['', '#zoo', '#machine']) { await p.page.evaluate((h) => { location.hash = h }, hash); await p.page.waitForTimeout(600)
      strings.push(...(await p.page.evaluate(() => __h.texts().filter((x) => !x.e.closest('.hintbtn')).map((x) => x.t))))
      const n = Math.min(await p.page.locator('.hintbtn').count(), 40)
      for (let i = 0; i < n; i++) { const b = p.page.locator('.hintbtn').nth(i); try { await b.scrollIntoViewIfNeeded({ timeout: 800 }); await b.click({ timeout: 800 }); strings.push(await p.page.locator('.hintpop').first().innerText({ timeout: 500 })); await p.page.keyboard.press('Escape') } catch {} } }
    const sent = [...new Set(strings)].flatMap((s) => s.split(/(?<=[.!?])\s+|\n+/)).map((s) => s.trim()).filter((s) => /[A-Za-z]{2}/.test(s) && (/[.!?]$/.test(s) || s.split(/\s+/).length >= 4)), words = sent.map((s) => s.split(/\s+/).filter(Boolean).length)
    const W = words.reduce((a, b) => a + b, 0), avg = W / sent.length, longest = Math.max(...words), sy = sent.join(' ').split(/\s+/).reduce((a, w) => a + syl(w), 0)
    const fk = 0.39 * avg + 11.8 * (sy / W) - 15.59, banned = [...new Set(sent.join(' ').match(BANNED)?.map((x) => x.toLowerCase()) ?? [])]
    fs.writeFileSync(path.join(OUT, 'a26-strings.txt'), sent.join('\n'))
    return ok(avg <= 12 && longest <= 20 && fk <= 8 && !banned.length, `${sent.length} sentences; avg ${avg.toFixed(1)} words; longest ${longest}; grade ${fk.toFixed(1)}; banned: ${banned.join(',') || 'none'}`) } },

  // ---- legacy intent (nine old scripts): 3D drawing, no page errors on a tour, replay, recorded score, zoo nets, idle cost
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
    const p = await env.open(); await p.goto('#machine', 2500); const b = p.page.locator('#sec-power button:has-text("Replay a measured run"), [data-replay]').first()
    if (!(await b.count())) return S('no replay button'); await b.click(); await p.page.waitForTimeout(1500)
    const read = async (t) => { await p.page.evaluate((x) => { const s = window.__hw.getState(); s.pPause(); s.setPHead(x) }, t); await p.page.waitForTimeout(400); return p.page.locator('#sec-power .phud .pbig').first().innerText() }
    const a = await read(3.3), m = await read(9.9), c = await read(3.3); return ok(a === c, `${a} / ${m} / ${c}`) } },
  { id: 'L4', title: 'recorded journey gives a numeric score', run: async (env) => {
    const p = await env.open(); await p.goto('#machine', 2500); const b = p.page.locator('#sec-power button:has-text("Play a recorded journey"), [data-recorded]').first()
    if (!(await b.count())) return S('no recorded-journey button'); await b.click(); await p.page.waitForFunction(() => window.__hw.getState().journey, null, { timeout: 30000 }); await p.page.waitForTimeout(900)
    const pg = p.page; if (!(await pg.locator('#sec-power .tabs').count()) && (await pg.locator('#sec-power .detbtn').count())) await pg.click('#sec-power .detbtn')
    if (await pg.locator('#sec-power .tabs button:has-text("Score")').count()) await pg.click('#sec-power .tabs button:has-text("Score")')
    const h = pg.locator('.hero-score, [data-score]').first(); if (!(await h.count())) return S('no score element after the journey')
    await pg.waitForFunction(() => /\d{2,}/.test(document.querySelector('.hero-score, [data-score]')?.innerText ?? ''), null, { timeout: 8000 }).catch(() => {}); const t = (await h.innerText({ timeout: 5000 })).replace(/\s+/g, ' '); return ok(/\d{2,}/.test(t), t.slice(0, 30)) } },
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
  { id: 'T2', tier: 3, title: 'smoke: real page, real Hub, no mocks: a first score appears', needs: ['S4'], run: async (env) => {
    const p = await env.open({ hub: false, companion: 'real' }); await p.goto(); await p.page.locator('[data-start]').first().click(); await p.page.waitForSelector('[data-score]', { timeout: 180000 }); await p.shot('t2'); return P('score shown') } },
]
