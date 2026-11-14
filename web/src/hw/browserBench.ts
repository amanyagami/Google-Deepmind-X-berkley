// Browser-only mode: the machine measured from inside the page, with no companion installed.
// Emits the same events as the companion's /ws/bench (stage, progress, result, power), so the score,
// the 3D machine and the power replay work the same way in both modes.
//
// What a browser can and cannot know:
//  - Logical processors, a capped RAM size, the GPU adapter name and the network type are readable.
//  - The CPU model, cache sizes, RAM speed and every power sensor are hidden from web pages.
//    Power here is therefore an ESTIMATE from a small model (see estimatePower), and is labelled so.
import type { ModelSpec, RunStats, Task, TaskInput } from '../api'

/* ================================================================== CONTRACT (frozen in Phase 0; owner: S2)
 * What this browser and device can do. probe() runs once at page load, takes <= 2 s and downloads nothing. */
export interface Capabilities {
  isolated: boolean; cores: number; deviceMemoryGB: number | null; simd: boolean
  timerResolutionMs: { page: number; worker: number | null }
  gpu: { available: boolean; software: boolean; f16: boolean; timestamps: boolean; adapter: string | null; canaryOk: boolean | null; maxBuffer: number | null }
  opfs: { available: boolean; syncHandle: boolean; quotaBytes: number | null }
  net: { type: string | null; saveData: boolean; online: boolean }
  battery: { charging: boolean; level: number } | null
  profile: 'lite' | 'standard' | 'full'
}
export async function probe(): Promise<Capabilities> { throw new Error('probe: not implemented (stream S2)') }
/* ================================================================== */

export type Emit = (m: any) => void

/* ------------------------------------------------------------------------------------- info */
async function gpuName(): Promise<string | null> {
  try {
    const ad = await (navigator as any).gpu?.requestAdapter?.()
    const i = ad?.info ?? (await ad?.requestAdapterInfo?.())
    if (i && (i.description || i.vendor)) return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ')
  } catch { /* fall through */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null
  } catch { return null }
}

export async function browserInfo(): Promise<any> {
  const n = navigator.hardwareConcurrency || 4
  const mem = (navigator as any).deviceMemory as number | undefined
  const conn = (navigator as any).connection
  const uaData = (navigator as any).userAgentData
  let platform = navigator.platform
  try { const h = await uaData?.getHighEntropyValues?.(['platform', 'platformVersion', 'architecture']); if (h) platform = `${h.platform} ${h.platformVersion ?? ''} ${h.architecture ?? ''}`.trim() } catch { /* ignore */ }
  let quota: number | null = null
  try { quota = (await navigator.storage.estimate()).quota ?? null } catch { /* ignore */ }
  const gpu = await gpuName()
  return {
    source: 'browser',
    os: platform, python: null, torch: null,
    cpu: {
      name: 'CPU (model hidden from web pages)', vendor: '', cores: n, threads: n, base_mhz: null, isa: 'WebAssembly SIMD128',
      threads_used: n, caches: {}, per_core_cache: {}, flops_per_cycle: null, flops_basis: null, peak_gflops_est: null,
      peak_note: 'browsers report logical processors only', logical_only: true,
    },
    ram: { total: mem ? mem * 2 ** 30 : null, total_note: mem ? `browsers report at most 8 GB (${mem} GB reported)` : 'not reported by this browser', sticks: [], channels: null, mts: null, type: null, peak_gbps_est: null },
    gpus: gpu ? [{ name: gpu, integrated: /intel|radeon(?!.*rx)|uhd|iris|apple|adreno|mali/i.test(gpu), used: false }] : [],
    disks: [{ name: 'Browser storage (OPFS)', media: 'sandboxed', bus: 'via the OS file cache', bytes: quota }],
    nics: conn ? [{ name: `${conn.effectiveType ?? 'network'}${conn.type ? ' · ' + conn.type : ''}`, link: conn.downlink ? `~${conn.downlink} Mbit/s (browser estimate)` : '' }] : [],
    pcie: [],
    power: { measured: false, per_core: false, source: 'estimate', thermal_note: '' },
  }
}

