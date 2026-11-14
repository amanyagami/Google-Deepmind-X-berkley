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
  | { kind: 'audio'; url: string }     // a URL, an upload, or a microphone recording

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
export function onnxInfo(siblings: { rfilename: string; size?: number | null }[]): { dtypes: string[]; sizes: Record<string, number> } {
  const size = new Map(siblings.map((f) => [f.rfilename, f.size ?? 0]))
  const names = siblings.map((f) => f.rfilename)
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
