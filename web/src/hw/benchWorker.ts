/// <reference lib="webworker" />
// One benchmark worker = one busy thread. The page starts several at once for the multi-core tests.
import { loadKernel, type Kernel } from './browserBench'

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

self.onmessage = async (e: MessageEvent) => {
  const { cmd, id, args } = e.data
  try {
    let r: any
    if (cmd === 'ready') r = { ok: true }
    else if (cmd === 'mm') r = await mm(args.n, args.ms, id)
    else if (cmd === 'mem') r = mem(args.mb, args.ms, id)
    else if (cmd === 'cache') r = cache(args.sizes, id)
    else if (cmd === 'storage') r = await storage(args.mb, id)
    post({ type: 'done', id, result: r })
  } catch (err: any) {
    post({ type: 'done', id, error: String(err?.message ?? err) })
  }
}