/* ------------------------------------------------------------------------------ power model */
// Package power vs number of busy threads, fitted to RAPL readings on one test PC (AMD 8-core / 16-thread
// laptop chip, ~54 W class): 9 W idle, 30 W one busy core, 60 W all cores. Shape P = T*(0.17 + 0.39*busy^0.45),
// scaled by the TDP class the user sets. An estimate, never shown as a measurement.
export function estimatePower(tdp: number, busy: number, threads: number, intensity = 1) {
  const cores = Math.max(1, threads / 2)
  const b = Math.min(cores, busy) * intensity
  const pkg = tdp * (0.17 + 0.39 * Math.pow(b, 0.45) * (b > 0 ? 1 : 0))
  const idleCore = (tdp * 0.17 * 0.6) / cores
  const perBusy = b > 0 ? (pkg - tdp * 0.17) / b : 0
  const core_w = Array.from({ length: Math.round(cores) }, (_, k) => +(idleCore + (k < Math.round(b / intensity) ? perBusy * intensity : 0)).toFixed(2))
  return { pkg_w: +pkg.toFixed(2), core_w }
}

/* ---------------------------------------------------------------------------------- workers */
function spawn(): Worker { return new Worker(new URL('./benchWorker.ts', import.meta.url), { type: 'module' }) }

function call(w: Worker, id: number, cmd: string, args: any, onTick?: (m: any) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const h = (e: MessageEvent) => {
      const m = e.data
      if (m.id !== id) return
      if (m.type === 'tick') onTick?.(m)
      if (m.type === 'done') { w.removeEventListener('message', h); m.error ? reject(new Error(m.error)) : resolve(m.result) }
    }
    w.addEventListener('message', h)
    w.postMessage({ cmd, id, args })
  })
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
function spread(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length))
  return { n: xs.length, min: +s[0]?.toFixed(2), median: +median(xs).toFixed(2), max: +s[s.length - 1]?.toFixed(2), cv_pct: m ? +((100 * sd) / m).toFixed(1) : 0 }
}

/* ------------------------------------------------------------------------------------- run */
export interface BrowserBenchOpts { tdp: number; ai: boolean }

