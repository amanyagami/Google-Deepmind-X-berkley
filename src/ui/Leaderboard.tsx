// The leaderboard dialog: top 50 by best score, this device highlighted, its rank even outside the top 50.
// Loaded on first open only (see board.tsx). States: loading, offline (no API on this host), error, empty, table.
import { useEffect, useRef, useState } from 'react'
import { BOARD_PILLARS, boardHere, loadBoard, setBoardOff, useBoard, type BoardMe, type BoardPillar, type BoardRow } from '../board'

const LABEL: Record<BoardPillar, string> = { compute: 'Compute', memory: 'Memory', gpu: 'GPU', storage: 'Storage', model: 'Model' }
/** Log scale like the score rows: 100 is empty, 2000 is full. */
const pct = (s: number | null | undefined) => (s && s > 0 ? Math.max(4, Math.min(100, (Math.log(s / 100) / Math.log(20)) * 100)) : 0)
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
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
  return (
    <tr className={you ? 'you' : undefined} aria-current={you ? 'true' : undefined} data-board-row={you ? 'me' : undefined}>
      <td className="lb-rank mono">{r.rank}</td>
      <td className="lb-name"><span>{r.name}</span>{you && <b className="lb-you">you</b>}</td>
      <td className="lb-when">{ago(r.updatedAt)}</td>
      <td className="lb-parts"><Bars p={r.pillars} /></td>
      <td className="lb-score mono">{fmt(r.best)}</td>
    </tr>
  )
}

export default function Leaderboard({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>(() => (boardHere() ? { k: 'loading' } : { k: 'offline' }))
  const [tries, setTries] = useState(0)
  const off = useBoard((s) => s.off), sentAt = useBoard((s) => (s.state === 'sent' ? s.me?.updatedAt : null)), testAll = useBoard((s) => s.testAll)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!boardHere()) return
    let live = true
    setView((v) => (v.k === 'ok' ? v : { k: 'loading' }))
    loadBoard().then((r) => live && setView({ k: 'ok', ...r }), () => live && setView({ k: 'error' }))
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
  if (view.k === 'loading') body = <div className="lb-state" role="status"><p>Loading the leaderboard.</p><button type="button" className="t5-btn" onClick={onClose}>Close</button></div>
  else if (view.k === 'offline') body = <div className="lb-state" data-board-offline><p>Leaderboard is offline on this copy of the app.</p><button type="button" className="t5-btn" onClick={onClose}>Close</button></div>
  else if (view.k === 'error') body = <div className="lb-state" role="alert"><p>Could not load the leaderboard.</p><button type="button" className="t5-btn pri" onClick={() => setTries((n) => n + 1)}>Try again</button></div>
  else if (!view.rows.length) body = <div className="lb-state"><p>No scores yet. Test your system to be the first.</p>{testAll ? <button type="button" className="t5-btn pri" onClick={testAll}>Test your system</button> : <button type="button" className="t5-btn" onClick={onClose}>Close</button>}</div>
  else body = (
    <table className="lb-table">
      <thead><tr><th className="lb-rank" scope="col">#</th><th scope="col">Name</th><th className="lb-when" scope="col">When</th><th className="lb-parts" scope="col">Parts</th><th className="lb-score" scope="col">Best</th></tr></thead>
      <tbody>{view.rows.map((r) => <Row key={`${r.rank}-${r.name}-${r.updatedAt}`} r={r} you={isMe(r)} />)}</tbody>
      {me && !inTop && <tbody className="lb-mine"><tr className="lb-gap" aria-hidden><td colSpan={5}>⋯</td></tr><Row r={{ rank: me.rank, name: me.name, best: me.best, pillars: me.pillars ?? {}, updatedAt: me.updatedAt }} you /></tbody>}
    </table>
  )

  const line = off ? null : me ? `You are #${fmt(me.rank)} of ${fmt(me.total)}. Best ${fmt(me.best)}, tested ${me.visits} ${me.visits === 1 ? 'time' : 'times'}.`
    : view.k === 'ok' ? 'Test your system to get on the board.' : null

  return (
    <div className="lb-wall" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}>
      <section className="lb" role="dialog" aria-modal="true" aria-labelledby="lb-t" data-leaderboard>
        <header className="lb-head">
          <div><h3 id="lb-t">Leaderboard</h3><p className="lb-sub">Best score of each device. Names are public.</p></div>
          <button ref={closeRef} type="button" className="t5-btn" onClick={onClose}>Close</button>
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
.lb-wall{position:fixed;inset:0;z-index:95;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--bg) 80%,transparent)}
.lb{width:min(720px,100%);max-height:min(86dvh,880px);display:flex;flex-direction:column;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:var(--r-lg,18px);box-shadow:0 20px 60px #0007;overflow:hidden;animation:rise var(--d3,360ms) var(--ease,ease) both}
.lb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 16px 8px}
.lb-sub{color:var(--muted);font-size:13px;margin-top:2px}
.lb-me{padding:0 16px 8px;font-size:13.5px;color:var(--fg)}
.lb-scroll{overflow:auto;padding:0 8px 12px;min-height:120px}
.lb-state{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:16px 8px 8px}
.lb-state p{color:var(--fg)}
.lb-table{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
.lb-table th{position:sticky;top:0;z-index:1;background:var(--panel);text-align:left;font:600 11.5px var(--body);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:6px 8px;border-bottom:1px solid var(--line)}
.lb-table td{padding:7px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);height:40px}
.lb-rank{width:44px;color:var(--muted)}
.lb-name{max-width:0;width:100%;white-space:nowrap}
.lb-name span{display:inline-block;max-width:calc(100% - 44px);overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.lb-when{white-space:nowrap;color:var(--muted);font-size:12.5px}
.lb-parts{width:64px}
.lb-score,.lb-table th.lb-score{text-align:right;font-weight:700;white-space:nowrap}
.lb-bars{display:inline-flex;align-items:flex-end;gap:2px;height:20px;width:52px;vertical-align:middle}
.lb-bars i{flex:1;min-height:2px;border-radius:2px 2px 0 0;opacity:.9}
.lb-table tr.you td{background:color-mix(in srgb,var(--pos) 16%,var(--panel))}
.lb-table tr.you .lb-rank{color:var(--fg);font-weight:700}
.lb-you{margin-left:6px;font:700 11px var(--body);color:var(--pos-ink);border:1px solid var(--pos);border-radius:999px;padding:0 6px;vertical-align:middle}
.lb-gap td{text-align:center;color:var(--muted);height:28px;border:0}
@media (max-width:640px){.lb-when{display:none}.lb-wall{padding:8px}.lb-head{padding:12px 12px 6px}.lb-me{padding:0 12px 6px}.lb-scroll{padding:0 4px 8px}.lb-table td,.lb-table th{padding:6px 5px}.lb-rank{width:34px}}
`
