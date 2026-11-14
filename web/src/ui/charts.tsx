import { useEffect, useRef } from 'react'

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

export function Spark({ values, height = 44, label }: { values: number[]; height?: number; label: string }) {
  const m = Math.max(1e-9, ...values)
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${height - 3 - (v / m) * (height - 8)}`).join(' ')
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="spark" style={{ height }} role="img" aria-label={label}>
      <polyline points={`0,${height} ${pts} 100,${height}`} fill="color-mix(in srgb, var(--pos) 18%, transparent)" stroke="none" />
      <polyline points={pts} fill="none" stroke="var(--pos)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
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
