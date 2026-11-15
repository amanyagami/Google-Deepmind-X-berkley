// Thin client for the FastAPI backend. Errors from the server arrive as { error }.
import { apiUrl, backendKind, detectBackend, wsUrl } from './base'

export function parseRepo(text: string): string {
  let s = text.trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?huggingface\.co\//i, '')
  s = s.split(/[?#]/)[0]
  const p = s.split('/').filter(Boolean)
  if (p.length === 1) return p[0].toLowerCase() === 'gpt2' ? 'openai-community/gpt2' : p[0]
  return p.slice(0, 2).join('/')
}

async function req(url: string, init?: RequestInit) {
  const r = await fetch(apiUrl(url), init)
  const text = await r.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  if (!r.ok) throw new Error(body?.error ?? body?.detail ?? `HTTP ${r.status}`)
  if (body === null) throw new Error('Backend returned a non-JSON response.')
  return body
}

const post = (url: string, data: unknown) =>
  req(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })

export const api = {
  health: async () => { if ((await detectBackend()) === 'none') throw new Error('no backend'); return req('/api/health') },
  probe: (repo: string) => req(`/api/probe?repo=${encodeURIComponent(repo)}`),
  tensor: (repo: string, name: string, rows = 256, size = 32) =>
    req(`/api/tensor?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}&rows=${rows}&size=${size}`),
  scan: (b: unknown) => post('/api/scan', b),
  compare: (b: unknown) => post('/api/compare', b),
  calc: (b: unknown) => post('/api/calc', b),
}

/** Stream one frame per layer over WebSocket. Resolves when the server sends `done`. */
export function streamRun(repo: string, prompt: string, edits: unknown[], onFrame: (f: any) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl('/ws/run'))
    let finished = false
    ws.onopen = () => ws.send(JSON.stringify({ repo, prompt, edits, topk: 10 }))
    ws.onmessage = (m) => {
      const f = JSON.parse(m.data)
      if (f.type === 'error') { finished = true; reject(new Error(f.message)); ws.close(); return }
      onFrame(f)
      if (f.type === 'done') { finished = true; resolve(); ws.close() }
    }
    ws.onerror = () => { if (!finished) reject(new Error('WebSocket connection failed.')) }
    ws.onclose = () => { if (!finished) reject(new Error('Connection closed before the run finished.')) }
  })
}

/* =====================================================================================================================
 * Shared contract for "any model, on any computer". Implemented across workstreams:
 *   resolveModel / checkFit / pickRuntime ........ this file (api.ts)
 *   runInBrowser ................................. hw/browserBench.ts (Transformers.js, WebGPU or WebAssembly)
 *   scoreRun ..................................... hw/score.ts
 * Frames use the same shape as the companion's /ws/run stream, so every view can draw either source:
 *   { type: 'start', tokens: string[] }  { type: 'embed', norm: number[] }  { type: 'layer', i, resid_norm, attn_norm,
 *   mlp_norm, head_norm, attn }  { type: 'final', topk?: {token,p}[], labels?: {label,score}[], text?: string, seconds }
 *   { type: 'done' }.  Browser runs send 'layer' frames only when the model exposes hidden states.
 * ===================================================================================================================== */

/** The kinds of model the app can run. Each has a default input and accepts the user's own. */
export type Task = 'text-generation' | 'fill-mask' | 'text-classification' | 'image-classification' | 'automatic-speech-recognition'

export type TaskInput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }     // a URL or an object URL from an upload
  | { kind: 'audio'; url: string; language?: string }   // a URL, an upload, or a microphone recording; language: the spoken language of a multilingual speech model (a name such as 'spanish' or a code such as 'es')

/** Everything the app needs to know about a Hugging Face repo before running it. */
export interface ModelSpec {
  repo: string
  task: Task | null                  // null: a task the app cannot run (structure only)
  arch: string                       // config.model_type, e.g. 'llama', 'gpt2', 'bert', 'vit', 'whisper'
  params: number | null              // parameter count
  bytes: number | null               // weight bytes on disk
  onnx: { repo: string; dtypes: string[]; sizes?: Record<string, number> } | null   // a repo with ONNX weights Transformers.js can load (this one or a converted copy); sizes: bytes per dtype
  companion: boolean                 // the local PyTorch companion can run it with full traces
  defaultInput: TaskInput
  notes: string[]                    // plain-language caveats shown to the user
}

/** Will it fit on this computer, and where would it run? */
export interface Fit {
  verdict: 'fits' | 'tight' | 'too-big'
  needBytes: number                  // estimated memory to run it
  haveBytes: number | null           // what this device offers for that runtime (null: unknown)
  where: 'companion' | 'webgpu' | 'wasm' | 'none'
  reason: string                     // one sentence, shown to the user
  dtype?: string                     // the ONNX precision the estimate assumed for a browser runtime
}

/** What a finished run measured. */
export interface RunStats {
  where: Fit['where']
  repo: string
  task: Task
  loadMs: number                     // download + initialise
  firstMs: number                    // time to the first output (first token / the result)
  totalMs: number
  items: number                      // tokens written, or 1 for a single classification
  unit: 'tokens' | 'items'
  perSec: number
  memBytes: number | null            // peak memory if known
  joules: number | null              // measured (companion RAPL) or estimated energy, if known
  estimatedEnergy: boolean
}

/* =====================================================================================================================
 * resolveModel / deviceBudget / checkFit / pickRuntime
 * ===================================================================================================================== */
const HUB = 'https://huggingface.co'
const GiB = 1024 ** 3
const TASKS: Record<string, Task> = {
  'text-generation': 'text-generation', 'fill-mask': 'fill-mask', 'text-classification': 'text-classification',
  'image-classification': 'image-classification', 'automatic-speech-recognition': 'automatic-speech-recognition',
}
export const COMPANION_ARCHS = ['llama', 'qwen2', 'mistral', 'gpt2']

export function defaultInputFor(task: Task | null): TaskInput {
  switch (task) {
    case 'fill-mask': return { kind: 'text', text: 'Paris is the [MASK] of France.' }
    case 'text-classification': return { kind: 'text', text: 'I really enjoyed this film, it was wonderful.' }
    case 'image-classification': return { kind: 'image', url: `${HUB}/datasets/Xenova/transformers.js-docs/resolve/main/tiger.jpg` }
    case 'automatic-speech-recognition': return { kind: 'audio', url: `${HUB}/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav` }
    default: return { kind: 'text', text: 'The Eiffel Tower is located in the city of' }
  }
}

const SUFFIX = /(?:_(fp16|q4f16|q4|bnb4|quantized|int8|uint8))?\.onnx$/

/** ONNX precision of a file name: model.onnx fp32, model_fp16, model_q4f16, model_q4, model_quantized/int8/uint8 q8, model_bnb4. */
export function onnxDtype(file: string): string | null {
  if (!file.startsWith('onnx/')) return null
  const m = SUFFIX.exec(file)
  if (!m) return null
  const t = m[1]
  return !t ? 'fp32' : t === 'quantized' || t === 'int8' || t === 'uint8' ? 'q8' : t
}

/** Dtypes and total bytes per dtype from a repo's file list. A model made of several files (encoder + decoder) sums them,
 *  using the merged decoder when there is one; weights stored beside the graph (.onnx_data) are counted too. */
/** The graphs Transformers.js loads for a repo: `model` (decoder-only and encoder-only models), or encoder + merged decoder (Whisper and friends).
 *  Null when the repo has neither layout (then every graph is counted). Other graphs in the repo (decoder_model, ...) are never fetched. */
export function loaderBases(names: string[]): string[] | null {
  const has = (b: string) => names.some((n) => n.startsWith(`onnx/${b}.onnx`) || n.startsWith(`onnx/${b}_`))
  if (names.some((n) => n.startsWith('onnx/encoder_model'))) return ['encoder_model', has('decoder_model_merged') ? 'decoder_model_merged' : 'decoder_model']
  if (names.some((n) => /^onnx\/model(\.onnx|_)/.test(n))) return ['model']
  return null
}
const STRICT_DTYPES = ['fp32', 'fp16', 'q8', 'q4', 'q4f16', 'bnb4']

export function onnxInfo(siblings: { rfilename: string; size?: number | null }[]): { dtypes: string[]; sizes: Record<string, number> } {
  const size = new Map(siblings.map((f) => [f.rfilename, f.size ?? 0]))
  const names = siblings.map((f) => f.rfilename)
  const bases = loaderBases(names)
  if (bases) {
    const sizes: Record<string, number> = {}
    for (const d of STRICT_DTYPES) {
      const files = bases.map((b) => `onnx/${b}${DTYPE_SUFFIX[d]}.onnx`)
      if (files.every((f) => size.has(f))) sizes[d] = files.reduce((a, f) => a + (size.get(f) ?? 0) + names.filter((n) => n.startsWith(`${f}_data`)).reduce((x, n) => x + (size.get(n) ?? 0), 0), 0)
    }
    const order = ['q4f16', 'fp16', 'q4', 'bnb4', 'q8', 'fp32']
    if (Object.keys(sizes).length) return { dtypes: order.filter((d) => d in sizes), sizes }
  }
  const hasMerged = names.some((n) => n.startsWith('onnx/decoder_model_merged'))
  const part = new Map<string, number>()   // dtype|component -> bytes (model_quantized, _int8 and _uint8 are all q8: count the largest once)
  for (const n of names) {
    const d = onnxDtype(n)
    if (!d) continue
    const base = n.slice(5).replace(SUFFIX, '')
    if (hasMerged && (base === 'decoder_model' || base === 'decoder_with_past_model')) continue
    const k = `${d}|${base}`
    part.set(k, Math.max(part.get(k) ?? 0, (size.get(n) ?? 0) + (size.get(`${n}_data`) ?? 0)))
  }
  const sizes: Record<string, number> = {}
  for (const [k, v] of part) { const d = k.split('|')[0]; sizes[d] = (sizes[d] ?? 0) + v }
  const order = ['q4f16', 'fp16', 'q4', 'bnb4', 'q8', 'fp32']
  return { dtypes: order.filter((d) => d in sizes), sizes }
}

async function hubModel(repo: string): Promise<any | null> {
  let r: Response
  try { r = await fetch(`${HUB}/api/models/${repo}?blobs=true`) } catch {
    throw new Error('Could not reach huggingface.co. Check the internet connection and try again.')
  }
  if (r.status === 404 || r.status === 401) return null   // the Hub answers 401 for a repo that does not exist
  if (!r.ok) throw new Error(`Hugging Face answered HTTP ${r.status} for ${repo}.`)
  return r.json()
}

