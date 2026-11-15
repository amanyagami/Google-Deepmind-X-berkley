// The leaderboard dialog: top 50 by best score, this device highlighted, its rank even outside the top 50.
// Loaded on first open only (see board.tsx). States: loading, offline (no API on this host), error, empty, table.
import { useEffect, useRef, useState } from 'react'
import { BOARD_PILLARS, boardHere, loadBoard, retryPending, setBoardOff, startTestAll, useBoard, type BoardMe, type BoardPillar, type BoardRow } from '../board'

const LABEL: Record<BoardPillar, string> = { compute: 'Compute', memory: 'Memory', gpu: 'GPU', storage: 'Storage', model: 'Model' }
/** Log scale like the score rows: 100 is empty, 2000 is full. */
const pct = (s: number | null | undefined) => (s && s > 0 ? Math.max(4, Math.min(100, (Math.log(s / 100) / Math.log(20)) * 100)) : 0)
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const BACKEND_LABEL: Record<string, string> = { webgpu: 'WebGPU', wasm: 'Wasm', companion: 'Companion' }
function ago(iso: string) {
  const d = (Date.now() - Date.parse(iso)) / 86400e3
  return !Number.isFinite(d) ? '' : d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 60 ? `${Math.floor(d)} d ago` : new Date(iso).toISOString().slice(0, 10)
}

type View = { k: 'loading' } | { k: 'offline' } | { k: 'error' } | { k: 'ok'; rows: BoardRow[]; total: number; me: BoardMe | null }

function Bars({ p }: { p: BoardRow['pillars'] }) {
  const says = BOARD_PILLARS.map((k) => `${LABEL[k]} ${p?.[k] != null ? fmt(p[k]!) : 'not tested'}`).join(', ')
  return (
    <span className="lb-bars" role="img" aria-label={says} title={says}>
      {BOARD_PILLARS.map((k) => <i key={k} style={{ height: `${pct(p?.[k])}%`, background: `var(--p-${k})` }} />)}
    </span>
  )
}

function Row({ r, you }: { r: BoardRow; you: boolean }) {
  const medal = r.rank === 1 ? 'top1' : r.rank === 2 ? 'top2' : r.rank === 3 ? 'top3' : ''
  const engine = r.backend ? (BACKEND_LABEL[r.backend.toLowerCase()] ?? r.backend) : ''
  return (
    <tr className={`${you ? 'you ' : ''}${medal}`} aria-current={you ? 'true' : undefined} data-board-row={you ? 'me' : undefined}>
      <td className="lb-rank mono">{r.rank}</td>
      <td className="lb-name"><span>{r.name}</span>{you && <b className="lb-you">you</b>}</td>
      <td className="lb-when">{ago(r.updatedAt)}{engine ? ` · ${engine}` : ''}</td>
      <td className="lb-parts"><Bars p={r.pillars} /></td>
      <td className="lb-score mono">{fmt(r.best)}</td>
    </tr>
  )
}

