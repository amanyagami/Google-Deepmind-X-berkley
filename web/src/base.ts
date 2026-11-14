// Where the companion (the Python server) lives, if anywhere.
//   1. The page was served by the companion itself  -> same origin.
//   2. The page is a static web app (any host)       -> try the companion on this PC, http://127.0.0.1:8000.
//   3. Neither answers                               -> browser-only mode: everything runs in the page.
// A ?token=... in the page URL is forwarded when the companion was started with NEURAL_STUDIO_TOKEN.

export type Backend = 'same' | 'companion' | 'none'

const COMPANION = 'http://127.0.0.1:8000'
let base = ''
let kind: Backend = 'none'
// tolerate non-browser environments (unit tests import this module)
const loc: { search: string; origin: string; protocol: string; host: string } = typeof location !== 'undefined' ? location : { search: '', origin: '', protocol: 'http:', host: 'localhost' }
const token = new URLSearchParams(loc.search).get('token')

const withToken = (p: string) => (token ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : p)
export const apiUrl = (p: string) => withToken(base + p)
export const wsUrl = (p: string) =>
  withToken(base ? base.replace(/^http/, 'ws') + p : `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${p}`)
export const backendKind = () => kind

async function ping(url: string, ms = 1500): Promise<boolean> {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(withToken(url), { signal: c.signal })
    if (!r.ok) return false
    const j = await r.json()
    return !!j?.ok
  } catch { return false } finally { clearTimeout(t) }
}

let detecting: Promise<Backend> | null = null
export function detectBackend(): Promise<Backend> {
  if (detecting) return detecting
  detecting = (async () => {
    if (new URLSearchParams(loc.search).has('browser')) return (kind = 'none')
    if (await ping('/api/health')) { base = ''; return (kind = 'same') }
    if (loc.origin !== COMPANION && (await ping(`${COMPANION}/api/health`))) { base = COMPANION; return (kind = 'companion') }
    return (kind = 'none')
  })()
  return detecting
}
