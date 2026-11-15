// Browser-only mode: the machine measured from inside the page, with no companion installed.
// Emits the same events as the companion's /ws/bench (stage, progress, result, power), so the score,
// the 3D machine and the power replay work the same way in both modes.
//
// What a browser can and cannot know:
//  - Logical processors, a capped RAM size, the GPU adapter name and the network type are readable.
//  - The CPU model, cache sizes, RAM speed and every power sensor are hidden from web pages.
//    Power here is therefore an ESTIMATE from a small model (see estimatePower), and is labelled so.
import type { ModelSpec, RunStats, Task, TaskInput } from '../api'
import type { Flag, Progress, TestResult } from './hwStore'

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
/* ================================================================== */

export type Emit = (m: any) => void

/* ------------------------------------------------------------------------------------- info */
/** "ANGLE (AMD, AMD Radeon(TM) 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "AMD Radeon 780M Graphics". */
export function cleanGpuName(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = String(raw).trim()
  const m = /^ANGLE \((?:[^,]*),\s*(.+?)(?:,\s*[^,]*)?\)$/.exec(s)
  if (m) s = m[1]
  if (/swiftshader|llvmpipe/i.test(s)) return 'Software renderer'
  s = s.replace(/^ANGLE Metal Renderer:\s*/i, '').replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+(Direct3D|OpenGL|Vulkan|Metal|D3D)\d*(\s.*)?$/i, '').replace(/\((TM|R|C)\)/gi, '').replace(/^ANGLE Metal Renderer:\s*/i, '').replace(/\s{2,}/g, ' ').trim()
  return s || null
}
/** The graphics chip's real name as the drawing API reports it (WebGL), which is more specific than WebGPU's vendor + family. */
export function webglGpuName(): string | null {
  try {
    const gl = (document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return null
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = cleanGpuName(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)))
    try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* ignore */ }
    return name && !/^webkit webgl$|^mozilla$/i.test(name) ? name : null
  } catch { return null }
}
async function gpuName(): Promise<string | null> {
  const real = typeof document !== 'undefined' ? webglGpuName() : null
  if (real) return real
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
      try { const root = new URL('ort/', (typeof document !== 'undefined' ? document.baseURI : self.location.href)).href; tf.env.backends.onnx.wasm.wasmPaths = { mjs: root + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: root + 'ort-wasm-simd-threaded.asyncify.wasm' } } catch { /* default location */ }
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

export const MAX_N = 1024
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

/* ================================================================================================
 * S2 MEASUREMENT ENGINE: pure helpers (unit-tested), probe(), and one runner per component.
 * ============================================================================================== */

/* ------------------------------------------------------------------------------- statistics */
export const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
export const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}
/** Coefficient of variation in percent. */
export const cvPct = (xs: number[]) => { const m = mean(xs); return m ? (100 * stdev(xs)) / Math.abs(m) : 0 }
export const geomean = (xs: number[]) => (xs.length && xs.every((x) => x > 0) ? Math.exp(mean(xs.map(Math.log))) : 0)
export const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const T95 = [0, 0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093]
const tcrit = (n: number) => (n < 2 ? Infinity : n < T95.length ? T95[n] : n < 31 ? 2.05 : 1.96)
/** 95 % confidence interval of the median (normal approximation: se = 1.2533 * sd / sqrt(n), Student t for small n). */
export function ci95(xs: number[]): [number, number] {
  const m = median(xs)
  if (xs.length < 2) return [m, m]
  const h = tcrit(xs.length) * 1.2533 * stdev(xs) / Math.sqrt(xs.length)
  return [m - h, m + h]
}
/** Half-width of the CI relative to the median (0.02 = +-2 %). Infinity when it cannot be known yet. */
export function ciRel(xs: number[]): number {
  if (xs.length < 2) return Infinity
  const [lo, hi] = ci95(xs), m = median(xs)
  return m ? (hi - lo) / 2 / Math.abs(m) : Infinity
}
export const shouldStopEarly = (xs: number[], minSamples = 5, tol = 0.02) => xs.length >= minSamples && ciRel(xs) <= tol
export const NOISY_CV = 15
export interface FlagCtx { cv: number; hidden?: boolean; timerMs?: number | null; onBattery?: boolean; isolated?: boolean; halved?: boolean; cancelled?: boolean; custom?: boolean }
export function sampleFlags(c: FlagCtx): Flag[] {
  const f: Flag[] = []
  if (c.cv > NOISY_CV) f.push('noisy')
  if (c.hidden) f.push('hidden-tab')
  if (c.onBattery) f.push('on-battery')
  if (c.isolated === false) f.push('not-isolated')
  if (c.timerMs != null && c.timerMs >= 1) f.push('coarse-timer')
  if (c.halved) f.push('size-halved')
  if (c.cancelled) f.push('cancelled')
  if (c.custom) f.push('custom')
  return f
}
/** Minimum duration of one sample: 50 ms, or 250 ms when the timer is 1 ms or coarser. */
export const minSampleMs = (timerMs: number | null | undefined) => (timerMs != null && timerMs >= 1 ? 250 : 50)

/* ------------------------------------------------------------------------- caps and halving */
export const clampInt = (x: number, lo: number, hi: number, step = 1) => {
  const raw = Math.round(x / step) * step
  const v = Math.min(hi, Math.max(lo, raw))
  return { value: v, clamped: v !== raw }
}
/** Bytes this page may use for a test: `fraction` of device memory (unknown memory is treated as 4 GB). */
export const memoryBudget = (deviceMemoryGB: number | null, fraction = 0.12) => (deviceMemoryGB ?? 4) * 2 ** 30 * fraction
/** RAM test plan: threads x 3 arrays per worker, each array >= 4x the largest cache knee, total <= 12 % of memory. */
export function planTriad(o: { deviceMemoryGB: number | null; threads: number; kneeBytes: number | null; requestedMB: number | null }) {
  const MB = 2 ** 20
  const want = o.requestedMB != null ? clampInt(o.requestedMB, 16, 128).value * MB : Math.max(16 * MB, Math.min(128 * MB, 4 * (o.kneeBytes ?? 8 * MB)))
  const maxArr = Math.floor(memoryBudget(o.deviceMemoryGB) / (3 * Math.max(1, o.threads)) / MB) * MB
  const arr = Math.max(MB, Math.min(want, maxArr))
  return { arrayBytes: arr, halved: arr < want, memoryUnknown: o.deviceMemoryGB == null }
}
/** Cache sweep sizes: 12 sizes, 16 KB to 64 MB; the largest is capped (lite: 32 MB; else 25 % of the memory budget). */
export function cacheSizes(profile: Capabilities['profile'], deviceMemoryGB: number | null): number[] {
  const cap = profile === 'lite' ? 32 * 2 ** 20 : Math.max(2 ** 20, memoryBudget(deviceMemoryGB, 1) * 0.25 * 0.5)
  return SWEEP_SIZES.filter((s) => s <= cap)
}
/** Run fn(size); on RangeError halve the size (down to `min`) and try again. */
export async function withHalving<T>(fn: (size: number) => Promise<T>, size: number, min: number): Promise<{ result: T; size: number; halved: boolean }> {
  let s = size, halved = false
  for (;;) {
    try { return { result: await fn(s), size: s, halved } } catch (e) {
      const oom = e instanceof RangeError || (e as any)?.name === 'GPUOutOfMemoryError' || /out of memory|allocation|invalid (typed )?array length/i.test(String((e as any)?.message))
      if (!oom || s / 2 < min) throw e
      s = Math.floor(s / 2); halved = true
    }
  }
}
export const chooseProfile = (o: { deviceMemoryGB: number | null; cores: number; mobile: boolean; gpuOk: boolean }): Capabilities['profile'] =>
  (o.deviceMemoryGB != null && o.deviceMemoryGB <= 2) || o.mobile ? 'lite' : o.cores >= 8 && (o.deviceMemoryGB ?? 0) >= 8 && o.gpuOk ? 'full' : 'standard'