export default function Leaderboard({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>(() => (boardHere() ? { k: 'loading' } : { k: 'offline' }))
  const [tries, setTries] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const off = useBoard((s) => s.off)
  const sendState = useBoard((s) => s.state)
  const pending = useBoard((s) => s.pending)
  const sentAt = useBoard((s) => (s.state === 'sent' ? s.me?.updatedAt : null))
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!boardHere()) return
    let live = true
    setRefreshing(true)
    setView((v) => (v.k === 'ok' ? v : { k: 'loading' }))
    loadBoard().then(
      (r) => { if (live) { setView({ k: 'ok', ...r }); setRefreshing(false) } },
      () => { if (live) { setView({ k: 'error' }); setRefreshing(false) } },
    )
    return () => { live = false }
  }, [tries, sentAt])

  // bring this device's row into view once the table is there
  useEffect(() => { if (view.k === 'ok') document.querySelector('[data-leaderboard] [data-board-row=me]')?.scrollIntoView({ block: 'nearest' }) }, [view])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', key)
    return () => { removeEventListener('keydown', key); before?.focus?.() }
  }, [onClose])

  const me = view.k === 'ok' ? view.me : null
  const isMe = (r: BoardRow) => !!me && r.rank === me.rank && r.name === me.name && r.best === me.best
  const inTop = view.k === 'ok' && view.rows.some(isMe)

  let body: React.ReactNode
  if (view.k === 'loading') body = <div className="lb-state" role="status"><p>Loading the leaderboard…</p><button type="button" className="t5-btn" onClick={onClose}>Close</button></div>
  else if (view.k === 'offline') body = <div className="lb-state" data-board-offline><p>Leaderboard is offline on this copy of the app.</p><button type="button" className="t5-btn" onClick={onClose}>Close</button></div>
  else if (view.k === 'error') body = <div className="lb-state" role="alert"><p>Could not load the leaderboard.</p><button type="button" className="t5-btn pri" onClick={() => setTries((n) => n + 1)}>Try again</button></div>
  else if (!view.rows.length) body = <div className="lb-state"><p>No scores yet. Run Test all to be the first on the board.</p><button type="button" className="t5-btn pri" onClick={startTestAll}>Test all</button></div>
  else body = (
    <table className="lb-table">
      <thead><tr><th className="lb-rank" scope="col">#</th><th scope="col">Name</th><th className="lb-when" scope="col">When</th><th className="lb-parts" scope="col">Parts</th><th className="lb-score" scope="col">Best</th></tr></thead>
      <tbody>{view.rows.map((r) => <Row key={`${r.rank}-${r.name}-${r.updatedAt}`} r={r} you={isMe(r)} />)}</tbody>
      {me && !inTop && <tbody className="lb-mine"><tr className="lb-gap" aria-hidden><td colSpan={5}>⋯</td></tr><Row r={{ rank: me.rank, name: me.name, best: me.best, pillars: me.pillars ?? {}, updatedAt: me.updatedAt }} you /></tbody>}
    </table>
  )

  const pendingBanner = !off && pending && (sendState === 'error' || sendState === 'rate_limited' || sendState === 'blocked')
  const line = off ? null
    : pendingBanner ? (
      sendState === 'blocked'
        ? <>Saved score ({fmt(pending.score)}) could not be posted: pick a different name in Settings, then test again.</>
        : <>Saved score ({fmt(pending.score)}) is waiting to post. <button type="button" className="t5-link" onClick={retryPending}>Send now</button></>
    )
    : me ? `You are #${fmt(me.rank)} of ${fmt(me.total)}. Best ${fmt(me.best)}, tested ${me.visits} ${me.visits === 1 ? 'time' : 'times'}.`
    : view.k === 'ok' ? 'Run Test all in Machine to post your device score.' : null

  const sub = view.k === 'ok'
    ? `${fmt(view.total)} ${view.total === 1 ? 'device' : 'devices'} ranked · best score kept · names are public`
    : 'Best score of each device. Names are public.'

  return (
    <div className="lb-wall" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}>
      <section className="lb" role="dialog" aria-modal="true" aria-labelledby="lb-t" data-leaderboard>
        <header className="lb-head">
          <div><h3 id="lb-t">Leaderboard</h3><p className="lb-sub">{sub}</p></div>
          <div className="lb-head-act">
            {view.k !== 'offline' && (
              <button type="button" className="t5-btn" disabled={refreshing} onClick={() => setTries((n) => n + 1)} aria-label="Refresh leaderboard">
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            <button ref={closeRef} type="button" className="t5-btn" onClick={onClose}>Close</button>
          </div>
        </header>
        {(line || off) && view.k === 'ok' && (
          <p className="lb-me" data-board-me>{off ? <>You are off the board. <button type="button" className="t5-link" onClick={() => setBoardOff(false)}>Join</button></> : line}</p>
        )}
        <div className="lb-scroll">{body}</div>
      </section>
      <style>{CSS}</style>
    </div>
  )
}