/** Resolve a Hugging Face repo (org/name, a URL, or a bare name) into what the app needs to run it. */
export async function resolveModel(repoOrUrl: string): Promise<ModelSpec> {
  const repo = parseRepo(repoOrUrl)
  if (!repo) throw new Error('Paste a Hugging Face link or a repo name such as org/name.')
  const d = await hubModel(repo)
  if (!d) throw new Error(`"${repo}" was not found on Hugging Face. It may be misspelled, private, or need a login.`)
  if (d.private) throw new Error(`"${repo}" is private, so it cannot be read without a login.`)
  if (d.gated) throw new Error(`"${repo}" is gated: it needs you to accept its licence on Hugging Face and sign in, which this app cannot do. Try an open copy of the model.`)
  const notes: string[] = []
  const tag: string | undefined = d.pipeline_tag
  const task = (tag && TASKS[tag]) || null
  if (!task) notes.push(tag ? `The "${tag}" task is not supported yet, so only the structure can be shown.` : 'This repo declares no task, so only the structure can be shown.')
  const arch: string = d.config?.model_type ?? ''
  const st = d.safetensors
  const params: number | null = typeof st?.total === 'number' ? st.total : st?.parameters ? Object.values<number>(st.parameters).reduce((a, b) => a + b, 0) : null
  const sibs: { rfilename: string; size?: number }[] = d.siblings ?? []
  const wsum = (re: RegExp) => sibs.filter((f) => re.test(f.rfilename)).reduce((a, f) => a + (f.size ?? 0), 0)
  const bytes = wsum(/\.safetensors$/) || wsum(/(^|\/)pytorch_model[^/]*\.bin$/) || null

  let onnx: ModelSpec['onnx'] = null
  if (task) {
    const own = onnxInfo(sibs)
    if (own.dtypes.length) onnx = { repo, ...own }
    else {
      const name = repo.split('/').pop()!
      for (const cand of [`onnx-community/${name}`, `onnx-community/${name}-ONNX`, `Xenova/${name}`]) {
        let c: any = null
        try { c = await hubModel(cand) } catch { /* the copy is unreachable: skip it */ }
        const info = c && !c.gated && !c.private ? onnxInfo(c.siblings ?? []) : null
        if (info?.dtypes.length) { onnx = { repo: cand, ...info }; notes.push(`Browser weights come from the converted copy ${cand}.`); break }
      }
      if (!onnx) notes.push('No ONNX weights were found for this model, so it cannot run in the browser.')
    }
  }
  const online = backendKind() !== 'none'
  const companion = online && task === 'text-generation' && COMPANION_ARCHS.includes(arch)
  if (!online && task === 'text-generation' && !onnx) notes.push('Running it needs the local companion.')
  return { repo, task, arch, params, bytes, onnx, companion, defaultInput: defaultInputFor(task), notes }
}

/** What this computer offers. Memory numbers from a browser are lower bounds. */
export interface Budget {
  companionRam: number | null        // bytes of RAM on the companion's computer, when it is online
  browserRam: number | null          // navigator.deviceMemory, capped by browsers at 8 GB
  browserRamCapped: boolean
  gpu: { maxBuffer: number; maxStorage: number } | null   // WebGPU limits (null: no WebGPU)
  cacheQuota: number | null          // navigator.storage.estimate().quota
}

export async function deviceBudget(): Promise<Budget> {
  const b: Budget = { companionRam: null, browserRam: null, browserRamCapped: false, gpu: null, cacheQuota: null }
  const nav: any = typeof navigator !== 'undefined' ? navigator : {}
  if (typeof nav.deviceMemory === 'number') { b.browserRam = nav.deviceMemory * GiB; b.browserRamCapped = nav.deviceMemory >= 8 }
  try {
    const q = await nav.storage?.estimate?.()
    if (q?.quota) b.cacheQuota = q.quota
  } catch { /* unavailable */ }
  try {
    const ad = await nav.gpu?.requestAdapter?.()
    if (ad) b.gpu = { maxBuffer: ad.limits.maxBufferSize, maxStorage: ad.limits.maxStorageBufferBindingSize }
  } catch { /* no WebGPU */ }
  if (backendKind() !== 'none') {
    try {
      const r = await fetch(apiUrl('/api/hw/info'))
      const j = r.ok ? await r.json() : null
      if (typeof j?.ram?.total === 'number') b.companionRam = j.ram.total
    } catch { /* the companion went away */ }
  }
  return b
}

const WASM_CAP = 4 * GiB   // a WebAssembly memory cannot exceed 4 GB
const gb = (n: number) => `${(n / GiB).toFixed(n < 10 * GiB ? 1 : 0)} GB`
const PREFER: Record<'webgpu' | 'wasm', string[]> = { webgpu: ['q4f16', 'fp16', 'q4', 'q8', 'bnb4', 'fp32'], wasm: ['q8', 'q4', 'bnb4', 'fp32'] }
const BYTES_PER_PARAM: Record<string, number> = { fp32: 4, fp16: 2, q8: 1, q4: 0.5, q4f16: 0.5, bnb4: 0.5 }

interface Est { where: 'companion' | 'webgpu' | 'wasm'; need: number; have: number | null; tooBig: boolean; ratio: number; dtype?: string; why: string }

function estimate(spec: ModelSpec, b: Budget, where: Est['where']): Est | null {
  if (spec.task === null) return null
  if (where === 'companion') {
    if (!spec.companion || b.companionRam == null) return null
    const p = spec.params ?? (spec.bytes ? spec.bytes / 2 : spec.onnx?.sizes?.fp32 ? spec.onnx.sizes.fp32 / 4 : null)
    if (p == null) return null
    const need = p * 4 * 1.2
    const ratio = need / b.companionRam
    return { where, need, have: b.companionRam, tooBig: ratio > 0.85, ratio, why: `needs about ${gb(need)} of RAM (fp32) and this computer has ${gb(b.companionRam)}` }
  }
  if (!spec.onnx) return null
  if (where === 'webgpu' && !b.gpu) return null
  const sizes = spec.onnx.sizes ?? {}
  const have0 = b.browserRam ?? 4 * GiB
  const have = where === 'wasm' ? Math.min(have0, WASM_CAP) : have0
  const haveText = b.browserRam == null ? 'about 4 GB' : `${b.browserRamCapped ? 'at least ' : ''}${gb(have)}`
  let best: Est | null = null
  for (const dt of PREFER[where].filter((d) => spec.onnx!.dtypes.includes(d))) {
    const w = sizes[dt] || (spec.params ? spec.params * BYTES_PER_PARAM[dt] : 0)
    const kv = spec.task === 'text-generation' ? Math.min(0.1 * w, GiB) : 0
    const need = w * 1.3 + kv
    const ratio = need / have
    let tooBig = ratio > 0.85
    let why = `needs about ${gb(need)} (${dt}) and the browser can use ${haveText}`
    if (where === 'wasm' && need > WASM_CAP * 0.85) { tooBig = true; why = `needs about ${gb(need)} (${dt}), more than the 4 GB a browser WebAssembly can address` }
    // the largest single weight buffer (about a fifth of the weights: the embedding table) must fit one GPU binding
    if (where === 'webgpu' && b.gpu && w * 0.2 > Math.min(b.gpu.maxBuffer, b.gpu.maxStorage)) {
      tooBig = true; why = `has a weight buffer of about ${gb(w * 0.2)} (${dt}) and this GPU allows ${gb(Math.min(b.gpu.maxBuffer, b.gpu.maxStorage))} per buffer`
    }
    if (b.cacheQuota != null && w > b.cacheQuota * 0.9) { tooBig = true; why = `downloads ${gb(w)} (${dt}) and the browser's cache allows ${gb(b.cacheQuota)}` }
    const e: Est = { where, need, have, tooBig, ratio, dtype: dt, why }
    if (!tooBig) return e
    if (!best || need < best.need) best = e
  }
  return best
}

/** Where to run: the companion if it can run the model and it fits, else WebGPU, else WebAssembly, else nowhere. */
export function pickRuntime(spec: ModelSpec, fit: Fit, companionOnline: boolean): Fit['where'] {
  if (spec.task === null || fit.verdict === 'too-big') return 'none'
  if (companionOnline && spec.companion && fit.where === 'companion') return 'companion'
  if (fit.where === 'companion') return 'none'
  return spec.onnx ? fit.where : 'none'
}

/** Will the model fit, and on which runtime? Candidates are tried in order companion, webgpu, wasm; the first that fits wins. */
export function checkFit(spec: ModelSpec, b: Budget): Fit {
  const cands = (['companion', 'webgpu', 'wasm'] as const).map((w) => estimate(spec, b, w)).filter((e): e is Est => !!e)
  const fitting = cands.find((e) => !e.tooBig)
  if (fitting) {
    const verdict: Fit['verdict'] = fitting.ratio > 0.5 ? 'tight' : 'fits'
    const f: Fit = {
      verdict, needBytes: fitting.need, haveBytes: fitting.have, where: fitting.where, dtype: fitting.dtype,
      reason: `It ${fitting.why}, so it runs ${fitting.where === 'companion' ? 'on the local companion' : fitting.where === 'webgpu' ? 'in the browser on the GPU' : 'in the browser on the CPU (WebAssembly)'}${verdict === 'tight' ? ', but memory will be tight' : ''}.`,
    }
    return { ...f, where: pickRuntime(spec, f, b.companionRam != null) }
  }
  if (cands.length) {
    const e = cands.reduce((a, c) => (c.need < a.need ? c : a))
    return { verdict: 'too-big', needBytes: e.need, haveBytes: e.have, where: 'none', dtype: e.dtype, reason: `It is too big for this computer: it ${e.why}.` }
  }
  // nothing can run it: say why, and still give a size so the verdict means something
  const p = spec.params ?? (spec.bytes ? spec.bytes / 2 : null)
  const need = p ? p * 4 * 1.2 : 0
  const have = b.companionRam ?? b.browserRam
  const why = spec.task === null ? 'This task is not supported, so only the structure can be shown.'
    : !spec.onnx ? 'It has no ONNX weights for the browser' + (b.companionRam == null ? ' and the local companion is not running.' : ' and the companion cannot run this architecture.')
      : 'This computer has no runtime that can run it (WebGPU is missing and the companion is not running).'
  return { verdict: have && need / have > 0.85 ? 'too-big' : 'fits', needBytes: need, haveBytes: have ?? null, where: 'none', reason: why }
}

/* ------------------------------------------------------------------ errors */
export type BrowserRunCode = 'oom' | 'unsupported' | 'degenerate' | 'offline' | 'gated' | 'quota' | 'input' | 'aborted' | 'unknown'
/** Every failure of the in-browser engine carries a code the UI can act on, and a plain-language message. */
export class BrowserRunError extends Error {
  code: BrowserRunCode
  constructor(code: BrowserRunCode, message: string) { super(message); this.name = 'BrowserRunError'; this.code = code }
}

/** Failures of the tensor window and of the safetensors header parser. */
export type TensorErrorCode = 'length' | 'truncated' | 'json' | 'entry' | 'field' | 'dtype' | 'dims' | 'offsets' | 'overlap' | 'size'
  | 'gated' | 'notfound' | 'http' | 'offline' | 'timeout' | 'range' | 'needs-i0' | 'aborted'
export class TensorError extends Error {
  code: TensorErrorCode
  constructor(code: TensorErrorCode, message: string) { super(message); this.name = 'TensorError'; this.code = code }
}

/* ------------------------------------------------------------------ small helpers */
const MiB = 1024 ** 2
type Nav = Navigator & { connection?: { downlink?: number; type?: string; effectiveType?: string; saveData?: boolean }; deviceMemory?: number }
const nav = (): Nav | null => (typeof navigator !== 'undefined' ? (navigator as Nav) : null)
const isAbort = (e: any) => e?.name === 'AbortError' || e?.code === 'aborted'

/* ------------------------------------------------------------------ download manager */
const CACHE_NAME = 'transformers-cache'   // Transformers.js reads and writes this Cache Storage entry (env.cacheKey); we fill it ahead of time
const MARK = (repo: string, dtype: string) => `${HUB}/__ns_complete__/${repo}/${dtype}`
async function openCache(): Promise<Cache | null> {
  try { return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null } catch { return null }
}
const fileUrl = (repo: string, path: string) => `${HUB}/${repo}/resolve/main/${path}`
let lastBytesPerSec: number | null = null   // measured by the last download of this session

const RUN_DEVICE = (): 'webgpu' | 'wasm' => ((nav() as any)?.gpu ? 'webgpu' : 'wasm')

/** The ONNX precision a model would be fetched in, and on which device (an explicit device or dtype wins). */
export function planDtype(spec: ModelSpec, device: 'webgpu' | 'wasm' = RUN_DEVICE(), dtype?: string): string {
  return dtype ?? pickDtype(spec.onnx?.dtypes ?? [], device)
}

