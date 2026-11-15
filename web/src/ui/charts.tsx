import { Children, useCallback, useEffect, useId, useInsertionEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { useStore } from "../store"
import { useZoo, type Inspect } from "../zoo/zooStore"
import * as api from "../api"

export const AMBER = '255,169,77'
export const BLUE = '85,168,255'

/** Visible token text: leading spaces become a dot, newlines an arrow. */
export const showTok = (t: string) => (t === '' ? '∅' : t.replace(/\n/g, '↵').replace(/^ /, '·').replace(/ /g, '·'))

/** Canvas heatmap. mode "div": blue negative / amber positive. mode "seq": amber 0..1. */
export function Heat({ data, size = 120, mode = 'div', max, onClick, title }: {
  data: number[][]; size?: number; mode?: 'div' | 'seq'; max?: number; onClick?: () => void; title?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !data.length) return
    const rows = data.length, cols = data[0].length
    c.width = cols; c.height = rows
    const g = c.getContext('2d')!
    const m = max ?? Math.max(1e-9, ...data.flat().map((v) => Math.abs(v)))
    const img = g.createImageData(cols, rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = data[y][x]
      const a = Math.min(1, Math.pow(Math.abs(v) / m, mode === 'div' ? 0.7 : 0.8))
      const [r, gg, b] = (mode === 'seq' || v >= 0 ? AMBER : BLUE).split(',').map(Number)
      const i = (y * cols + x) * 4
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = Math.round(a * 255)
    }
    g.putImageData(img, 0, 0)
  }, [data, mode, max])
  const rows = data.length || 1, cols = data[0]?.length || 1
  const h = Math.round(size * Math.min(1, rows / cols) * (rows > cols ? cols / rows : 1)) || size
  return (
    <canvas ref={ref} className="heat" title={title} onClick={onClick}
      style={{ width: size, height: rows > cols ? size : Math.max(14, Math.round((size * rows) / cols)), cursor: onClick ? 'pointer' : 'default' }}
      aria-hidden={!title} data-h={h} />
  )
}

/** One bar per dimension, blue below zero, amber above. */
export function DimBars({ values, height = 56 }: { values: number[]; height?: number }) {
  const m = Math.max(1e-9, ...values.map(Math.abs))
  const w = 100 / values.length
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="dimbars" style={{ height }} role="img" aria-label={`${values.length} values, largest magnitude ${m.toFixed(2)}`}>
      <line x1="0" x2="100" y1={height / 2} y2={height / 2} stroke="var(--line)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      {values.map((v, i) => {
        const hh = (Math.abs(v) / m) * (height / 2 - 1)
        return <rect key={i} x={i * w + w * 0.12} width={w * 0.76} y={v >= 0 ? height / 2 - hh : height / 2} height={Math.max(0.4, hh)} fill={v >= 0 ? 'var(--pos)' : 'var(--neg)'} />
      })}
    </svg>
  )
}