/* ------------------------------------------------------------------------- knee detection */
/** Cache boundaries from a latency curve: the largest size still on a plateau before each rise. Up to 3 (L1, L2, L3). */
export function findKnees(sizes: number[], lat: number[], rise = 1.3): number[] {
  const knees: number[] = []
  if (sizes.length < 3) return knees
  let plateau = lat[0], i = 1
  while (i < sizes.length && knees.length < 3) {
    // a step of >30 % between neighbours, or >2x the plateau it started from (slow creep that adds up)
    if (lat[i] > lat[i - 1] * rise || lat[i] > plateau * 2) {
      knees.push(sizes[i - 1])
      let j = i
      while (j + 1 < sizes.length && lat[j + 1] > lat[j] * 1.15) j++ // still climbing through the transition
      plateau = lat[j]; i = j + 1
    } else i++
  }
  return knees
}

/* ---------------------------------------------------------------------------- run control */
export interface Clock { now(): number }
export const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
/** Disposers (worker.terminate, device.destroy, ...) fire synchronously on abort; latency is measured with an injectable clock. */
export class RunScope {
  private fns: (() => void)[] = []
  firedAt: number | null = null
  latencyMs: number | null = null
  constructor(readonly signal: AbortSignal, private clock: Clock = performance) {
    if (signal.aborted) this.fire(); else signal.addEventListener('abort', () => this.fire(), { once: true })
  }
  get aborted() { return this.firedAt != null || this.signal.aborted }
  add(fn: () => void) { if (this.firedAt != null) { try { fn() } catch { /* ignore */ } } else this.fns.push(fn) }
  private fire() {
    if (this.firedAt != null) return
    this.firedAt = this.clock.now()
    for (const f of this.fns.splice(0)) { try { f() } catch { /* ignore */ } }
    this.latencyMs = this.clock.now() - this.firedAt
  }
  /** Normal end: run the disposers without marking an abort. */
  dispose() { for (const f of this.fns.splice(0)) { try { f() } catch { /* ignore */ } } }
}

export interface SampleOpts {
  clock?: Clock; signal?: AbortSignal; warmups?: number; minSamples?: number; maxSamples?: number
  budgetMs: number; tol?: number; onSample?: (v: number, n: number, elapsedMs: number) => void
}
export interface SampleOut { samples: number[]; cancelled: boolean; stopped: 'ci' | 'budget' | 'max' | 'cancel' }
/** The one sampling loop every test uses: warm-up discarded, >= minSamples, stop when the median's CI <= tol, budget, or abort. */
export async function collectSamples(measure: () => number | Promise<number>, o: SampleOpts): Promise<SampleOut> {
  const clock = o.clock ?? performance, min = o.minSamples ?? 5, max = o.maxSamples ?? 60, tol = o.tol ?? 0.02
  const samples: number[] = []
  const gone = () => !!o.signal?.aborted
  for (let w = 0; w < (o.warmups ?? 1); w++) { if (gone()) return { samples, cancelled: true, stopped: 'cancel' }; await measure() }
  const t0 = clock.now()
  for (;;) {
    if (gone()) return { samples, cancelled: true, stopped: 'cancel' }
    const v = await measure()
    if (gone()) return { samples, cancelled: true, stopped: 'cancel' }
    samples.push(v)
    const el = clock.now() - t0
    o.onSample?.(v, samples.length, el)
    if (shouldStopEarly(samples, min, tol)) return { samples, cancelled: false, stopped: 'ci' }
    if (samples.length >= max) return { samples, cancelled: false, stopped: 'max' }
    if (el >= o.budgetMs && samples.length >= min) return { samples, cancelled: false, stopped: 'budget' }
    if (el >= 3 * o.budgetMs) return { samples, cancelled: false, stopped: 'budget' }
  }
}
/** Find a repeat count whose run takes >= minMs (this is also the warm-up). fn(reps) runs the op `reps` times. */
export function calibrateReps(fn: (reps: number) => void, minMs: number, clock: Clock = performance, maxReps = 1 << 24): number {
  let reps = 1
  for (;;) {
    const t = clock.now(); fn(reps); const dt = clock.now() - t
    if (dt >= minMs || reps >= maxReps) return reps
    reps = Math.min(maxReps, Math.ceil(reps * (dt <= 0 ? 16 : Math.min(16, Math.max(2, (minMs * 1.15) / dt)))))
  }
}

/* ------------------------------------------------------------------ keeping the main thread free */
/** Give the browser a turn (rendering, input). scheduler.yield() when present, else a macrotask. */
export const yieldMain = (): Promise<void> => {
  const sch = (globalThis as any).scheduler
  return typeof sch?.yield === 'function' ? sch.yield() : new Promise<void>((r) => setTimeout(r, 0))
}
/** Fill arr[i] = f(i) in slices of <= sliceMs, yielding between slices (large host-side buffers for the GPU test). */
export async function fillSliced(arr: Float32Array, f: (i: number) => number, sliceMs = 8, clock: Clock = performance, yielder: () => Promise<void> = yieldMain): Promise<number> {
  let yields = 0, t = clock.now()
  for (let i = 0; i < arr.length; i++) {
    arr[i] = f(i)
    if ((i & 1023) === 1023 && clock.now() - t >= sliceMs) { await yielder(); yields++; t = clock.now() }
  }
  return yields
}
/** Repeat count for the next size from the measured rate of the previous one (work units per ms), so no calibration pass is needed. */
export const repsFromRate = (minMs: number, ratePerMs: number, workPerRep: number, max = 1 << 24) =>
  Math.max(1, Math.min(max, Math.ceil((minMs * 1.1 * ratePerMs) / workPerRep)))