const SMALL_EXT = /\.(json|txt|model|jinja)$/
/** The files Transformers.js reads for one precision: small config files at the root and the matching .onnx files. */
export function selectModelFiles(siblings: { rfilename: string; size?: number | null }[], dtype: string): { path: string; size: number }[] {
  const names = siblings.map((f) => f.rfilename)
  const hasMerged = names.some((n) => n.startsWith('onnx/decoder_model_merged'))
  const suf = (DTYPE_SUFFIX[dtype] ?? '') + '.onnx'
  const out: { path: string; size: number }[] = []
  const bases = loaderBases(names)
  const strict = bases ? new Set(bases.map((b) => `onnx/${b}${suf}`)) : null
  const wanted = strict && [...strict].every((f) => names.includes(f))
  for (const f of siblings) {
    const n = f.rfilename, size = f.size ?? 0
    if (!n.includes('/')) {
      if (SMALL_EXT.test(n) && size < 32 * MiB && !/safetensors|pytorch_model|\.index\./.test(n)) out.push({ path: n, size })
    } else if (n.startsWith('onnx/') && wanted) {
      if (strict!.has(n) || [...strict!].some((g) => n.startsWith(`${g}_data`))) out.push({ path: n, size })
    } else if (n.startsWith('onnx/')) {
      const isGraph = n.endsWith('.onnx') && onnxDtype(n) === dtype && n.endsWith(suf)
      const base = n.slice(5).replace(SUFFIX, '')
      if (isGraph && !(hasMerged && (base === 'decoder_model' || base === 'decoder_with_past_model'))) out.push({ path: n, size })
      else if (!n.endsWith('.onnx')) {
        const g = n.replace(/_data(_\d+)?$/, '')
        if (g !== n && names.includes(g) && g.endsWith(suf) && onnxDtype(g) === dtype && !(hasMerged && /decoder_(with_past_)?model(_data|\.onnx|_)/.test(g) && !g.includes('merged'))) out.push({ path: n, size })
      }
    }
  }
  return out
}

const fileLists = new Map<string, Promise<{ path: string; size: number }[]>>()
async function modelFiles(repo: string, dtype: string): Promise<{ path: string; size: number }[]> {
  const k = `${repo}|${dtype}`
  let p = fileLists.get(k)
  if (!p) {
    p = (async () => {
      const d = await hubModel(repo)
      if (!d) throw new BrowserRunError('unsupported', `"${repo}" was not found on Hugging Face.`)
      return selectModelFiles(d.siblings ?? [], dtype)
    })()
    fileLists.set(k, p)
    p.catch(() => fileLists.delete(k))
  }
  return p
}

async function isMarked(repo: string, dtype: string): Promise<boolean> {
  try { const c = await openCache(); return !!c && !!(await c.match(MARK(repo, dtype))) } catch { return false }
}

/** Pure rule: how loudly to ask before downloading. */
export function consentFor(bytes: number | null, net?: { cellular?: boolean; saveData?: boolean }): DownloadPlan['consent'] {
  if (net?.cellular || net?.saveData) return 'warn'
  if (bytes == null) return 'size'
  if (bytes > 150 * MiB) return 'warn'
  if (bytes >= 25 * MiB) return 'size'
  return 'none'
}

/** Size, time and consent level for fetching a model. Makes no request for model files (metadata at most). */
export async function planDownload(spec: ModelSpec, opts: { device?: 'webgpu' | 'wasm'; dtype?: string } = {}): Promise<DownloadPlan> {
  const repo = spec.onnx?.repo ?? spec.repo
  const dev = opts.device ?? RUN_DEVICE()
  const dtype = opts.dtype ?? pickDtype(spec.onnx?.dtypes ?? [], dev, dev === 'webgpu' && (await gpuF16Bad()) ? ['fp16', 'q4f16'] : [])
  const cached = !!spec.onnx && (await isMarked(repo, dtype))
  let bytes: number | null = spec.onnx?.sizes?.[dtype] ?? null
  if (bytes == null && spec.onnx && !cached) {
    try { bytes = (await modelFiles(repo, dtype)).reduce((a, f) => a + f.size, 0) || null } catch { bytes = null }
  }
  const conn = nav()?.connection
  const cellular = conn?.type === 'cellular'
  const rate = lastBytesPerSec ?? (conn?.downlink ? (conn.downlink * 1e6) / 8 : null)
  const etaSeconds = cached ? 0 : bytes != null && rate ? Math.ceil(bytes / rate) : null
  return { repo, bytes, cached, etaSeconds, dtype, metered: cellular || !!conn?.saveData, consent: cached ? 'none' : consentFor(bytes, { cellular, saveData: !!conn?.saveData }) }
}

function quotaError(e: any): BrowserRunError | null {
  if (e?.name === 'QuotaExceededError' || /quota/i.test(String(e?.message ?? ''))) {
    return new BrowserRunError('quota', 'This browser has no room left to store the model. Free some space (use "Clear downloaded models") or pick a smaller model.')
  }
  return null
}
function netError(status: number | null, repo: string, e?: any): BrowserRunError {
  if (status === 401 || status === 403) return new BrowserRunError('gated', `"${repo}" needs a Hugging Face login or a licence you have not accepted, so it cannot be downloaded here.`)
  if (status === 404) return new BrowserRunError('unsupported', `A model file of "${repo}" is missing, so the browser cannot load it. Check that the repository has ONNX files.`)
  if (status != null) return new BrowserRunError('offline', `Hugging Face answered HTTP ${status} while downloading "${repo}". Try again in a moment.`)
  return new BrowserRunError('offline', e && nav()?.onLine === false ? 'You are offline, so the model cannot be downloaded.' : 'The model files could not be downloaded. Check the internet connection and try again.')
}

/**
 * Fill the browser cache with everything Transformers.js needs for a model. Resolves {cached:true} when nothing had to be
 * fetched. Progress counts bytes of all files; cancel() aborts the transfers (partial files are never stored).
 */
export function ensureModel(spec: ModelSpec, o: { onProgress: (done: number, total: number | null) => void; signal?: AbortSignal; device?: 'webgpu' | 'wasm'; dtype?: string }): DownloadHandle {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener('abort', onAbort, { once: true }) }
  const done = (async () => {
    if (!spec.onnx) throw new BrowserRunError('unsupported', 'This model has no ONNX weights, so the browser cannot load it.')
    const repo = spec.onnx.repo
    const dtype = planDtype(spec, o.device, o.dtype)
    const cache = await openCache()
    if (!cache) { o.onProgress(0, null); return { cached: false, bytes: 0 } }   // no Cache Storage: Transformers.js will fetch for itself
    if (await isMarked(repo, dtype)) { const b = spec.onnx.sizes?.[dtype] ?? 0; o.onProgress(b, b || null); return { cached: true, bytes: b } }
    let files: { path: string; size: number }[]
    try { files = await modelFiles(repo, dtype) } catch (e: any) { throw e instanceof BrowserRunError ? e : netError(null, repo, e) }
    let total: number | null = files.reduce((a, f) => a + f.size, 0) || null
    let got = 0, fetched = 0
    const t0 = performance.now()
    o.onProgress(0, total)
    const fetchOne = async (f: { path: string; size: number }) => {
      const url = fileUrl(repo, f.path)
      if (await cache.match(url)) { got += f.size; o.onProgress(got, total); return }
      let r: Response
      try { r = await fetch(url, { signal: ac.signal }) } catch (e: any) { if (isAbort(e) || ac.signal.aborted) throw new BrowserRunError('aborted', 'The download was cancelled.'); throw netError(null, repo, e) }
      if (!r.ok || !r.body) throw netError(r.status, repo)
      let mine = 0
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) { mine += chunk.byteLength; got += chunk.byteLength; fetched += chunk.byteLength; o.onProgress(got, total); ctl.enqueue(chunk) },
      })
      const headers = new Headers(r.headers)
      try { await cache.put(url, new Response(r.body.pipeThrough(counter), { status: 200, headers })) } catch (e: any) {
        if (isAbort(e) || ac.signal.aborted) throw new BrowserRunError('aborted', 'The download was cancelled.')
        throw quotaError(e) ?? netError(null, repo, e)
      }
      if (f.size && mine !== f.size) { got += f.size - mine; o.onProgress(got, total) }   // sizes from the file list can differ slightly: keep the bar honest
    }
    try {
      const queue = [...files]
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (let f = queue.shift(); f; f = queue.shift()) await fetchOne(f) }))
    } catch (e) { ac.abort(); throw e }
    if (total == null || got > total) total = got
    o.onProgress(got, total)
    if (fetched > 0) {
      const secs = (performance.now() - t0) / 1000
      if (secs > 0.5 && fetched > MiB) lastBytesPerSec = fetched / secs
    }
    try { await cache.put(MARK(repo, dtype), new Response(JSON.stringify({ bytes: total, at: Date.now() }), { headers: { 'content-type': 'application/json' } })) } catch (e) { throw quotaError(e) ?? e }
    return { cached: fetched === 0, bytes: total }
  })().finally(() => o.signal?.removeEventListener('abort', onAbort))
  return { cancel: () => ac.abort(), done }
}

/** Ask the browser to keep downloaded models. Call it from a click handler: browsers refuse it otherwise. */
export async function requestPersist(): Promise<boolean> {
  try { return (await nav()?.storage?.persist?.()) ?? false } catch { return false }
}

/** After the first good download: ask the browser to keep the files (Chrome grants this silently for engaged sites). Once only. */
export async function persistAfterDownload(): Promise<boolean> {
  try {
    if (await nav()?.storage?.persisted?.()) return true
    return await requestPersist()
  } catch { return false }
}

export interface ModelCacheInfo { usage: number | null; quota: number | null; persisted: boolean | null; models: { repo: string; dtype: string; bytes: number }[] }
/** What is stored: browser usage and quota, whether it is persistent, and the downloaded models. */
export async function modelCacheInfo(): Promise<ModelCacheInfo> {
  const info: ModelCacheInfo = { usage: null, quota: null, persisted: null, models: [] }
  try { const e = await nav()?.storage?.estimate?.(); info.usage = e?.usage ?? null; info.quota = e?.quota ?? null } catch { /* unavailable */ }
  try { info.persisted = (await nav()?.storage?.persisted?.()) ?? null } catch { /* unavailable */ }
  try {
    const c = await openCache()
    for (const k of c ? await c.keys() : []) {
      const m = new RegExp(`^${HUB}/__ns_complete__/(.+)/([^/]+)$`).exec(k.url)
      if (!m) continue
      let bytes = 0
      try { bytes = (await (await c!.match(k))!.json()).bytes ?? 0 } catch { /* unreadable marker */ }
      info.models.push({ repo: m[1], dtype: m[2], bytes })
    }
  } catch { /* unavailable */ }
  return info
}

/** What is saved on this device: model bytes, and whether the browser promised to keep them. */
export async function savedInfo(): Promise<{ bytes: number; persisted: boolean | null; usage: number | null; quota: number | null }> {
  const i = await modelCacheInfo()
  return { bytes: i.models.reduce((a, m) => a + m.bytes, 0), persisted: i.persisted, usage: i.usage, quota: i.quota }
}

/** Delete every downloaded model and release the one in memory. */
export async function clearModels(): Promise<void> {
  await disposeAll()
  fileLists.clear()
  try { if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME) } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ task inputs */
export interface InputCaps { deviceMemoryGB?: number | null; maxTextTokens?: number; maxImageBytes?: number; maxAudioSeconds?: number; maxAudioBytes?: number; prepare?: boolean }
export const INPUT_LIMITS = { textTokens: 512, textTokensLowMem: 128, imageBytes: 10 * MiB, audioSeconds: 30, audioBytes: 40 * MiB, imageSide: 1024, audioRate: 16000 }
export type Prepared = { text?: string; image?: string; audio?: Float32Array; language?: string; revoke?: () => void }
export type InputCheck = { ok: true; prepared: Prepared } | { ok: false; code: 'input'; error: string }

