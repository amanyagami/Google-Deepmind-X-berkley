import { useId, useState, type ReactNode } from 'react'

/* TODO(L-cards): swap this local Peek for the shared `<Peek>` in ui/charts.tsx once that lane is merged
 * (same idea: summary always shown; details overlay on hover, keyboard focus or tap; Esc closes; no layout shift).
 * Kept minimal on purpose so the swap is a one-line import change. */
export function Peek({ summary, children, label, className = '', align = 'left' }: { summary: ReactNode; children?: ReactNode; label: string; className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!children) return <div className={`peek ${className}`}><div className="peek-sum static">{summary}</div></div>
  return (
    <div className={`peek ${open ? 'open' : ''} ${className}`} data-peek onKeyDown={(e) => { if (e.key === 'Escape' && (open || e.currentTarget.contains(document.activeElement))) { e.stopPropagation(); setOpen(false); (document.activeElement as HTMLElement | null)?.blur?.() } }} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="peek-sum" aria-expanded={open} aria-controls={id} aria-label={`${label}: show details`} onClick={() => setOpen(!open)}>{summary}</button>
      <div id={id} className={`peek-det ${align}`} role="group" aria-label={label}>{children}</div>
    </div>
  )
}

export const PEEK_CSS = `
.peek{position:relative;min-width:0}
.peek-sum{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;background:none;border:0;padding:0 2px;margin:0;color:inherit;font:inherit;text-align:left;cursor:pointer;min-height:var(--hit,40px);border-radius:var(--r-sm,8px)}
.peek-sum.static{cursor:default}
.peek-sum:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.peek-det{position:absolute;top:calc(100% + 4px);left:0;z-index:60;min-width:min(260px,calc(100vw - 32px));max-width:min(360px,calc(100vw - 32px));display:grid;gap:6px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-md,12px);background:var(--panel,#10172b);color:var(--fg);box-shadow:0 12px 32px #0007;font-size:13px;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity 120ms ease,visibility 0s linear 120ms}
.peek-det.right{left:auto;right:0}
.peek:hover>.peek-det,.peek:focus-within>.peek-det,.peek.open>.peek-det{opacity:1;visibility:visible;pointer-events:auto;transition:opacity 120ms ease}
@media (prefers-reduced-motion:reduce){.peek-det,.peek:hover>.peek-det,.peek:focus-within>.peek-det,.peek.open>.peek-det{transition:none}}
`