export async function runBrowserBench(emit: Emit, opts: BrowserBenchOpts) {
  const threads = navigator.hardwareConcurrency || 4
  const pool = Array.from({ length: threads }, spawn)
  await Promise.all(pool.map((w, i) => call(w, i, 'ready', {})))
  let stageName = 'idle', busy = 0, intensity = 1
  const t0 = performance.now()
  const samples: any[] = []
  const prog = (name: string, unit: string) => {
    let best = 0
    return (v: number) => { best = Math.max(best, v); emit({ type: 'progress', name, value: +v.toFixed(2), best: +best.toFixed(2), unit, extra: [] }) }
  }
  const timer = setInterval(() => {
    const p = estimatePower(opts.tdp, busy, threads, intensity)
    const row = { t: +((performance.now() - t0) / 1000).toFixed(3), stage: stageName, ...p, mhz: null, util: p.core_w.map((_, k) => (k < busy ? 100 : 2)), estimated: true }
    samples.push(row); emit({ type: 'power', ...row })
  }, 100)
  const stage = (name: string, b: number, inten = 1) => { stageName = name; busy = b; intensity = inten; emit({ type: 'stage', name }) }
  const done = (name: string, data: any) => emit({ type: 'result', name, data })
  try {
    stage('idle', 0); await new Promise((r) => setTimeout(r, 800))

    // CPU, one thread: the hand-written WASM SIMD kernel
    stage('matmul_1', 1)
    const p1 = prog('matmul_1', 'GFLOP/s')
    const r1 = await call(pool[0], 0, 'mm', { n: 256, ms: 1600 }, (m) => p1(m.value))
    done('matmul_1', { gflops: +Math.max(...r1.samples).toFixed(1), threads: 1, n: 256, spread: spread(r1.samples), engine: 'WASM SIMD (hand-written kernel)' })

    // CPU, every thread at once: the sum of what the workers achieved over the same window
    stage('matmul_n', threads)
    const pn = prog('matmul_n', 'GFLOP/s')
    const per = new Array(threads).fill(0)
    const t = performance.now()
    const rs = await Promise.all(pool.map((w, i) => call(w, 100 + i, 'mm', { n: 256, ms: 1800 }, (m) => { per[i] = m.value; pn(per.reduce((a, b) => a + b, 0)) })))
    const secs = (performance.now() - t) / 1000
    const total = rs.reduce((a, r) => a + r.flop, 0) / secs / 1e9
    done('matmul_n', { gflops: +total.toFixed(1), threads, n: 256, spread: spread(rs.map((r) => median(r.samples))), engine: 'WASM SIMD in one Web Worker per thread' })

    // RAM: big copies in every worker at once
    stage('dram', threads, 0.75)
    const pm = prog('dram', 'GB/s')
    const memW = Math.min(threads, 8)
    const perm = new Array(memW).fill(0)
    const rm = await Promise.all(pool.slice(0, memW).map((w, i) => call(w, 200 + i, 'mem', { mb: 64, ms: 1500 }, (m) => { perm[i] = m.value; pm(perm.reduce((a, b) => a + b, 0)) })))
    const agg = rm.reduce((a, r) => a + median(r.samples), 0)
    done('dram', { copy_gbps: +agg.toFixed(1), read_gbps: null, array_mb: 128 * memW, spread: spread(rm.map((r) => median(r.samples))), engine: `${memW} workers copying 64 MB each` })

    // cache curve: one worker, growing working set
    stage('cache', 1)
    const pc = prog('cache', 'GB/s')
    const rc = await call(pool[0], 300, 'cache', { sizes: [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072] }, (m) => pc(m.value))
    done('cache', rc.curve)

    // storage: the page's private file system (goes through the OS cache, so it is not a raw SSD figure)
    stage('disk', 1, 0.4)
    const pd = prog('disk', 'GB/s')
    try {
      const rd = await call(pool[0], 400, 'storage', { mb: 256 }, (m) => pd(m.value))
      done('disk', { gbps: rd.read_gbps, write_gbps: rd.write_gbps, mb: rd.mb, cached: true, file: 'browser storage (OPFS)' })
    } catch (e: any) { done('disk', null); emit({ type: 'note', name: 'disk', message: `Browser storage test unavailable: ${e.message}` }) }
    pool.forEach((w) => w.terminate())

    // network: 24 MB from the Hugging Face Hub
    stage('net', 0)
    done('net', await netTest(prog('net', 'Mbit/s')))

    // GPU: WebGPU tiled matmul
    stage('gpu', 0)
    const pg = prog('gpu', 'GFLOP/s')
    done('gpu', await gpuBench((v) => pg(v)))

    if (opts.ai) {
      stage('ai_load', 1, 0.3)
      const gen = await loadBrowserLM((x) => emit({ type: 'note', name: 'ai_load', message: x }))
      stage('ai', threads, 0.6)
      done('ai', gen ? await browserLM(gen, prog('ai', 'tokens/s')) : null)
    }
    stage('cool', 0); await new Promise((r) => setTimeout(r, 600))
  } finally {
    clearInterval(timer)
    pool.forEach((w) => w.terminate())
  }
  done('power', { summary: summarise(samples), samples, source: `estimate (no power sensor in browsers; TDP class ${opts.tdp} W)`, estimated: true })
}