export function maxTextTokens(caps?: InputCaps): number {
  const mem = caps?.deviceMemoryGB !== undefined ? caps.deviceMemoryGB : (nav()?.deviceMemory ?? null)
  return caps?.maxTextTokens ?? (mem != null && mem < 4 ? INPUT_LIMITS.textTokensLowMem : INPUT_LIMITS.textTokens)
}
/** A cheap token count before a tokenizer is loaded (about four characters per token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4)
export function checkAudioSeconds(seconds: number, caps?: InputCaps): string | null {
  const cap = caps?.maxAudioSeconds ?? INPUT_LIMITS.audioSeconds
  return seconds > cap ? `This clip is ${Math.round(seconds)} s long. The limit is ${cap} s: trim it and try again.` : null
}
const mb = (n: number) => `${(n / MiB).toFixed(n < 10 * MiB ? 1 : 0)} MB`
const bad = (error: string): InputCheck => ({ ok: false, code: 'input', error })

/** Check the user's input against the caps; for images and audio also fetch, downscale / resample and return what to feed the model. */
export async function validateInput(task: Task, input: TaskInput, caps?: InputCaps): Promise<InputCheck> {
  const wantText = task === 'text-generation' || task === 'fill-mask' || task === 'text-classification'
  if (wantText) {
    if (input.kind !== 'text') return bad('This model reads text. Type or paste some text.')
    const text = input.text.trim()
    if (!text) return bad('Type some text first.')
    const cap = maxTextTokens(caps)
    if (estimateTokens(text) > cap) return bad(`That text is about ${estimateTokens(text)} tokens. The limit is ${cap}${cap < INPUT_LIMITS.textTokens ? ' on this device (less than 4 GB of memory)' : ''}. Shorten it.`)
    return { ok: true, prepared: { text: input.text } }
  }
  const kind = task === 'image-classification' ? 'image' : 'audio'
  if (input.kind !== kind) return bad(kind === 'image' ? 'This model reads images. Choose a picture.' : 'This model reads audio. Choose a recording.')
  if (!input.url) return bad(kind === 'image' ? 'Choose a picture first.' : 'Choose an audio clip first.')
  let blob: Blob
  try {
    const r = await fetch(input.url)
    if (!r.ok) return bad(`The ${kind} could not be read (HTTP ${r.status}).`)
    blob = await r.blob()
  } catch { return bad(`The ${kind} could not be read. Check the link, or upload the file instead.`) }
  const cap = kind === 'image' ? (caps?.maxImageBytes ?? INPUT_LIMITS.imageBytes) : (caps?.maxAudioBytes ?? INPUT_LIMITS.audioBytes)
  if (blob.size > cap) return bad(`That ${kind} file is ${mb(blob.size)}. The limit is ${mb(cap)}${kind === 'audio' ? ` (and ${caps?.maxAudioSeconds ?? INPUT_LIMITS.audioSeconds} s of sound)` : ''}.`)
  if (caps?.prepare === false) return { ok: true, prepared: kind === 'image' ? { image: input.url } : { language: (input as any).language } }
  try {
    if (kind === 'image') return await prepareImage(blob)
    const a = await prepareAudio(blob, caps)
    if (a.ok && input.kind === 'audio') a.prepared.language = input.language
    return a
  } catch (e: any) {
    return bad(e instanceof BrowserRunError ? e.message : `That ${kind} could not be decoded. Try a common format (${kind === 'image' ? 'JPEG, PNG, WebP' : 'WAV, MP3, M4A'}).`)
  }
}

/** Shrink an image so its longest side is at most 1024 px; the model resizes further, so quality is unaffected. */
async function prepareImage(blob: Blob): Promise<InputCheck> {
  const bmp = await createImageBitmap(blob)
  const k = Math.min(1, INPUT_LIMITS.imageSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k))
  const cv = new OffscreenCanvas(w, h)
  cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()
  const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  const url = URL.createObjectURL(out)
  return { ok: true, prepared: { image: url, revoke: () => URL.revokeObjectURL(url) } }
}

/** Decode audio to mono 16 kHz floats; longer than 30 s is refused. */
async function prepareAudio(blob: Blob, caps?: InputCaps): Promise<InputCheck> {
  const AC: typeof AudioContext = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
  const ctx = new AC()
  let buf: AudioBuffer
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()) } finally { ctx.close?.() }
  const tooLong = checkAudioSeconds(buf.duration, caps)
  if (tooLong) return bad(tooLong)
  const rate = INPUT_LIMITS.audioRate
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * rate)), rate)   // mixes down to mono and resamples
  const src = off.createBufferSource()
  src.buffer = buf; src.connect(off.destination); src.start()
  return { ok: true, prepared: { audio: (await off.startRendering()).getChannelData(0) } }
}

const inputKey = (task: Task) => `ns.input.${task}`
/** The user's own input for a task, remembered between visits (text, or an http(s) link). */
export function saveInput(task: Task, input: TaskInput): void {
  try {
    if (input.kind !== 'text' && !/^https?:/i.test(input.url)) return   // an object URL dies with the page
    localStorage.setItem(inputKey(task), JSON.stringify(input))
  } catch { /* private mode */ }
}
export function loadSavedInput(task: Task): TaskInput | null {
  try {
    const j = JSON.parse(localStorage.getItem(inputKey(task)) ?? 'null')
    if (j?.kind === 'text' && typeof j.text === 'string') return j
    if ((j?.kind === 'image' || j?.kind === 'audio') && typeof j.url === 'string') return j
  } catch { /* none saved */ }
  return null
}

/* ------------------------------------------------------------------ running a model in the page */
export type BrowserRunStats = RunStats & { device: 'webgpu' | 'wasm'; dtype: string; cached: boolean }

const DTYPE_SUFFIX: Record<string, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' }
interface Loaded { pipe: any; tf: any; repo: string }

export function pickDtype(dtypes: string[], device: 'webgpu' | 'wasm', avoid: string[] = []): string {
  const order = device === 'webgpu' ? ['q4f16', 'fp16', 'q4', 'q8', 'quantized', 'fp32'] : ['q8', 'quantized', 'int8', 'uint8', 'q4', 'fp32']
  const hit = order.find((d) => dtypes.includes(d) && !avoid.includes(d))
  return hit === 'quantized' ? 'q8' : hit ?? 'fp32'
}

/** Map any failure to a BrowserRunError with a friendly message. */
export function classifyError(e: any, device = 'webgpu'): BrowserRunError {
  if (e instanceof BrowserRunError) return e
  const m = String(e?.message ?? e)
  const q = quotaError(e)
  if (q) return q
  if (isAbort(e)) return new BrowserRunError('aborted', 'The run was cancelled.')
  if (/out of memory|allocation|memory access|bad_alloc|Array buffer allocation|RangeError: Invalid/i.test(m)) return new BrowserRunError('oom', `This model needs more memory than the browser can give it on the ${device === 'webgpu' ? 'GPU' : 'CPU'}. Try a smaller model.`)
  if (/\b(401|403)\b|gated|unauthorized|forbidden/i.test(m)) return new BrowserRunError('gated', 'The model needs a Hugging Face login or an accepted licence, so it cannot be downloaded here.')
  if (/could not locate file|\b404\b/i.test(m)) return new BrowserRunError('unsupported', 'A model file is missing, so the browser cannot load it. Check that the repository has ONNX files.')
  if (/failed to fetch|networkerror|load failed|network request failed|offline/i.test(m)) return netError(null, 'the model', e)
  if (/webgpu|not supported|unsupported|no available backend|failed to (create|initialize)|kernel|op_type|create a session|GPU/i.test(m)) return new BrowserRunError('unsupported', `This browser cannot run this model on the ${device === 'webgpu' ? 'GPU' : 'CPU'}.`)
  return new BrowserRunError('unknown', m)
}

/* one pipeline at a time: loading another disposes the previous one first */
let current: { key: string; p: Promise<Loaded> } | null = null
let ortRoot = ''   // where the page serves the ONNX runtime from (/ort/); a worker is told by the page
export const livePipelineKey = () => current?.key ?? null
export async function disposeAll(): Promise<void> {
  if (worker && !IN_WORKER) { try { await callWorker(worker, { type: 'dispose' }, {}) } catch { /* no worker to free */ } }
  const c = current
  current = null
  if (!c) return
  try { await (await c.p).pipe?.dispose?.() } catch { /* the load failed, nothing to free */ }
}
/** Load (or reuse) the single live pipeline. `cached` is true when it was already in memory. */
export async function loadPipeline(task: Task, repo: string, device: 'webgpu' | 'wasm', dtype: string): Promise<{ l: Loaded; cached: boolean }> {
  const key = `${task}|${repo}|${device}|${dtype}`
  if (current?.key === key) { try { return { l: await current.p, cached: true } } catch { /* fall through and retry */ } }
  const prev = current
  const p: Promise<Loaded> = (async () => {
    if (prev) { try { await (await prev.p).pipe?.dispose?.() } catch { /* previous failed to load */ } }
    const tf: any = await import('@huggingface/transformers')
    try { tf.env.backends.onnx.logLevel = 'error' } catch { /* ignore */ }
    if (IN_WORKER && ortRoot) { try { tf.env.backends.onnx.wasm.wasmPaths = { mjs: ortRoot + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: ortRoot + 'ort-wasm-simd-threaded.asyncify.wasm' } } catch { /* default location */ } }
    return { pipe: await tf.pipeline(task, repo, { device, dtype }), tf, repo }
  })()
  current = { key, p }
  p.catch(() => { if (current?.p === p) current = null })
  return { l: await p, cached: false }
}

/** Does this browser's GPU compute float16 wrongly? Asks the capability probe (stream S2); a stub or failure means "unknown". */
const IN_WORKER = typeof (globalThis as any).WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof (globalThis as any).WorkerGlobalScope
let f16Verdict: Promise<boolean> | null = null
function gpuF16Bad(): Promise<boolean> {
  return (f16Verdict ??= (async () => {
    try {
      if (IN_WORKER) return false   // the page decides and passes `avoid`
      const c = await (await import('./hw/browserBench')).probe()
      return !!c.gpu?.available && (c.gpu.f16 === false || c.gpu.canaryOk === false)
    } catch { return false }
  })())
}

// logits and hidden states may come back as float16 (a Uint16Array of raw bits)
function toF32(d: any): Float32Array {
  if (d instanceof Float32Array) return d
  if (d instanceof Uint16Array) return Float32Array.from(d, f16bits)
  return Float32Array.from(d)
}
function f16bits(x: number): number {
  const s = x >> 15 ? -1 : 1, e = (x >> 10) & 31, f = x & 1023
  return s * (e === 0 ? 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : Infinity) : 2 ** (e - 15) * (1 + f / 1024))
}

/** True when a vector of scores carries no information: NaN, infinite, or one value repeated. */
export function isDegenerate(v: ArrayLike<number>): boolean {
  if (v.length < 2) return v.length === 0
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (!Number.isFinite(x)) return true
    if (x < mn) mn = x
    if (x > mx) mx = x
  }
  return !(mx > mn)
}
const degenerateError = () => new BrowserRunError('degenerate', 'The model returned empty results on this device. Try the CPU, or another model.')

const hiddenSeen = new Map<string, boolean>()   // repo -> did the last run expose hidden states?