/** Cache sweep sizes with the interior of the plateaus thinned out: 16/32/64 KB (L1), 256K..2 MB (L2), 4..32 MB (L3), 64 MB (DRAM). */
export const SWEEP_SIZES = [16, 32, 64, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].map((k) => k * 1024)

/* ---------------------------------------------------------------------------------- kernels (pure JS) */
/** Random single-cycle pointer chain, one pointer per 64-byte line (Sattolo), so the footprint is exactly `bytes`. */
export function buildChase(bytes: number, rng: () => number = Math.random, into?: Uint32Array): Uint32Array {
  const lines = Math.max(2, bytes >> 6), a = into ? into.subarray(0, lines * 16) : new Uint32Array(lines * 16), ord = new Uint32Array(lines)
  for (let i = 0; i < lines; i++) ord[i] = i
  for (let i = lines - 1; i > 0; i--) { const j = Math.floor(rng() * i), t = ord[i]; ord[i] = ord[j]; ord[j] = t }
  for (let i = 0; i < lines; i++) a[ord[i] * 16] = ord[(i + 1) % lines] * 16
  return a
}
export function chase(a: Uint32Array, steps: number): number {
  let p = 0
  for (let s = 0; s < steps; s += 4) { p = a[p]; p = a[p]; p = a[p]; p = a[p] }
  return p
}
export function readSum(a: Float64Array, reps: number): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0
  const n = a.length
  for (let r = 0; r < reps; r++) for (let i = 0; i < n; i += 4) { s0 += a[i]; s1 += a[i + 1]; s2 += a[i + 2]; s3 += a[i + 3] }
  return s0 + s1 + s2 + s3
}
/** STREAM triad a = b + s*c: 24 bytes per element. */
export function triad(a: Float64Array, b: Float64Array, c: Float64Array, s: number, reps: number) {
  const n = a.length
  for (let r = 0; r < reps; r++) for (let i = 0; i < n; i++) a[i] = b[i] + s * c[i]
}

/* ----------------------------------------------------------------------------------------- probe */
const withTimeout = <T>(p: Promise<T>, ms: number, dflt: T): Promise<T> =>
  Promise.race([p.catch(() => dflt), new Promise<T>((r) => setTimeout(() => r(dflt), ms))])

export function pageTimerMs(): number {
  let min = Infinity, last = performance.now()
  const t0 = last
  for (let i = 0; i < 400000 && performance.now() - t0 < 20; i++) {
    const t = performance.now(), d = t - last
    if (d > 0) { if (d < min) min = d; last = t }
  }
  return Number.isFinite(min) ? min : 1
}
/** One throw-away worker: its timer resolution and whether OPFS sync handles exist there (they are worker-only). */
async function workerProbe(): Promise<{ ms: number | null; sync: boolean }> {
  let w: Worker | null = null
  try {
    w = spawn()
    return await withTimeout(call(w, 1, 'timer', {}).then((r) => ({ ms: r.ms as number, sync: !!r.sync })), 1000, { ms: null, sync: false })
  } catch { return { ms: null, sync: false } } finally { w?.terminate() }
}

const CANARY_N = 16
const canaryWgsl = (f16: boolean) => `${f16 ? 'enable f16;' : ''}
alias T = ${f16 ? 'f16' : 'f32'};
@group(0) @binding(0) var<storage, read> A: array<T>;
@group(0) @binding(1) var<storage, read> B: array<T>;
@group(0) @binding(2) var<storage, read_write> C: array<T>;
@compute @workgroup_size(16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= 16u) { return; }
  let i = g.x / 4u; let j = g.x % 4u;
  var s = T(0);
  for (var k = 0u; k < 4u; k = k + 1u) { s = s + A[i * 4u + k] * B[k * 4u + j]; }
  C[g.x] = s;
}`
/** 4x4 matmul on the GPU against the CPU, f32 or f16. Values are multiples of 1/4 so f16 is exact. */
async function gpuCanary(device: any, f16: boolean): Promise<boolean> {
  const U = (globalThis as any).GPUBufferUsage, M = (globalThis as any).GPUMapMode
  const A = Array.from({ length: CANARY_N }, (_, i) => ((i * 3) % 7 - 3) / 4), B = Array.from({ length: CANARY_N }, (_, i) => ((i * 5) % 9 - 4) / 4)
  const cpu = Array.from({ length: CANARY_N }, (_, x) => { const i = x >> 2, j = x & 3; let s = 0; for (let k = 0; k < 4; k++) s += A[i * 4 + k] * B[k * 4 + j]; return s })
  const toHalf = (v: number) => {
    if (v === 0) return 0
    const sign = v < 0 ? 0x8000 : 0, a = Math.abs(v), e = Math.floor(Math.log2(a)), m = Math.round((a / 2 ** e - 1) * 1024)
    return sign | ((e + 15) << 10) | m
  }
  const fromHalf = (h: number) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024) }
  const size = f16 ? 32 : 64
  const mk = (data: number[]) => {
    const b = device.createBuffer({ size, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST, mappedAtCreation: true })
    if (f16) new Uint16Array(b.getMappedRange()).set(data.map(toHalf)); else new Float32Array(b.getMappedRange()).set(data)
    b.unmap(); return b
  }
  const a = mk(A), b = mk(B), c = device.createBuffer({ size, usage: U.STORAGE | U.COPY_SRC })
  const rd = device.createBuffer({ size, usage: U.MAP_READ | U.COPY_DST })
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: canaryWgsl(f16) }), entryPoint: 'main' } })
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [a, b, c].map((buffer, i) => ({ binding: i, resource: { buffer } })) })
  const enc = device.createCommandEncoder(), pass = enc.beginComputePass()
  pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(1); pass.end()
  enc.copyBufferToBuffer(c, 0, rd, 0, size)
  device.queue.submit([enc.finish()])
  await rd.mapAsync(M.READ)
  const out = f16 ? Array.from(new Uint16Array(rd.getMappedRange().slice(0))).map(fromHalf) : Array.from(new Float32Array(rd.getMappedRange().slice(0)))
  rd.unmap()
  return out.every((v, i) => Math.abs(v - cpu[i]) < 1e-3) && out.some((v) => v !== 0)
}