/** The one sparkline. `values` scale to their own maximum; `data` is a percent series (max 100 unless `max` is given). */
export function Spark({ values, data, height, label, color = 'var(--pos)', max }: { values?: number[]; data?: number[]; height?: number; label?: string; color?: string; max?: number }) {
  const v = values ?? data ?? []
  const H = height ?? (data && !values ? 38 : 44)
  const m = Math.max(1e-9, max ?? (values ? Math.max(...v) : 100))
  const pts = v.map((x, i) => `${(i / Math.max(1, v.length - 1)) * 100},${(H - 3 - (Math.min(x, m) / m) * (H - 8)).toFixed(2)}`).join(' ')
  return (
    <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="spark" style={{ height: H }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline points={`0,${H} ${pts} 100,${H}`} fill={`color-mix(in srgb, ${color} 18%, transparent)`} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

const prefersReduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The one animated counter: eases from the last shown value to the new one (instant under reduced motion). */
export function Counter({ value, digits = 0 }: { value: number | null; digits?: number }) {
  const [v, setV] = useState(value ?? 0)
  const from = useRef(value ?? 0)
  useEffect(() => {
    if (value === null) return
    if (prefersReduced() || from.current === value) { from.current = value; setV(value); return }
    const a = from.current, t0 = performance.now(), dur = 500
    let raf = requestAnimationFrame(function step(t) {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3)
      from.current = a + (value - a) * e; setV(from.current)
      if (k < 1) raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{value === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}</>
}

/** The one arc gauge: score on a 0..max arc, an animated number in the middle, an optional label under it. */
export function Gauge({ score, size = 150, max = 2000, label, small, aria }: { score: number | null; size?: number; max?: number; label?: string; small?: boolean; aria?: string }) {
  const r = size / 2 - 12, c = size / 2
  const frac = score === null ? 0 : Math.max(0, Math.min(1, score / max))
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2
  const pt = (a: number) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`
  const arc = `M ${pt(a0)} A ${r} ${r} 0 1 1 ${pt(a1)}`
  const [shown, setShown] = useState(0)
  useEffect(() => { const id = requestAnimationFrame(() => setShown(frac)); return () => cancelAnimationFrame(id) }, [frac])
  const sw = small ? 6 : 9
  return (
    <div className="gauge" style={{ width: size, height: size * (small ? 0.82 : 0.9) }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={aria ?? `${label ?? 'score'} ${score ?? 'not measured'}`}>
        <path d={arc} fill="none" stroke="var(--line)" strokeWidth={sw} strokeLinecap="round" />
        <path d={arc} fill="none" stroke="var(--pos)" strokeWidth={sw} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - shown}
          style={{ opacity: shown > 0 ? 1 : 0, transition: prefersReduced() ? 'none' : 'stroke-dashoffset .7s cubic-bezier(.2,.8,.2,1)', filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--pos) 60%, transparent))' }} />
      </svg>
      <div className="gnum"><b className={small ? 's' : ''}><Counter value={score} /></b>{label && <span>{label}</span>}</div>
    </div>
  )
}

export function TopBars({ items, ghost, max = 1, color = 'var(--neg)' }: {
  items: { token: string; p: number }[]; ghost?: Record<string, number>; max?: number; color?: string
}) {
  return (
    <div className="topbars">
      {items.map((it, i) => (
        <div className="tb" key={i + it.token}>
          <span className="tbl mono" title={JSON.stringify(it.token)}>{showTok(it.token)}</span>
          <div className="tbt">
            <i style={{ width: `${Math.max(0.5, (it.p / max) * 100)}%`, background: color }} />
            {ghost && ghost[it.token] !== undefined && <em style={{ left: `calc(${(ghost[it.token] / max) * 100}% - 1px)` }} />}
          </div>
          <span className="tbv mono">{(it.p * 100).toFixed(it.p < 0.1 ? 1 : 0)}%</span>
        </div>
      ))}
    </div>
  )
}

/* ===================================================================================================================
 * S7 · Inspector and hints.  Everything below is self-contained: styles are injected once from this file.
 * =================================================================================================================== */

const injected = new Set<string>()
/** Inject a <style> into <head> once per id (so this file never touches styles.css). */
export function useInjectedStyle(id: string, css: string) {
  useInsertionEffect(() => {
    if (injected.has(id) || typeof document === 'undefined') return
    injected.add(id)
    const el = document.createElement('style')
    el.setAttribute('data-ns', id)
    el.textContent = css
    document.head.appendChild(el)
  }, [id, css])
}

/* ------------------------------------------------------------------ pure helpers (exported for tests) */

/** 3 significant figures, real minus sign. `plus` puts a + in front of positives. */
export function fmt3(v: number, plus = false): string {
  if (v !== v) return 'n/a'
  if (v === 0) return '0'
  const a = Math.abs(v)
  let s: string
  if (a >= 1e6 || a < 1e-3) s = a.toExponential(2).replace('e+', 'e').replace('e-', 'e−')
  else s = String(Number(a.toPrecision(3)))
  return (v < 0 ? '−' : plus ? '+' : '') + s
}

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** Zoom tiers by pixels per cell. */
export const CELL_PX = 8
export const NUM_PX = 28
export const tierFor = (s: number): 'pooled' | 'cells' | 'numbers' => (s >= NUM_PX ? 'numbers' : s >= CELL_PX ? 'cells' : 'pooled')
/** Which mip level to draw at s px per cell: the coarsest one whose cells are still >= 1 px. */
export const pickLevel = (s: number, maxL: number) => (s >= 1 ? 0 : Math.min(maxL, Math.ceil(Math.log2(1 / s))))

/** Visible cell range for a view (top-left cell coordinate ox,oy, s px per cell, W x H px), clipped to the matrix. */
export function visibleWindow(ox: number, oy: number, W: number, H: number, s: number, rows: number, cols: number) {
  const c0 = clamp(Math.floor(ox), 0, cols), c1 = clamp(Math.ceil(ox + W / s), 0, cols)
  const r0 = clamp(Math.floor(oy), 0, rows), r1 = clamp(Math.ceil(oy + H / s), 0, rows)
  return { r0, r1, c0, c1 }
}

/** Keep the view over the content: centre when the content is smaller than the viewport, else clamp. */
export function clampView(v: { s: number; ox: number; oy: number }, W: number, H: number, rows: number, cols: number, minS: number, maxS: number) {
  const s = clamp(v.s, minS, maxS)
  const vw = W / s, vh = H / s
  const ox = cols <= vw ? (cols - vw) / 2 : clamp(v.ox, 0, cols - vw)
  const oy = rows <= vh ? (rows - vh) / 2 : clamp(v.oy, 0, rows - vh)
  return { s, ox, oy }
}

export function softmaxT(logits: ArrayLike<number>, T: number): number[] {
  const t = Math.max(1e-3, T)
  let m = -Infinity
  for (let i = 0; i < logits.length; i++) if (logits[i] > m) m = logits[i]
  const e: number[] = []; let z = 0
  for (let i = 0; i < logits.length; i++) { const x = Math.exp((logits[i] - m) / t); e.push(x); z += x }
  return e.map((x) => x / z)
}

export function histogram(data: ArrayLike<number>, bins: number, lo: number, hi: number): number[] {
  const h = new Array(bins).fill(0)
  const w = (hi - lo) || 1
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v !== v) continue
    h[clamp(Math.floor(((v - lo) / w) * bins), 0, bins - 1)]++
  }
  return h
}

export interface TStats { min: number; max: number; mean: number; std: number; zeros: number; norm: number; n: number; vmax: number }
export interface MipLevel { rows: number; cols: number; data: Float32Array }
export interface MipResult { levels: MipLevel[]; stats: TStats; hist: number[] }

/** Mean-pooled mipmaps (level 1.. halves each side; NaN cells are skipped), stats and a histogram.
 *  SELF-CONTAINED on purpose: its source is shipped to a Worker through a Blob URL. */
export const mipBuild = (data: Float32Array, rows: number, cols: number): MipResult => {
  const n = data.length
  let mn = Infinity, mx = -Infinity, sum = 0, ss = 0, zeros = 0, cnt = 0
  for (let i = 0; i < n; i++) {
    const v = data[i]
    if (v !== v) continue
    cnt++; sum += v; ss += v * v
    if (v < mn) mn = v
    if (v > mx) mx = v
    if (v === 0) zeros++
  }
  const mean = cnt ? sum / cnt : 0
  const std = cnt ? Math.sqrt(Math.max(0, ss / cnt - mean * mean)) : 0
  // robust colour range: 99.5th percentile of |v| over <= 100k samples
  const step = Math.max(1, Math.floor(n / 100000))
  const samp: number[] = []
  for (let i = 0; i < n; i += step) { const v = data[i]; if (v === v) samp.push(Math.abs(v)) }
  const sa = Float32Array.from(samp).sort()
  let vmax = sa.length ? sa[Math.min(sa.length - 1, Math.floor(sa.length * 0.995))] : 0
  if (!(vmax > 0)) vmax = Math.max(Math.abs(mn), Math.abs(mx)) || 1e-9
  const R = vmax * 1.5, bins = 48
  const hist = new Array(bins).fill(0)
  for (let i = 0; i < n; i++) {
    const v = data[i]
    if (v !== v) continue
    let b = Math.floor(((v + R) / (2 * R)) * bins)
    if (b < 0) b = 0
    if (b >= bins) b = bins - 1
    hist[b]++
  }
  const levels: MipLevel[] = [{ rows, cols, data }]
  let cr = rows, cc = cols, cur = data
  while (cr > 16 || cc > 16) {
    const nr = Math.ceil(cr / 2), nc = Math.ceil(cc / 2)
    const out = new Float32Array(nr * nc)
    for (let y = 0; y < nr; y++) for (let x = 0; x < nc; x++) {
      let s = 0, k = 0
      for (let dy = 0; dy < 2; dy++) {
        const yy = y * 2 + dy
        if (yy >= cr) continue
        for (let dx = 0; dx < 2; dx++) {
          const xx = x * 2 + dx
          if (xx >= cc) continue
          const v = cur[yy * cc + xx]
          if (v === v) { s += v; k++ }
        }
      }
      out[y * nc + x] = k ? s / k : NaN
    }
    levels.push({ rows: nr, cols: nc, data: out })
    cr = nr; cc = nc; cur = out
  }
  return { levels, stats: { min: cnt ? mn : 0, max: cnt ? mx : 0, mean, std, zeros: cnt ? zeros / cnt : 0, norm: Math.sqrt(ss), n: cnt, vmax }, hist }
}

/** TSV text of a cell range, capped at `cap` values (row-major; the cut is stated by the caller). */
export function toTSV(data: Float32Array, cols: number, r0: number, r1: number, c0: number, c1: number, cap = 100000) {
  const lines: string[] = []; let n = 0, truncated = false
  outer: for (let r = r0; r < r1; r++) {
    const row: string[] = []
    for (let c = c0; c < c1; c++) {
      if (n >= cap) { truncated = true; if (row.length) lines.push(row.join('\t')); break outer }
      row.push(String(data[r * cols + c])); n++
    }
    lines.push(row.join('\t'))
  }
  return { text: lines.join('\n'), values: n, truncated }
}

/* ------------------------------------------------------------------ Hint */

const HINT_CSS = `
.nshint{position:relative;display:inline-flex;vertical-align:middle;margin-left:6px}
.nshint .nshint-btn{all:unset;box-sizing:border-box;width:var(--hit,40px);height:var(--hit,40px);margin:-6px -6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border-radius:50%;color:var(--muted,#9aa5c7);-webkit-tap-highlight-color:transparent}
.nshint .nshint-btn svg{width:28px;height:28px;display:block;transition:transform var(--d1,120ms) var(--ease,ease),color var(--d1,120ms)}
.nshint .nshint-btn:hover svg{color:var(--fg,#e8ecf8);transform:scale(1.06)}
.nshint-btn[aria-expanded="true"] svg{color:var(--warn,#ffd36b)}
.nshint-btn:focus-visible{outline:2px solid var(--pos,#ffa94d);outline-offset:-2px}
.nshint .nshint-pop{--shift:0px;position:absolute;z-index:60;top:calc(100% + 2px);left:50%;transform:translateX(calc(-50% + var(--shift)));width:max-content;max-width:min(320px,calc(100vw - 32px));padding:10px 13px;border-radius:var(--r-md,12px);border:1px solid var(--line,#27314f);background:var(--panel,#0f1526);box-shadow:0 16px 40px var(--nsx-shadow,rgba(0,0,0,.55));font:400 var(--t0,14px)/1.5 var(--body,system-ui,sans-serif);color:var(--fg,#e8ecf8);text-transform:none;letter-spacing:0;white-space:normal;text-align:left}
.nshint .nshint-pop.up{top:auto;bottom:calc(100% + 2px)}
@media (prefers-reduced-motion:no-preference){.nshint-pop{animation:nshintin var(--d1,120ms) var(--ease,ease-out)}}
@keyframes nshintin{from{opacity:0}to{opacity:1}}
`

const Bulb = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3.5a7.2 7.2 0 0 0-4.2 13.1c.8.6 1.2 1.5 1.2 2.4v.5h6V19c0-.9.4-1.8 1.2-2.4A7.2 7.2 0 0 0 14 3.5Z" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.9 : 0} />
    <path d="M11.2 22.2h5.6M12 24.6h4" />
  </svg>
)

/** The info mark (ⓘ) for Hint. The bulb belongs to the one scene explainer per stage. */
const Info = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="14" cy="14" r="8.6" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.16 : 0} />
    <path d="M14 13v5.4" /><circle cx="14" cy="9.6" r="0.6" fill="currentColor" />
  </svg>
)

/** An explanation behind an ⓘ. Click opens. The mouse can leave toward the bubble (150 ms grace). Tap opens and a tap
 *  outside closes on touch. Esc closes. Focus moving into the bubble keeps it open. */
export function Hint({ children, label = 'More info' }: { children: React.ReactNode; label?: string }) {
  useInjectedStyle('ns-hint', HINT_CSS)
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLSpanElement>(null)
  const timer = useRef(0)
  const cancel = () => { clearTimeout(timer.current) }
  const closeLater = () => { cancel(); timer.current = window.setTimeout(() => setOpen(false), 150) }
  useEffect(() => cancel, [])
  // keep the bubble on screen: slide it back if it would run past either edge, flip above if it would run off the bottom
  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el) { setUp(false); return }
    el.style.setProperty('--shift', '0px')
    const r = el.getBoundingClientRect()
    const over = r.right > innerWidth - 8 ? innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0
    el.style.setProperty('--shift', `${over}px`)
    const wr = wrap.current?.getBoundingClientRect()
    if (wr && r.bottom > innerHeight - 8 && wr.top - r.height - 4 > 8) setUp(true)
  }, [open])
  useEffect(() => {
    if (!open) return
    const down = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); e.stopPropagation() } }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <span ref={wrap} className="hintwrap nshint" onMouseEnter={cancel} onMouseLeave={closeLater}
      onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
      <button type="button" className="nshint-btn hintbtn" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => { cancel(); setOpen((o) => !o) }}><Info on={open} /></button>
      {open && <span ref={pop} id={id} role="tooltip" tabIndex={-1} className={`nshint-pop hintpop${up ? ' up' : ''}`}>{children}</span>}
    </span>
  )
}

/* ------------------------------------------------------------------ Peek (D16: calm cards) */

const PEEK_CSS = `
.nspeek{position:relative}
.nspeek-sum{display:flex;align-items:center;gap:8px;min-width:0;min-height:24px}
.nspeek-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nspeek-tog{all:unset;box-sizing:border-box;flex:none;width:var(--hit,40px);height:var(--hit,40px);margin:-8px -10px -8px 0;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-md,12px);cursor:pointer;color:var(--muted,#9aa5c7);-webkit-tap-highlight-color:transparent}
.nspeek-tog svg{width:18px;height:18px;display:block}
.nspeek-tog:hover{color:var(--fg,#e8ecf8)}
.nspeek-tog:focus-visible{outline:2px solid var(--pos,#ffa94d);outline-offset:-4px}
.nspeek-det{position:absolute;z-index:3;left:-1px;right:-1px;top:calc(100% - 1px);box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:4px 16px 14px;background:var(--peek-bg,color-mix(in srgb,var(--bg,#0a0e19) 95%,transparent));border:1px solid var(--line,#27314f);border-top:0;border-radius:0 0 var(--peek-r,16px) var(--peek-r,16px);box-shadow:0 18px 40px var(--nsx-shadow,rgba(0,0,0,.5));color:var(--fg,#e8ecf8);opacity:0;visibility:hidden;pointer-events:none;transition:opacity var(--d1,120ms) linear,visibility 0s linear var(--d1,120ms)}
.nspeek-det p{margin:0}
.nspeek[data-open]>.nspeek-det,.nspeek:not([data-shut]):focus-within>.nspeek-det{opacity:1;visibility:visible;pointer-events:auto;transition:opacity var(--d1,120ms) linear,visibility 0s}
@media (hover:hover){.nspeek:not([data-shut]):hover>.nspeek-det{opacity:1;visibility:visible;pointer-events:auto;transition:opacity var(--d1,120ms) linear,visibility 0s}}
.nspeek[data-vis]{border-bottom-left-radius:0;border-bottom-right-radius:0}
.nspeek-tog[aria-expanded="true"] svg{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.nspeek-det,.nspeek[data-open]>.nspeek-det,.nspeek:focus-within>.nspeek-det,.nspeek:hover>.nspeek-det{transition:none}}
`
const Chevron = () => <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 8l4.5 4.5L14.5 8" /></svg>

/** A calm card: `summary` (one line) is always shown; `details` overlay downward on hover, keyboard focus or a tap on the
 *  toggle. The box never changes size (no layout shift). Esc closes. Opacity-only fade, none under reduced motion. */
export function Peek({ summary, details, label = 'Show details', className, ...rest }: {
  summary: React.ReactNode; details: React.ReactNode; label?: string; className?: string
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>) {
  useInjectedStyle('ns-peek', PEEK_CSS)
  const [open, setOpen] = useState(false)      // pinned by a tap / click
  const [shut, setShut] = useState(false)      // closed by Esc / toggle until the pointer or focus leaves
  const [hov, setHov] = useState(false)
  const [foc, setFoc] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  const vis = !shut && (open || hov || foc)
  const close = useCallback(() => { setOpen(false); setShut(true) }, [])
  useEffect(() => {
    if (!vis) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); if (root.current?.contains(document.activeElement)) e.stopPropagation() } }
    const down = (e: Event) => { if (open && !root.current?.contains(e.target as Node)) close() }
    document.addEventListener('keydown', key, true); document.addEventListener('pointerdown', down, true)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down, true) }
  }, [vis, open, close])
  const toggle = (e: React.MouseEvent) => {
    const touch = (e.nativeEvent as PointerEvent).pointerType === 'touch'
    if (touch ? open : vis) close()
    else { setShut(false); setOpen(true) }
  }
  return (
    <div {...rest} ref={root} className={`nspeek${className ? ' ' + className : ''}`} data-peek data-open={open && !shut ? '' : undefined} data-shut={shut ? '' : undefined} data-vis={vis ? '' : undefined}
      onPointerEnter={(e) => { if (e.pointerType !== 'touch') setHov(true) }}
      onPointerLeave={(e) => { if (e.pointerType !== 'touch') { setHov(false); if (!foc) setShut(false) } }}
      onFocus={() => setFoc(true)}
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) { setFoc(false); setOpen(false); if (!hov) setShut(false) } }}>
      <div className="nspeek-sum">
        <div className="nspeek-txt">{summary}</div>
        <button type="button" className="nspeek-tog" aria-label={label} aria-expanded={vis} aria-controls={id} onClick={toggle}><Chevron /></button>
      </div>
      <div className="nspeek-det" id={id} data-peek-details>{details}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ mock data (?mockTensor=1) */

export const isMock = () => { try { return new URLSearchParams(location.search).has('mockTensor') } catch { return false } }
const strSeed = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
const hash3 = (a: number, b: number, c: number) => {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
/** Deterministic mock weight at (r, c): noise + smooth structure + two banded rows + one hot column. */
export function mockValue(name: string, r: number, c: number): number {
  if (name === 'w') return Math.fround(Math.sin(r * 0.37) + Math.cos(c * 0.21)) // the e2e fixture tensor
  const sd = strSeed(name) & 0xffff
  const g = (hash3(sd, r, c) + hash3(sd + 1, r, c) + hash3(sd + 2, r, c) - 1.5) * 0.08
  let v = g + 0.05 * Math.sin(r * 0.11) * Math.cos(c * 0.07)
  if (r % 64 < 2) v += 0.1
  if (c === 37) v *= 4
  return Math.fround(v)
}
export function mockMatrix(name: string, rows: number, cols: number, stride = 1): { data: Float32Array; rows: number; cols: number } {
  const R = Math.ceil(rows / stride), C = Math.ceil(cols / stride)
  const d = new Float32Array(R * C)
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) d[r * C + c] = mockValue(name, r * stride, c * stride)
  return { data: d, rows: R, cols: C }
}
export const mockVector = (name: string, n = 576) => Float32Array.from({ length: n }, (_, i) => Math.fround(mockValue(name, 0, i) * 12 - (i % 97 === 0 ? 1.4 : 0)))
export const mockLogits = (T = 1) => Array.from({ length: 50 }, (_, i) => ({ token: ['Paris', ' the', ' a', ' Lyon', ' France', ',', '.', ' located', ' known', ' Marseille'][i] ?? ` tok${i}`, logit: 9 - Math.log(1 + i) * 3.1 - (i % 3) * 0.35 }))
const MOCK_TOKENS = ['The', ' capital', ' of', ' France', ' is']

/* ------------------------------------------------------------------ model info (read defensively from the main store) */

interface TInfo { name: string; shape: number[]; dtype: string; params: number; file?: string }
interface ModelInfo { repo: string; blocks: { attn: TInfo[]; mlp: TInfo[]; norm: TInfo[] }[]; tokens: string[]; topk: { token: string; p: number }[]; mock: boolean }

const toT = (t: any): TInfo => ({ name: String(t?.name ?? ''), shape: Array.isArray(t?.shape) ? t.shape.map(Number) : [], dtype: String(t?.dtype ?? 'F32'), params: Number(t?.numel ?? (Array.isArray(t?.shape) ? t.shape.reduce((a: number, b: number) => a * b, 1) : 0)) || 0, file: t?.file })
const mkT = (name: string, r: number, c?: number): TInfo => ({ name, shape: c === undefined ? [r] : [r, c], dtype: 'BF16', params: r * (c ?? 1) })
function mockBlocks(): ModelInfo['blocks'] {
  return Array.from({ length: 12 }, (_, L) => {
    const p = `model.layers.${L}.`
    return {
      attn: [mkT(p + 'self_attn.q_proj.weight', 576, 576), mkT(p + 'self_attn.k_proj.weight', 192, 576), mkT(p + 'self_attn.v_proj.weight', 192, 576), mkT(p + 'self_attn.o_proj.weight', 576, 576)],
      mlp: [mkT(p + 'mlp.gate_proj.weight', 1536, 576), mkT(p + 'mlp.up_proj.weight', 1536, 576), mkT(p + 'mlp.down_proj.weight', 576, 1536)],
      norm: [mkT(p + 'input_layernorm.weight', 576), mkT(p + 'post_attention_layernorm.weight', 576)],
    }
  })
}
function useModelInfo(): ModelInfo | null {
  const probe = useStore((s) => s.probe), repo = useStore((s) => s.repo), tokens = useStore((s) => s.tokens), fin = useStore((s) => s.final)
  const mock = isMock()
  const blocks = probe?.graph?.blocks
  if (Array.isArray(blocks) && blocks.length) {
    const pick = (b: any, k: string) => (Array.isArray(b?.[k]) ? b[k].filter((t: any) => !t?.buffer).map(toT) : [])
    return { repo: repo || probe.graph.repo || '', blocks: blocks.map((b: any) => ({ attn: pick(b, 'attn'), mlp: pick(b, 'mlp'), norm: pick(b, 'norm') })), tokens: tokens ?? [], topk: fin?.topk ?? [], mock }
  }
  if (mock) return { repo: 'mock/model', blocks: mockBlocks(), tokens: MOCK_TOKENS, topk: [], mock }
  return null
}
const PART_NAME: Record<string, string> = { attn: 'Attention', mlp: 'MLP', norm: 'Norm', embed: 'Embedding' }
const shortName = (n: string) => n.replace(/^model\./, '').replace(/^layers\.\d+\./, '').replace(/\.weight$/, '')
function findTensor(info: ModelInfo | null, i: NonNullable<Inspect>): TInfo | null {
  const name = i.name ?? ''
  if (info && i.layer !== undefined) {
    const b = info.blocks[i.layer]
    const all = b ? [...b.attn, ...b.mlp, ...b.norm] : []
    const t = all.find((x) => x.name === name)
    if (t) return t
  }
  if (isMock() && name === 'w') return { name, shape: [64, 64], dtype: 'F32', params: 4096 }
  if (isMock() && name === 'mock.big') return mkT(name, 2000, 2000)
  if (isMock() && name === 'mock.huge') return mkT(name, 3000, 3000)
  if (isMock() && name) return mkT(name, 576, 576)
  return null
}

/** `Model › Block 12 › Attention › q_proj`. S6 puts this in its breadcrumb. */
export function inspectCrumb(i: Inspect): string {
  const out = ['Model']
  if (!i) return out[0]
  if (i.layer !== undefined) out.push(`Block ${i.layer + 1}`)
  if (i.part) out.push(PART_NAME[i.part] ?? i.part)
  if (i.kind === 'tensor' && i.name) out.push(shortName(i.name))
  if (i.kind === 'token') out.push(`${i.name === 'in' ? 'Input' : i.name === 'out' ? 'Output' : 'Values'} · token ${(i.index ?? 0) + 1}`)
  if (i.kind === 'output') out.push('Output')
  return out.join(' › ')
}
/** One level up (what Esc and the breadcrumb do). */
export function inspectParent(i: Inspect): Inspect {
  if (!i || i.kind === 'block' || i.kind === 'output') return null
  if (i.layer !== undefined) return { kind: 'block', layer: i.layer, part: i.part }
  return null
}

/* ------------------------------------------------------------------ inspect: no mode any more (B6) */

/** There is no Inspect mode: clicking a block always inspects, and hover outlines always show. These stay so the
 *  scene code that reads them keeps working; they always answer "on". */
export const isInspectOn = () => true
/** @deprecated no-op: the Inspect switch is gone. */
export const setInspectOn = (_v: boolean) => {}
export const useInspectOn = () => true

/** A small tooltip chip for hover (state 1). S8 renders it near the pointer. */
export function InspectTip({ label, x, y }: { label: string; x: number; y: number }) {
  useInjectedStyle('ns-inspector', INSPECTOR_CSS)
  return <div className="nsx-tip" role="status" style={{ left: x, top: y }}>{label}</div>
}

/* ------------------------------------------------------------------ mipmaps in a worker */

const workerSrc = () => `const mip=${mipBuild.toString()};onmessage=function(e){var d=e.data;var r=mip(d.data,d.rows,d.cols);var lv=r.levels.slice(1);postMessage({levels:lv,stats:r.stats,hist:r.hist},lv.map(function(l){return l.data.buffer}))}`

export function useMips(data: Float32Array | null, rows: number, cols: number): MipResult | null {
  const [res, setRes] = useState<{ key: Float32Array; r: MipResult } | null>(null)
  useEffect(() => {
    setRes(null)
    if (!data) return
    let dead = false
    let w: Worker | undefined
    const fin = (levels: MipLevel[], stats: TStats, hist: number[]) => { if (!dead) setRes({ key: data, r: { levels: [{ rows, cols, data }, ...levels], stats, hist } }) }
    const inline = () => { const x = mipBuild(data, rows, cols); fin(x.levels.slice(1), x.stats, x.hist) }
    try {
      const url = URL.createObjectURL(new Blob([workerSrc()], { type: 'text/javascript' }))
      w = new Worker(url)
      URL.revokeObjectURL(url)
      w.onmessage = (e) => { fin(e.data.levels, e.data.stats, e.data.hist); w?.terminate() }
      w.onerror = () => { w?.terminate(); inline() }
      w.postMessage({ data, rows, cols })
    } catch { setTimeout(inline, 0) }
    return () => { dead = true; w?.terminate() }
  }, [data, rows, cols])
  return res && res.key === data ? res.r : null
}

/* ------------------------------------------------------------------ the semantic-zoom heatmap */

const LUT_N = 1024
type Lut = { c: Uint32Array; d: Uint32Array; bright: Uint8Array; bg: number }
const LUTS: Partial<Record<'dark' | 'light', Lut>> = {}
/** Diverging map. Dark: near zero dark, amber +, blue -. Light: near zero light, darker amber and blue ends. */
function getLut(theme: 'dark' | 'light'): Lut {
  const hit = LUTS[theme]
  if (hit) return hit
  const c = new Uint32Array(LUT_N + 1), d = new Uint32Array(LUT_N + 1), bright = new Uint8Array(LUT_N + 1)
  const light = theme === 'light'
  const base = light ? [247, 248, 252] : [16, 22, 40]
  const P = light ? [180, 93, 0] : [255, 169, 77], N = light ? [31, 111, 209] : [85, 168, 255]
  for (let i = 0; i <= LUT_N; i++) {
    const t = (i / LUT_N) * 2 - 1, m = Math.pow(Math.abs(t), 0.6)
    const tg = t >= 0 ? P : N
    const rgb = [0, 1, 2].map((k) => Math.round(base[k] + (tg[k] - base[k]) * m))
    c[i] = (255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]
    d[i] = (255 << 24) | (Math.round(rgb[2] * 0.55) << 16) | (Math.round(rgb[1] * 0.55) << 8) | Math.round(rgb[0] * 0.55)
    bright[i] = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140 ? 1 : 0
  }
  return (LUTS[theme] = { c, d, bright, bg: light ? (255 << 24) | (248 << 16) | (240 << 8) | 238 : (255 << 24) | (20 << 16) | (14 << 8) | 10 })
}

/** The active colour theme: <html data-theme="light|dark"> wins, else the system setting. */
const themeSubs = new Set<() => void>()
const readTheme = (): 'dark' | 'light' => {
  if (typeof document === 'undefined') return 'dark'
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'light' || t === 'dark') return t
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
let themeWatching = false
function watchTheme() {
  if (themeWatching || typeof document === 'undefined') return
  themeWatching = true
  const f = () => themeSubs.forEach((x) => x())
  new MutationObserver(f).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', f) } catch { /* old browser */ }
}
export const useTheme = () => useSyncExternalStore((f) => { watchTheme(); themeSubs.add(f); return () => { themeSubs.delete(f) } }, readTheme, () => 'dark' as const)

let curHm: { api: HmApi; name: string } | null = null
export interface HmApi { fit(): void; zoomBy(f: number): void; isZoomed(): boolean; zoomTo(r: number, c: number, s: number): void; panBy(dx: number, dy: number): void; state(): { s: number; minS: number; ox: number; oy: number; tier: string; level: number; rows: number; cols: number }; valueAt(r: number, c: number): number }

/** Canvas heatmap with three tiers: pooled mipmaps, one coloured cell per value (>= 8 px), numbers (>= 28 px).
 *  Only the visible window is drawn. Wheel / pinch / +/- / Home zoom; drag / arrows pan. */
export function Heatmap({ m, rows, cols, stride = 1, pooledOnly = false, label, height = 340, apiRef, onZoomChange }: {
  m: MipResult; rows: number; cols: number; stride?: number; pooledOnly?: boolean; label: string; height?: number; apiRef?: { current: HmApi | null }; onZoomChange?: (zoomed: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const th = useRef<HTMLCanvasElement>(null)
  const win = useRef<HTMLDivElement>(null)
  const ro = useRef<HTMLDivElement>(null)
  const sc = useRef<HTMLSpanElement>(null)
  const S = useRef({ s: 1, ox: 0, oy: 0, W: 0, H: 0, minS: 0.1, maxS: 100, raf: 0, hover: null as null | { x: number; y: number }, zoomed: false, img: null as ImageData | null })
  const draw = useRef<() => void>(() => {})
  const theme = useTheme()

  useEffect(() => {
    const st = S.current, c = cv.current!, b = box.current!
    const maxL = m.levels.length - 1
    const inv = 1 / (m.stats.vmax || 1)
    const { c: lutC, d: lutD, bright: lutB, bg: BG } = getLut(theme)
    const lvIdx = (v: number) => { const k = ((v * inv + 1) * 0.5 * LUT_N + 0.5) | 0; return k < 0 ? 0 : k > LUT_N ? LUT_N : k }
    st.maxS = pooledOnly ? 7.5 : 120
    const measure = () => { st.W = b.clientWidth; st.H = height; st.minS = Math.max(1e-4, Math.min(st.W / cols, st.H / rows)) }
    const place = (v: { s: number; ox: number; oy: number }) => { const r = clampView(v, st.W, st.H, rows, cols, st.minS, st.maxS); st.s = r.s; st.ox = r.ox; st.oy = r.oy }
    const sched = () => { if (!st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; render() }) }
    const level = () => pickLevel(st.s, maxL)
    const readout = () => {
      const el = ro.current; if (!el) return
      const h = st.hover ?? { x: st.W / 2, y: st.H / 2 }
      const cx = Math.floor(st.ox + h.x / st.s), cy = Math.floor(st.oy + h.y / st.s)
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) { el.textContent = st.hover ? '' : ' '; return }
      const L = level()
      if (L > 0) {
        const lv = m.levels[L], f = 1 << L, lx = cx >> L, ly = cy >> L
        el.textContent = `rows ${ly * f * stride}–${Math.min(rows, (ly + 1) * f) * stride - 1}, cols ${lx * f * stride}–${Math.min(cols, (lx + 1) * f) * stride - 1} · mean ${fmt3(lv.data[ly * lv.cols + lx], true)}`
      } else el.textContent = `${stride > 1 ? '≈ ' : ''}row ${cy * stride}, col ${cx * stride} = ${fmt3(m.levels[0].data[cy * cols + cx], true)}`
    }
    const render = () => {
      const dpr0 = Math.min(window.devicePixelRatio || 1, 2)
      const dpr = Math.min(dpr0, Math.sqrt(1.4e6 / Math.max(1, st.W * st.H)))
      const cw = Math.max(1, Math.round(st.W * dpr)), ch = Math.max(1, Math.round(st.H * dpr))
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; st.img = null }
      const g = c.getContext('2d')!
      const sd = st.s * dpr, L = level(), lv = m.levels[L], d = lv.data
      if (!st.img) st.img = g.createImageData(cw, ch)
      const u32 = new Uint32Array(st.img.data.buffer)
      const xi = new Int32Array(cw), xl = new Uint8Array(cw)
      const grid = st.s >= 12
      for (let px = 0; px < cw; px++) {
        const cx = st.ox + (px + 0.5) / sd, ix = Math.floor(cx)
        xi[px] = ix < 0 || ix >= cols ? -1 : ix >> L
        xl[px] = grid && (cx - ix) * sd < 1 ? 1 : 0
      }
      for (let py = 0; py < ch; py++) {
        const cy = st.oy + (py + 0.5) / sd, iy = Math.floor(cy)
        const o = py * cw
        if (iy < 0 || iy >= rows) { u32.fill(BG, o, o + cw); continue }
        const ro2 = (iy >> L) * lv.cols
        const yl = grid && (cy - iy) * sd < 1
        for (let px = 0; px < cw; px++) {
          const x = xi[px]
          if (x < 0) { u32[o + px] = BG; continue }
          const v = d[ro2 + x]
          if (v !== v) { u32[o + px] = BG; continue }
          const k = lvIdx(v)
          u32[o + px] = yl || xl[px] ? lutD[k] : lutC[k]
        }
      }
      g.putImageData(st.img, 0, 0)
      const tier = tierFor(st.s)
      if (tier === 'numbers') {
        const w = visibleWindow(st.ox, st.oy, st.W, st.H, st.s, rows, cols)
        g.textAlign = 'center'; g.textBaseline = 'middle'
        const d0 = m.levels[0].data
        let drawn = 0
        for (let r = w.r0; r < w.r1 && drawn < 1600; r++) for (let cc = w.c0; cc < w.c1 && drawn < 1600; cc++) {
          const v = d0[r * cols + cc]
          if (v !== v) continue
          const t = fmt3(v, true).replace(/^([+−])0\./, '$1.').replace(/^0\./, '.')
          const fs = clamp((st.s * 0.86) / (Math.max(3, t.length) * 0.6), 6, 15)
          g.font = `${fs * dpr}px ui-monospace,Menlo,Consolas,monospace`
          g.fillStyle = lutB[lvIdx(v)] ? '#10141f' : '#f2f5ff'
          g.fillText(t, (cc + 0.5 - st.ox) * sd, (r + 0.5 - st.oy) * sd)
          drawn++
        }
      }
      // thumbnail viewport rectangle
      const wv = win.current
      if (wv) {
        const vw = Math.min(1, st.W / st.s / cols), vh = Math.min(1, st.H / st.s / rows)
        wv.style.left = `${clamp(st.ox / cols, 0, 1) * 100}%`; wv.style.top = `${clamp(st.oy / rows, 0, 1) * 100}%`
        wv.style.width = `${vw * 100}%`; wv.style.height = `${vh * 100}%`
      }
      if (sc.current) sc.current.textContent = `${st.s >= 10 ? Math.round(st.s) : st.s.toFixed(st.s >= 1 ? 1 : 2)} px/cell · ${tier}${pooledOnly ? ' (overview only)' : ''}`
      const z = st.s > st.minS * 1.02
      if (z !== st.zoomed) { st.zoomed = z; onZoomChange?.(z) }
      readout()
    }
    draw.current = sched
    const fit = () => { measure(); place({ s: st.minS, ox: 0, oy: 0 }); sched() }
    fit()
    // thumbnail from the coarsest level not smaller than ~100 px
    const tl = m.levels.find((l) => Math.max(l.rows, l.cols) <= 128) ?? m.levels[m.levels.length - 1]
    const t = th.current
    if (t) {
      t.width = tl.cols; t.height = tl.rows
      const tg = t.getContext('2d')!, im = tg.createImageData(tl.cols, tl.rows), tu = new Uint32Array(im.data.buffer)
      for (let i = 0; i < tl.data.length; i++) { const v = tl.data[i]; tu[i] = v !== v ? BG : lutC[lvIdx(v)] }
      tg.putImageData(im, 0, 0)
    }
    const zoomAt = (f: number, px: number, py: number) => {
      const cx = st.ox + px / st.s, cy = st.oy + py / st.s
      const s = clamp(st.s * f, st.minS, st.maxS)
      place({ s, ox: cx - px / s, oy: cy - py / s }); sched()
    }
    const api: HmApi = {
      fit, zoomBy: (f) => zoomAt(f, st.W / 2, st.H / 2), isZoomed: () => st.s > st.minS * 1.02,
      zoomTo: (r, cc, s) => { const ss = clamp(s, st.minS, st.maxS); place({ s: ss, ox: cc + 0.5 - st.W / ss / 2, oy: r + 0.5 - st.H / ss / 2 }); st.hover = null; render() },
      panBy: (dx, dy) => { place({ s: st.s, ox: st.ox + dx / st.s, oy: st.oy + dy / st.s }); sched() },
      state: () => ({ s: st.s, minS: st.minS, ox: st.ox, oy: st.oy, tier: tierFor(st.s), level: level(), rows, cols }),
      valueAt: (r, cc) => m.levels[0].data[r * cols + cc],
    }
    if (apiRef) apiRef.current = api
    const rect = () => c.getBoundingClientRect()
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = rect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016) * (e.deltaMode === 1 ? 16 : 1)), e.clientX - r.left, e.clientY - r.top) }
    c.addEventListener('wheel', wheel, { passive: false })
    const ptrs = new Map<number, { x: number; y: number }>()
    let pinch = 0, moved = 0
    const down = (e: PointerEvent) => { c.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; if (ptrs.size === 2) { const [a, b2] = [...ptrs.values()]; pinch = Math.hypot(a.x - b2.x, a.y - b2.y) } }
    const move = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId), r = rect()
      if (!p) { st.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; sched(); return }
      if (ptrs.size === 2) {
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const [a, b2] = [...ptrs.values()], dist = Math.hypot(a.x - b2.x, a.y - b2.y)
        if (pinch > 0) zoomAt(dist / pinch, (a.x + b2.x) / 2 - r.left, (a.y + b2.y) / 2 - r.top)
        pinch = dist; return
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      moved += Math.abs(dx) + Math.abs(dy)
      st.hover = { x: e.clientX - r.left, y: e.clientY - r.top }
      place({ s: st.s, ox: st.ox - dx / st.s, oy: st.oy - dy / st.s }); sched()
    }
    const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); pinch = 0; if (e.pointerType !== 'mouse') st.hover = null }
    const leave = () => { st.hover = null; sched() }
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('pointerleave', leave)
    const key = (e: KeyboardEvent) => {
      const step = (e.shiftKey ? 0.5 : 0.15)
      let used = true
      if (e.key === 'ArrowLeft') api.panBy(-st.W * step, 0)
      else if (e.key === 'ArrowRight') api.panBy(st.W * step, 0)
      else if (e.key === 'ArrowUp') api.panBy(0, -st.H * step)
      else if (e.key === 'ArrowDown') api.panBy(0, st.H * step)
      else if (e.key === '+' || e.key === '=') api.zoomBy(1.5)
      else if (e.key === '-' || e.key === '_') api.zoomBy(1 / 1.5)
      else if (e.key === 'Home') fit()
      else if (e.key === 'Enter') { if (st.s >= NUM_PX) fit(); else api.zoomTo(Math.floor(st.oy + st.H / st.s / 2), Math.floor(st.ox + st.W / st.s / 2), 34) }
      else used = false
      if (used) { e.preventDefault(); e.stopPropagation() }
    }
    c.addEventListener('keydown', key)
    const obs = new ResizeObserver(() => { const was = st.s <= st.minS * 1.02; measure(); place(was ? { s: st.minS, ox: 0, oy: 0 } : st); sched() })
    obs.observe(b)
    if (window.__ns7) window.__ns7.hm = api
    curHm = { api, name: label }
    return () => {
      cancelAnimationFrame(st.raf); st.raf = 0; obs.disconnect()
      c.removeEventListener('wheel', wheel); c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); c.removeEventListener('pointerleave', leave); c.removeEventListener('keydown', key)
      if (apiRef) apiRef.current = null
      if (window.__ns7 && window.__ns7.hm === api) window.__ns7.hm = null
      if (curHm?.api === api) curHm = null
    }
  }, [m, rows, cols, stride, pooledOnly, height, theme]) // eslint-disable-line react-hooks/exhaustive-deps

  const tw = 88, tt = rows >= cols ? tw : Math.max(24, Math.round((tw * rows) / cols)), tww = cols >= rows ? tw : Math.max(24, Math.round((tw * cols) / rows))
  return (
    <div className="nsx-hmbox" ref={box} style={{ height }}>
      <canvas ref={cv} className="nsx-hm" tabIndex={0} role="img" aria-label={`${label}. Arrow keys pan, plus and minus zoom, Home fits, Enter toggles number view.`} style={{ height }} />
      <div className="nsx-thumb" style={{ width: tww, height: tt }} onPointerDown={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), a = apiRef?.current
        if (a) { const s = a.state(); a.zoomTo(Math.floor(((e.clientY - r.top) / r.height) * rows), Math.floor(((e.clientX - r.left) / r.width) * cols), Math.max(s.s, s.minS)) }
      }}>
        <canvas ref={th} aria-hidden="true" />
        <div ref={win} className="nsx-thumbwin" />
      </div>
      <span className="nsx-scale mono" ref={sc} aria-hidden="true" />
      <div className="nsx-readout mono" ref={ro} aria-live="off" />
    </div>
  )
}

declare global { interface Window { __ns7?: any; __inspectorDemo?: (el: HTMLElement) => Promise<void> } }

/* ------------------------------------------------------------------ formatting helpers */

const ITEM: Record<string, number> = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1 }
const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`)
const fmtCount = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} K` : String(n))
const MAX_VALUES = 4_000_000
const COPY_CAP = 100_000

function roleFor(name: string | undefined, part: string | undefined): string {
  const n = name ?? ''
  if (/q_proj|query/.test(n)) return 'Turns each token into a query. It says what the token looks for.'
  if (/k_proj|key/.test(n)) return 'Turns each token into a key. It says what the token offers.'
  if (/v_proj|value/.test(n)) return 'Builds the value each token passes on.'
  if (/o_proj|out_proj|c_proj/.test(n) && part !== 'mlp') return 'Mixes the heads back into one vector.'
  if (/gate_proj|up_proj|fc1|c_fc/.test(n)) return 'Widens the vector so the MLP can pick out features.'
  if (/down_proj|fc2/.test(n)) return 'Shrinks the wide vector back to model size.'
  if (/norm|ln_/.test(n)) return 'Rescales each vector so the numbers stay steady.'
  if (/embed|wte/.test(n)) return 'Looks up one vector for each token.'
  if (/lm_head/.test(n)) return 'Scores every word in the vocabulary.'
  if (part === 'attn') return 'Lets each token look at the tokens before it.'
  if (part === 'mlp') return 'Rewrites each token on its own, using what attention gathered.'
  if (part === 'norm') return 'Rescales each vector so the numbers stay steady.'
  return 'One step of the model. It reads the vectors and writes new ones.'
}
const HINT_TEXT = {
  weights: 'Weights are the numbers the model learned. Amber is positive. Blue is negative. Dark is near zero.',
  vector: 'One number per dimension for one token. Each row holds 64 numbers.',
  logits: 'Scores for the next word. Softmax turns them into chances that add up to 100%. A low temperature makes the top word win more often.',
}

/* ------------------------------------------------------------------ small views */

function useSize1() { return typeof window !== 'undefined' && window.innerWidth < 560 }

function StatsRow({ s }: { s: TStats }) {
  const items: [string, string][] = [['min', fmt3(s.min, true)], ['max', fmt3(s.max, true)], ['mean', fmt3(s.mean, true)], ['std', fmt3(s.std)], ['zeros', `${(s.zeros * 100).toFixed(s.zeros < 0.01 ? 2 : 1)}%`], ['norm', fmt3(s.norm)]]
  return <dl className="nsx-stats mono">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}
function Legend({ s }: { s: TStats }) {
  return (
    <div className="nsx-legend" aria-label={`Colour scale from minus ${fmt3(s.vmax)} to plus ${fmt3(s.vmax)}`}>
      <div className="nsx-lbar" />
      <div className="nsx-llab mono"><span>○ −{fmt3(s.vmax)}</span><span>0</span><span>▲ +{fmt3(s.vmax)}</span></div>
    </div>
  )
}
function Histogram({ h }: { h: number[] }) {
  const mx = Math.max(1, ...h.map((x) => Math.log1p(x)))
  const w = 96 / h.length
  return (
    <svg className="nsx-hist" viewBox="0 0 96 30" preserveAspectRatio="none" role="img" aria-label="Histogram of values: blue below zero, amber above">
      {h.map((x, i) => { const hh = (Math.log1p(x) / mx) * 28; return <rect key={i} x={i * w + 0.1} width={w - 0.2} y={30 - hh} height={hh} fill={i < h.length / 2 ? 'var(--nsx-neg)' : 'var(--nsx-pos)'} /> })}
      <line x1="48" x2="48" y1="0" y2="30" stroke="var(--line,#27314f)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function download(name: string, blob: Blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000) }

/** Matrix view: legend, stats, histogram, zoomable heatmap, export buttons. */
function MatrixView({ data, rows, cols, stride, pooledOnly, label, name, height }: { data: Float32Array; rows: number; cols: number; stride: number; pooledOnly: boolean; label: string; name: string; height?: number }) {
  const m = useMips(data, rows, cols)
  const api = useRef<HmApi | null>(null)
  const [note, setNote] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const H = height ?? (useSize1() ? 300 : 360)
  if (!m) return <p className="nsx-muted" role="status">Building the picture…</p>
  const cut = () => {
    const s = api.current?.state()
    if (!s) return null
    const w = visibleWindow(s.ox, s.oy, 1e9, 1e9, s.s, rows, cols)
    const vw = visibleWindow(s.ox, s.oy, cvWidth(), H, s.s, rows, cols)
    return pooledOnly ? { ...w, r0: 0, r1: rows, c0: 0, c1: cols } : vw
  }
  const cvWidth = () => (document.querySelector('.nsx-hm') as HTMLElement | null)?.clientWidth ?? 600
  const doCopy = async () => {
    const w = cut(); if (!w) return
    const t = toTSV(data, cols, w.r0, w.r1, w.c0, w.c1, COPY_CAP)
    try { await navigator.clipboard.writeText(t.text); setNote(`Copied ${t.values.toLocaleString()} values.${t.truncated ? ` Cut at ${COPY_CAP.toLocaleString()} values. Zoom in for the rest.` : ''}`) } catch { setNote('Copy was blocked. Try Download CSV.') }
  }
  const doCsv = () => {
    const w = cut(); if (!w) return
    const t = toTSV(data, cols, w.r0, w.r1, w.c0, w.c1, COPY_CAP)
    download(`${name.replace(/[^\w.-]+/g, '_')}.csv`, new Blob([t.text.replace(/\t/g, ',')], { type: 'text/csv' }))
    setNote(`Saved ${t.values.toLocaleString()} values.${t.truncated ? ` Cut at ${COPY_CAP.toLocaleString()} values.` : ''}`)
  }
  const doPng = () => (document.querySelector('.nsx-hm') as HTMLCanvasElement | null)?.toBlob((b) => b && download(`${name.replace(/[^\w.-]+/g, '_')}.png`, b))
  return (
    <div className="nsx-tview" data-tensor={name}>
      {pooledOnly && <p className="nsx-note" role="status">This tensor has {(rows * cols * stride * stride).toLocaleString()} values. That is too many to draw one by one. This is a pooled overview, 1 sample in every {stride}×{stride}.</p>}
      <Legend s={m.stats} />
      <Heatmap m={m} rows={rows} cols={cols} stride={stride} pooledOnly={pooledOnly} label={label} height={H} apiRef={api} onZoomChange={setZoomed} />
      <div className="nsx-tools">
        <button className="nsx-btn sm" type="button" aria-label="Zoom out" onClick={() => api.current?.zoomBy(1 / 1.5)}>−</button>
        <button className="nsx-btn sm" type="button" aria-label="Zoom in" onClick={() => api.current?.zoomBy(1.5)}>+</button>
        <button className="nsx-btn" type="button" onClick={() => api.current?.fit()} disabled={!zoomed}>Fit</button>
        <span className="nsx-sp" />
        <button className="nsx-btn" type="button" onClick={doCopy}>Copy TSV</button>
        <button className="nsx-btn" type="button" onClick={doCsv}>Download CSV</button>
        <button className="nsx-btn" type="button" onClick={doPng}>PNG</button>
      </div>
      {note && <p className="nsx-note" role="status">{note}</p>}
      <StatsRow s={m.stats} />
      <Histogram h={m.hist} />
      <p className="nsx-muted">Min {fmt3(m.stats.min, true)} · max {fmt3(m.stats.max, true)}. Colours clip at ±{fmt3(m.stats.vmax)}. Wheel or pinch to zoom. Drag to pan. At 28 px per cell the numbers show.</p>
    </div>
  )
}

/** Vector view: the values wrapped in rows of 64, plus a paged table of every number. */
function VectorView({ data, label, name }: { data: Float32Array; label: string; name: string }) {
  const rows = Math.ceil(data.length / 64)
  const padded = useRef<{ src: Float32Array; out: Float32Array } | null>(null)
  if (!padded.current || padded.current.src !== data) { const out = new Float32Array(rows * 64).fill(NaN); out.set(data); padded.current = { src: data, out } }
  const [all, setAll] = useState(false)
  const [page, setPage] = useState(0)
  const pages = Math.ceil(data.length / 64)
  const slice = Array.from(data.subarray(page * 64, page * 64 + 64))
  return (
    <div>
      <MatrixView data={padded.current.out} rows={rows} cols={64} stride={1} pooledOnly={false} label={label} name={name} height={Math.min(300, Math.max(150, rows * 22 + 20))} />
      <button className="nsx-btn" type="button" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'Hide numbers' : 'Show all numbers'}</button>
      {all && (
        <div className="nsx-table-wrap">
          <table className="nsx-table mono">
            <caption>Values {page * 64} to {Math.min(data.length, page * 64 + 64) - 1} of {data.length}</caption>
            <tbody>{Array.from({ length: Math.ceil(slice.length / 8) }, (_, r) => (
              <tr key={r}>{slice.slice(r * 8, r * 8 + 8).map((v, k) => <td key={k} className={v < 0 ? 'neg' : 'pos'}><b>{page * 64 + r * 8 + k}</b>{fmt3(v, true)}</td>)}</tr>
            ))}</tbody>
          </table>
          <div className="nsx-tools">
            <button className="nsx-btn" type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous 64</button>
            <button className="nsx-btn" type="button" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next 64</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ tensor card: load button -> view */

type Load = { st: 'idle' } | { st: 'loading'; done: number } | { st: 'err'; msg: string } | { st: 'ready'; data: Float32Array; rows: number; cols: number; stride: number; rank1: boolean }

const sleep = (ms: number, sig?: AbortSignal) => new Promise<void>((res, rej) => { const t = setTimeout(res, ms); sig?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Cancelled.')) }) })

function dims(shape: number[]) {
  if (shape.length <= 1) return { rows: 1, cols: shape[0] ?? 0, rank1: true }
  return { rows: shape[shape.length - 2], cols: shape[shape.length - 1], rank1: false }
}

function TensorBody({ t, repo }: { t: TInfo; repo: string }) {
  const [ld, setLd] = useState<Load>({ st: 'idle' })
  const ctl = useRef<AbortController | null>(null)
  const loadRef = useRef<(q?: boolean) => Promise<void>>(async () => {})
  useEffect(() => { setLd({ st: 'idle' }); return () => ctl.current?.abort() }, [t.name])
  // mock data is generated locally (no fetch), so it shows at once
  useEffect(() => { if (isMock() && t.name === 'w') void loadRef.current(true) }, [t.name]) // eslint-disable-line react-hooks/exhaustive-deps
  const { rows, cols, rank1 } = dims(t.shape)
  const n = rows * cols
  const bytes = n * (ITEM[t.dtype.toUpperCase()] ?? 4)
  const stride = rank1 ? 1 : n > MAX_VALUES ? Math.ceil(Math.sqrt(n / 1_000_000)) : 1
  const load = async (quick = false) => {
    ctl.current?.abort(); const ac = (ctl.current = new AbortController())
    setLd({ st: 'loading', done: 0 })
    try {
      const Ro = Math.ceil(rows / stride), Co = Math.ceil(cols / stride)
      if (isMock()) {
        if (!quick) for (let i = 1; i <= 4; i++) { await sleep(120, ac.signal); setLd({ st: 'loading', done: i / 4 }) }
        const mm = mockMatrix(t.name, rows, cols, stride)
        setLd({ st: 'ready', data: mm.data, rows: mm.rows, cols: mm.cols, stride, rank1 })
        return
      }
      const out = new Float32Array(Ro * Co), tile = 1024
      const tiles = Math.ceil(Ro / tile) * Math.ceil(Co / tile); let k = 0
      for (let r0 = 0; r0 < Ro; r0 += tile) for (let c0 = 0; c0 < Co; c0 += tile) {
        const w = await api.tensorWindow({ repo, file: t.file ?? '', name: t.name, i0: t.shape.length > 2 ? 0 : undefined, r0: r0 * stride, c0: c0 * stride, rows: Math.min(tile, Ro - r0), cols: Math.min(tile, Co - c0), stride }, ac.signal)
        for (let r = 0; r < w.rows; r++) out.set(w.data.subarray(r * w.cols, r * w.cols + w.cols), (r0 + r) * Co + c0)
        setLd({ st: 'loading', done: ++k / tiles })
      }
      setLd({ st: 'ready', data: out, rows: Ro, cols: Co, stride, rank1 })
    } catch (e: any) { if (!ac.signal.aborted) setLd({ st: 'err', msg: String(e?.message ?? e) }) }
  }
  loadRef.current = load
  if (ld.st === 'ready') {
    const label = `${shortName(t.name)}, ${t.shape.join(' by ')}`
    return ld.rank1 ? <VectorView data={ld.data} label={label} name={t.name} /> : <MatrixView data={ld.data} rows={ld.rows} cols={ld.cols} stride={ld.stride} pooledOnly={ld.stride > 1} label={label} name={t.name} />
  }
  return (
    <div className="nsx-load">
      {ld.st === 'loading' ? (
        <>
          <div className="nsx-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ld.done * 100)} aria-label="Loading tensor"><i style={{ width: `${Math.max(3, ld.done * 100)}%` }} /></div>
          <button className="nsx-btn" type="button" onClick={() => { ctl.current?.abort(); setLd({ st: 'idle' }) }}>Cancel</button>
        </>
      ) : (
        <button className="nsx-btn primary" type="button" onClick={() => load()}>Load this tensor ({fmtBytes(Math.round(bytes / (stride * stride)))})</button>
      )}
      {ld.st === 'err' && <p className="nsx-err" role="alert">{ld.msg} Try again.</p>}
      {stride > 1 && <p className="nsx-muted">{n.toLocaleString()} values is too many to draw one by one. You will get a pooled overview.</p>}
      {t.shape.length > 2 && <p className="nsx-muted">Showing slice 0 of {t.shape.slice(0, -2).join('×')}.</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ token (vector) and output views */

function TokenBody({ i, info }: { i: NonNullable<Inspect>; info: ModelInfo | null }) {
  const setInspect = useZoo((s) => s.setInspect)
  const input = useStore((s) => s.input)
  const [ld, setLd] = useState<{ st: 'idle' | 'busy' | 'err' | 'ok'; msg?: string; data?: Float32Array }>({ st: 'idle' })
  const pos = i.index ?? 0
  const key = `${i.layer}|${i.name}|${pos}`
  useEffect(() => { setLd({ st: 'idle' }) }, [key])
  const toks = info?.tokens.length ? info.tokens : MOCK_TOKENS
  const go = async () => {
    setLd({ st: 'busy' })
    try {
      if (isMock()) { await sleep(150); setLd({ st: 'ok', data: mockVector(`vec.${i.layer}.${i.name}.${pos}`) }); return }
      const layer = Math.max(0, (i.layer ?? 0) - (i.name === 'in' ? 1 : 0))
      const r = await api.activation({ repo: info?.repo ?? '', input, layer, pos, kind: 'resid' })
      if (!r.available) setLd({ st: 'err', msg: r.reason })
      else setLd({ st: 'ok', data: r.data })
    } catch (e: any) { setLd({ st: 'err', msg: String(e?.message ?? e) }) }
  }
  return (
    <div>
      <div className="nsx-chips" role="group" aria-label="Pick a token">
        {toks.map((t, k) => <button key={k} type="button" className={`nsx-chip${k === pos ? ' on' : ''}`} aria-pressed={k === pos} onClick={() => setInspect({ ...i, index: k })}>{showTok(t)}</button>)}
      </div>
      {ld.st === 'ok' && ld.data
        ? <VectorView data={ld.data} label={`Vector for token ${pos + 1}, ${ld.data.length} numbers`} name={`token${pos}_${i.name}`} />
        : <div className="nsx-load">
            <button className="nsx-btn primary" type="button" onClick={go} disabled={ld.st === 'busy'}>{ld.st === 'busy' ? 'Working…' : `Show the numbers for token ${pos + 1}`}</button>
            {ld.st === 'err' && <p className="nsx-err" role="alert">{ld.msg} Run the model first, or start the companion.</p>}
          </div>}
    </div>
  )
}

function OutputBody({ info }: { info: ModelInfo | null }) {
  const [T, setT] = useState(1)
  const [more, setMore] = useState(false)
  const real = info?.topk ?? []
  const items = real.length ? real.map((x) => ({ token: x.token, logit: Math.log(Math.max(1e-12, x.p)) })) : isMock() ? mockLogits() : []
  const probs = softmaxT(items.map((x) => x.logit), T)
  const order = items.map((x, k) => ({ ...x, p: probs[k] })).sort((a, b) => b.p - a.p)
  const shown = order.slice(0, more ? 50 : 10)
  if (!items.length) return <p className="nsx-muted">Run a prompt to see the next-word scores.</p>
  const top = shown[0]?.p || 1
  return (
    <div>
      <label className="nsx-temp">Temperature <b className="mono">{T.toFixed(2)}</b>
        <input type="range" min="0.1" max="2" step="0.05" value={T} onChange={(e) => setT(Number(e.target.value))} aria-label="Temperature" />
      </label>
      <ol className="nsx-logits">
        {shown.map((x) => (
          <li key={x.token}>
            <span className="mono nsx-lt" title={JSON.stringify(x.token)}>{showTok(x.token)}</span>
            <span className="nsx-lbarw"><i style={{ width: `${Math.max(0.5, (x.p / top) * 100)}%` }} /></span>
            <span className="mono nsx-lp">{(x.p * 100).toFixed(x.p < 0.1 ? 1 : 0)}%</span>
          </li>
        ))}
      </ol>
      <button className="nsx-btn" type="button" disabled={items.length <= 10} onClick={() => setMore((m) => !m)}>{more ? 'Show 10' : 'Show 50'}</button>
      {items.length <= 10 && <p className="nsx-muted">The model returned {items.length} words. Chances are shared among them.</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ the card */

function Crumbs({ i }: { i: NonNullable<Inspect> }) {
  const setInspect = useZoo((s) => s.setInspect)
  const parts: { label: string; go: Inspect }[] = [{ label: 'Model', go: null }]
  if (i.layer !== undefined) parts.push({ label: `Block ${i.layer + 1}`, go: { kind: 'block', layer: i.layer } })
  if (i.part) parts.push({ label: PART_NAME[i.part] ?? i.part, go: { kind: 'block', layer: i.layer, part: i.part } })
  const tail = inspectCrumb(i).split(' › ').slice(parts.length).join(' › ')
  return (
    <nav className="nsx-crumb" aria-label="Breadcrumb">
      {parts.map((p, k) => <span key={k}><button type="button" className="nsx-link" onClick={() => setInspect(p.go)}>{p.label}</button>{(tail || k < parts.length - 1) && <i aria-hidden="true"> › </i>}</span>)}
      {tail && <span aria-current="page">{tail}</span>}
    </nav>
  )
}

function Card({ i }: { i: NonNullable<Inspect> }) {
  const info = useModelInfo()
  const setInspect = useZoo((s) => s.setInspect)
  const sid = useId()
  const [pick, setPick] = useState(false)
  useEffect(() => setPick(false), [i.layer, i.part, i.kind])
  const blk = i.layer !== undefined ? info?.blocks[i.layer] : undefined
  const parts = blk ? (i.part && i.part !== 'embed' ? blk[i.part] : [...blk.attn, ...blk.mlp, ...blk.norm]) : []
  const tens = i.kind === 'tensor' ? findTensor(info, i) : null
  const lastTok = Math.max(0, (info?.tokens.length ?? MOCK_TOKENS.length) - 1)

  let title = 'Output', shape = 'vocabulary words', params = '', dtype = '', role = 'Scores every word in the vocabulary, then picks the next one.'
  if (i.kind === 'block') {
    title = i.layer !== undefined ? `Block ${i.layer + 1}${i.part ? ` · ${PART_NAME[i.part]}` : ''}` : (PART_NAME[i.part ?? ''] ?? 'Block')
    shape = `${parts.length} weight tensors`
    params = fmtCount(parts.reduce((a, t) => a + t.params, 0)); dtype = parts[0]?.dtype ?? ''
    role = roleFor(undefined, i.part)
  } else if (i.kind === 'tensor') {
    title = shortName(i.name ?? 'tensor'); shape = tens ? tens.shape.join(' × ') : 'unknown'; params = tens ? fmtCount(tens.params) : ''; dtype = tens?.dtype ?? ''
    role = roleFor(i.name, i.part)
  } else if (i.kind === 'token') {
    title = `${i.name === 'in' ? 'Input' : i.name === 'out' ? 'Output' : 'Values'} of block ${(i.layer ?? 0) + 1}`; shape = 'one vector per token'; dtype = 'F32'
    role = i.name === 'in' ? 'The vector this block reads for one token.' : 'The vector this block hands on for one token.'
  }
  const summary = `${title}. ${role} Shape ${shape}.${params ? ` ${params} parameters.` : ''}${dtype ? ` Data type ${dtype}.` : ''}`
  const hint = i.kind === 'tensor' ? HINT_TEXT.weights : i.kind === 'token' ? HINT_TEXT.vector : i.kind === 'output' ? HINT_TEXT.logits : HINT_TEXT.weights
  const openWeights = (t: TInfo) => setInspect({ kind: 'tensor', layer: i.layer, part: i.part, name: t.name })
  return (
    <section className="nsx-card" data-inspector role="region" aria-label={`Inspector: ${title}`} aria-describedby={sid}>
      <header className="nsx-head">
        <Crumbs i={i} />
        <button type="button" className="nsx-btn sm" aria-label="Back up one level" onClick={() => setInspect(inspectParent(i))}>✕</button>
      </header>
      <h3 className="nsx-title">{title}<Hint label={`About ${title}`}>{hint}</Hint></h3>
      <p className="nsx-role">{role}</p>
      <dl className="nsx-facts">
        <div><dt>Shape</dt><dd className="mono">{shape}</dd></div>
        {params && <div><dt>Parameters</dt><dd className="mono">{params}</dd></div>}
        {dtype && <div><dt>Data type</dt><dd className="mono">{dtype}</dd></div>}
      </dl>
      <p className="nsx-sr" id={sid}>{summary}</p>
      {i.kind === 'block' && (
        <>
          <div className="nsx-actions">
            <button type="button" className="nsx-btn primary" aria-expanded={pick} onClick={() => (parts.length === 1 ? openWeights(parts[0]) : setPick((p) => !p))} disabled={!parts.length}>Weights ▸</button>
            <button type="button" className="nsx-btn" disabled={i.layer === undefined} onClick={() => setInspect({ kind: 'token', layer: i.layer, part: i.part, index: lastTok, name: 'in' })}>Input ▸</button>
            <button type="button" className="nsx-btn" disabled={i.layer === undefined} onClick={() => setInspect({ kind: 'token', layer: i.layer, part: i.part, index: lastTok, name: 'out' })}>Output ▸</button>
          </div>
          {pick && <ul className="nsx-tlist">{parts.map((t) => <li key={t.name}><button type="button" className="nsx-btn" onClick={() => openWeights(t)}><span>{shortName(t.name)}</span><span className="mono nsx-muted">{t.shape.join('×')}</span></button></li>)}</ul>}
          {!info && <p className="nsx-muted">Load a model to see its blocks.</p>}
        </>
      )}
      {i.kind === 'tensor' && <p className="nsx-muted">Key: ○ −1 blue is negative. ▲ +1 amber is positive. Dark is near 0.</p>}
      {i.kind === 'tensor' && (tens ? <TensorBody t={tens} repo={info?.repo ?? ''} /> : <p className="nsx-muted">This tensor is not in the model header.</p>)}
      {i.kind === 'token' && <TokenBody i={i} info={info} />}
      {i.kind === 'output' && <OutputBody info={info} />}
    </section>
  )
}

/* ------------------------------------------------------------------ the exported Inspector */

const PILL_KEY = 'ns.inspect.pill'
/** Self-contained inspector. Renders the overview pill + `Inspect` toggle while nothing is selected, the card otherwise.
 *  Selection comes from useZoo().inspect (S8 sets it). Esc goes up one level. */
export function Inspector({ className }: { className?: string }) {
  useInjectedStyle('ns-inspector', INSPECTOR_CSS)
  const inspect = useZoo((s) => s.inspect)
  const setInspect = useZoo((s) => s.setInspect)
  const [pill, setPill] = useState(() => { try { return localStorage.getItem(PILL_KEY) !== '1' } catch { return true } })
  const dismiss = useCallback(() => { setPill(false); try { localStorage.setItem(PILL_KEY, '1') } catch { /* private mode */ } }, [])
  useEffect(() => { if (inspect && pill) dismiss() }, [inspect, pill, dismiss])
  useEffect(() => {
    if (!inspect) return
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return
      const hm = window.__ns7?.hm as HmApi | null | undefined
      if (hm?.isZoomed()) { hm.fit(); return }
      setInspect(inspectParent(inspect))
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [inspect, setInspect])
  // the shared selection (S8 / harness) opens a tensor view; Esc then closes it
  const sel = useZoo((s) => s.sel) as any
  useEffect(() => { if (sel && sel.kind === 'block' && sel.name) useZoo.getState().setInspect({ kind: 'tensor', name: sel.name }) }, [sel])
  useEffect(() => { if (window.__ns7) window.__ns7.set = (i: Inspect) => useZoo.getState().setInspect(i) }, [])
  if (!inspect) {
    if (!pill) return null
    return (
      <div className={`nsx-bar ${className ?? ''}`}>
        <span className="nsx-pill" role="status">Click any block to inspect it.<button type="button" aria-label="Dismiss" onClick={dismiss}>×</button></span>
      </div>
    )
  }
  return <div className={className}><Card i={inspect} /></div>
}

/* ------------------------------------------------------------------ styles */

const INSPECTOR_CSS = `
.nsx-card,.nsx-bar,.nsx-hmbox,.nshint,.nsx-expl{--nsx-neg:var(--neg,#55a8ff);--nsx-pos:var(--pos,#ffa94d);--nsx-mid:#101628;--nsx-canvas:#0a0e19;--nsx-grad:var(--brand-solid,linear-gradient(135deg,#5b3df5,#0a7d9c 55%,#c2255c));--nsx-shadow:rgba(0,0,0,.55)}
:root[data-theme="light"] .nsx-card,:root[data-theme="light"] .nsx-bar,:root[data-theme="light"] .nsx-hmbox,:root[data-theme="light"] .nshint,:root[data-theme="light"] .nsx-expl{--nsx-neg:#1f6fd1;--nsx-pos:#b45d00;--nsx-mid:#f7f8fc;--nsx-canvas:#eef0f8;--nsx-shadow:rgba(20,26,60,.22)}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]) .nsx-card,:root:not([data-theme="dark"]) .nsx-bar,:root:not([data-theme="dark"]) .nsx-hmbox,:root:not([data-theme="dark"]) .nshint,:root:not([data-theme="dark"]) .nsx-expl{--nsx-neg:#1f6fd1;--nsx-pos:#b45d00;--nsx-mid:#f7f8fc;--nsx-canvas:#eef0f8;--nsx-shadow:rgba(20,26,60,.22)}}
.nsx-bar{display:flex;gap:var(--s2,8px);align-items:center;flex-wrap:wrap}
.nsx-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 12px;border-radius:var(--r-pill,999px);background:var(--surface2,#1b2542);border:1px solid var(--line,#27314f);color:var(--fg,#e8ecf8);font:400 var(--t0,14px)/1.3 var(--body,system-ui,sans-serif)}
.nsx-pill button{all:unset;cursor:pointer;width:var(--hit,40px);height:var(--hit,40px);margin:-8px 0;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:var(--muted,#9aa5c7)}
.nsx-tip{position:fixed;z-index:70;pointer-events:none;padding:5px 10px;border-radius:var(--r-sm,8px);background:var(--panel,#0f1526);border:1px solid var(--line,#27314f);color:var(--fg,#e8ecf8);font:400 13px/1.3 var(--body,system-ui,sans-serif);transform:translate(10px,10px)}
.nsx-card{box-sizing:border-box;width:100%;max-width:760px;padding:var(--s4,16px);border-radius:var(--r-lg,18px);border:1px solid var(--line,#27314f);background:var(--panel,#0f1526);color:var(--fg,#e8ecf8);font:400 var(--t0,14px)/1.45 var(--body,system-ui,sans-serif);display:flex;flex-direction:column;gap:var(--s3,12px)}
.nsx-card .mono,.nsx-bar .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.nsx-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s2,8px)}
.nsx-crumb{font-size:13px;color:var(--muted,#9aa5c7);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsx-crumb i{font-style:normal}
.nsx-crumb [aria-current]{color:var(--fg,#e8ecf8);font-weight:600;text-shadow:0 0 14px color-mix(in srgb,var(--nsx-pos) 75%,transparent)}
.nsx-link{all:unset;cursor:pointer;color:var(--muted,#9aa5c7);text-decoration:underline;text-underline-offset:2px;padding:10px 0}
.nsx-link:hover{color:var(--fg,#e8ecf8)}
.nsx-link:focus-visible,.nsx-chip:focus-visible,.nsx-hm:focus-visible{outline:2px solid var(--pos,#ffa94d);outline-offset:2px}
.nsx-title{margin:0;font:600 var(--t2,20px)/1.2 var(--body,system-ui,sans-serif);display:flex;align-items:center;flex-wrap:wrap}
.nsx-role{margin:0;color:var(--muted,#9aa5c7)}
.nsx-facts{display:flex;flex-wrap:wrap;gap:var(--s2,8px) var(--s5,24px);margin:0}
.nsx-facts dt{font-size:12px;color:var(--faint,#8a95b8)}
.nsx-facts dd{margin:0}
.nsx-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;margin:0}
.nsx-actions,.nsx-tools{display:flex;flex-wrap:wrap;gap:var(--s2,8px);align-items:center}
.nsx-sp{flex:1}
.nsx-btn{all:unset;box-sizing:border-box;cursor:pointer;min-height:var(--hit,40px);padding:0 14px;display:inline-flex;align-items:center;justify-content:space-between;gap:var(--s3,12px);border-radius:var(--r-md,12px);border:1px solid var(--line,#27314f);background:transparent;color:var(--fg,#e8ecf8);font:600 13px/1 var(--body,system-ui,sans-serif);transition:border-color var(--d1,120ms),background var(--d1,120ms)}
.nsx-btn:hover:not(:disabled){border-color:var(--muted,#9aa5c7)}
.nsx-link{font-weight:600}
.nsx-btn:focus-visible{outline:2px solid var(--pos,#ffa94d);outline-offset:2px}
.nsx-btn.primary{background:var(--pos,#ffa94d);border-color:transparent;color:var(--on-pos,#0a0e19)}
.nsx-btn.primary:hover:not(:disabled){filter:brightness(1.08)}
.nsx-btn.primary:focus-visible{outline:2px solid var(--on-pos,#0a0e19);outline-offset:-4px;box-shadow:0 0 0 2px var(--fg,#e8ecf8)}
.nsx-btn.sm{min-width:var(--hit,40px);padding:0;justify-content:center}
.nsx-btn:disabled{opacity:.45;cursor:default}
.nsx-btn[aria-pressed="true"]{border-color:var(--pos,#ffa94d)}
.nsx-tlist{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.nsx-tlist .nsx-btn{width:100%}
.nsx-muted{margin:0;color:var(--faint,#8a95b8);font-size:13px}
.nsx-note{margin:0;padding:8px 12px;border-radius:var(--r-sm,8px);background:var(--surface,#141c32);border:1px dashed var(--line,#27314f);font-size:13px}
.nsx-err{margin:0;color:var(--bad,#ff7a7a)}
.nsx-load{display:flex;flex-direction:column;gap:var(--s2,8px);align-items:flex-start}
.nsx-prog{width:100%;height:8px;border-radius:4px;background:var(--surface,#141c32);overflow:hidden}
.nsx-prog i{display:block;height:100%;background:var(--pos,#ffa94d);transition:width var(--d2,220ms)}
.nsx-tview{display:flex;flex-direction:column;gap:var(--s2,8px)}
.nsx-hmbox{position:relative;width:100%;border-radius:var(--r-md,12px);overflow:hidden;background:var(--nsx-canvas);border:1px solid var(--line,#27314f)}
.nsx-hm{display:block;width:100%;cursor:grab;touch-action:pan-y}
.nsx-hm:focus{touch-action:none}
.nsx-hm:active{cursor:grabbing}
.nsx-thumb{position:absolute;right:8px;top:8px;border:1px solid var(--line,#27314f);border-radius:6px;overflow:hidden;opacity:.92;cursor:pointer;background:var(--nsx-canvas)}
.nsx-thumb canvas{display:block;width:100%;height:100%}
.nsx-thumbwin{position:absolute;border:1.5px solid #fff;outline:1px solid #000a;box-sizing:border-box;pointer-events:none;min-width:3px;min-height:3px}
.nsx-scale{position:absolute;left:8px;top:8px;padding:3px 9px;border-radius:var(--r-pill,999px);background:var(--nsx-grad);box-shadow:0 0 14px color-mix(in srgb,#7c5cff 45%,transparent);font-size:12px;font-weight:600;color:#fff;pointer-events:none}
.nsx-readout{position:absolute;left:8px;bottom:8px;padding:3px 8px;border-radius:6px;background:color-mix(in srgb,var(--panel,#0f1526) 90%,transparent);border:1px solid var(--line,#27314f);font-size:12px;color:var(--fg,#e8ecf8);pointer-events:none;max-width:calc(100% - 16px)}
.nsx-readout:empty{display:none}
.nsx-legend{display:flex;flex-direction:column;gap:3px}
.nsx-lbar{height:10px;border-radius:5px;background:linear-gradient(90deg,var(--nsx-neg),var(--nsx-mid) 50%,var(--nsx-pos))}
.nsx-llab{display:flex;justify-content:space-between;font-size:12px;color:var(--muted,#9aa5c7)}
.nsx-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:6px;margin:0}
.nsx-stats div{padding:6px 8px;border-radius:var(--r-sm,8px);background:var(--surface,#141c32)}
.nsx-stats dt{font-size:12px;color:var(--faint,#8a95b8)}
.nsx-stats dd{margin:0;font-size:var(--t0,14px)}
.nsx-hist{width:100%;height:44px;display:block}
.nsx-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--s3,12px)}
.nsx-chip{all:unset;cursor:pointer;box-sizing:border-box;min-height:var(--hit,40px);padding:0 12px;display:inline-flex;align-items:center;border-radius:var(--r-pill,999px);border:1px solid var(--line,#27314f);font:400 13px ui-monospace,Menlo,Consolas,monospace;color:var(--fg,#e8ecf8)}
.nsx-chip.on{border-color:var(--pos,#ffa94d);background:var(--surface2,#1b2542)}
.nsx-table-wrap{margin:var(--s2,8px) 0;overflow-x:auto}
.nsx-table{border-collapse:collapse;font-size:12px;width:100%}
.nsx-table caption{text-align:left;color:var(--faint,#8a95b8);padding-bottom:4px}
.nsx-table td{padding:4px 6px;border:1px solid var(--line,#27314f);white-space:nowrap}
.nsx-table td b{font-weight:400;color:var(--faint,#8a95b8);margin-right:6px}
.nsx-table td.pos{color:var(--pos-ink,var(--nsx-pos))}
.nsx-table td.neg{color:var(--neg-ink,var(--nsx-neg))}
.nsx-temp{display:flex;align-items:center;gap:var(--s3,12px);margin-bottom:var(--s3,12px)}
.nsx-temp input{flex:1;min-height:var(--hit,40px)}
.nsx-logits{list-style:none;margin:0 0 var(--s3,12px);padding:0;display:grid;gap:4px}
.nsx-logits li{display:grid;grid-template-columns:minmax(64px,110px) 1fr 52px;gap:8px;align-items:center}
.nsx-lt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsx-lbarw{height:12px;border-radius:3px;background:var(--surface,#141c32);overflow:hidden}
.nsx-lbarw i{display:block;height:100%;background:var(--nsx-grad);transition:width var(--d2,220ms) var(--ease,ease)}
.nsx-lp{text-align:right}
@media (max-width:560px){.nsx-card{padding:var(--s3,12px)}.nsx-thumb{display:none}}
`

/* ------------------------------------------------------------------ dev / test harness (off unless ?inspectorDemo is in the URL) */

if (typeof window !== 'undefined' && (import.meta.env.DEV || /[?&]inspectorDemo/.test(location.search))) {
  window.__ns7 = { fmt3, mipBuild, softmaxT, histogram, visibleWindow, clampView, tierFor, pickLevel, toTSV, mockValue, mockMatrix, inspectCrumb, inspectParent, hm: null, set: (i: Inspect) => useZoo.getState().setInspect(i) }
  ;(window as any).__explainerDemo = async (el: HTMLElement) => { const { createRoot } = await import('react-dom/client'); createRoot(el).render(<><Explainer id="demo-a" placement="top-right">Each dot is a word.<br />Lines show what it listens to.</Explainer><Explainer id="demo-b" placement="bottom-left">Amber is plus. Blue is minus.</Explainer></>) }
  window.__inspectorDemo = async (el: HTMLElement) => { const { createRoot } = await import('react-dom/client'); createRoot(el).render(<Inspector />) }
}

/** Hooks for the e2e harness (always on, tiny). zoomMax zooms the open heatmap to its maximum, returns the value at the
 *  cell in view, and puts the view back so one Esc closes the card. */
if (typeof window !== 'undefined') {
  ;(window as any).__inspector = {
    async zoomMax() {
      for (let k = 0; k < 100 && !curHm; k++) await new Promise((r) => setTimeout(r, 50))
      if (!curHm) throw new Error('no heatmap open')
      const a = curHm.api, name = (document.querySelector('[data-tensor]') as HTMLElement | null)?.dataset.tensor ?? '', st = a.state()
      const r = Math.floor(st.rows * 0.37), c = Math.floor(st.cols * 0.61)
      a.zoomTo(r, c, 1e6)
      await new Promise((res) => requestAnimationFrame(() => res(null)))
      const value = a.valueAt(r, c), tier = a.state().tier
      a.fit()
      return { name, r, c, value, tier }
    },
  }
}

/* ------------------------------------------------------------------ Explainer (round 3, B4) */

const EXPL_CSS = `
.nsx-ecard>span{display:block}
.nsx-expl{position:absolute;z-index:5;pointer-events:none;width:0;height:0}
.nsx-expl[data-p="top-left"]{top:8px;left:8px}
.nsx-expl[data-p="top-right"]{top:8px;right:8px}
.nsx-expl[data-p="bottom-left"]{bottom:8px;left:8px}
.nsx-expl[data-p="bottom-right"]{bottom:8px;right:8px}
.nsx-ebulb{all:unset;box-sizing:border-box;pointer-events:auto;position:absolute;width:var(--hit,40px);height:var(--hit,40px);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border-radius:50%;color:var(--muted,#9aa5c7);-webkit-tap-highlight-color:transparent}
.nsx-expl[data-p$="left"] .nsx-ebulb{left:0}.nsx-expl[data-p$="right"] .nsx-ebulb{right:0}
.nsx-expl[data-p^="top"] .nsx-ebulb{top:0}.nsx-expl[data-p^="bottom"] .nsx-ebulb{bottom:0}
.nsx-ebulb svg{width:28px;height:28px;display:block;transition:color var(--d1,120ms),filter var(--d1,120ms)}
.nsx-ebulb:hover svg,.nsx-ebulb[aria-expanded="true"] svg{color:var(--pos,#ffa94d);filter:drop-shadow(0 0 6px color-mix(in srgb,var(--pos,#ffa94d) 60%,transparent))}
.nsx-ebulb:focus-visible{outline:2px solid var(--pos,#ffa94d);outline-offset:-2px}
.nsx-ecard{position:fixed;inset:auto;margin:0;pointer-events:none;width:max-content;max-width:min(280px,calc(100vw - 32px));padding:10px 14px;border-radius:var(--r-md,12px);border:1px solid var(--line,#27314f);background:var(--panel,#0f1526);color:var(--fg,#e8ecf8);box-shadow:0 12px 32px var(--nsx-shadow,rgba(0,0,0,.45)),0 0 0 1px color-mix(in srgb,#7c5cff 25%,transparent);font:400 var(--t0,14px)/1.45 var(--body,system-ui,sans-serif);overflow:visible}
.nsx-ecard::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--nsx-grad,linear-gradient(135deg,#5b3df5,#0a7d9c 55%,#c2255c))}
.nsx-ecard p{margin:0}.nsx-ecard p+p{margin-top:4px}.nsx-ecard{white-space:normal}
.nsx-ecard[data-probe]{visibility:hidden}
@media (prefers-reduced-motion:no-preference){
.nsx-ecard{opacity:0;transition:opacity 60ms linear,display 60ms allow-discrete,overlay 60ms allow-discrete}
.nsx-ecard:popover-open,.nsx-ecard[data-open]{opacity:1}}
`
const idDelay = (id: string) => (strSeed(id) % 5) * 30
const SEEN_KEY = (id: string) => `ns.expl.seen.${id}`
const wasSeen = (id: string) => { try { return localStorage.getItem(SEEN_KEY(id)) === '1' } catch { return false } }
const markSeen = (id: string) => { try { localStorage.setItem(SEEN_KEY(id), '1') } catch { /* private mode */ } }

/** True for ~`ms` once per explainer id, ever (then bulb only). Waits for the name card. The caller may still veto it
 *  (see Explainer: never over a control or the pad). */
export function useExplainerIntro(id: string, ms = 5000): boolean {
  const [on, setOn] = useState(false)
  // on a first visit the name card is modal: hold the intro until it is answered
  const named = useStore((st) => !!st.name)
  useEffect(() => {
    if (!named || wasSeen(id)) { setOn(false); return }
    const a = window.setTimeout(() => setOn(true), idDelay(id) + 400)
    const b = window.setTimeout(() => setOn(false), idDelay(id) + 400 + ms)
    return () => { clearTimeout(a); clearTimeout(b) }
  }, [id, ms, named])
  return on
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
const INTERACTIVE = 'button,a[href],input,select,textarea,[role=button],[tabindex]:not([tabindex="-1"]),[data-pad],[data-label]'
const hits = (a: DOMRect, b: DOMRect, gap = 4) => a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap
/** Does this rectangle cover any visible control (or the draw pad / a 3D label)? One look, no polling. */
function coversControl(r: DOMRect, mine: HTMLElement): boolean {
  if (mine.closest('[data-pad-wrap]')) return true // never over the pad
  for (const e of document.querySelectorAll<HTMLElement>(INTERACTIVE)) {
    if (mine.contains(e)) continue
    const b = e.getBoundingClientRect()
    if (b.width <= 0 || b.height <= 0) continue
    const s = getComputedStyle(e)
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity < 0.05) continue
    if (hits(r, b)) return true
  }
  return false
}

/** One bulb per stage, in a fixed corner (`placement`). Its card shows once on a first visit for ~5 s, but only when it
 *  covers no control and not the pad; after that the bulb alone stays: hover, focus or a click shows the card, and it
 *  goes when the pointer leaves (150 ms grace). Touch: tap opens, tap elsewhere closes. Esc closes. */
export function Explainer({ id, children, placement = 'top-right' }: { id: string; children: React.ReactNode; placement?: Corner }): React.ReactElement | null {
  useInjectedStyle('ns-expl', EXPL_CSS)
  useInjectedStyle('ns-inspector', INSPECTOR_CSS)
  const intro = useExplainerIntro(id)
  const [introOk, setIntroOk] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [tapped, setTapped] = useState(false)
  const open = (intro && introOk) || hover || tapped
  const uid = useId()
  const btn = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const place = useCallback(() => {
    const c = card.current, b = btn.current
    if (!c || !b) return
    const r = b.getBoundingClientRect(), w = c.offsetWidth, h = c.offsetHeight
    let left = placement.endsWith('left') ? r.left : r.right - w
    let top = placement.startsWith('top') ? r.bottom + 6 : r.top - h - 6
    if (top + h > innerHeight - 8) top = r.top - h - 6
    if (top < 8) top = r.bottom + 6
    left = clamp(left, 8, Math.max(8, innerWidth - w - 8))
    c.style.left = `${left}px`; c.style.top = `${top}px`; c.style.right = 'auto'; c.style.bottom = 'auto'
  }, [placement])
  const show = (c: HTMLDivElement) => { try { if (typeof (c as any).showPopover === 'function' && !c.matches(':popover-open')) (c as any).showPopover() } catch { /* shown */ } }
  const hide = (c: HTMLDivElement) => { try { if (typeof (c as any).hidePopover === 'function' && c.matches(':popover-open')) (c as any).hidePopover() } catch { /* hidden */ } }
  // the intro: measure the card where it would go (hidden), and show it only if it covers nothing you can use
  useLayoutEffect(() => {
    const c = card.current, w = wrap.current
    if (!intro || !c || !w) { setIntroOk(false); return }
    c.setAttribute('data-probe', ''); show(c); place()
    const ok = !coversControl(c.getBoundingClientRect(), w)
    c.removeAttribute('data-probe')
    if (!ok) hide(c)
    else markSeen(id)
    setIntroOk(ok)
  }, [intro, id, place])
  useLayoutEffect(() => {
    const c = card.current
    if (!c) return
    if (open) { show(c); c.setAttribute('data-open', ''); place() }
    else { c.removeAttribute('data-open'); hide(c) }
  }, [open, place])
  useEffect(() => {
    if (!open) return
    const re = () => place()
    window.addEventListener('resize', re); window.addEventListener('scroll', re, true)
    return () => { window.removeEventListener('resize', re); window.removeEventListener('scroll', re, true) }
  }, [open, place])
  useEffect(() => {
    if (!tapped && !hover) return
    const down = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) { setTapped(false); setHover(false) } }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setTapped(false); setHover(false) } }
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key) }
  }, [tapped, hover])
  useEffect(() => () => clearTimeout(timer.current), [])
  // once the visitor uses the bulb, the intro has done its job
  useEffect(() => { if (hover || tapped) markSeen(id) }, [hover, tapped, id])
  const enter = (e: React.PointerEvent) => { if (e.pointerType === 'touch') return; clearTimeout(timer.current); setHover(true) }
  const leave = (e: React.PointerEvent) => { if (e.pointerType === 'touch') return; clearTimeout(timer.current); timer.current = window.setTimeout(() => { setHover(false); setTapped(false) }, 150) }
  const arr = Children.toArray(children)
  const lines = arr.length > 1 && arr.every((c) => typeof c === 'string') ? arr.map((c, k) => <p key={k}>{c}</p>) : [children]
  return (
    <div ref={wrap} className="nsx-expl" data-p={placement}>
      <button ref={btn} type="button" className="nsx-ebulb" data-explainer-bulb={id} aria-label="What am I looking at?" aria-expanded={open} aria-controls={uid}
        onPointerEnter={enter} onPointerLeave={leave} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
        onClick={(e) => { if ((e.nativeEvent as PointerEvent).pointerType === 'touch') setTapped((t) => !t); else setTapped(true) }}><Bulb on={open} /></button>
      <div ref={card} id={uid} className="nsx-ecard" data-explainer={id} role="note" {...({ popover: 'manual' } as any)} data-p={placement}>
        {lines}
      </div>
    </div>
  )
}
