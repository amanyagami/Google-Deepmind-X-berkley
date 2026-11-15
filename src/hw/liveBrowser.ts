// Live telemetry that a web page can really read, always on, no test needed. One sample every 500 ms goes into the
// hardware store (`bl` and `blHist`), and the 3D labels, the power card and the timeline all read those same numbers.
//   CPU load   a small fixed job runs in a worker; the slower it gets against its own best time, the busier the machine
//   memory     performance.memory, or performance.measureUserAgentSpecificMemory where the page is isolated
//   frame rate requestAnimationFrame
//   network    PerformanceResourceTiming bytes, plus navigator.connection
//   storage    navigator.storage.estimate (usage, quota)
//   battery    navigator.getBattery, when the browser has it

export interface BrowserLive {
  t: number                         // seconds since the sampler started
  cpu: number | null                // 0..100, estimated from a calibrated job
  cores: number
  memBytes: number | null           // JS and WASM memory of this page
  memTotalGB: number | null         // navigator.deviceMemory
  fps: number | null
  netBps: number                    // bytes per second received by this page
  net: { down: number | null; rtt: number | null; type: string | null }
  storUsage: number | null
  storQuota: number | null
  battery: { level: number; charging: boolean } | null
}

export const LIVE_SECONDS = 15
export const LIVE_MS = 500
const KEEP = Math.round((LIVE_SECONDS * 1000) / LIVE_MS)

const WORKER_SRC = `
let best = Infinity
const job = () => { let x = 1.0001; for (let i = 0; i < 2500000; i++) x = x * 1.0000001 + 1e-7; return x }
onmessage = () => {
  let sum = 0, n = 3
  for (let k = 0; k < n; k++) { const t0 = performance.now(); job(); const dt = performance.now() - t0; sum += dt; if (dt > 0.2 && dt < best) best = dt }
  postMessage({ dt: sum / n, best })
}`

/** Starts the sampler. `push` receives each sample and the last 15 s. Returns a function that stops everything. */
export function startBrowserLiveSampler(push: (s: BrowserLive, history: BrowserLive[]) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const t0 = performance.now()
  const hist: BrowserLive[] = []
  const cores = navigator.hardwareConcurrency || 1
  let stopped = false
  // --- CPU: a worker times the same job again and again
  let cpu: number | null = null, worker: Worker | null = null, url = ''
  try {
    url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
    worker = new Worker(url)
    worker.onmessage = (e: MessageEvent) => {
      const { dt, best } = e.data as { dt: number; best: number }
      if (!isFinite(best) || !(dt > 0)) return
      const raw = Math.max(0, Math.min(100, (1 - best / dt) * 100))
      cpu = cpu == null ? raw : cpu * 0.5 + raw * 0.5
    }
  } catch { worker = null }
  // --- frame rate
  let frames = 0, raf = 0
  const tick = () => { frames++; raf = requestAnimationFrame(tick) }
  raf = requestAnimationFrame(tick)
  // --- network bytes from resource timing
  let bytes = 0
  let po: PerformanceObserver | null = null
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries() as PerformanceResourceTiming[]) bytes += e.transferSize || e.encodedBodySize || 0 }); po.observe({ type: 'resource' }) } catch { po = null }
  // --- memory
  let mem: number | null = null
  const readMem = () => {
    const pm = (performance as any).memory
    if (pm?.usedJSHeapSize) { mem = pm.usedJSHeapSize; return }
    const f = (performance as any).measureUserAgentSpecificMemory
    if (typeof f === 'function' && (self as any).crossOriginIsolated) f.call(performance).then((r: any) => { if (!stopped && r?.bytes) mem = r.bytes }).catch(() => { /* not allowed here */ })
  }
  readMem()
  const memT = window.setInterval(readMem, 2000)
  // --- storage
  let usage: number | null = null, quota: number | null = null
  const readStor = () => { try { navigator.storage?.estimate?.().then((e) => { if (!stopped) { usage = e.usage ?? null; quota = e.quota ?? null } }).catch(() => { /* ignore */ }) } catch { /* ignore */ } }
  readStor()
  const storT = window.setInterval(readStor, 3000)
  // --- battery
  let battery: { level: number; charging: boolean } | null = null
  try {
    ;(navigator as any).getBattery?.().then((b: any) => {
      const upd = () => { battery = { level: b.level, charging: b.charging } }
      upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd)
    }).catch(() => { /* none */ })
  } catch { /* none */ }
  // --- one sample every 500 ms
  let lastT = performance.now(), lastBytes = 0
  const loop = window.setInterval(() => {
    if (document.hidden) { lastT = performance.now(); frames = 0; return }
    worker?.postMessage(0)
    const now = performance.now(), dt = Math.max(0.05, (now - lastT) / 1000)
    const conn = (navigator as any).connection
    const s: BrowserLive = {
      t: +((now - t0) / 1000).toFixed(2), cpu: cpu == null ? null : Math.round(cpu), cores,
      memBytes: mem, memTotalGB: (navigator as any).deviceMemory ?? null,
      fps: Math.round(frames / dt), netBps: Math.round((bytes - lastBytes) / dt),
      net: { down: conn?.downlink ?? null, rtt: conn?.rtt ?? null, type: conn?.effectiveType ?? null },
      storUsage: usage, storQuota: quota, battery,
    }
    frames = 0; lastBytes = bytes; lastT = now
    hist.push(s); if (hist.length > KEEP) hist.shift()
    push(s, hist.slice())
  }, LIVE_MS)
  return () => {
    stopped = true
    clearInterval(loop); clearInterval(memT); clearInterval(storT); cancelAnimationFrame(raf)
    try { po?.disconnect() } catch { /* ignore */ }
    try { worker?.terminate(); if (url) URL.revokeObjectURL(url) } catch { /* ignore */ }
  }
}