// Only fires when an ONNX export exposes hidden states (most do not). Attention and MLP parts cannot be split out of them.
function layerFrames(out: any, emit: (f: any) => void): boolean {
  const hs: any[] | undefined = out?.hidden_states
  if (!Array.isArray(hs) || hs.length < 2) return false
  hs.slice(1).forEach((t: any, i: number) => {
    const [, seq, dim] = t.dims
    const d = toF32(t.data)
    const norm = Array.from({ length: seq }, (_, k) => { let a = 0; for (let j = 0; j < dim; j++) a += d[k * dim + j] ** 2; return Math.sqrt(a) })
    emit({ type: 'layer', i, resid_norm: norm, attn_norm: norm.map(() => 0), mlp_norm: norm.map(() => 0), head_norm: [], attn: [] })
  })
  return true
}

interface RunOpts { device: 'webgpu' | 'wasm'; dtype?: string; avoid?: string[]; prepared?: Prepared; signal?: AbortSignal; onProgress?: (done: number, total: number | null) => void }

async function runOnce(spec: ModelSpec, task: Task, prep: Prepared, emit: (f: any) => void, device: 'webgpu' | 'wasm', dtype: string, opts: RunOpts): Promise<BrowserRunStats> {
  const repo = spec.onnx?.repo ?? spec.repo
  const t0 = performance.now()
  const dl = await ensureModel(spec, { onProgress: opts.onProgress ?? (() => {}), signal: opts.signal, device, dtype }).done
  if (opts.signal?.aborted) throw new BrowserRunError('aborted', 'The run was cancelled.')
  const { l, cached: warm } = await loadPipeline(task, repo, device, dtype)
  const cached = dl.cached || warm
  const loadMs = performance.now() - t0
  const { pipe, tf } = l
  const text = prep.text ?? ''
  const start = performance.now()
  let firstMs = 0, items = 1, unit: 'tokens' | 'items' = 'items'
  const seconds = () => (performance.now() - start) / 1000
  const tokens = (s: string): string[] => pipe.tokenizer.tokenize?.(s) ?? s.split(/\s+/)
  const lim = maxTextTokens()

  if (task === 'text-generation') {
    const tok = pipe.tokenizer
    const enc = await tok(text)
    const ids: number[] = Array.from(enc.input_ids.data as ArrayLike<any>, (x) => Number(x))
    if (ids.length > lim) throw new BrowserRunError('input', `That text is ${ids.length} tokens. The limit is ${lim}. Shorten it.`)
    // the next-token distribution right after the prompt: one forward pass
    let out: any
    try { out = await pipe.model({ ...enc, output_hidden_states: true, output_attentions: true }) } catch { out = await pipe.model(enc) }
    const [, seq, vocab] = out.logits.dims
    const lg = toF32(out.logits.data).subarray((seq - 1) * vocab, seq * vocab)
    // some GPU drivers return all zeros for float16 models: treat that as a failure so another precision is tried
    if (isDegenerate(lg)) throw degenerateError()
    let mx = -Infinity
    for (const v of lg) if (v > mx) mx = v
    let z = 0
    const ex = new Float32Array(vocab)
    for (let i = 0; i < vocab; i++) { ex[i] = Math.exp(lg[i] - mx); z += ex[i] }
    const top = Array.from(ex.keys()).sort((a, b) => ex[b] - ex[a]).slice(0, 10)
    const topk = top.map((i) => ({ token: tok.decode([i]), p: ex[i] / z }))
    emit({ type: 'start', tokens: ids.map((id) => tok.decode([id])) })
    hiddenSeen.set(spec.repo, layerFrames(out, emit))
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
    if (isDegenerate(r.map((x) => x.score))) throw degenerateError()
    emit({ type: 'final', topk: r.map((x) => ({ token: String(x.token_str).trim(), p: x.score })), text: r[0]?.sequence, seconds: seconds() })
  } else if (task === 'text-classification') {
    emit({ type: 'start', tokens: tokens(text) })
    const r: any[] = await pipe(text, { top_k: 5 })
    firstMs = performance.now() - start
    if (isDegenerate(r.map((x) => x.score))) throw degenerateError()
    emit({ type: 'final', labels: r.map((x) => ({ label: x.label, score: x.score })), seconds: seconds() })
  } else if (task === 'image-classification') {
    const r: any[] = await pipe(prep.image, { top_k: 5 })
    firstMs = performance.now() - start
    if (isDegenerate(r.map((x) => x.score))) throw degenerateError()
    emit({ type: 'final', labels: r.map((x) => ({ label: x.label, score: x.score })), seconds: seconds() })
  } else {
    // a multilingual Whisper (not the .en models) takes the spoken language; English-only models ignore it
    const multi = !/\.en$/i.test(repo) && !!prep.language
    const r: any = await pipe(prep.audio, { chunk_length_s: 30, ...(multi ? { language: prep.language, task: 'transcribe' } : {}) })
    firstMs = performance.now() - start
    const said = String(r?.text ?? '').trim()
    let rms = 0
    for (const v of prep.audio ?? []) rms += v * v
    const loud = prep.audio ? Math.sqrt(rms / Math.max(1, prep.audio.length)) > 0.005 : true
    if (!said && loud) throw degenerateError()   // real sound in, nothing out
    emit({ type: 'final', text: said, seconds: seconds() })
  }
  const totalMs = performance.now() - start
  emit({ type: 'done' })
  return {
    where: device, repo, task, loadMs, firstMs, totalMs, items, unit,
    perSec: unit === 'tokens' && totalMs > firstMs && items > 1 ? ((items - 1) * 1000) / (totalMs - firstMs) : 1000 / Math.max(1, totalMs),
    memBytes: spec.onnx?.sizes?.[dtype] ?? null, joules: null, estimatedEnergy: false, device, dtype, cached,
  }
}

/**
 * Run a model in the page. Tries the precision chosen from the capability probe, then another precision, then the CPU when the
 * output is empty or the GPU fails. Failures arrive as BrowserRunError with a code. Starts downloading when the files are not cached:
 * the caller must have asked the user first (see planDownload).
 */
async function runInThread(spec: ModelSpec, input: TaskInput, onFrame: (f: any) => void, opts: RunOpts): Promise<BrowserRunStats> {
  const task = spec.task
  if (!task) throw new BrowserRunError('unsupported', 'This kind of model cannot be run in the browser.')
  if (!spec.onnx) throw new BrowserRunError('unsupported', 'This model has no ONNX weights, so the browser cannot run it. Use the companion instead.')
  let prep: Prepared
  if (opts.prepared) prep = opts.prepared
  else {
    const check = await validateInput(task, input)
    if (!check.ok) throw new BrowserRunError('input', check.error)
    prep = check.prepared
  }
  let device = opts.device
  if (device === 'webgpu' && !(await (globalThis.navigator as any)?.gpu?.requestAdapter?.().catch(() => null))) device = 'wasm'
  const dts = spec.onnx.dtypes
  const f16Bad = device === 'webgpu' && !opts.dtype && (opts.avoid ? opts.avoid.includes('fp16') : await gpuF16Bad())
  const tried = new Set<string>()
  const next = (dev: 'webgpu' | 'wasm'): string | null => {
    const d = dev === device && opts.dtype && !tried.has(`${dev}|${opts.dtype}`) ? opts.dtype : pickDtype(dts, dev, [...(f16Bad && dev === 'webgpu' ? ['fp16', 'q4f16'] : []), ...[...tried].filter((t) => t.startsWith(`${dev}|`)).map((t) => t.split('|')[1])])
    return tried.has(`${dev}|${d}`) || !(dts.includes(d) || (d === 'fp32' && !dts.length)) ? null : d
  }
  let dev = device
  let lastErr: BrowserRunError | null = null
  try {
    for (;;) {
      const dtype = next(dev)
      if (!dtype) {
        if (dev === 'webgpu') { dev = 'wasm'; continue }
        throw lastErr ?? new BrowserRunError('unsupported', 'No usable precision was found for this model.')
      }
      tried.add(`${dev}|${dtype}`)
      try {
        return await runOnce(spec, task, prep, onFrame, dev, dtype, opts)
      } catch (e: any) {
        const err = classifyError(e, dev)
        lastErr = err
        if (err.code === 'degenerate' || (dev === 'webgpu' && err.code === 'unsupported')) continue   // another precision, then the CPU
        throw err
      }
    }
  } finally { if (!opts.prepared) prep.revoke?.() }
}

/* ================================================================== CONTRACT (frozen in Phase 0; owner: S4)
 * Downloads with consent, and real weights/activations for the inspector. */
export interface DownloadPlan { repo: string; bytes: number | null; cached: boolean; etaSeconds: number | null; consent: 'none' | 'size' | 'warn'; /** the precision that will be fetched */ dtype?: string; /** cellular or data saver: the UI adds one quiet line, nothing blocks */ metered?: boolean }
export interface DownloadHandle { cancel(): void; done: Promise<{ cached: boolean; bytes: number }> }
/* planDownload(spec, opts?), ensureModel(spec, {onProgress, signal?, device?, dtype?}), requestPersist(), clearModels(), modelCacheInfo() are defined above.
 * consent: 'none' < 25 MB, 'size' 25-150 MB (show size + time), 'warn' > 150 MB or cellular/saveData. */
export interface TensorReq { repo: string; file: string; name: string; i0?: number; r0: number; c0: number; rows: number; cols: number; stride?: number }
/** `rows` x `cols` is the size of `data` (row-major, F32). Source cell (i, j) is (r0 + i * stride, c0 + j * colStride). */
export interface TensorWin { name: string; dtype: string; shape: number[]; r0: number; c0: number; rows: number; cols: number; stride: number; data: Float32Array; fetchedBytes: number; requests: number; truncated: boolean; decoded: boolean; colStride?: number; source?: 'hub' | 'companion' }

/* ------------------------------------------------------------------ safetensors header */
const ITEMSIZE: Record<string, number> = { F64: 8, F32: 4, F16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, I64: 8, I32: 4, I16: 2, I8: 1, U64: 8, U32: 4, U16: 2, U8: 1, BOOL: 1 }
const DECODABLE = new Set(['F64', 'F32', 'F16', 'BF16', 'F8_E4M3', 'F8_E5M2'])
const MAX_HEADER = 16 * MiB
export interface TensorEntry { dtype: string; shape: number[]; start: number; end: number }
export interface SafetensorsHeader { headerLen: number; base: number; tensors: Record<string, TensorEntry>; metadata: Record<string, unknown> | null }

/**
 * Validate and parse a safetensors header. `bytes` starts at byte 0 of the file (the 8-byte length, then the JSON) and
 * `fileSize` is the whole file's size. Offsets in the result are relative to `base` (= 8 + header length).
 */
