/// <reference lib="webworker" />
// One benchmark worker = one busy thread. The page starts several at once for the multi-core tests.
import { buildChase, calibrateReps, chase, collectSamples, loadKernel, median, triad, type Kernel } from './browserBench'

let kernel: Kernel | null = null
const post = (m: any) => (self as any).postMessage(m)

async function mm(n: number, ms: number, id: number) {
  kernel ??= await loadKernel()
  const k = kernel
  for (let i = 0; i < 3 * n * n; i++) k.f32[i] = ((i * 2654435761) % 1000) / 1000 - 0.5
  k.mm(n) // warm-up: compile tier-up and page-in
  const flop = 2 * n ** 3
  const samples: number[] = []
  const end = performance.now() + ms
  let last = performance.now(), ops = 0
  while (performance.now() < end) {
    const t = performance.now()
    k.mm(n)
    const dt = (performance.now() - t) / 1000
    samples.push(flop / dt / 1e9); ops += flop
    if (performance.now() - last > 120) { post({ type: 'tick', id, value: samples[samples.length - 1] }); last = performance.now() }
  }
  return { samples, flop: ops }
}

function mem(mb: number, ms: number, id: number) {
  const n = (mb * 2 ** 20) / 8
  const a = new Float64Array(n).fill(1), b = new Float64Array(n)
  b.set(a)
  const samples: number[] = []
  const end = performance.now() + ms
  let last = performance.now()
  while (performance.now() < end) {
    const t = performance.now()
    b.set(a)
    samples.push((2 * n * 8) / ((performance.now() - t) / 1000) / 1e9) // bytes read + bytes written
    if (performance.now() - last > 120) { post({ type: 'tick', id, value: samples[samples.length - 1] }); last = performance.now() }
  }
  return { samples }
}

function cache(sizesKb: number[], id: number) {
  const out: { kb: number; gbps: number }[] = []
  for (const kb of sizesKb) {
    const n = (kb * 1024) / 2 / 8 // two arrays share the working set
    const a = new Float64Array(n).fill(1), b = new Float64Array(n)
    b.set(a)
    // browsers round timers (to 0.1 ms or coarser), so find a repeat count whose round takes at least 10 ms
    let reps = 1
    for (;;) { const t1 = performance.now(); for (let i = 0; i < reps; i++) b.set(a); if (performance.now() - t1 >= 10 || reps > 1 << 22) break; reps *= 2 }
    let best = 0
    for (let r = 0; r < 3; r++) {
      const t = performance.now()
      for (let i = 0; i < reps; i++) b.set(a)
      best = Math.max(best, (2 * n * 8 * reps) / ((performance.now() - t) / 1000) / 1e9)
    }
    out.push({ kb, gbps: Math.round(best * 10) / 10 })
    post({ type: 'tick', id, value: best, kb })
  }
  return { curve: out }
}