const SOFTWARE_RE = /swiftshader|llvmpipe|software|basic render|microsoft basic|softpipe/i
async function probeGpu(): Promise<Capabilities['gpu']> {
  const real = typeof document !== 'undefined' ? webglGpuName() : null
  const none = { available: false, software: false, f16: false, timestamps: false, adapter: real, canaryOk: null, maxBuffer: null }
  const gpu = (navigator as any).gpu
  if (!gpu) return none
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) return none
  const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
  const name = real ?? ([info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || null)
  const software = !!(adapter.isFallbackAdapter ?? info.isFallbackAdapter) || SOFTWARE_RE.test([info.vendor, info.architecture, info.description].filter(Boolean).join(' '))
  let f16 = adapter.features?.has('shader-f16') ?? false
  const timestamps = adapter.features?.has('timestamp-query') ?? false
  const out = { available: true, software, f16, timestamps, adapter: name, canaryOk: null as boolean | null, maxBuffer: (adapter.limits?.maxBufferSize as number) ?? null }
  if (software) return out
  let device: any = null
  try {
    device = await adapter.requestDevice({ requiredFeatures: f16 ? ['shader-f16'] : [] })
    out.canaryOk = await gpuCanary(device, false)
    if (f16) f16 = await gpuCanary(device, true).catch(() => false)
  } catch { out.canaryOk = false } finally { try { device?.destroy() } catch { /* ignore */ } }
  out.f16 = f16
  return out
}
async function probeOpfs(): Promise<Capabilities['opfs']> {
  const s = (navigator as any).storage
  const available = typeof s?.getDirectory === 'function'
  const syncHandle = available && typeof (globalThis as any).FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in (globalThis as any).FileSystemFileHandle.prototype
  let quotaBytes: number | null = null
  try { quotaBytes = (await s.estimate()).quota ?? null } catch { /* ignore */ }
  return { available, syncHandle, quotaBytes }
}

let probeCache: Promise<Capabilities> | null = null
/** Runs once (the result is remembered). <= 2 s, downloads nothing. */
export function probe(): Promise<Capabilities> { return (probeCache ??= probeNow()) }
export function resetProbe() { probeCache = null }
async function probeNow(): Promise<Capabilities> {
  const nav = navigator as any
  const cores = navigator.hardwareConcurrency || 4
  const deviceMemoryGB: number | null = nav.deviceMemory ?? null
  let simd = false
  try { simd = WebAssembly.validate(kernelBytes() as BufferSource) } catch { /* no wasm */ }
  const conn = nav.connection
  const gpuNone: Capabilities['gpu'] = { available: false, software: false, f16: false, timestamps: false, adapter: null, canaryOk: null, maxBuffer: null }
  const [wp, gpu, opfs0, battery] = await Promise.all([
    workerProbe(),
    withTimeout(probeGpu(), 1600, gpuNone),
    withTimeout(probeOpfs(), 800, { available: false, syncHandle: false, quotaBytes: null } as Capabilities['opfs']),
    withTimeout((async () => { const b = await nav.getBattery?.(); return b ? { charging: !!b.charging, level: +b.level } : null })(), 500, null),
  ])
  const opfs = { ...opfs0, syncHandle: opfs0.available && wp.sync }
  const mobile = !!nav.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  return {
    isolated: !!(globalThis as any).crossOriginIsolated, cores, deviceMemoryGB, simd,
    timerResolutionMs: { page: +pageTimerMs().toFixed(4), worker: wp.ms },
    gpu, opfs,
    net: { type: conn?.effectiveType ? `${conn.type ? conn.type + ' ' : ''}${conn.effectiveType}`.trim() : conn?.type ?? null, saveData: !!conn?.saveData, online: navigator.onLine },
    battery,
    profile: chooseProfile({ deviceMemoryGB, cores, mobile, gpuOk: gpu.available && !gpu.software }),
  }
}

/* ------------------------------------------------------------------------------ runner plumbing */
export type RunResult = TestResult & { extra?: Record<string, unknown> }
const nowIso = () => new Date().toISOString()
const timerOf = (c: Capabilities) => Math.max(c.timerResolutionMs.page, c.timerResolutionMs.worker ?? 0)

function watchHidden(scope: RunScope) {
  const has = typeof document !== 'undefined'
  let hidden = has && document.hidden
  const h = () => { if (document.hidden) hidden = true }
  if (has) { document.addEventListener('visibilitychange', h); scope.add(() => document.removeEventListener('visibilitychange', h)) }
  return { get hidden() { return hidden }, stop: () => { if (has) document.removeEventListener('visibilitychange', h) } }
}

interface Built {
  component: TestResult['component']; workload: { id: string; v: number }; custom?: boolean; summary: string
  samples: number[]; unit: string; env: TestResult['env']; flags: Flag[]; extra?: Record<string, unknown>
  value?: number; ci?: [number, number]; cv?: number
}
function build(b: Built): RunResult {
  const value = b.value ?? median(b.samples)
  return {
    v: 1, component: b.component, scale: 'browser', workload: b.workload,
    input: { kind: b.custom ? 'custom' : 'default', summary: b.summary },
    samples: b.samples, value, unit: b.unit, ci95: b.ci ?? ci95(b.samples), cv: b.cv ?? cvPct(b.samples),
    score: null, // S3 computes the score from value, REF and the gates
    flags: [...new Set(b.flags)], env: b.env, at: nowIso(), ...(b.extra ? { extra: b.extra } : {}),
  }
}
function baseFlags(caps: Capabilities, hid: { hidden: boolean }, cv: number, cancelled: boolean, extra: Partial<FlagCtx> = {}): Flag[] {
  return sampleFlags({ cv, hidden: hid.hidden, timerMs: timerOf(caps), onBattery: !!caps.battery && !caps.battery.charging, isolated: caps.isolated, cancelled, ...extra })
}

function callW(w: Worker, id: number, cmd: string, args: any, scope: RunScope | null, onTick?: (m: any) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    scope?.add(() => reject(abortError()))
    call(w, id, cmd, args, onTick).then(resolve, reject)
  })
}
/** Workers are created one per turn so spawning 8 of them never holds the main thread. */
async function pool(n: number, scope: RunScope): Promise<Worker[]> {
  const ws: Worker[] = []
  scope.add(() => ws.forEach((w) => w.terminate()))
  for (let i = 0; i < n && !scope.aborted; i++) { ws.push(spawn()); if (i + 1 < n) await yieldMain() }
  return ws
}
const isAbort = (e: any) => e?.name === 'AbortError'
const poolSize = (caps: Capabilities) => Math.max(1, Math.min(8, caps.cores, caps.profile === 'lite' ? 4 : 8))
const epochIn = (ms: number) => performance.timeOrigin + performance.now() + ms