export function parseHeader(bytes: ArrayBuffer | Uint8Array, fileSize: number): SafetensorsHeader {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (u8.byteLength < 8) throw new TensorError('truncated', 'The file is too short to be a safetensors file.')
  const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getBigUint64(0, true)
  if (len === 0n || len > BigInt(MAX_HEADER)) throw new TensorError('length', `The header length ${len} is outside 1 byte to 16 MiB, so this is not a valid safetensors file.`)
  const n = Number(len), base = 8 + n
  if (base > fileSize) throw new TensorError('truncated', 'The header is longer than the file.')
  if (u8.byteLength < base) throw new TensorError('truncated', 'The header bytes were cut short.')
  let obj: any
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(8, base)))
  } catch { throw new TensorError('json', 'The header is not valid UTF-8 JSON.') }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new TensorError('json', 'The header is not a JSON object.')
  const tensors: Record<string, TensorEntry> = {}
  let metadata: Record<string, unknown> | null = null
  const spans: { name: string; a: number; b: number }[] = []
  const isInt = (x: any) => typeof x === 'number' && Number.isSafeInteger(x)
  for (const [name, e] of Object.entries<any>(obj)) {
    if (name === '__metadata__') { if (e !== null && typeof e === 'object' && !Array.isArray(e)) metadata = e; else throw new TensorError('entry', '"__metadata__" is not a dictionary.'); continue }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new TensorError('entry', `Entry "${name}" is not a dictionary.`)
    if (typeof e.dtype !== 'string' || e.shape === undefined || e.data_offsets === undefined) throw new TensorError('field', `Entry "${name}" is missing dtype, shape or data_offsets.`)
    if (!(e.dtype in ITEMSIZE)) throw new TensorError('dtype', `Entry "${name}" has the unknown dtype "${String(e.dtype).slice(0, 20)}".`)
    if (!Array.isArray(e.shape) || e.shape.length > 8) throw new TensorError('dims', `Entry "${name}" has a bad shape (at most 8 dimensions).`)
    if (!e.shape.every((d: any) => isInt(d) && d >= 0)) throw new TensorError('dims', `Entry "${name}" has a negative, fractional or too large dimension.`)
    const off = e.data_offsets
    if (!Array.isArray(off) || off.length !== 2 || !isInt(off[0]) || !isInt(off[1]) || off[0] < 0 || off[0] > off[1]) throw new TensorError('offsets', `Entry "${name}" has bad data_offsets.`)
    const want = (e.shape as number[]).reduce((p, d) => p * BigInt(d), 1n) * BigInt(ITEMSIZE[e.dtype])
    if (BigInt(off[1]) - BigInt(off[0]) !== want) throw new TensorError('size', `Entry "${name}" says ${off[1] - off[0]} bytes but its shape needs ${want}.`)
    if (base + off[1] > fileSize) throw new TensorError('offsets', `Entry "${name}" reaches past the end of the file.`)
    tensors[name] = { dtype: e.dtype, shape: e.shape, start: off[0], end: off[1] }
    if (off[1] > off[0]) spans.push({ name, a: off[0], b: off[1] })
  }
  spans.sort((x, y) => x.a - y.a || x.b - y.b)
  for (let i = 1; i < spans.length; i++) if (spans[i].a < spans[i - 1].b) throw new TensorError('overlap', `Entries "${spans[i - 1].name}" and "${spans[i].name}" overlap.`)
  return { headerLen: n, base, tensors, metadata }
}

/* ------------------------------------------------------------------ decoding */
function f8(b: number, e4m3: boolean): number {
  const s = b & 0x80 ? -1 : 1
  if (e4m3) {
    const e = (b >> 3) & 15, m = b & 7
    if (e === 15 && m === 7) return NaN
    return s * (e === 0 ? (m / 8) * 2 ** -6 : (1 + m / 8) * 2 ** (e - 7))
  }
  const e = (b >> 2) & 31, m = b & 3
  if (e === 31) return m ? NaN : s * Infinity
  return s * (e === 0 ? (m / 4) * 2 ** -14 : (1 + m / 4) * 2 ** (e - 15))
}
/** Decode raw little-endian bytes of a float dtype to Float32. */
export function decodeBytes(buf: Uint8Array, dtype: string, count: number): Float32Array {
  const out = new Float32Array(count)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  switch (dtype) {
    case 'F32': for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true); break
    case 'F64': for (let i = 0; i < count; i++) out[i] = dv.getFloat64(i * 8, true); break
    case 'F16': for (let i = 0; i < count; i++) out[i] = f16bits(dv.getUint16(i * 2, true)); break
    case 'BF16': { const t = new DataView(new ArrayBuffer(4)); for (let i = 0; i < count; i++) { t.setUint32(0, dv.getUint16(i * 2, true) << 16); out[i] = t.getFloat32(0) } break }
    case 'F8_E4M3': for (let i = 0; i < count; i++) out[i] = f8(buf[i], true); break
    case 'F8_E5M2': for (let i = 0; i < count; i++) out[i] = f8(buf[i], false); break
    default: throw new TensorError('dtype', `${dtype} cannot be decoded to numbers.`)
  }
  return out
}

/* ------------------------------------------------------------------ tensor window: Range reads from the Hub */
export const WINDOW_CAPS = { readBytes: 16 * MiB, maxSide: 1024, ms: 15_000, inFlight: 8, lruBytes: 64 * MiB, overviewRows: 64 }

let gate = 0
const waiters: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (gate >= WINDOW_CAPS.inFlight) await new Promise<void>((r) => waiters.push(r))
  gate++
  try { return await fn() } finally { gate--; waiters.shift()?.() }
}

const shas = new Map<string, Promise<string>>()
/** Pin `main` to a commit SHA once, so every range of a window reads the same revision. */
export function resolveSha(repo: string, signal?: AbortSignal): Promise<string> {
  let p = shas.get(repo)
  if (!p) {
    p = (async () => {
      let r: Response
      try { r = await fetch(`${HUB}/api/models/${repo}`, { signal }) } catch (e: any) { throw netErr(e, repo) }
      if (r.status === 401 || r.status === 403) throw new TensorError('gated', `"${repo}" is gated or private: it needs a Hugging Face login.`)
      if (r.status === 404) throw new TensorError('notfound', `"${repo}" was not found on Hugging Face.`)
      if (!r.ok) throw new TensorError('http', `Hugging Face answered HTTP ${r.status} for ${repo}.`)
      const d = await r.json()
      if (d.gated) throw new TensorError('gated', `"${repo}" is gated: accept its licence on Hugging Face first.`)
      if (typeof d.sha !== 'string' || !/^[0-9a-f]{40}$/.test(d.sha)) throw new TensorError('http', 'Hugging Face did not give a commit for this repo.')
      return d.sha as string
    })()
    shas.set(repo, p)
    p.catch(() => shas.delete(repo))
  }
  return p
}
function netErr(e: any, repo: string): TensorError {
  if (isAbort(e)) return new TensorError('aborted', 'The read was cancelled.')
  return new TensorError('offline', nav()?.onLine === false ? 'You are offline.' : `Could not reach Hugging Face to read ${repo}.`)
}

interface Stats { requests: number; bytes: number }
async function range(url: string, a: number, b: number, signal: AbortSignal, st: Stats, repo: string): Promise<{ data: Uint8Array; total: number | null }> {
  return slot(async () => {
    let r: Response
    st.requests++
    try { r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, signal }) } catch (e: any) { throw netErr(e, repo) }
    if (r.status === 401 || r.status === 403) throw new TensorError('gated', `"${repo}" is gated or private: it needs a Hugging Face login.`)
    if (r.status === 404) throw new TensorError('notfound', 'That file was not found in the repository.')
    if (r.status !== 206) { try { await r.body?.cancel() } catch { /* ignore */ } throw new TensorError('http', `The server did not honour a byte range (HTTP ${r.status}), so the file was not read.`) }
    let data: Uint8Array
    try { data = new Uint8Array(await r.arrayBuffer()) } catch (e: any) { throw netErr(e, repo) }
    st.bytes += data.byteLength
    const tm = /\/(\d+)\s*$/.exec(r.headers.get('content-range') ?? '')
    return { data, total: tm ? Number(tm[1]) : null }
  })
}

const headers = new Map<string, Promise<{ hdr: SafetensorsHeader; url: string; fileSize: number }>>()
/** Read and validate one safetensors file's header (cached for the session). `file` comes from the repo's file list. */
export function readHeader(repo: string, file: string, signal?: AbortSignal): Promise<{ hdr: SafetensorsHeader; url: string; fileSize: number }> {
  const k = `${repo}|${file}`
  let p = headers.get(k)
  if (!p) {
    p = (async () => {
      const sha = await resolveSha(repo, signal)
      const url = `${HUB}/${repo}/resolve/${sha}/${file.split('/').map(encodeURIComponent).join('/')}`
      const st: Stats = { requests: 0, bytes: 0 }
      const ac = signal ?? new AbortController().signal
      const first = await range(url, 0, 65535, ac, st, repo)
      if (first.total == null) throw new TensorError('http', 'The server did not report the file size.')
      let buf = first.data
      if (buf.byteLength >= 8) {
        const need = 8 + Number(new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true))
        if (need > buf.byteLength && need <= 8 + MAX_HEADER && need <= first.total) buf = (await range(url, 0, need - 1, ac, st, repo)).data
      }
      return { hdr: parseHeader(buf, first.total), url, fileSize: first.total }
    })()
    headers.set(k, p)
    p.catch(() => headers.delete(k))
  }
  return p
}

interface Plan2D { R: number; C: number; slab: number }   // the matrix view: R rows of C columns, `slab` bytes to skip for i0
function view2d(shape: number[], i0: number | undefined, isz: number): Plan2D {
  if (shape.length === 0) return { R: 1, C: 1, slab: 0 }
  if (shape.length === 1) return { R: 1, C: shape[0], slab: 0 }
  if (shape.length === 2) return { R: shape[0], C: shape[1], slab: 0 }
  if (i0 === undefined) throw new TensorError('needs-i0', `This tensor has ${shape.length} dimensions: choose which slice (i0) to view.`)
  if (!Number.isInteger(i0) || i0 < 0 || i0 >= shape[0]) throw new TensorError('range', `i0 ${i0} is outside 0..${shape[0] - 1}.`)
  const C = shape.slice(2).reduce((a, b) => a * b, 1)
  return { R: shape[1], C, slab: i0 * shape[1] * C * isz }
}

/* LRU of decoded windows, 64 MB */
const lru = new Map<string, TensorWin>()
let lruBytes = 0
const lruGet = (k: string) => { const v = lru.get(k); if (v) { lru.delete(k); lru.set(k, v) } return v }
function lruPut(k: string, w: TensorWin) {
  const sz = w.data.byteLength
  if (sz > WINDOW_CAPS.lruBytes) return
  lru.set(k, w); lruBytes += sz
  while (lruBytes > WINDOW_CAPS.lruBytes) { const [ok, ov] = lru.entries().next().value as [string, TensorWin]; lru.delete(ok); lruBytes -= ov.data.byteLength }
}
export const windowCacheBytes = () => lruBytes