export function summarise(s: any[]) {
  const by: Record<string, any> = {}
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i], b = s[i + 1], dt = b.t - a.t
    const d = (by[a.stage] ??= { joules: 0, seconds: 0, peak_w: 0, core_j: a.core_w.map(() => 0) })
    // each interval belongs wholly to the sample that starts it, so a test's average never exceeds its peak
    d.joules += a.pkg_w * dt; d.seconds += dt; d.peak_w = Math.max(d.peak_w, a.pkg_w)
    a.core_w.forEach((x: number, k: number) => { d.core_j[k] += x * dt })
  }
  for (const k in by) { const d = by[k]; d.avg_w = d.seconds ? +(d.joules / d.seconds).toFixed(2) : null; d.joules = +d.joules.toFixed(2); d.seconds = +d.seconds.toFixed(2); d.core_j = d.core_j.map((x: number) => +x.toFixed(2)) }
  return by
}

async function netTest(p: (v: number) => void) {
  const url = 'https://huggingface.co/openai-community/gpt2/resolve/main/model.safetensors'
  const want = 24 * 2 ** 20
  try {
    const ctl = new AbortController()
    const t0 = performance.now()
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' })
    const ttfb = performance.now() - t0
    const rd = r.body!.getReader()
    let got = 0
    const t1 = performance.now()
    while (got < want) {
      const { done, value } = await rd.read()
      if (done) break
      got += value.length
      p((got * 8) / ((performance.now() - t1) / 1000) / 1e6)
    }
    ctl.abort()
    const dt = (performance.now() - t1) / 1000
    return { mbps: Math.round((got * 8) / dt / 1e6), mbytes_s: +(got / dt / 1e6).toFixed(1), latency_ms: Math.round(ttfb), mb: Math.round(got / 1e6) }
  } catch { return null }
}

/* ------------------------------------------------------------------- language model in the page */
export const BROWSER_LM = 'HuggingFaceTB/SmolLM2-135M-Instruct'
let lmCache: Promise<any> | null = null

export function loadBrowserLM(note: (s: string) => void): Promise<any> {
  lmCache ??= (async () => {
    try {
      const tf: any = await import('@huggingface/transformers')
      try { tf.env.backends.onnx.logLevel = 'error' } catch { /* older versions */ }
      // Transformers.js 4 fetches the ONNX Runtime WebAssembly files from the CDN by itself
      const webgpu = !!(await (navigator as any).gpu?.requestAdapter?.())
      note(webgpu ? 'Downloading SmolLM2-135M (118 MB, once) to run on the GPU through WebGPU…' : 'Downloading SmolLM2-135M (137 MB, once) to run on the CPU through WebAssembly…')
      const gen = await tf.pipeline('text-generation', BROWSER_LM, { device: webgpu ? 'webgpu' : 'wasm', dtype: webgpu ? 'q4f16' : 'q8' })
      return { gen, tf, device: webgpu ? 'webgpu' : 'wasm', dtype: webgpu ? 'q4f16' : 'q8' }
    } catch (e) { lmCache = null; note(`Could not load the model in the browser: ${(e as Error).message}`); return null }
  })()
  return lmCache
}

export async function browserLM(lm: any, p: (v: number) => void, n = 32) {
  const times: number[] = []
  let last = 0, calls = 0
  // generate() calls put() once with the prompt, then once per new token
  class Clock extends lm.tf.BaseStreamer {
    put() { const now = performance.now(); if (calls++ > 0 && last) { times.push(now - last); p(1000 / (now - last)) } last = now }
    end() { /* nothing */ }
  }
  const streamer = new Clock()
  let text = ''
  const out = await lm.gen('The capital of France is', { max_new_tokens: n, do_sample: false, streamer })
  text = out?.[0]?.generated_text ?? ''
  const steady = times.slice(2)
  const tps = steady.length ? 1000 / median(steady) : null
  return tps ? { tps: +tps.toFixed(1), model: BROWSER_LM, tokens: times.length + 1, device: lm.device, dtype: lm.dtype, spread: spread(steady.map((x) => 1000 / x)), text } : null
}

