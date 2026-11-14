// Browser-only mode: the machine measured from inside the page, with no companion installed.
// Emits the same events as the companion's /ws/bench (stage, progress, result, power), so the score,
// the 3D machine and the power replay work the same way in both modes.
//
// What a browser can and cannot know:
//  - Logical processors, a capped RAM size, the GPU adapter name and the network type are readable.
//  - The CPU model, cache sizes, RAM speed and every power sensor are hidden from web pages.
//    Power here is therefore an ESTIMATE from a small model (see estimatePower), and is labelled so.
import { gpuBench } from './gpuBench'
import type { ModelSpec, RunStats, Task, TaskInput } from '../api'

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

/* ------------------------------------------------------------------ any model, in the page */
// Runs a model from its ONNX repo with Transformers.js and emits the same frames as the companion's /ws/run.
export type BrowserRunStats = RunStats & { device: 'webgpu' | 'wasm'; dtype: string; cached: boolean }

const DTYPE_SUFFIX: Record<string, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' }
interface Loaded { pipe: any; tf: any; bytes: number | null }
const pipes = new Map<string, Promise<Loaded>>()

export function pickDtype(dtypes: string[], device: 'webgpu' | 'wasm', avoid: string[] = []): string {
  const order = device === 'webgpu' ? ['q4f16', 'fp16', 'q4', 'q8', 'quantized', 'fp32'] : ['q8', 'quantized', 'int8', 'uint8', 'q4', 'fp32']
  const hit = order.find((d) => dtypes.includes(d) && !avoid.includes(d))
  return hit === 'quantized' ? 'q8' : hit ?? 'fp32'
}

