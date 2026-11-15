import { useId, useMemo } from 'react'

/** The Kundali mark: a North-Indian birth chart (square, both diagonals, inner diamond, vertex dots and a central star). */
export function KundaliLogo({ size = 20 }: { size?: number }) {
  const uid = useId().replace(/:/g, '')
  const gid = `ns-lg-${uid}`, cid = `ns-lc-${uid}`
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <defs>
        <linearGradient id={gid} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="k-g1" stopColor="#f6dfae" /><stop offset=".55" className="k-g2" stopColor="#ffb454" /><stop offset="1" className="k-g3" stopColor="#ff7d5a" />
        </linearGradient>
        <linearGradient id={cid} x1="8" y1="8" x2="16" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff6e2" /><stop offset=".5" stopColor="#ffc071" /><stop offset="1" className="k-g3" stopColor="#ff7d5a" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="2.2" stroke={`url(#${gid})`} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2.6 2.6l18.8 18.8M21.4 2.6L2.6 21.4" stroke={`url(#${gid})`} strokeOpacity=".7" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M12 2L22 12 12 22 2 12z" stroke={`url(#${gid})`} strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M12 8.2l1.15 2.65L15.8 12l-2.65 1.15L12 15.8l-1.15-2.65L8.2 12l2.65-1.15z" fill={`url(#${cid})`} />
    </svg>
  )
}

/** A small seeded generator: the sky is the same on every visit. */
const rng = (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

/** Three layers of stars. Each layer is its own element, so its slow twinkle costs no repaint. */
export function Stars() {
  const layers = useMemo(() => {
    const r = rng(11)
    return [110, 54, 22].map((n, k) => Array.from({ length: n }, () => [r() * 1600, r() * 1000, [0.55, 0.9, 1.35][k] * (0.6 + r() * 0.8), 0.3 + r() * 0.7] as const))
  }, [])
  return (
    <>
      {layers.map((pts, k) => (
        <svg key={k} className={`kx-stars s${k}`} viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden>
          {pts.map(([x, y, rad, o], i) => <circle key={i} cx={x.toFixed(0)} cy={y.toFixed(0)} r={rad.toFixed(2)} fill="currentColor" opacity={o.toFixed(2)} />)}
        </svg>
      ))}
    </>
  )
}

/** Where the twelve houses of a North-Indian chart sit, for a square of half-size h centred on 0,0. House 1 is the top diamond;
 *  the count runs counter-clockwise. Houses 1, 4, 7 and 10 are the four diamonds; the other eight are the corner triangles. */
export const houseAt = (i: number, h: number): [number, number] => {
  const a = h / 2, b = (h * 5) / 6
  return ([[0, -a], [-a, -b], [-b, -a], [-a, 0], [-b, a], [-a, b], [0, a], [a, b], [b, a], [a, 0], [b, -a], [a, -b]] as [number, number][])[i]
}
export const chartPaths = (h: number) => [`M${-h} ${-h}H${h}V${h}H${-h}Z`, `M${-h} ${-h}L${h} ${h}M${h} ${-h}L${-h} ${h}`, `M0 ${-h}L${h} 0L0 ${h}L${-h} 0Z`]
export const STAR8 = (r: number, q = 0.34) => { let d = ''; for (let k = 0; k < 8; k++) { const R = k % 2 ? r * q : r, t = (k * Math.PI) / 4 - Math.PI / 2; d += `${k ? 'L' : 'M'}${(R * Math.cos(t)).toFixed(2)} ${(R * Math.sin(t)).toFixed(2)}` } return d + 'Z' }

const PARTS = ['Processor', 'Graphics', 'Memory', 'Cache', 'Storage', 'Model', 'Screen', 'Network', 'Power', 'Threads', 'Browser', 'System']
const pol = (r: number, deg: number) => { const t = (deg * Math.PI) / 180; return [r * Math.cos(t), r * Math.sin(t)] as const }

/** The opening screen's instrument: a degree ring, the twelve parts the page reads, and the chart itself in the middle.
 *  Three rings of markers turn slowly. Each turning ring is its own element, so the motion never repaints the drawing. */
export function Astrolabe() {
  const ticks = useMemo(() => {
    let d = ''
    for (let a = 0; a < 360; a += 2) { const [x1, y1] = pol(492, a), [x2, y2] = pol(a % 30 === 0 ? 452 : a % 10 === 0 ? 470 : 480, a); d += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}` }
    return d
  }, [])
  const H = 290, [sq, dg, dm] = chartPaths(H)
  const vb = '-500 -500 1000 1000'
  const dot = (r: number, deg: number, size: number, cls: string) => { const [x, y] = pol(r, deg); return <g key={`${r}-${deg}`} className={cls}><circle cx={x} cy={y} r={size * 2.6} className="halo" /><circle cx={x} cy={y} r={size} /></g> }
  return (
    <div className="kx-astro" aria-hidden>
      <svg className="kx-a kx-a0" viewBox={vb}>
        <defs>
          <radialGradient id="kx-core"><stop offset="0" stopColor="#ffc071" stopOpacity=".5" /><stop offset=".45" stopColor="#ffb454" stopOpacity=".12" /><stop offset="1" stopColor="#ffb454" stopOpacity="0" /></radialGradient>
          <linearGradient id="kx-g" x1="-290" y1="-290" x2="290" y2="290" gradientUnits="userSpaceOnUse"><stop offset="0" className="k-g1" stopColor="#f6dfae" /><stop offset=".55" className="k-g2" stopColor="#ffb454" /><stop offset="1" className="k-g3" stopColor="#ff7d5a" /></linearGradient>
        </defs>
        <circle r="492" className="ln" /><path d={ticks} className="tk" /><circle r="452" className="ln" />
        {PARTS.map((t, i) => <text key={t} className="lb" transform={`rotate(${i * 30 + 15}) translate(0 -426)`} textAnchor="middle">{t}</text>)}
        {PARTS.map((_, i) => { const [x1, y1] = pol(452, i * 30 - 90), [x2, y2] = pol(410, i * 30 - 90); return <path key={i} className="ln" d={`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`} /> })}
        <circle r="410" className="ln draw" pathLength={1} />
        <circle r="290" className="ln dim" /><circle r="205" className="ln dim" />
        <circle r="150" fill="url(#kx-core)" />
        <path className="ch draw" pathLength={1} d={sq} /><path className="ch thin draw d2" pathLength={1} d={dg} /><path className="ch draw d3" pathLength={1} d={dm} />
        {PARTS.map((_, i) => { const [x, y] = houseAt(i, H); return <text key={i} className="hn" x={x} y={y + 11} textAnchor="middle">{i + 1}</text> })}
        <path className="bindu" d={STAR8(30)} />
      </svg>
      <div className="kx-a kx-a1"><svg viewBox={vb}>{dot(290, 18, 7, 'p1')}{dot(290, 148, 5, 'p2')}{dot(290, 262, 4, 'p4')}</svg></div>
      <div className="kx-a kx-a2"><svg viewBox={vb}>{dot(205, 80, 5.5, 'p3')}{dot(205, 215, 4, 'p1')}{dot(205, 330, 3.2, 'p4')}</svg></div>
      <div className="kx-a kx-a3"><svg viewBox={vb}><circle r="352" className="dash" /><path className="ptr" transform="rotate(-58)" d="M0 -500l9 16h-18z" />{dot(352, 205, 3.4, 'p2')}{dot(352, 20, 2.6, 'p4')}</svg></div>
    </div>
  )
}
