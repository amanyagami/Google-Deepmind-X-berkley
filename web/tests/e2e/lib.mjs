// Harness core: browser launch, error hooks, request log, mocks (Hub, companion, device profiles), in-page helpers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
let pw
try { pw = await import('playwright-core') } catch { pw = await import('file:///C:/Users/bajipater/Desktop/testing/neural-studio/web/node_modules/playwright-core/index.mjs') }
export const OUT = path.join(process.env.TEMP || os.tmpdir(), 'ns-s10')
fs.mkdirSync(OUT, { recursive: true })
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
export const launch = () => pw.chromium.launch({ executablePath: fs.existsSync(EDGE) ? EDGE : undefined, headless: true,
  args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-webgpu'] })

// Fixture: tiny safetensors with one 64x64 F32 tensor "w" whose value is a known function of (r, c).
export const valueAt = (r, c) => Math.fround(Math.sin(r * 0.37) + Math.cos(c * 0.21))
export function safetensors() {
  const n = 64, data = Buffer.alloc(n * n * 4)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data.writeFloatLE(valueAt(r, c), (r * n + c) * 4)
  const head = Buffer.from(JSON.stringify({ w: { dtype: 'F32', shape: [n, n], data_offsets: [0, data.length] } }))
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(head.length))
  return Buffer.concat([len, head, data])
}
const FILES = { 'model.safetensors': safetensors(), 'config.json': Buffer.from('{"model_type":"mock","hidden_size":64,"num_hidden_layers":2}') }
const HOST = /(^|\.)(huggingface\.co|hf\.co)$/

/** In-page device profile: any of nogpu mem saveData cellular battery quota mic oom phone. */
const mockScript = (p) => `(()=>{const p=${JSON.stringify(p)};const def=(o,k,v)=>{try{Object.defineProperty(o,k,{get:()=>v,configurable:true})}catch{}}
if(p.nogpu||p.phone)def(Navigator.prototype,'gpu',undefined)
if(p.mem||p.phone)def(Navigator.prototype,'deviceMemory',p.mem||2)
if(p.phone)def(Navigator.prototype,'hardwareConcurrency',4)
if(p.saveData||p.cellular)def(Navigator.prototype,'connection',{saveData:!!p.saveData,effectiveType:p.cellular?'3g':'4g',type:p.cellular?'cellular':'wifi',downlink:p.cellular?1.5:50,addEventListener(){},removeEventListener(){}})
if(p.battery)navigator.getBattery=async()=>({level:p.battery,charging:false,addEventListener(){},removeEventListener(){}})
if(p.quota){navigator.storage.estimate=async()=>({quota:1e6,usage:1e6});navigator.storage.getDirectory=async()=>{throw new DOMException('full','QuotaExceededError')};try{Cache.prototype.put=async()=>{throw new DOMException('full','QuotaExceededError')}}catch{}}
if(p.mic)navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError')}
if(p.oom){WebAssembly.Memory=function(){throw new RangeError('WebAssembly.Memory(): could not allocate memory')};if(window.GPUAdapter)GPUAdapter.prototype.requestDevice=async()=>{throw new DOMException('out of memory','OperationError')}}})()`

/** Page-side helpers (window.__h): visibility, colour compositing, contrast. Serialised with toString(). */
function helpers() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const rgba = (s) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1)
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.01 && !el.closest('[aria-hidden=true],[hidden]') }
  const bg = (el) => { // composite ancestors' backgrounds; "unknown" when an image, gradient or canvas sits behind
    let c = [10, 14, 25, 1], unknown = false
    const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e)
    for (const e of chain.reverse()) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') unknown = true; const b = rgba(s.backgroundColor); if (b[3] > 0) c = over(b, c) }
    return { c, unknown }
  }
  const texts = () => { const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode());) { const t = n.textContent.trim(), e = n.parentElement; if (t && e && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(e.tagName) && vis(e)) out.push({ t, e }) }
    return out }
  const contrast = () => {
    let min = 99, n = 0, unknown = 0; const fails = []
    for (const { t, e } of texts()) {
      const s = getComputedStyle(e), b = bg(e); if (b.unknown) { unknown++; continue }
      let op = 1; for (let x = e; x; x = x.parentElement) op *= +getComputedStyle(x).opacity
      const f = rgba(s.color); f[3] *= op
      const px = parseFloat(s.fontSize), large = px >= 24 || (px >= 18.66 && +s.fontWeight >= 700)
      const r = ratio(over(f, b.c), b.c); n++; min = Math.min(min, r)
      if (r < (large ? 3 : 4.5)) fails.push(`${r.toFixed(2)} "${t.slice(0, 24)}" <${e.tagName.toLowerCase()}.${String(e.className).slice(0, 20)}>`)
    }
    return { min, n, unknown, fails }
  }
  const interactive = () => [...document.querySelectorAll('button,a[href],input,select,textarea,[role=button],[tabindex]:not([tabindex="-1"])')].filter(vis)
  window.__h = { rgba, over, ratio, vis, bg, texts, contrast, interactive }
}