async function onnxBytes(repo: string, dtype: string): Promise<number | null> {
  try {
    const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main/onnx`)
    if (!r.ok) return null
    const files: { path: string; size: number }[] = await r.json()
    const suf = DTYPE_SUFFIX[dtype] ?? ''
    const other = /_(fp16|quantized|int8|uint8|q4|q4f16|bnb4)\.onnx/
    const sum = files
      .filter((f) => !(files.some((g) => g.path.includes('decoder_model_merged')) && /decoder_model(?!_merged)|decoder_with_past/.test(f.path)))
      .filter((f) => f.path.includes(`${suf}.onnx`) && (suf !== '' || !other.test(f.path)))
      .reduce((a, f) => a + f.size, 0)
    return sum || null
  } catch { return null }
}

function friendly(e: any, device: string): Error {
  const m = String(e?.message ?? e)
  if (/out of memory|allocation|memory access|bad_alloc|Array buffer allocation/i.test(m)) return new Error(`This model needs more memory than the browser can give it on the ${device === 'webgpu' ? 'GPU' : 'CPU'}. Try a smaller model.`)
  if (/failed to fetch|networkerror|load failed|could not locate file|404|401|403/i.test(m)) return new Error('The model files could not be downloaded. Check the internet connection, and that the repository has ONNX files.')
  return new Error(m)
}
const retryOnWasm = (m: string) => !/out of memory/i.test(m) && /empty results|webgpu|not supported|unsupported|no available backend|failed to (create|initialize)|kernel|op_type|create a session|GPU/i.test(m)

async function load(task: Task, repo: string, device: 'webgpu' | 'wasm', dtype: string): Promise<{ l: Loaded; cached: boolean }> {
  const key = `${task}|${repo}|${device}|${dtype}`
  let p = pipes.get(key)
  const cached = !!p
  if (!p) {
    p = (async () => {
      const tf: any = await import('@huggingface/transformers')
      try { tf.env.backends.onnx.logLevel = 'error' } catch { /* ignore */ }
      const [pipe, bytes] = await Promise.all([tf.pipeline(task, repo, { device, dtype }), onnxBytes(repo, dtype)])
      return { pipe, tf, bytes }
    })()
    pipes.set(key, p)
    p.catch(() => pipes.delete(key))
  }
  return { l: await p, cached }
}

// logits and hidden states may come back as float16 (a Uint16Array of raw bits)
function toF32(d: any): Float32Array {
  if (d instanceof Float32Array) return d
  if (d instanceof Uint16Array) {
    return Float32Array.from(d, (x) => {
      const s = x >> 15 ? -1 : 1, e = (x >> 10) & 31, f = x & 1023
      return s * (e === 0 ? 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : Infinity) : 2 ** (e - 15) * (1 + f / 1024))
    })
  }
  return Float32Array.from(d)
}

// Only fires when an ONNX export exposes hidden states (most do not). Attention and MLP parts cannot be split out of them.
function layerFrames(out: any, emit: (f: any) => void) {
  const hs: any[] | undefined = out?.hidden_states
  if (!Array.isArray(hs) || hs.length < 2) return
  hs.slice(1).forEach((t: any, i: number) => {
    const [, seq, dim] = t.dims
    const d = toF32(t.data)
    const norm = Array.from({ length: seq }, (_, k) => { let a = 0; for (let j = 0; j < dim; j++) a += d[k * dim + j] ** 2; return Math.sqrt(a) })
    emit({ type: 'layer', i, resid_norm: norm, attn_norm: norm.map(() => 0), mlp_norm: norm.map(() => 0), head_norm: [], attn: [] })
  })
}

async function runOnce(spec: ModelSpec, task: Task, input: TaskInput, emit: (f: any) => void, device: 'webgpu' | 'wasm', avoid: string[] = []): Promise<BrowserRunStats> {
  const repo = spec.onnx?.repo ?? spec.repo
  const dtype = pickDtype(spec.onnx?.dtypes ?? [], device, avoid)
  const t0 = performance.now()
  const { l, cached } = await load(task, repo, device, dtype)
  const loadMs = performance.now() - t0
  const { pipe, tf } = l
  const text = input.kind === 'text' ? input.text : ''
  const url = input.kind !== 'text' ? input.url : ''
  const start = performance.now()
  let firstMs = 0, items = 1, unit: 'tokens' | 'items' = 'items'
  const seconds = () => (performance.now() - start) / 1000
  const tokens = (s: string): string[] => pipe.tokenizer.tokenize?.(s) ?? s.split(/\s+/)

  if (task === 'text-generation') {
    const tok = pipe.tokenizer
    const enc = await tok(text)
    const ids: number[] = Array.from(enc.input_ids.data as ArrayLike<any>, (x) => Number(x))
    // the next-token distribution right after the prompt: one forward pass
    let out: any
    try { out = await pipe.model({ ...enc, output_hidden_states: true, output_attentions: true }) } catch { out = await pipe.model(enc) }
    const [, seq, vocab] = out.logits.dims
    const lg = toF32(out.logits.data).subarray((seq - 1) * vocab, seq * vocab)
    let mx = -Infinity, mn = Infinity
    for (const v of lg) { if (v > mx) mx = v; if (v < mn) mn = v }
    // some GPU drivers return all zeros for float16 models: treat that as a failure so another precision is tried
    if (!(mx > mn)) throw new Error('EMPTY_OUTPUT')
    let z = 0
    const ex = new Float32Array(vocab)
    for (let i = 0; i < vocab; i++) { ex[i] = Math.exp(lg[i] - mx); z += ex[i] }
    const top = Array.from(ex.keys()).sort((a, b) => ex[b] - ex[a]).slice(0, 10)
    const topk = top.map((i) => ({ token: tok.decode([i]), p: ex[i] / z }))
    emit({ type: 'start', tokens: ids.map((id) => tok.decode([id])) })
    layerFrames(out, emit)
    let gen = '', n = 0
    const streamer = new tf.TextStreamer(tok, {
      skip_prompt: true,
      callback_function: (s: string) => { if (s) { gen += s; emit({ type: 'token', text: s }) } },
      token_callback_function: () => { if (!n++) firstMs = performance.now() - start },
    })
    await pipe(text, { max_new_tokens: 24, do_sample: false, streamer })
    items = Math.max(1, n); unit = 'tokens'
    emit({ type: 'final', topk, text: gen, seconds: seconds() })
  } else if (task === 'fill-mask') {
    emit({ type: 'start', tokens: tokens(text) })
    const r: any[] = await pipe(text, { top_k: 10 })
    firstMs = performance.now() - start
    emit({ type: 'final', topk: r.map((x) => ({ token: String(x.token_str).trim(), p: x.score })), text: r[0]?.sequence, seconds: seconds() })
  } else if (task === 'text-classification') {
    emit({ type: 'start', tokens: tokens(text) })
    const r: any[] = await pipe(text, { top_k: 5 })
    firstMs = performance.now() - start
    emit({ type: 'final', labels: r.map((x) => ({ label: x.label, score: x.score })), seconds: seconds() })
  } else if (task === 'image-classification') {
    const r: any[] = await pipe(url, { top_k: 5 })
    firstMs = performance.now() - start
    emit({ type: 'final', labels: r.map((x) => ({ label: x.label, score: x.score })), seconds: seconds() })
  } else {
    const r: any = await pipe(url, { chunk_length_s: 30 })
    firstMs = performance.now() - start
    emit({ type: 'final', text: String(r.text ?? '').trim(), seconds: seconds() })
  }
  const totalMs = performance.now() - start
  emit({ type: 'done' })
  return {
    where: device, repo, task, loadMs, firstMs, totalMs, items, unit,
    perSec: unit === 'tokens' && totalMs > firstMs && items > 1 ? ((items - 1) * 1000) / (totalMs - firstMs) : 1000 / Math.max(1, totalMs),
    memBytes: l.bytes, joules: null, estimatedEnergy: false, device, dtype, cached,
  }
}

export async function runInBrowser(spec: ModelSpec, input: TaskInput, onFrame: (f: any) => void, opts: { device: 'webgpu' | 'wasm' }): Promise<BrowserRunStats> {
  const task = spec.task
  if (!task) throw new Error('This kind of model cannot be run in the browser.')
  if (!spec.onnx) throw new Error('This model has no ONNX weights, so the browser cannot run it. Use the companion instead.')
  let device = opts.device
  if (device === 'webgpu' && !(await (navigator as any).gpu?.requestAdapter?.().catch(() => null))) device = 'wasm'
  try {
    try {
      return await runOnce(spec, task, input, onFrame, device)
    } catch (e: any) {
      if (device !== 'webgpu' || e?.message !== 'EMPTY_OUTPUT') throw e
      return await runOnce(spec, task, input, onFrame, device, ['fp16', 'q4f16']) // this GPU cannot do float16 maths
    }
  } catch (e: any) {
    if (e?.message === 'EMPTY_OUTPUT') e = new Error('The GPU returned empty results for this model.')
    if (device === 'webgpu' && retryOnWasm(String(e?.message ?? e))) {
      try { return await runOnce(spec, task, input, onFrame, 'wasm') } catch (e2) { throw friendly(e2, 'wasm') }
    }
    throw friendly(e, device)
  }
}
