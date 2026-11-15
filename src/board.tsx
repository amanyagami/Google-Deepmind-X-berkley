// The global score leaderboard: device ID, opt-out, submit after Test all, and the lazy dialog.
// Kept tiny: the first page loads this file; the table itself (ui/Leaderboard.tsx) loads on first open.
// The host marks pages that have the API with <meta name="kundali-board"> (server-web/server.mjs adds it), so other
// hosts (a static preview, the companion) show "offline" without a failing request.
import { lazy, Suspense } from 'react'
import { create } from 'zustand'

declare const __APP_VERSION__: string
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
export const BOARD_PILLARS = ['compute', 'memory', 'gpu', 'storage', 'model'] as const
export type BoardPillar = (typeof BOARD_PILLARS)[number]

export interface BoardRow { rank: number; name: string; best: number; pillars: Partial<Record<BoardPillar, number | null>>; tested?: number; backend?: string; updatedAt: string }
export interface BoardMe { rank: number; total: number; name: string; best: number; latest?: number; visits: number; updatedAt: string; pillars?: BoardRow['pillars'] }
export interface BoardPayload { name: string; score: number; pillars: Record<BoardPillar, number | null>; tested: number; backend: string; appVersion: string }
export type SendState = 'idle' | 'sending' | 'sent' | 'off' | 'offline' | 'blocked' | 'rate_limited' | 'error'

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const put = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } }

/** True when this host serves the leaderboard API. */
export const boardHere = () => typeof document !== 'undefined' && !!document.querySelector('meta[name="kundali-board"]')

interface Board {
  open: boolean
  /** "Keep me off the leaderboard" (localStorage ns.board = 'off'): nothing is sent */
  off: boolean
  state: SendState
  me: BoardMe | null
  /** the last score that was not sent because the visitor was off the board; sent if they join */
  pending: BoardPayload | null
  /** set by the Machine view: runs Test all (the empty board offers it) */
  testAll: (() => void) | null
}
export const useBoard = create<Board>(() => ({ open: false, off: get('ns.board') === 'off', state: 'idle', me: null, pending: null, testAll: null }))
if (typeof window !== 'undefined') (window as any).__board = useBoard

/** Open or close the leaderboard. A hook for any button (the top bar can call this). */
export const openLeaderboard = () => {
  useBoard.setState({ open: true })
  const st = useBoard.getState()
  if (st.pending && !st.off && st.state === 'error' && boardHere()) void send(st.pending)
}
export const closeLeaderboard = () => useBoard.setState({ open: false })

export function retryPending() {
  const st = useBoard.getState()
  if (st.pending && !st.off && st.state !== 'sending' && boardHere()) void send(st.pending)
}

export function startTestAll() {
  const fn = useBoard.getState().testAll
  if (fn) { fn(); return }
  closeLeaderboard()
  void import('./store').then(({ jumpTo }) => {
    jumpTo('power')
    let n = 0
    const t = setInterval(() => {
      const f = useBoard.getState().testAll
      if (f) { clearInterval(t); f() }
      else if (++n > 40) clearInterval(t)
    }, 50)
  })
}

export function setBoardOff(off: boolean) {
  put('ns.board', off ? 'off' : null)
  useBoard.setState({ off, ...(off ? { state: 'off' as SendState } : {}) })
  const p = useBoard.getState().pending
  if (!off && p) void send(p)
}