/* ---------------------------------------------------------------------------- CPU: 1 core, all cores */
const MM_WORKLOAD = { id: 'matmul_f32_simd', v: 1 }

export async function run_cpu1(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  const custom = input != null && input !== 256
  const n = clampInt(input ?? 256, 128, 1024, 16).value
  let samples: number[] = [], cancelled = false
  try {
    const [w] = await pool(1, scope)
    await callW(w, 1, 'prep', { kind: 'mm', n, minMs: minSampleMs(timerOf(caps)) }, scope)
    const r = await callW(w, 2, 'run', { startAt: 0, budgetMs: 2500, minSamples: 5, maxSamples: 40 }, scope, (m) => onProgress({ value: m.value, unit: 'GFLOP/s', fraction: Math.min(0.95, (m.elapsed ?? 0) / 2500) }))
    samples = r.samples
  } catch (e) { if (!isAbort(e)) throw e; cancelled = true } finally { scope.dispose(); hid.stop() }
  onProgress({ value: median(samples), unit: 'GFLOP/s', fraction: 1 })
  return build({
    component: 'cpu1', workload: MM_WORKLOAD, custom, summary: `matmul n=${n}, 1 thread`, samples, unit: 'GFLOP/s',
    env: { where: 'wasm', threads: 1, isolated: caps.isolated }, flags: baseFlags(caps, hid, cvPct(samples), cancelled, { custom }),
    extra: { n, peak: samples.length ? Math.max(...samples) : 0 },
  })
}

/** `input` = thread count (1..cores, pool <= 8). */
export async function run_cpun(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  const max = poolSize(caps)
  const custom = input != null && input !== max
  const threads = clampInt(input ?? max, 1, max).value
  const n = 256
  let agg: number[] = [], cancelled = false, sustained = 0
  try {
    const ws = await pool(threads, scope)
    await Promise.all(ws.map((w, i) => callW(w, 10 * i + 1, 'prep', { kind: 'mm', n, minMs: minSampleMs(timerOf(caps)) }, scope)))
    const per = new Array(threads).fill(0)
    const startAt = epochIn(100)
    const rs = await Promise.all(ws.map((w, i) => callW(w, 10 * i + 2, 'run', { startAt, budgetMs: 3500, minSamples: 5, maxSamples: 40 }, scope, (m) => {
      per[i] = m.value; onProgress({ value: per.reduce((a, b) => a + b, 0), unit: 'GFLOP/s', fraction: Math.min(0.55, ((m.elapsed ?? 0) / 3500) * 0.55) })
    })))
    const len = Math.min(...rs.map((r: any) => r.samples.length))
    agg = Array.from({ length: len }, (_, k) => rs.reduce((a: number, r: any) => a + r.samples[k], 0))
    // sustained: 3 s straight on every thread; throughput over the whole window
    const t1 = epochIn(100)
    const ss = await Promise.all(ws.map((w, i) => callW(w, 10 * i + 3, 'run', { startAt: t1, budgetMs: 3000, sustain: true }, scope, (m) => onProgress({ unit: 'GFLOP/s', fraction: 0.55 + Math.min(0.44, ((m.elapsed ?? 0) / 3000) * 0.44) }))))
    sustained = ss.reduce((a: number, r: any) => a + r.flop / (r.ms / 1000) / 1e9, 0)
  } catch (e) { if (!isAbort(e)) throw e; cancelled = true } finally { scope.dispose(); hid.stop() }
  const burst = median(agg), ratio = burst ? sustained / burst : 0
  const flags = baseFlags(caps, hid, cvPct(agg), cancelled, { custom })
  if (!cancelled && sustained && ratio < 0.85) flags.push('sustained-low' as Flag)
  onProgress({ value: burst, unit: 'GFLOP/s', fraction: 1 })
  return build({
    component: 'cpun', workload: MM_WORKLOAD, custom, summary: `matmul n=${n}, ${threads} threads`, samples: agg, unit: 'GFLOP/s',
    env: { where: 'wasm', threads, isolated: caps.isolated }, flags,
    extra: { n, threads, burst, sustained, sustainedRatio: ratio },
  })
}

/* ----------------------------------------------------------------------------------------- cache */
let lastKnees: number[] = []
/** `input` = largest working set in MB (capped by the profile). */
export async function run_cache(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  let sizes = cacheSizes(caps.profile, caps.deviceMemoryGB)
  const custom = input != null
  if (input != null) { const cap = Math.max(2 ** 20, input * 2 ** 20); sizes = sizes.filter((s) => s <= cap) }
  let rows: { bytes: number; lat: number[]; bw: number[] }[] = [], cancelled = false
  try {
    const [w] = await pool(1, scope)
    const r = await callW(w, 1, 'sweep', { sizes, minMs: minSampleMs(timerOf(caps)) }, scope, (m) => onProgress({ fraction: m.fraction, unit: 'GB/s', value: m.bw, note: m.note }))
    rows = r.rows
  } catch (e) { if (!isAbort(e)) throw e; cancelled = true } finally { scope.dispose(); hid.stop() }
  const sz = rows.map((r) => r.bytes), lat = rows.map((r) => median(r.lat)), bw = rows.map((r) => median(r.bw))
  const knees = findKnees(sz, lat)
  if (knees.length) lastKnees = knees
  const l2 = knees[1] ?? knees[0] ?? sz[Math.min(5, sz.length - 1)]
  const l2i = Math.max(0, sz.indexOf(l2)), l2Samples = rows[l2i]?.bw ?? []
  const l3 = knees[2], target = l3 ? 4 * l3 : sz[sz.length - 1]
  const di = sz.findIndex((s) => s >= target), dramI = di < 0 ? sz.length - 1 : di
  const flags = baseFlags(caps, hid, cvPct(l2Samples), cancelled, { custom })
  if (!cancelled && knees.length < 2) flags.push('no-knee' as Flag)
  return build({
    component: 'cache', workload: { id: 'chase_read_sweep', v: 1 }, custom, summary: `${sz.length} sizes, ${sz.length ? sz[0] / 1024 : 0} KB to ${sz.length ? sz[sz.length - 1] / 2 ** 20 : 0} MB`,
    samples: bw, unit: 'GB/s', value: bw[l2i] ?? 0, ci: ci95(l2Samples), cv: cvPct(l2Samples),
    env: { where: 'wasm', threads: 1, isolated: caps.isolated }, flags,
    extra: { sizes: sz, latencyNs: lat, bandwidthGBs: bw, knees, l2BandwidthGBs: bw[l2i] ?? 0, latencyAt4xL3Ns: lat[dramI] ?? 0, dramLatencyNs: lat[lat.length - 1] ?? 0 },
  })
}

