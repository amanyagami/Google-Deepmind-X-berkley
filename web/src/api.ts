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