/** Anonymous random device ID, made on the first submit. null when the browser cannot keep it (then nothing is sent). */
function deviceId(create: boolean): string | null {
  let id = get('ns.device')
  if (id || !create) return id
  if (typeof crypto.randomUUID === 'function') id = crypto.randomUUID()
  else {   // insecure contexts have no randomUUID: build a v4 from random bytes
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  put('ns.device', id)
  return get('ns.device') === id ? id : null
}

/** Called when Test all finishes with a final score. Sends it unless the visitor is off the board or the host has no board. */
export async function submitScore(s: { score: number; pillars: Partial<Record<string, number | null>>; tested: number; backend: string }, name: string): Promise<void> {
  const r1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10)
  const p: BoardPayload = {
    name: (name || 'Guest').trim().slice(0, 24) || 'Guest',
    score: Math.round(s.score),
    pillars: Object.fromEntries(BOARD_PILLARS.map((k) => [k, r1(s.pillars[k])])) as BoardPayload['pillars'],
    tested: Math.max(0, Math.min(1, Math.round(s.tested * 100) / 100)),
    backend: s.backend.replace(/[^\w .()+-]/g, '').slice(0, 24),
    appVersion: APP_VERSION,
  }
  if (!boardHere()) { useBoard.setState({ state: 'offline' }); return }
  if (useBoard.getState().off) { useBoard.setState({ state: 'off', pending: p }); return }
  await send(p)
}

async function send(p: BoardPayload) {
  const id = deviceId(true)
  if (!id) { useBoard.setState({ state: 'error', pending: p }); return }
  useBoard.setState({ state: 'sending', pending: null })
  try {
    const r = await fetch('/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: id, ...p }) })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.me) useBoard.setState({ state: 'sent', me: j.me })
    else useBoard.setState({ state: j.error === 'name_not_allowed' ? 'blocked' : r.status === 429 || j.error === 'rate_limited' ? 'rate_limited' : 'error', pending: p })
  } catch { useBoard.setState({ state: 'error', pending: p }) }
}

/** Top 50 plus this device's own rank (even outside the top 50). Throws when the board cannot be read. */
export async function loadBoard(): Promise<{ rows: BoardRow[]; total: number; me: BoardMe | null }> {
  const id = deviceId(false)
  const [a, b] = await Promise.all([fetch('/api/leaderboard?limit=50'), id ? fetch(`/api/leaderboard/me?deviceId=${encodeURIComponent(id)}`).catch(() => null) : null])
  if (!a.ok) throw new Error(`HTTP ${a.status}`)
  const top = await a.json()
  const mine = b && b.ok ? await b.json().catch(() => null) : null
  const me: BoardMe | null = mine?.me ?? null
  if (me) useBoard.setState({ me })
  return { rows: top.rows ?? [], total: top.total ?? 0, me }
}

const LeaderboardDialog = lazy(() => import('./ui/Leaderboard'))
/** Renders the dialog when open. Mount once (App does). */
export function BoardHost() {
  const open = useBoard((s) => s.open)
  return open ? <Suspense fallback={null}><LeaderboardDialog onClose={closeLeaderboard} /></Suspense> : null
}

const CUP = 'M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4'
/** The "Leaderboard" button. Any place can render it; `className` lets the host style it. */
export function LeaderboardButton({ className = 't5-btn t5-board', label = 'Leaderboard' }: { className?: string; label?: string }) {
  return (
    <button type="button" className={className} data-board-open onClick={openLeaderboard} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={CUP} /></svg>
      <span className="t5-blbl">{label}</span>
    </button>
  )
}

/** One line under the score: what happened to it on the board. */
export function BoardStatus({ className = 't5-line' }: { className?: string }) {
  const s = useBoard((b) => b.state), me = useBoard((b) => b.me)
  const text = s === 'sending' ? 'Sending your score to the leaderboard…'
    : s === 'sent' && me ? `On the leaderboard: #${me.rank.toLocaleString('en-US')} of ${me.total.toLocaleString('en-US')}.`
    : s === 'blocked' ? 'This name cannot go on the leaderboard. Change your name, then test again.'
    : s === 'rate_limited' ? 'Too many submissions right now — your score is saved here; try again shortly.'
    : s === 'error' ? 'Your score did not reach the leaderboard. It is saved here.'
    : s === 'off' ? 'You are off the leaderboard.'
    : null
  return text ? <p className={className} data-board-status={s} aria-live="polite">{text}</p> : null
}

/** "Keep me off the leaderboard". */
export function BoardOptOut({ className = 'boardopt' }: { className?: string }) {
  const off = useBoard((s) => s.off)
  return <label className={className}><input type="checkbox" checked={off} onChange={(e) => setBoardOff(e.target.checked)} /> Keep me off the leaderboard</label>
}
