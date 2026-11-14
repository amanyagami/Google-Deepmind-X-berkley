// Thin client for the FastAPI backend. Errors from the server arrive as { error }.
import { apiUrl, detectBackend, wsUrl } from './base'

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
  onnx: { repo: string; dtypes: string[] } | null   // a repo with ONNX weights Transformers.js can load (this one or a converted copy)
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