async function browserWindow(q: TensorReq, userSignal?: AbortSignal): Promise<TensorWin> {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, WINDOW_CAPS.ms)
  const onAbort = () => ac.abort()
  if (userSignal) { if (userSignal.aborted) ac.abort(); else userSignal.addEventListener('abort', onAbort, { once: true }) }
  try {
    const { hdr, url } = await readHeader(q.repo, q.file, ac.signal)
    const e = hdr.tensors[q.name]
    if (!e) throw new TensorError('notfound', `"${q.name}" is not in ${q.file}.`)
    const isz = ITEMSIZE[e.dtype]
    const { R, C, slab } = view2d(e.shape, q.i0, isz)
    const rows = Math.max(1, Math.min(Math.floor(q.rows), WINDOW_CAPS.maxSide)), cols = Math.max(1, Math.min(Math.floor(q.cols), WINDOW_CAPS.maxSide))
    if (![q.r0, q.c0, q.rows, q.cols].every(Number.isInteger) || q.r0 < 0 || q.c0 < 0 || q.rows < 1 || q.cols < 1) throw new TensorError('range', 'The window must be whole numbers, starting at 0 or more, at least 1 x 1.')
    if (q.r0 >= R || q.c0 >= C) throw new TensorError('range', `The window starts outside the tensor (${R} x ${C}).`)
    const base = { name: q.name, dtype: e.dtype, shape: e.shape, r0: q.r0, c0: q.c0 }
    const key = `${url}|${q.name}|${q.i0 ?? ''}|${q.r0}|${q.c0}|${rows}|${cols}|${q.stride ?? 'auto'}`
    const hit = lruGet(key)
    if (hit) return { ...hit, fetchedBytes: 0, requests: 0 }
    if (!DECODABLE.has(e.dtype)) {
      // quantized / integer storage: say so, without reading anything
      return { ...base, rows, cols, stride: q.stride ?? 1, data: new Float32Array(rows * cols), fetchedBytes: 0, requests: 0, truncated: false, decoded: false, source: 'hub' }
    }
    // output grid: source cell (i, j) = (r0 + i * sr, c0 + j * sc)
    let sr: number, sc: number, truncated = false
    if (q.stride !== undefined) {
      if (!Number.isInteger(q.stride) || q.stride < 1) throw new TensorError('range', 'The stride must be a whole number of 1 or more.')
      sr = sc = q.stride
    } else {
      sr = Math.max(1, Math.ceil((R - q.r0) / rows)); sc = Math.max(1, Math.ceil((C - q.c0) / cols))
    }
    let nr = Math.min(rows, Math.ceil((R - q.r0) / sr)), nc = Math.min(cols, Math.ceil((C - q.c0) / sc))
    if (sr > 1 && nr > WINDOW_CAPS.overviewRows) {
      // an overview samples at most 64 rows, evenly spaced over the requested span (never just the first rows)
      if (q.stride === undefined) { sr = Math.max(1, Math.ceil((R - q.r0) / WINDOW_CAPS.overviewRows)); nr = Math.min(WINDOW_CAPS.overviewRows, Math.ceil((R - q.r0) / sr)) } else { nr = WINDOW_CAPS.overviewRows; truncated = true }
    }
    // byte plan
    const rowBytes = C * isz
    let span = (nc - 1) * sc + 1                                   // elements read per row
    if (span * isz > WINDOW_CAPS.readBytes) { span = Math.floor(WINDOW_CAPS.readBytes / isz); nc = Math.floor((span - 1) / sc) + 1; span = (nc - 1) * sc + 1; truncated = true }
    const contiguousLen = (nr: number) => (nr - 1) * rowBytes + span * isz
    const contiguous = sr === 1 && (contiguousLen(nr) <= MiB || contiguousLen(nr) <= 4 * nr * span * isz)
    let rowsRead = nr
    if (contiguous) { while (rowsRead > 1 && contiguousLen(rowsRead) > WINDOW_CAPS.readBytes) rowsRead-- }
    else rowsRead = Math.max(1, Math.min(nr, Math.floor(WINDOW_CAPS.readBytes / (span * isz))))
    if (rowsRead < nr) { nr = rowsRead; truncated = true }
    const st: Stats = { requests: 0, bytes: 0 }
    const origin = hdr.base + e.start + slab + q.c0 * isz
    const out = new Float32Array(nr * nc)
    const pick = (row: Uint8Array) => {   // one row's bytes (starting at column c0) -> nc decoded cells
      const all = decodeBytes(row, e.dtype, span)
      return sc === 1 ? all : Float32Array.from({ length: nc }, (_, j) => all[j * sc])
    }
    if (contiguous) {
      const a = origin + q.r0 * rowBytes
      const { data } = await range(url, a, a + contiguousLen(nr) - 1, ac.signal, st, q.repo)
      for (let i = 0; i < nr; i++) out.set(pick(data.subarray(i * rowBytes, i * rowBytes + span * isz)), i * nc)
    } else {
      const idx = Array.from({ length: nr }, (_, i) => i)
      await Promise.all(idx.map(async (i) => {
        const a = origin + (q.r0 + i * sr) * rowBytes
        const { data } = await range(url, a, a + span * isz - 1, ac.signal, st, q.repo)
        out.set(pick(data), i * nc)
      }))
    }
    const win: TensorWin = { ...base, rows: nr, cols: nc, stride: sr, colStride: sc, data: out, fetchedBytes: st.bytes, requests: st.requests, truncated, decoded: true, source: 'hub' }
    lruPut(key, win)
    return win
  } catch (e: any) {
    if (timedOut) throw new TensorError('timeout', `Reading the tensor took longer than ${WINDOW_CAPS.ms / 1000} s and was stopped.`)
    if (e instanceof TensorError) throw e
    if (isAbort(e)) throw new TensorError('aborted', 'The read was cancelled.')
    throw e
  } finally { clearTimeout(timer); userSignal?.removeEventListener('abort', onAbort) }
}

/** A window of one tensor, read straight from the Hub by byte range (browser-first); the companion is the fallback when one is running. */
export async function tensorWindow(q: TensorReq, signal?: AbortSignal): Promise<TensorWin> {
  try {
    return await browserWindow(q, signal)
  } catch (e: any) {
    const inputBug = e instanceof TensorError && ['range', 'needs-i0', 'aborted'].includes(e.code)
    if (inputBug || signal?.aborted || backendKind() === 'none') throw e
    try {
      const t = await api.tensor(q.repo, q.name, Math.min(256, Math.max(1, q.rows)), Math.min(96, Math.max(8, q.cols)))
      const heat: number[][] = t.heat
      const rows = heat.length, cols = heat[0]?.length ?? 0
      return {
        name: q.name, dtype: t.dtype, shape: t.shape, r0: 0, c0: 0, rows, cols, stride: Math.max(1, Math.ceil((t.rows_read ?? rows) / Math.max(1, rows))),
        data: Float32Array.from(heat.flat()), fetchedBytes: t.fetched_bytes ?? 0, requests: 1, truncated: true, decoded: true, source: 'companion',
      }
    } catch { throw e }   // the companion failed too: report the browser's reason
  }
}

/* ------------------------------------------------------------------ activations */
export type Activation = { available: false; reason: string } | { available: true; dim: number; data: Float32Array; stats: { min: number; max: number; mean: number; std: number }; source: 'companion' | 'onnx'; what?: 'vector' | 'norm-per-position' }
function statsOf(d: Float32Array) {
  let mn = Infinity, mx = -Infinity, s = 0
  for (const v of d) { if (v < mn) mn = v; if (v > mx) mx = v; s += v }
  const mean = d.length ? s / d.length : 0
  let q = 0
  for (const v of d) q += (v - mean) ** 2
  return { min: d.length ? mn : 0, max: d.length ? mx : 0, mean, std: d.length ? Math.sqrt(q / d.length) : 0 }
}
/**
 * One layer's activation on demand. The companion streams per-position norms, so with it `data` holds one norm per token
 * (what: 'norm-per-position'). In the browser only an ONNX export that exposes hidden states can answer, and only for the residual stream.
 */
export async function activation(q: { repo: string; input: TaskInput; layer: number; pos: number; kind: 'resid' | 'attn' | 'mlp' }): Promise<Activation> {
  if (q.input.kind !== 'text') return { available: false, reason: 'Activations are shown for text models only.' }
  if (backendKind() !== 'none') {
    try {
      let hit: any = null
      await streamRun(q.repo, q.input.text, [], (f) => { if (f.type === 'layer' && f.i === q.layer) hit = f })
      const arr: number[] | undefined = hit?.[`${q.kind}_norm`]
      if (!arr) return { available: false, reason: `The companion did not report layer ${q.layer}.` }
      const data = Float32Array.from(arr)
      return { available: true, dim: data.length, data, stats: statsOf(data), source: 'companion', what: 'norm-per-position' }
    } catch (e: any) { return { available: false, reason: `The companion could not run this model: ${e?.message ?? e}` } }
  }
  if (worker && !IN_WORKER) { try { return await callWorker<Activation>(worker, { type: 'activation', q }, {}) } catch (e: any) { return { available: false, reason: `The browser could not read this layer: ${e?.message ?? e}` } } }
  const live = current
  if (!live) return { available: false, reason: 'Run the model in the browser first, then ask again.' }
  if (hiddenSeen.get(q.repo) !== true) return { available: false, reason: 'This ONNX export does not expose hidden states, so only the weights can be shown in the browser. The local companion can show activations.' }
  if (q.kind !== 'resid') return { available: false, reason: 'ONNX exports do not separate attention from the MLP: only the residual stream can be read in the browser.' }
  try {
    const l = await live.p
    const enc = await l.pipe.tokenizer(q.input.text)
    const out = await l.pipe.model({ ...enc, output_hidden_states: true })
    const hs = out?.hidden_states?.[q.layer + 1]
    if (!hs) return { available: false, reason: `This export has no hidden state for layer ${q.layer}.` }
    const [, seq, dim] = hs.dims
    const p = q.pos < 0 ? seq + q.pos : q.pos
    if (p < 0 || p >= seq) return { available: false, reason: `Position ${q.pos} is outside the ${seq} tokens.` }
    const data = toF32(hs.data).slice(p * dim, (p + 1) * dim)
    if (isDegenerate(data)) return { available: false, reason: 'The model returned empty values for this layer on this device.' }
    return { available: true, dim, data, stats: statsOf(data), source: 'onnx', what: 'vector' }
  } catch (e: any) { return { available: false, reason: `The browser could not read this layer: ${e?.message ?? e}` } }
}
/* ================================================================== */