/* ------------------------------------------------------------------------------------------ RAM */
/** `input` = MB per array per worker (16-128); total <= 12 % of device memory. */
export async function run_ram(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  const threads = poolSize(caps)
  const plan = planTriad({ deviceMemoryGB: caps.deviceMemoryGB, threads, kneeBytes: lastKnees[2] ?? lastKnees[lastKnees.length - 1] ?? null, requestedMB: input })
  const custom = input != null
  let arrayBytes = plan.arrayBytes, halved = plan.halved, agg: number[] = [], cancelled = false
  try {
    const ws = await pool(threads, scope)
    const prep = await withHalving(async (bytes) => {
      await Promise.all(ws.map((w, i) => callW(w, i + 1, 'prep', { kind: 'triad', bytes, minMs: minSampleMs(timerOf(caps)) }, scope)))
      return bytes
    }, arrayBytes, 2 ** 20)
    if (prep.halved) { halved = true; arrayBytes = prep.size }
    const startAt = epochIn(100)
    const per = new Array(threads).fill(0)
    const rs = await Promise.all(ws.map((w, i) => callW(w, i + 1001, 'run', { startAt, budgetMs: 3500, minSamples: 5, maxSamples: 40 }, scope, (m) => {
      per[i] = m.value; onProgress({ value: per.reduce((a, b) => a + b, 0), unit: 'GB/s', fraction: Math.min(0.99, (m.elapsed ?? 0) / 3500) })
    })))
    const len = Math.min(...rs.map((r: any) => r.samples.length))
    agg = Array.from({ length: len }, (_, k) => rs.reduce((a: number, r: any) => a + r.samples[k], 0))
  } catch (e) { if (!isAbort(e)) throw e; cancelled = true } finally { scope.dispose(); hid.stop() }
  const flags = baseFlags(caps, hid, cvPct(agg), cancelled, { halved, custom })
  if (plan.memoryUnknown) flags.push('fallback:memory-unknown')
  onProgress({ value: median(agg), unit: 'GB/s', fraction: 1 })
  return build({
    component: 'ram', workload: { id: 'stream_triad_f64', v: 1 }, custom, summary: `STREAM triad (24 B/element), ${threads} threads x 3 x ${Math.round(arrayBytes / 2 ** 20)} MB`,
    samples: agg, unit: 'GB/s', env: { where: 'wasm', threads, isolated: caps.isolated }, flags,
    extra: { arrayBytes, threads, totalBytes: arrayBytes * 3 * threads, peak: agg.length ? Math.max(...agg) : 0 },
  })
}

/* ------------------------------------------------------------------------------------- storage */
/** `input` = file size in MB (16-512, <= 10 % of the free quota). Labelled "browser file storage", never "SSD". */
export async function run_storage(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  const custom = input != null && input !== 128
  const wl = { id: 'opfs_seq_rand', v: 1 }
  if (!caps.opfs.available || !caps.opfs.syncHandle) {
    scope.dispose(); hid.stop()
    return build({ component: 'storage', workload: wl, summary: 'browser file storage unavailable', samples: [], unit: 'MB/s', env: { where: 'wasm', isolated: caps.isolated }, flags: ['fallback:no-opfs'], extra: { unavailable: true, label: 'browser file storage' } })
  }
  let mb = clampInt(input ?? 128, 16, 512, 16).value, halved = false
  if (caps.opfs.quotaBytes) { const cap = Math.max(16, Math.floor((caps.opfs.quotaBytes * 0.1) / 2 ** 20 / 16) * 16); if (mb > cap) { mb = cap; halved = true } }
  let rounds: any[] = [], cancelled = false
  try {
    const [w] = await pool(1, scope)
    const r = await withHalving((size) => callW(w, 1, 'store', { mb: size, rounds: 3, randomMs: 330 }, scope, (m) => onProgress({ fraction: m.fraction, unit: 'MB/s', value: m.value, note: m.note })), mb, 16)
    rounds = r.result.rounds; if (r.halved) { halved = true; mb = r.size }
  } catch (e) { if (!isAbort(e)) throw e; cancelled = true } finally { scope.dispose(); hid.stop() }
  const samples = rounds.map((r) => geomean([r.writeMBs, r.readMBs, r.randMBs]))
  const med = (k: string) => median(rounds.map((r) => r[k]))
  const flags = baseFlags(caps, hid, cvPct(samples), cancelled, { halved, custom })
  if (rounds.length && med('readMBs') > 2 * med('writeMBs')) flags.push('cached-read' as Flag)
  if (caps.opfs.quotaBytes != null && caps.opfs.quotaBytes < 2 ** 30) flags.push('small-quota' as Flag)
  onProgress({ value: median(samples), unit: 'MB/s', fraction: 1 })
  return build({
    component: 'storage', workload: wl, custom, summary: `browser file storage, ${mb} MB seq write+flush, seq read, 4K random read QD1`, samples, unit: 'MB/s',
    env: { where: 'wasm', isolated: caps.isolated }, flags,
    extra: { label: 'browser file storage', mb, writeMBs: med('writeMBs'), readMBs: med('readMBs'), randMBs: med('randMBs'), randIops: med('randIops') },
  })
}