// Feature probes: which streams' hooks exist in this build (see README for the contract).
const feats = () => ({ S1: !!document.querySelector('[data-dock]'), S3: !!window.__score, S4: !!document.querySelector('[data-start]'), S5: !!document.querySelector('[data-test]'),
  S6: !!document.querySelector('[data-picker]'), S7: !!window.__inspector, S8: !!window.__scene })

export async function startHostile() { // another local origin serving a blank page, for A25
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>hostile</title>') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() }
}

export function makeEnv(browser, base, widths, query) {
  const live = []
  const env = { base, widths, browser, OUT, query,
    async open(o = {}) {
      const ctx = await browser.newContext({ viewport: { width: o.w ?? 1480, height: o.h ?? (o.w && o.w < 600 ? 844 : 900) }, deviceScaleFactor: o.dpr ?? 1, hasTouch: !!o.touch, isMobile: !!o.touch,
        reducedMotion: o.reduced ? 'reduce' : 'no-preference', acceptDownloads: true, serviceWorkers: 'block' })
      const P = { ctx, errors: [], reqs: [], hub: { delay: o.hubDelay ?? 0, hits: [] } }
      await ctx.addInitScript(`window.__errs=[];addEventListener('error',e=>__errs.push('error: '+e.message));addEventListener('unhandledrejection',e=>__errs.push('rejection: '+(e.reason&&e.reason.message||e.reason)))`)
      await ctx.addInitScript(`(${helpers})()`)
      if (o.profile) await ctx.addInitScript(mockScript(o.profile))
      ctx.on('request', (r) => P.reqs.push({ url: r.url(), t: Date.now(), type: r.resourceType() }))
      if (o.hub !== false) await ctx.route((u) => HOST.test(u.hostname), async (route) => { // Hub + CDN stub (HTTP Range supported)
        const u = new URL(route.request().url()); P.hub.hits.push(u.pathname)
        if (P.hub.delay) await new Promise((r) => setTimeout(r, P.hub.delay))
        const h = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' }
        if (u.pathname.startsWith('/api/')) return route.fulfill({ headers: h, contentType: 'application/json', body: JSON.stringify({ id: 'mock/tiny', sha: '0'.repeat(40), siblings: Object.entries(FILES).map(([f, b]) => ({ rfilename: f, size: b.length, lfs: { size: b.length } })), safetensors: { total: 4096 } }) })
        const f = FILES[decodeURIComponent(u.pathname.split('/').pop())]; if (!f) return route.fulfill({ status: 404, body: 'nope' })
        const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '')
        if (m) { const a = +m[1], b = m[2] ? +m[2] : f.length - 1; return route.fulfill({ status: 206, body: f.subarray(a, b + 1), headers: { ...h, 'content-range': `bytes ${a}-${b}/${f.length}` } }) }
        return route.fulfill({ body: f, headers: h })
      })
      if (o.companion !== 'real') await ctx.route((u) => (u.port === '8000' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) || (u.origin === new URL(base).origin && /^\/(api|ws)\//.test(u.pathname)), (r) => (o.companion === 'stub' ? r.fulfill({ json: { ok: true } }) : r.abort('connectionrefused')))
      P.page = await ctx.newPage()
      P.page.on('pageerror', (e) => P.errors.push(e.message))
      if (o.throttle) { const s = await ctx.newCDPSession(P.page); await s.send('Network.enable'); await s.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: o.throttle * 125000, uploadThroughput: o.throttle * 125000 }) }
      P.errCount = async () => Math.max(P.errors.length, await P.page.evaluate(() => window.__errs.length).catch(() => 0))
      P.goto = async (hash = '', settle = 1500) => { await P.page.goto(base + (o.query ?? query) + hash, { waitUntil: 'load' }); await P.page.waitForTimeout(settle); return P }
      P.features = () => P.page.evaluate(`(${feats})()`)
      P.shot = (n) => P.page.screenshot({ path: path.join(OUT, n + '.png') }).catch(() => {})
      live.push(P); return P },
    async closeAll() { const e = await env.liveErrors(); for (const p of live.splice(0)) await p.ctx.close().catch(() => {}); return e },
    async liveErrors() { let n = 0; for (const p of live) n += await p.errCount(); return n } }
  return env
}