/* ------------------------------------------------------------------ WebGPU matrix multiply */
// Real GPU benchmark through WebGPU: a tiled 1024 x 1024 fp32 matrix multiply (2.1 GFLOP per run).
// PyTorch on this install is a CPU build, so this is how the integrated GPU gets measured at all.

const GN = 1024
const WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
const N: u32 = ${GN}u;
const TS: u32 = 16u;
var<workgroup> As: array<f32, 256>;
var<workgroup> Bs: array<f32, 256>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  var acc = 0.0;
  for (var t = 0u; t < GN / TS; t = t + 1u) {
    As[l.y * TS + l.x] = A[g.y * GN + t * TS + l.x];
    Bs[l.y * TS + l.x] = B[(t * TS + l.y) * GN + g.x];
    workgroupBarrier();
    for (var k = 0u; k < TS; k = k + 1u) { acc = acc + As[l.y * TS + k] * Bs[k * TS + l.x]; }
    workgroupBarrier();
  }
  C[g.y * GN + g.x] = acc;
}`

export interface GpuResult { gflops: number; adapter: string; n: number; unavailable?: false }

export async function gpuBench(onProgress: (v: number, best: number) => void): Promise<GpuResult | { unavailable: true; reason: string }> {
  const gpu = (navigator as any).gpu
  if (!gpu) return { unavailable: true, reason: 'This browser has no WebGPU.' }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { unavailable: true, reason: 'No WebGPU adapter found.' }
    const ai = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
    const name = [ai.vendor, ai.architecture, ai.description].filter(Boolean).join(' ') || 'GPU'
    const device = await adapter.requestDevice()
    const U = (globalThis as any).GPUBufferUsage
    const bytes = GN * GN * 4
    const mk = (fill: boolean) => {
      const b = device.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC, mappedAtCreation: fill })
      if (fill) { const a = new Float32Array(b.getMappedRange()); for (let i = 0; i < a.length; i++) a[i] = Math.random() - 0.5; b.unmap() }
      return b
    }
    const A = mk(true), B = mk(true), C = mk(false)
    const module = device.createShaderModule({ code: WGSL })
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [A, B, C].map((buffer, i) => ({ binding: i, resource: { buffer } })) })
    const run = async () => {
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(GN / 16, GN / 16); pass.end()
      const t = performance.now()
      device.queue.submit([enc.finish()])
      await device.queue.onSubmittedWorkDone()
      return (2 * GN ** 3) / ((performance.now() - t) / 1000) / 1e9
    }
    await run() // warm-up: shader compile
    let best = 0
    for (let i = 0; i < 12; i++) { const v = await run(); best = Math.max(best, v); onProgress(v, best) }
    device.destroy?.()
    return { gflops: Math.round(best * 10) / 10, adapter: name, n: GN }
  } catch (e: any) {
    return { unavailable: true, reason: e?.message ?? String(e) }
  }
}

/* ------------------------------------------------------------------ WebAssembly SIMD kernel */
// A hand-assembled WebAssembly SIMD kernel: C += A x B for n x n float32 matrices (n a multiple of 16).
// Layout in the module's own memory: A at 0, B at n*n*4, C at 2*n*n*4. Loop order i-k-j, and the j loop
// handles 16 floats per turn as four 128-bit vectors: c[i, j..j+15] += splat(a[i,k]) * b[k, j..j+15].
// Written by hand so the browser benchmark needs no toolchain and every instruction is visible here.

const uleb = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b) } while (n); return o }
const sleb = (n: number) => { const o: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) { o.push(b); return o } o.push(b | 0x80) } }
const str = (s: string) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))]
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body]
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()]

// opcodes
const get = (i: number) => [0x20, i], set = (i: number) => [0x21, i]
const i32c = (v: number) => [0x41, ...sleb(v)]
const ADD = 0x6a, MUL = 0x6c, SHL = 0x74, GEU = 0x4f
const BLOCK = [0x02, 0x40], LOOP = [0x03, 0x40], END = 0x0b
const brIf = (d: number) => [0x0d, d], br = (d: number) => [0x0c, d]
const f32load = [0x2a, 2, 0]
const simd = (op: number) => [0xfd, ...uleb(op)]
const vload = (off: number) => [...simd(0x00), 4, ...uleb(off)]
const vstore = (off: number) => [...simd(0x0b), 4, ...uleb(off)]
const SPLAT = simd(0x13), FADD = simd(0xe4), FMUL = simd(0xe6)

// locals: 0 n (param) | 1 i, 2 k, 3 rowBytes, 4 Bbase, 5 Cbase, 6 bRow, 7 cRow, 8 jEnd (i32) | 9 av (v128)
const [N, I, K, RB, BB, CB, BR, CR, JE, AV] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

function body(): number[] {
  const madd = (off: number) => [...get(CR), ...get(CR), ...vload(off), ...get(AV), ...get(BR), ...vload(off), ...FMUL, ...FADD, ...vstore(off)]
  const code = [
    ...get(N), ...i32c(2), SHL, ...set(RB),
    ...get(N), ...get(RB), MUL, ...set(BB),
    ...get(BB), ...i32c(1), SHL, ...set(CB),
    ...i32c(0), ...set(I),
    ...BLOCK, ...LOOP,
    ...get(I), ...get(N), GEU, ...brIf(1),
    ...i32c(0), ...set(K),
    ...BLOCK, ...LOOP,
    ...get(K), ...get(N), GEU, ...brIf(1),
    // av = splat(A[i][k])
    ...get(I), ...get(RB), MUL, ...get(K), ...i32c(2), SHL, ADD, ...f32load, ...SPLAT, ...set(AV),
    ...get(BB), ...get(K), ...get(RB), MUL, ADD, ...set(BR),
    ...get(CB), ...get(I), ...get(RB), MUL, ADD, ...set(CR),
    ...get(CR), ...get(RB), ADD, ...set(JE),
    ...BLOCK, ...LOOP,
    ...get(CR), ...get(JE), GEU, ...brIf(1),
    ...madd(0), ...madd(16), ...madd(32), ...madd(48),
    ...get(CR), ...i32c(64), ADD, ...set(CR),
    ...get(BR), ...i32c(64), ADD, ...set(BR),
    ...br(0), END, END,
    ...get(K), ...i32c(1), ADD, ...set(K),
    ...br(0), END, END,
    ...get(I), ...i32c(1), ADD, ...set(I),
    ...br(0), END, END,
    END,
  ]
  const locals = vec([[...uleb(8), 0x7f], [...uleb(1), 0x7b]])
  const fn = [...locals, ...code]
  return [...uleb(fn.length), ...fn]
}

export const MAX_N = 512
export function kernelBytes(): Uint8Array {
  const pages = Math.ceil((3 * MAX_N * MAX_N * 4) / 65536)
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([[0x60, 1, 0x7f, 0]])),            // type: (i32) -> ()
    ...section(3, vec([[0]])),                           // one function of type 0
    ...section(5, vec([[0x00, ...uleb(pages)]])),        // memory
    ...section(7, vec([[...str('mm'), 0x00, 0], [...str('mem'), 0x02, 0]])),
    ...section(10, vec([body()])),
  ]
  return new Uint8Array(bytes)
}

export interface Kernel { mm: (n: number) => void; f32: Float32Array }
export async function loadKernel(): Promise<Kernel> {
  const mod = await WebAssembly.compile(kernelBytes() as BufferSource)
  const instance = await WebAssembly.instantiate(mod)
  const ex = instance.exports as any
  return { mm: ex.mm, f32: new Float32Array(ex.mem.buffer) }
}