const CSS = `
.lb-wall{position:fixed;inset:0;z-index:95;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--bg) 72%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.lb{width:min(740px,100%);max-height:min(86dvh,880px);display:flex;flex-direction:column;background:var(--glass-heavy,var(--panel));backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);color:var(--fg);border:1px solid var(--rim,var(--line));border-radius:var(--r-lg,18px);box-shadow:var(--sh-2,0 20px 60px #0007),0 0 40px -12px var(--glow,transparent);overflow:hidden;animation:rise var(--d3,360ms) var(--ease,ease) both}
.lb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 18px 10px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)}
.lb-head h3{margin:0;font:700 18px/1.2 var(--display,var(--body));letter-spacing:-0.015em}
.lb-head-act{display:flex;align-items:center;gap:8px;flex:none}
.lb-sub{color:var(--muted);font-size:13px;margin:3px 0 0}
.lb-me{margin:0;padding:10px 18px;font-size:13.5px;color:var(--fg);background:color-mix(in srgb,var(--pos) 8%,transparent);border-bottom:1px solid color-mix(in srgb,var(--line) 45%,transparent)}
.lb-scroll{overflow:auto;padding:4px 10px 14px;min-height:120px}
.lb-state{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:18px 8px 8px}
.lb-state p{color:var(--fg);margin:0}
.lb-table{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
.lb-table th{position:sticky;top:0;z-index:1;background:var(--glass-heavy,var(--panel));backdrop-filter:blur(14px);text-align:left;font:600 11.5px var(--body);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:8px;border-bottom:1px solid var(--line)}
.lb-table td{padding:7px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 50%,transparent);height:42px;transition:background var(--d1,120ms) ease}
.lb-table tbody tr:hover td{background:color-mix(in srgb,var(--fg) 4%,transparent)}
.lb-rank{width:46px;color:var(--muted);font-weight:600}
.lb-table tr.top1 .lb-rank{color:var(--pos-ink);font-weight:800}
.lb-table tr.top2 .lb-rank{color:var(--neg-ink);font-weight:700}
.lb-table tr.top3 .lb-rank{color:var(--est);font-weight:700}
.lb-name{max-width:0;width:100%;white-space:nowrap}
.lb-name span{display:inline-block;max-width:calc(100% - 48px);overflow:hidden;text-overflow:ellipsis;vertical-align:middle;font-weight:500}
.lb-when{white-space:nowrap;color:var(--muted);font-size:12.5px}
.lb-parts{width:68px}
.lb-score,.lb-table th.lb-score{text-align:right;font-weight:700;white-space:nowrap}
.lb-bars{display:inline-flex;align-items:flex-end;gap:2.5px;height:20px;width:54px;vertical-align:middle}
.lb-bars i{flex:1;min-height:2px;border-radius:2px 2px 0 0;opacity:.92}
.lb-table tr.you td{background:color-mix(in srgb,var(--pos) 15%,transparent)}
.lb-table tr.you:hover td{background:color-mix(in srgb,var(--pos) 21%,transparent)}
.lb-table tr.you .lb-rank{color:var(--fg);font-weight:800}
.lb-you{margin-left:8px;font:700 11px var(--body);color:var(--pos-ink);border:1px solid color-mix(in srgb,var(--pos) 65%,transparent);border-radius:6px;padding:1px 6px;vertical-align:middle}
.lb-gap td{text-align:center;color:var(--muted);height:28px;border:0}
@media (max-width:640px){.lb-when{display:none}.lb-wall{padding:8px}.lb-head{padding:12px 12px 8px}.lb-me{padding:8px 12px}.lb-scroll{padding:0 4px 8px}.lb-table td,.lb-table th{padding:6px 5px}.lb-rank{width:34px}}
`