/* ------------------------------------------------------------------ default models */
export interface CatalogEntry {
  repo: string; task: Task; title: string
  /** roughly the smallest browser download in MB (checked against the Hub on 2026-11-14; chooseDefault reads the real size again) */
  approxMB: number
  /** reads more than English */
  multilingual?: boolean
  /** only the lite profile may pick it: smaller, but a weaker result */
  liteOnly?: boolean
}
/** Browser-runnable models, smallest first per task. Sizes are the q4f16/q8 ONNX weights read from the Hub. */
export const CATALOG: CatalogEntry[] = [
  { repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', task: 'text-generation', title: 'SmolLM2 135M', approxMB: 112 },
  { repo: 'onnx-community/Qwen2.5-0.5B-Instruct', task: 'text-generation', title: 'Qwen2.5 0.5B (many languages)', approxMB: 461, multilingual: true },
  { repo: 'Xenova/distilbert-base-uncased', task: 'fill-mask', title: 'DistilBERT', approxMB: 65 },
  { repo: 'Xenova/bert-base-multilingual-cased', task: 'fill-mask', title: 'BERT multilingual', approxMB: 171, multilingual: true },
  { repo: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', task: 'text-classification', title: 'DistilBERT SST-2', approxMB: 64 },
  { repo: 'Xenova/distilbert-base-multilingual-cased-sentiments-student', task: 'text-classification', title: 'DistilBERT multilingual sentiment', approxMB: 130, multilingual: true },
  { repo: 'Xenova/mobilevit-xx-small', task: 'image-classification', title: 'MobileViT xx-small', approxMB: 2, liteOnly: true },
  { repo: 'Xenova/mobilevit-small', task: 'image-classification', title: 'MobileViT small', approxMB: 6 },
  { repo: 'Xenova/resnet-18', task: 'image-classification', title: 'ResNet-18', approxMB: 11 },
  { repo: 'Xenova/vit-base-patch16-224', task: 'image-classification', title: 'ViT base', approxMB: 84 },
  { repo: 'Xenova/whisper-tiny.en', task: 'automatic-speech-recognition', title: 'Whisper tiny (English)', approxMB: 39 },
  { repo: 'Xenova/whisper-tiny', task: 'automatic-speech-recognition', title: 'Whisper tiny (many languages)', approxMB: 39, multilingual: true },
]

/** The smallest catalog model for a task that reads languages other than English (null when none exists). */
export function multilingualFor(task: Task | null, catalog: CatalogEntry[] = CATALOG): CatalogEntry | null {
  return catalog.filter((e) => e.multilingual && e.task === task && !e.liteOnly).sort((a, b) => a.approxMB - b.approxMB)[0] ?? null
}

const specMemo = new Map<string, Promise<ModelSpec>>()
export interface Chosen { entry: CatalogEntry; spec: ModelSpec; fit: Fit; bytes: number }
/**
 * Pick the default model for a task: the smallest catalog entry (real sizes from the Hub) that passes checkFit.
 * caps.profile 'lite' also considers the lite-only entries. A language other than 'en' only considers multilingual entries.
 * `catalog` adds the app's own entries (for example examples/index.json rows with a task). Null when nothing fits.
 */
export async function chooseDefault(task: Task, caps: { profile?: 'lite' | 'standard' | 'full'; language?: string; budget?: Budget; catalog?: { repo: string; task?: Task; title?: string }[] } = {}): Promise<Chosen | null> {
  const lang = (caps.language ?? 'en').toLowerCase().split('-')[0]
  const extra: CatalogEntry[] = (caps.catalog ?? []).filter((e) => e.task === task && !CATALOG.some((c) => c.repo === e.repo)).map((e) => ({ repo: e.repo, task, title: e.title ?? e.repo, approxMB: 1e9 }))
  const pool = [...CATALOG, ...extra].filter((e) => e.task === task && (caps.profile === 'lite' || !e.liteOnly) && (lang === 'en' || e.multilingual))
  const budget = caps.budget ?? (await deviceBudget())
  const rated = await Promise.all(pool.map(async (entry): Promise<Chosen | null> => {
    try {
      let p = specMemo.get(entry.repo)
      if (!p) { p = resolveModel(entry.repo); specMemo.set(entry.repo, p); p.catch(() => specMemo.delete(entry.repo)) }
      const spec = await p
      if (spec.task !== task || !spec.onnx) return null
      const fit = checkFit(spec, budget)
      if (fit.where === 'none' || fit.where === 'companion' || fit.verdict === 'too-big') return null
      const bytes = spec.onnx.sizes?.[fit.dtype ?? ''] ?? Math.min(...Object.values(spec.onnx.sizes ?? { x: entry.approxMB * 1048576 }))
      return { entry, spec, fit, bytes }
    } catch { return null }
  }))
  return rated.filter((r): r is Chosen => !!r).sort((a, b) => a.bytes - b.bytes)[0] ?? null
}

/* ROUND 2 CONTRACT (owner S4): the model runs in a Web Worker so download, compile and inference never block the page.
 * Page -> worker. (Additive to the frozen shape: optional `avoid` and `prepared`, and the `dispose` and `activation` messages.) */
export type ModelWorkerIn =
  | { type: 'load'; id: number; spec: ModelSpec; device: 'webgpu' | 'wasm'; dtype?: string; avoid?: string[] }
  | { type: 'run'; id: number; spec: ModelSpec; input: TaskInput; device: 'webgpu' | 'wasm'; dtype?: string; avoid?: string[]; prepared?: Prepared }
  | { type: 'cancel'; id: number }
  | { type: 'dispose'; id: number }
  | { type: 'activation'; id: number; q: { repo: string; input: TaskInput; layer: number; pos: number; kind: 'resid' | 'attn' | 'mlp' } }
/** Worker -> page (frames carry transferable buffers) */
export type ModelWorkerOut =
  | { type: 'progress'; id: number; done: number; total: number | null; file?: string }
  | { type: 'frame'; id: number; frame: any }
  | { type: 'done'; id: number; stats: BrowserRunStats }
  | { type: 'activation'; id: number; result: Activation }
  | { type: 'error'; id: number; code: 'oom' | 'unsupported' | 'degenerate' | 'offline' | 'gated' | 'quota' | 'cancelled' | 'input' | 'unknown'; message: string }

/* ------------------------------------------------------------------ the worker: this same file is its entry point */
function serveWorker() {
  const ctl = new Map<number, AbortController>()
  const post = (m: ModelWorkerOut, transfer?: Transferable[]) => (self as any).postMessage(m, transfer ?? [])
  const fail = (id: number, e: any) => {
    const err = classifyError(e)
    post({ type: 'error', id, code: err.code === 'aborted' ? 'cancelled' : err.code, message: err.message })
  }
  ;(self as any).onmessage = async (ev: MessageEvent<ModelWorkerIn>) => {
    const m = ev.data
    if ((m as any).ort) ortRoot = (m as any).ort
    if (m.type === 'cancel') { ctl.get(m.id)?.abort(); return }
    if (m.type === 'dispose') { await disposeAll(); post({ type: 'done', id: m.id, stats: {} as any }); return }
    if (m.type === 'activation') { post({ type: 'activation', id: m.id, result: await activation(m.q) }); return }
    const ac = new AbortController()
    ctl.set(m.id, ac)
    let lastP = 0
    const onProgress = (done: number, total: number | null) => {
      const now = performance.now()
      if (now - lastP < 100 && !(total != null && done >= total)) return   // at most 10 messages a second
      lastP = now
      post({ type: 'progress', id: m.id, done, total })
    }
    try {
      if (m.type === 'load') {
        const t0 = performance.now()
        const repo = m.spec.onnx?.repo ?? m.spec.repo
        const dtype = m.dtype ?? pickDtype(m.spec.onnx?.dtypes ?? [], m.device, m.avoid ?? [])
        const dl = await ensureModel(m.spec, { onProgress, signal: ac.signal, device: m.device, dtype }).done
        await loadPipeline(m.spec.task!, repo, m.device, dtype)   // compile now, so the first run is warm
        const loadMs = performance.now() - t0
        post({ type: 'done', id: m.id, stats: { where: m.device, repo, task: m.spec.task!, loadMs, firstMs: 0, totalMs: 0, items: 0, unit: 'items', perSec: 0, memBytes: null, joules: null, estimatedEnergy: false, device: m.device, dtype, cached: dl.cached } })
      } else if (m.type === 'run') {
        const frames = (f: any) => {
          const tr: Transferable[] = []
          if (f?.type === 'layer') for (const k of ['resid_norm', 'attn_norm', 'mlp_norm']) if (f[k] instanceof Float32Array) tr.push(f[k].buffer)
          post({ type: 'frame', id: m.id, frame: f }, tr)
        }
        const stats = await runInThread(m.spec, m.input, frames, { device: m.device, dtype: m.dtype, avoid: m.avoid, prepared: m.prepared, signal: ac.signal, onProgress })
        post({ type: 'done', id: m.id, stats })
      }
    } catch (e: any) { fail(m.id, e) } finally { ctl.delete(m.id) }
  }
}
if (IN_WORKER) serveWorker()

/* ------------------------------------------------------------------ the page side: talks to the worker, falls back to running in the page */
interface Pending { onFrame?: (f: any) => void; onProgress?: (done: number, total: number | null) => void; resolve: (v: any) => void; reject: (e: any) => void }
let worker: Worker | null = null
let workerBroken = false
let msgId = 0
const pending = new Map<number, Pending>()
const modelWorker = (): Worker | null => {
  if (workerBroken || IN_WORKER || typeof Worker === 'undefined') return null
  if (!worker) {
    try {
      worker = new Worker(new URL('./api.ts', import.meta.url), { type: 'module' })
    } catch { workerBroken = true; return null }
    worker.onmessage = (ev: MessageEvent<ModelWorkerOut>) => {
      const m = ev.data, p = pending.get(m.id)
      if (!p) return
      if (m.type === 'progress') p.onProgress?.(m.done, m.total)
      else if (m.type === 'frame') p.onFrame?.(m.frame)
      else { pending.delete(m.id); if (m.type === 'error') p.reject(new BrowserRunError(m.code === 'cancelled' ? 'aborted' : m.code, m.message)); else p.resolve(m.type === 'activation' ? m.result : m.stats) }
    }
    worker.onerror = () => {   // the worker could not start (or died): fail what waits, and run in the page from now on
      workerBroken = true
      worker?.terminate(); worker = null
      for (const [id, p] of pending) { pending.delete(id); p.reject(new BrowserRunError('unsupported', 'The model engine could not start in a background thread.')) }
    }
  }
  return worker
}
function callWorker<T>(w: Worker, msg: ModelWorkerIn extends infer U ? (U extends { id: number } ? Omit<U, 'id'> : never) : never, h: Pick<Pending, 'onFrame' | 'onProgress'>, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
  const id = ++msgId
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new BrowserRunError('aborted', 'The run was cancelled.'))
    pending.set(id, { ...h, resolve, reject })
    signal?.addEventListener('abort', () => { w.postMessage({ type: 'cancel', id }); if (pending.delete(id)) reject(new BrowserRunError('aborted', 'The run was cancelled.')) }, { once: true })
    w.postMessage({ ...msg, id, ort: typeof document !== 'undefined' ? new URL('ort/', document.baseURI).href : undefined }, transfer)
  })
}
const f16Avoid = async (device: 'webgpu' | 'wasm', dtype?: string) => (device === 'webgpu' && !dtype && (await gpuF16Bad()) ? ['fp16', 'q4f16'] : [])

/** Run a model. It works in a background thread, so downloading, compiling and inference never freeze the page. */
export async function runInBrowser(spec: ModelSpec, input: TaskInput, onFrame: (f: any) => void, opts: RunOpts): Promise<BrowserRunStats> {
  const w = modelWorker()
  if (!w || !spec.task || !spec.onnx) return runInThread(spec, input, onFrame, opts)
  const check = await validateInput(spec.task, input)   // audio decoding needs the page's AudioContext, so inputs are prepared here
  if (!check.ok) throw new BrowserRunError('input', check.error)
  const prep = check.prepared
  const tr: Transferable[] = prep.audio ? [prep.audio.buffer as ArrayBuffer] : []
  try {
    return await callWorker<BrowserRunStats>(w, { type: 'run', spec, input, device: opts.device, dtype: opts.dtype, avoid: opts.avoid ?? (await f16Avoid(opts.device, opts.dtype)), prepared: { text: prep.text, image: prep.image, audio: prep.audio, language: prep.language } }, { onFrame, onProgress: opts.onProgress }, opts.signal, tr)
  } catch (e: any) {
    if (workerBroken && e?.code === 'unsupported' && !opts.signal?.aborted) return runInThread(spec, input, onFrame, { ...opts, prepared: undefined })
    throw e
  } finally { prep.revoke?.() }
}

/** Download a model (if needed) and compile it, in the background thread. Resolves with the load time and whether the files were already cached. */
export async function loadInBrowser(spec: ModelSpec, opts: { device: 'webgpu' | 'wasm'; dtype?: string; signal?: AbortSignal; onProgress?: (done: number, total: number | null) => void }): Promise<BrowserRunStats> {
  const w = modelWorker()
  const inThread = async (): Promise<BrowserRunStats> => {
    const t0 = performance.now()
    const dtype = opts.dtype ?? planDtype(spec, opts.device)
    const dl = await ensureModel(spec, { onProgress: opts.onProgress ?? (() => {}), signal: opts.signal, device: opts.device, dtype }).done
    const repo = spec.onnx!.repo
    await loadPipeline(spec.task!, repo, opts.device, dtype)
    return { where: opts.device, repo, task: spec.task!, loadMs: performance.now() - t0, firstMs: 0, totalMs: 0, items: 0, unit: 'items', perSec: 0, memBytes: null, joules: null, estimatedEnergy: false, device: opts.device, dtype, cached: dl.cached }
  }
  if (!spec.task || !spec.onnx) throw new BrowserRunError('unsupported', 'This model cannot be loaded in the browser.')
  if (!w) return inThread().catch((e) => { throw classifyError(e, opts.device) })
  try {
    return await callWorker<BrowserRunStats>(w, { type: 'load', spec, device: opts.device, dtype: opts.dtype, avoid: await f16Avoid(opts.device, opts.dtype) }, { onProgress: opts.onProgress }, opts.signal)
  } catch (e: any) {
    if (workerBroken && !opts.signal?.aborted) return inThread().catch((e2) => { throw classifyError(e2, opts.device) })
    throw e
  }
}