/* --------------------------------------------------------------------------------------- GPU */
/** Tiled matmul: 64x64 output tile per 16x16 workgroup, each thread keeps a 4x4 block in registers, k-tile 16. */
export const gpuWgsl = (n: number) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
const N: u32 = ${n}u;
var<workgroup> As: array<f32, 1024>;
var<workgroup> Bs: array<f32, 1024>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let tid = l.y * 16u + l.x;
  let row0 = wg.y * 64u; let col0 = wg.x * 64u;
  var acc: array<f32, 16>;
  for (var t = 0u; t < N / 16u; t = t + 1u) {
    for (var q = 0u; q < 4u; q = q + 1u) {
      let idx = tid + q * 256u;
      As[idx] = A[(row0 + idx / 16u) * N + t * 16u + idx % 16u];
      Bs[idx] = B[(t * 16u + idx / 64u) * N + col0 + idx % 64u];
    }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k = k + 1u) {
      var a: array<f32, 4>; var b: array<f32, 4>;
      for (var i = 0u; i < 4u; i = i + 1u) { a[i] = As[(l.y * 4u + i) * 16u + k]; b[i] = Bs[k * 64u + l.x * 4u + i]; }
      for (var i = 0u; i < 4u; i = i + 1u) { for (var j = 0u; j < 4u; j = j + 1u) { acc[i * 4u + j] = fma(a[i], b[j], acc[i * 4u + j]); } }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i = i + 1u) { for (var j = 0u; j < 4u; j = j + 1u) { C[(row0 + l.y * 4u + i) * N + col0 + l.x * 4u + j] = acc[i * 4u + j]; } }
}`
const hashVal = (i: number, s: number) => { let h = (Math.imul(i, 0x9e3779b1) ^ Math.imul(s, 0x85ebca6b)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; return ((h >>> 8) & 0xffff) / 65536 - 0.5 }

/** `input` = N (512-4096, multiple of 64). A software adapter is reported as unavailable, never scored. */
export async function run_gpu(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  const wl = { id: 'matmul_f32_tiled4x4', v: 1 }
  const custom = input != null && input !== 1024
  const env = (adapter?: string): TestResult['env'] => ({ where: 'webgpu', isolated: caps.isolated, ...(adapter ? { adapter } : {}) })
  const unavailable = (reason: string, flags: Flag[]) => { scope.dispose(); hid.stop(); return build({ component: 'gpu', workload: wl, summary: reason, samples: [], unit: 'GFLOP/s', env: env(caps.gpu.adapter ?? undefined), flags, extra: { unavailable: true, reason } }) }
  if (!caps.gpu.available) return unavailable('No WebGPU on this browser', ['fallback:no-webgpu'])
  if (caps.gpu.software) return unavailable('Software GPU adapter, not scored', ['software-gpu'])
  const lim = Math.min(256 * 2 ** 20, caps.gpu.maxBuffer ?? 256 * 2 ** 20)
  let N = clampInt(input ?? 1024, 512, 4096, 64).value
  while (N * N * 4 > lim && N > 512) N -= 64
  let samples: number[] = [], cancelled = false, halved = false, lost = false, check = { ok: true, worst: 0 }, finalN = N, batchUsed = 1
  let device: any = null
  try {
    const adapter = await (navigator as any).gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return unavailable('No WebGPU adapter', ['fallback:no-webgpu'])
    device = await adapter.requestDevice()
    let destroyed = false
    scope.add(() => { destroyed = true; try { device.destroy() } catch { /* ignore */ } })
    device.lost.then(() => { if (!destroyed) lost = true })
    const U = (globalThis as any).GPUBufferUsage, M = (globalThis as any).GPUMapMode
    const target = minSampleMs(timerOf(caps)) === 250 ? 250 : 100
    const attempt = async (n: number) => {
      device.pushErrorScope('out-of-memory')
      const bytes = n * n * 4
      const hostA = new Float32Array(n * n), hostB = new Float32Array(n * n)
      await fillSliced(hostA, (i) => hashVal(i, 1)); await fillSliced(hostB, (i) => hashVal(i, 2))
      const mk = (src: Float32Array | null) => {
        const b = device.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST, mappedAtCreation: !!src })
        if (src) { new Float32Array(b.getMappedRange()).set(src); b.unmap() }
        return b
      }
      const A = mk(hostA), B = mk(hostB), C = mk(null)
      if (await device.popErrorScope()) throw new RangeError('GPU out of memory')
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: gpuWgsl(n) }), entryPoint: 'main' } })
      const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [A, B, C].map((buffer, i) => ({ binding: i, resource: { buffer } })) })
      const flop = 2 * n ** 3
      const timed = async (batch: number) => {
        const enc = device.createCommandEncoder(), pass = enc.beginComputePass()
        pass.setPipeline(pipe); pass.setBindGroup(0, bind)
        for (let b = 0; b < batch; b++) pass.dispatchWorkgroups(n / 64, n / 64)
        pass.end()
        const t = performance.now()
        device.queue.submit([enc.finish()])
        await device.queue.onSubmittedWorkDone()
        return performance.now() - t
      }
      // batch so that one sample takes >= target ms; this doubles as the warm-up (shader compile, clocks ramp)
      let batch = 1, dt = await timed(1)
      while (dt < target && batch < 4096 && !scope.aborted) { batch = Math.min(4096, Math.ceil(batch * Math.min(8, Math.max(1.5, (target * 1.15) / Math.max(dt, 0.5))))); dt = await timed(batch) }
      let prev = 0
      for (let i = 0; i < 8 && !scope.aborted; i++) { const g = (flop * batch) / (await timed(batch)) / 1e6; if (prev && Math.abs(g - prev) / prev < 0.05) break; prev = g }
      const out = await collectSamples(async () => (flop * batch) / (await timed(batch)) / 1e6, {
        signal, warmups: 0, budgetMs: 4000, minSamples: 5, maxSamples: 30,
        onSample: (v, _k, el) => onProgress({ value: v, unit: 'GFLOP/s', fraction: Math.min(0.95, el / 4000) }),
      })
      // spot-check one result against the CPU (double precision)
      let worst = 0
      if (!scope.aborted && !lost) {
        const rd = device.createBuffer({ size: bytes, usage: U.MAP_READ | U.COPY_DST })
        const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(C, 0, rd, 0, bytes); device.queue.submit([enc.finish()])
        await rd.mapAsync(M.READ)
        const got = new Float32Array(rd.getMappedRange())
        for (let q = 0; q < 24; q++) {
          const i = Math.floor((hashVal(q, 7) + 0.5) * n) % n, j = Math.floor((hashVal(q, 8) + 0.5) * n) % n
          let s = 0; for (let k = 0; k < n; k++) s += hostA[i * n + k] * hostB[k * n + j]
          if (q % 4 === 3) await yieldMain()
          worst = Math.max(worst, Math.abs(s - got[i * n + j]))
        }
        rd.unmap()
      }
      batchUsed = batch
      return { samples: out.samples, cancelled: out.cancelled, worst }
    }
    const r = await withHalving(attempt, N, 512)
    finalN = r.size; halved = r.halved
    samples = r.result.samples; cancelled = r.result.cancelled
    check = { ok: r.result.worst < 1e-3 * Math.sqrt(finalN / 64), worst: r.result.worst }
  } catch (e: any) {
    if (scope.aborted || isAbort(e)) cancelled = true
    else if (lost || /lost|destroyed/i.test(String(e?.message))) lost = true
    else { scope.dispose(); hid.stop(); return build({ component: 'gpu', workload: wl, summary: 'GPU test failed', samples, unit: 'GFLOP/s', env: env(caps.gpu.adapter ?? undefined), flags: ['fallback:gpu-error'], extra: { error: String(e?.message ?? e) } }) }
  } finally { scope.dispose(); hid.stop() }
  const flags = baseFlags(caps, hid, cvPct(samples), cancelled, { halved, custom })
  if (lost) flags.push('fallback:device-lost')
  if (!check.ok) flags.push('fallback:gpu-incorrect')
  onProgress({ value: median(samples), unit: 'GFLOP/s', fraction: 1 })
  return build({
    component: 'gpu', workload: wl, custom, summary: `matmul N=${finalN} f32, ${batchUsed} dispatches per sample`, samples, unit: 'GFLOP/s', env: env(caps.gpu.adapter ?? undefined), flags,
    extra: { n: finalN, batch: batchUsed, correct: check.ok, maxError: check.worst, f16Available: caps.gpu.f16, peak: samples.length ? Math.max(...samples) : 0 },
  })
}

/* ------------------------------------------------------------------------------- connection */
const HUB_URL = 'https://huggingface.co/openai-community/gpt2/resolve/main/model.safetensors'
function pickTarget(): { url: string; range: string | null; hub: boolean } {
  try {
    const here = location.origin
    const e = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((r) => r.name.startsWith(here) && (r.encodedBodySize || r.decodedBodySize) > 256 * 1024)
      .sort((a, b) => (b.encodedBodySize || b.decodedBodySize) - (a.encodedBodySize || a.decodedBodySize))[0]
    if (e) return { url: e.name.split('?')[0], range: null, hub: false }
  } catch { /* fall through */ }
  return { url: HUB_URL, range: 'bytes=0-8388607', hub: true }
}
/** `input` = seconds of download (3-15, default 5). Not part of the device score. Flags confirm-needed on saveData / cellular. */
export async function run_net(input: number | null, signal: AbortSignal, onProgress: Progress): Promise<RunResult> {
  const caps = await probe(), scope = new RunScope(signal), hid = watchHidden(scope)
  const wl = { id: 'net_latency_download', v: 1 }
  const custom = input != null
  const secs = clampInt(input ?? 5, 3, 15).value
  const flags: Flag[] = []
  const cellular = /cellular|2g|3g/i.test(caps.net.type ?? '')
  if (caps.net.saveData) flags.push('save-data' as Flag)
  if (cellular) flags.push('cellular' as Flag)
  if (caps.net.saveData || cellular) flags.push('confirm-needed' as Flag)
  if (!caps.net.online) { scope.dispose(); hid.stop(); return build({ component: 'net', workload: wl, summary: 'connection test', samples: [], unit: 'Mbit/s', env: { where: 'wasm', isolated: caps.isolated }, flags: [...flags, 'fallback:offline'] }) }
  const ping = new URL('./examples/index.json', document.baseURI).href
  const rtt = async () => {
    const t = performance.now()
    const r = await fetch(`${ping}?nsr=${Math.random()}`, { cache: 'no-store', headers: { Range: 'bytes=0-0' }, signal })
    const dt = performance.now() - t
    await r.arrayBuffer().catch(() => null)
    return dt
  }
  const idle: number[] = [], loaded: number[] = [], windows: number[] = []
  let bytesTotal = 0, cancelled = false, hub = false
  try {
    for (let i = 0; i < 15; i++) { if (scope.aborted) throw abortError(); idle.push(await rtt()); onProgress({ fraction: ((i + 1) / 15) * 0.2, unit: 'ms', value: idle[i] }) }
    const tg = pickTarget(); hub = tg.hub
    const ctl = new AbortController()
    scope.add(() => ctl.abort())
    let bytes = 0
    const stream = async (delay: number, id: number) => {
      await new Promise((r) => setTimeout(r, delay))
      while (!ctl.signal.aborted && bytes < 100 * 2 ** 20) {
        try {
          const r = await fetch(`${tg.url}?nsr=${id}-${Math.random()}`, { cache: 'no-store', signal: ctl.signal, ...(tg.range ? { headers: { Range: tg.range } } : {}) })
          if (!r.ok && r.status !== 206) throw new Error(String(r.status))
          const rd = r.body!.getReader()
          for (;;) { const { done, value } = await rd.read(); if (done) break; bytes += value.length }
        } catch { if (ctl.signal.aborted) return; await new Promise((r) => setTimeout(r, 200)) }
      }
    }
    const t0 = performance.now()
    const streams = [0, 200, 400, 600].map((d, i) => stream(d, i)) // ramped start
    const loadedProbe = (async () => { await new Promise((r) => setTimeout(r, 1500)); for (let i = 0; i < 5 && !ctl.signal.aborted; i++) { try { loaded.push(await rtt()) } catch { /* ignore */ } } })()
    let lastB = 0, lastT = t0
    while (performance.now() - t0 < secs * 1000 && bytes < 100 * 2 ** 20 && !scope.aborted) {
      await new Promise<void>((r) => { const h = setTimeout(r, 500); scope.add(() => { clearTimeout(h); r() }) })
      const t = performance.now(), mbit = ((bytes - lastB) * 8) / ((t - lastT) / 1000) / 1e6
      if (t - t0 > 1300) windows.push(mbit) // the first ~1.3 s is ramp-up and is discarded
      lastB = bytes; lastT = t
      onProgress({ fraction: 0.2 + Math.min(0.78, ((t - t0) / (secs * 1000)) * 0.78), unit: 'Mbit/s', value: mbit })
    }
    bytesTotal = bytes
    ctl.abort()
    await Promise.allSettled([...streams, loadedProbe])
    if (scope.aborted) throw abortError()
  } catch (e: any) { if (isAbort(e) || scope.aborted) cancelled = true; else flags.push('fallback:net-error') } finally { scope.dispose(); hid.stop() }
  if (hub) flags.push('fallback:hub-cdn')
  const jitter = idle.length > 1 ? mean(idle.slice(1).map((x, i) => Math.abs(x - idle[i]))) : 0
  return build({
    component: 'net', workload: wl, custom, summary: `${idle.length} latency probes, 4-stream download${hub ? ' (Hub CDN)' : ''}`, samples: windows, unit: 'Mbit/s',
    env: { where: 'wasm', isolated: caps.isolated }, flags: [...flags, ...baseFlags(caps, hid, cvPct(windows), cancelled, { custom })],
    extra: { latencyMs: median(idle), latencyP95Ms: percentile(idle, 0.95), jitterMs: jitter, loadedLatencyMs: median(loaded), bufferbloatMs: loaded.length ? median(loaded) - median(idle) : null, p95Mbit: percentile(windows, 0.95), bytes: bytesTotal, hub },
  })
}