async function storage(mb: number, id: number) {
  const root = await (navigator as any).storage.getDirectory()
  const fh = await root.getFileHandle('neural-studio-bench.bin', { create: true })
  const h = await fh.createSyncAccessHandle()
  const chunk = new Uint8Array(4 * 2 ** 20)
  for (let i = 0; i < chunk.length; i += 4096) chunk[i] = i & 255
  const n = Math.round(mb / 4)
  try {
    h.truncate(0)
    let t = performance.now()
    for (let i = 0; i < n; i++) { h.write(chunk, { at: i * chunk.length }); if (i % 8 === 0) post({ type: 'tick', id, value: ((i + 1) * chunk.length) / ((performance.now() - t) / 1000) / 1e9 }) }
    h.flush()
    const write = (n * chunk.length) / ((performance.now() - t) / 1000) / 1e9
    t = performance.now()
    for (let i = 0; i < n; i++) { h.read(chunk, { at: i * chunk.length }); if (i % 8 === 0) post({ type: 'tick', id, value: ((i + 1) * chunk.length) / ((performance.now() - t) / 1000) / 1e9 }) }
    const read = (n * chunk.length) / ((performance.now() - t) / 1000) / 1e9
    return { write_gbps: Math.round(write * 100) / 100, read_gbps: Math.round(read * 100) / 100, mb: n * 4 }
  } finally {
    h.close()
    try { await root.removeEntry('neural-studio-bench.bin') } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ S2 engine commands */
const epoch = () => performance.timeOrigin + performance.now()
interface Job { sample(): number; work: number /* flop or bytes per sample */ }
let job: Job | null = null

async function prep(a: { kind: 'mm' | 'triad'; n?: number; bytes?: number; minMs: number }) {
  if (a.kind === 'mm') {
    kernel ??= await loadKernel()
    const k = kernel, n = a.n!
    for (let i = 0; i < 2 * n * n; i++) k.f32[i] = ((i * 2654435761) % 1000) / 1000 - 0.5
    const C = k.f32.subarray(2 * n * n, 3 * n * n)
    const reps = calibrateReps((r) => { for (let i = 0; i < r; i++) k.mm(n) }, a.minMs)
    job = { work: 2 * n ** 3 * reps, sample() { C.fill(0); const t = performance.now(); for (let i = 0; i < reps; i++) k.mm(n); return this.work / ((performance.now() - t) / 1e3) / 1e9 } }
  } else {
    const n = Math.floor(a.bytes! / 8)
    const A = new Float64Array(n), B = new Float64Array(n).fill(1), C = new Float64Array(n).fill(2) // RangeError here halves the size on the page
    const reps = calibrateReps((r) => triad(A, B, C, 3, r), a.minMs)
    job = { work: 24 * n * reps, sample() { const t = performance.now(); triad(A, B, C, 3, reps); return this.work / ((performance.now() - t) / 1e3) / 1e9 } }
  }
  return { ok: true }
}

function run(a: { startAt: number; budgetMs: number; minSamples?: number; maxSamples?: number; sustain?: boolean }, id: number) {
  const j = job!
  while (epoch() < a.startAt) { /* spin: all workers start together */ }
  const t0 = performance.now()
  if (a.sustain) {
    let ops = 0, last = t0
    while (performance.now() - t0 < a.budgetMs) { j.sample(); ops += j.work; if (performance.now() - last > 150) { post({ type: 'tick', id, elapsed: performance.now() - t0 }); last = performance.now() } }
    return { flop: ops, ms: performance.now() - t0 }
  }
  let last = t0
  return collectSamples(() => j.sample(), {
    warmups: 0, budgetMs: a.budgetMs, minSamples: a.minSamples, maxSamples: a.maxSamples,
    onSample: (v) => { if (performance.now() - last > 120) { post({ type: 'tick', id, value: v, elapsed: performance.now() - t0 }); last = performance.now() } },
  }).then((r) => ({ samples: r.samples, stopped: r.stopped }))
}

/** Latency (pointer chase) and read bandwidth for each size; >= 5 samples of >= minMs each. */
async function sweep(a: { sizes: number[]; minMs: number }, id: number) {
  const rows: { bytes: number; lat: number[]; bw: number[] }[] = []
  for (let si = 0; si < a.sizes.length; si++) {
    const bytes = a.sizes[si]
    const chain = buildChase(bytes)
    const steps = calibrateReps((r) => { chase(chain, r * 1024) }, a.minMs) * 1024
    const lat = (await collectSamples(() => { const t = performance.now(); chase(chain, steps); return ((performance.now() - t) * 1e6) / steps }, { warmups: 0, budgetMs: 400, minSamples: 5, maxSamples: 7, tol: 0.02 })).samples
    // bandwidth = memcpy (native, so not limited by JS loop speed); the working set is src + dst = `bytes`
    const half = Math.max(8, bytes / 2 / 8), src = new Float64Array(half).fill(1), dst = new Float64Array(half)
    const reps = calibrateReps((r) => { for (let i = 0; i < r; i++) dst.set(src) }, a.minMs)
    const bw = (await collectSamples(() => { const t = performance.now(); for (let i = 0; i < reps; i++) dst.set(src); return (half * 16 * reps) / ((performance.now() - t) / 1e3) / 1e9 }, { warmups: 0, budgetMs: 400, minSamples: 5, maxSamples: 7, tol: 0.02 })).samples
    rows.push({ bytes, lat, bw })
    post({ type: 'tick', id, fraction: (si + 1) / a.sizes.length, bw: median(bw), note: `${bytes >= 2 ** 20 ? bytes / 2 ** 20 + ' MB' : bytes / 1024 + ' KB'}: ${median(lat).toFixed(1)} ns` })
  }
  return { rows }
}

/** OPFS: seq write + flush, seq read, 4K random read QD1, repeated for `rounds`. Own file name, removed afterwards. */
async function store(a: { mb: number; rounds: number; randomMs: number }, id: number) {
  const root = await (navigator as any).storage.getDirectory()
  const name = `ns-bench-${Date.now()}.bin`
  const fh = await root.getFileHandle(name, { create: true })
  const h = await fh.createSyncAccessHandle()
  const CH = 4 * 2 ** 20, n = Math.round(a.mb / 4), total = n * CH
  const chunk = new Uint8Array(CH)
  for (let i = 0; i < CH; i += 4096) chunk[i] = (i >> 12) & 255
  const small = new Uint8Array(4096)
  const rounds: any[] = []
  try {
    for (let r = 0; r < a.rounds; r++) {
      h.truncate(0)
      let t = performance.now()
      for (let i = 0; i < n; i++) h.write(chunk, { at: i * CH })
      h.flush()
      const writeMBs = total / 1e6 / ((performance.now() - t) / 1e3)
      post({ type: 'tick', id, fraction: (r * 3 + 1) / (a.rounds * 3), value: writeMBs, note: 'sequential write' })
      t = performance.now()
      for (let i = 0; i < n; i++) h.read(chunk, { at: i * CH })
      const readMBs = total / 1e6 / ((performance.now() - t) / 1e3)
      post({ type: 'tick', id, fraction: (r * 3 + 2) / (a.rounds * 3), value: readMBs, note: 'sequential read' })
      let x = 123456789 + r, ops = 0
      t = performance.now()
      while (performance.now() - t < a.randomMs) {
        for (let k = 0; k < 32; k++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; h.read(small, { at: ((x >>> 0) % (total / 4096)) * 4096 }); ops++ }
      }
      const iops = ops / ((performance.now() - t) / 1e3)
      rounds.push({ writeMBs, readMBs, randIops: iops, randMBs: (iops * 4096) / 1e6 })
      post({ type: 'tick', id, fraction: (r + 1) / a.rounds, value: (iops * 4096) / 1e6, note: '4K random read' })
    }
  } finally {
    try { h.close() } catch { /* ignore */ }
    try { await root.removeEntry(name) } catch { /* ignore */ }
  }
  return { rounds }
}

function timer() {
  let min = Infinity, last = performance.now()
  const t0 = last
  for (let i = 0; i < 400000 && performance.now() - t0 < 20; i++) { const t = performance.now(), d = t - last; if (d > 0) { if (d < min) min = d; last = t } }
  return { ms: Number.isFinite(min) ? min : 1, sync: typeof (globalThis as any).FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in (globalThis as any).FileSystemFileHandle.prototype }
}

self.onmessage = async (e: MessageEvent) => {
  const { cmd, id, args } = e.data
  try {
    let r: any
    if (cmd === 'ready') r = { ok: true }
    else if (cmd === 'mm') r = await mm(args.n, args.ms, id)
    else if (cmd === 'mem') r = mem(args.mb, args.ms, id)
    else if (cmd === 'cache') r = cache(args.sizes, id)
    else if (cmd === 'storage') r = await storage(args.mb, id)
    else if (cmd === 'prep') r = await prep(args)
    else if (cmd === 'run') r = await run(args, id)
    else if (cmd === 'sweep') r = await sweep(args, id)
    else if (cmd === 'store') r = await store(args, id)
    else if (cmd === 'timer') r = timer()
    post({ type: 'done', id, result: r })
  } catch (err: any) {
    post({ type: 'done', id, error: String(err?.message ?? err) })
  }
}
