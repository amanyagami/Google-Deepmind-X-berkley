// The device report: everything this page can really read or has measured about the visitor's hardware, in one sheet.
// Every row says where its number comes from: "measured" (a test ran here), "live" (read right now), or "reported"
// (what the browser tells a page; some of it is rounded or capped by the browser, and the row says so).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHW, type TestResult } from '../hw/hwStore'
import { finalScore } from '../hw/score'
import { probe, type Capabilities } from '../hw/browserBench'
import { useStore } from '../store'
import { chartPaths, houseAt, STAR8 } from './Sky'

type Src = 'measured' | 'live' | 'reported'
interface Row { k: string; v: string; src: Src; note?: string }
interface Group { id: string; title: string; icon: string; hue: string; rows: Row[] }

const ICON: Record<string, string> = {
  cpu: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M7 5h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2zM9.5 9.5h5v5h-5z',
  gpu: 'M3 7h15a2 2 0 012 2v7H3zM3 5v14M7 16v3M11 16v3M15 16v3M9 11.5a2 2 0 104 0 2 2 0 00-4 0',
  mem: 'M3 8h18v8H3zM6 16v3M10 16v3M14 16v3M18 16v3M7 11v2M11 11v2M15 11v2',
  display: 'M3 4h18v12H3zM8 20h8M12 16v4',
  disk: 'M4 5h16v14H4zM4 14h16M8 17h.01M12 17h.01',
  net: 'M2 9a15 15 0 0120 0M5.5 12.5a10 10 0 0113 0M9 16a5 5 0 016 0M12 19.5h.01',
  power: 'M13 2L4 14h7l-1 8 9-12h-7z',
  soft: 'M4 5h16v14H4zM4 9h16M7 7h.01M10 7h.01',
  ai: 'M12 3l2.2 5.3L20 10l-5.8 1.7L12 17l-2.2-5.3L4 10l5.8-1.7zM18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z',
}
const PILLARS: { id: string; label: string; hue: string }[] = [
  { id: 'compute', label: 'CPU', hue: 'var(--p-compute)' }, { id: 'memory', label: 'Memory', hue: 'var(--p-memory)' },
  { id: 'gpu', label: 'GPU', hue: 'var(--p-gpu)' }, { id: 'storage', label: 'Storage', hue: 'var(--p-storage)' }, { id: 'model', label: 'Model', hue: 'var(--p-model)' },
]

const num = (v: number, d = 1) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(d))
const bytes = (b: number) => (b >= 2 ** 30 ? `${num(b / 2 ** 30)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`)
const yes = (b: boolean | null | undefined) => (b == null ? 'unknown' : b ? 'yes' : 'no')
const val = (r?: TestResult) => (r && r.value > 0 && !r.flags.includes('cancelled') ? `${num(r.value)} ${r.unit}` : null)

/** The screen's refresh rate, measured from 40 frames (rounded to the nearest common rate). */
function useRefreshRate(): number | null {
  const [hz, setHz] = useState<number | null>(null)
  useEffect(() => {
    let raf = 0, n = 0, t0 = 0, live = true
    const tick = (t: number) => {
      if (!live) return
      if (!n) t0 = t
      if (++n > 40) { const raw = (40 * 1000) / (t - t0); const snap = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240].reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a)); setHz(Math.abs(snap - raw) / snap < 0.06 ? snap : Math.round(raw)); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { live = false; cancelAnimationFrame(raf) }
  }, [])
  return hz
}

/** Operating system, browser and chip architecture, from the browser's own high-detail hints where it has them. */
function useSoftware() {
  const [s, setS] = useState<{ os: string; browser: string; arch: string | null; model: string | null }>(() => {
    const ua = navigator.userAgent
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown system'
    const m = /(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(ua)
    const name = m ? ({ Edg: 'Edge', OPR: 'Opera', Version: 'Safari' } as Record<string, string>)[m[1]] ?? m[1] : 'Browser'
    return { os, browser: m ? `${name} ${m[2]}` : name, arch: null, model: null }
  })
  useEffect(() => {
    let live = true
    const d = (navigator as any).userAgentData
    d?.getHighEntropyValues?.(['platform', 'platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']).then((h: any) => {
      if (!live || !h) return
      let os = h.platform || ''
      const major = parseInt(String(h.platformVersion ?? '').split('.')[0], 10)
      // Windows reports 13 and up for Windows 11, lower numbers for Windows 10
      if (os === 'Windows' && Number.isFinite(major)) os = major >= 13 ? 'Windows 11' : major > 0 ? 'Windows 10' : 'Windows'
      else if (h.platformVersion) os = `${os} ${String(h.platformVersion).split('.').slice(0, 2).join('.')}`
      const b = (h.fullVersionList as { brand: string; version: string }[] | undefined)?.filter((x) => !/not.?a.?brand/i.test(x.brand)).sort((a, c) => (/chromium/i.test(a.brand) ? 1 : 0) - (/chromium/i.test(c.brand) ? 1 : 0))[0]
      setS((p) => ({ os: os || p.os, browser: b ? `${b.brand.replace('Microsoft ', '')} ${b.version.split('.')[0]}` : p.browser, arch: h.architecture ? `${h.architecture}${h.bitness ? `, ${h.bitness}-bit` : ''}` : null, model: h.model || null }))
    }).catch(() => { /* low-detail values stay */ })
    return () => { live = false }
  }, [])
  return s
}

function buildGroups(caps: Capabilities | null, res: Record<string, TestResult>, bl: any, hz: number | null, soft: ReturnType<typeof useSoftware>): Group[] {
  const g: Group[] = []
  const threads = caps?.cores ?? navigator.hardwareConcurrency ?? null
  const cpu: Row[] = []
  if (threads) cpu.push({ k: 'Threads', v: String(threads), src: 'reported', note: 'Logical processors. Browsers do not reveal the chip model.' })
  if (soft.arch) cpu.push({ k: 'Architecture', v: soft.arch, src: 'reported' })
  const c1 = val(res.cpu1), cn = val(res.cpun)
  if (c1) cpu.push({ k: 'One core', v: c1, src: 'measured' })
  if (cn) cpu.push({ k: 'All cores', v: cn, src: 'measured' })
  if (c1 && cn && res.cpu1.value > 0) cpu.push({ k: 'Scaling', v: `${(res.cpun.value / res.cpu1.value).toFixed(1)}× one core`, src: 'measured' })
  if (bl?.cpu != null) cpu.push({ k: 'Busy now', v: `about ${bl.cpu}%`, src: 'live', note: 'Estimated from how fast a small fixed job runs.' })
  if (caps) cpu.push({ k: 'Wide vector math', v: caps.simd ? 'yes (WebAssembly SIMD)' : 'no', src: 'reported' })
  g.push({ id: 'cpu', title: 'Processor', icon: ICON.cpu, hue: 'var(--p-compute)', rows: cpu })

  const gp: Row[] = []
  if (caps?.gpu.adapter) gp.push({ k: 'Chip', v: caps.gpu.adapter, src: 'reported' })
  if (caps) gp.push({ k: 'WebGPU', v: caps.gpu.available ? (caps.gpu.software ? 'software only (slow)' : 'yes') : 'not in this browser', src: 'reported' })
  if (caps?.gpu.available) {
    gp.push({ k: 'Half-size numbers', v: yes(caps.gpu.f16), src: 'reported', note: 'Lets models use half the memory on the graphics chip.' })
    if (caps.gpu.maxBuffer) gp.push({ k: 'Largest block', v: bytes(caps.gpu.maxBuffer), src: 'reported', note: 'The biggest single piece of data a page may put on the graphics chip.' })
  }
  const gv = val(res.gpu); if (gv) gp.push({ k: 'Math speed', v: gv, src: 'measured' })
  g.push({ id: 'gpu', title: 'Graphics', icon: ICON.gpu, hue: 'var(--p-gpu)', rows: gp })

  const mem: Row[] = []
  const dm = caps?.deviceMemoryGB ?? (navigator as any).deviceMemory ?? null
  if (dm) mem.push({ k: 'Fitted', v: dm >= 8 ? '8 GB or more' : `about ${dm} GB`, src: 'reported', note: 'Browsers round this and never report more than 8 GB.' })
  if (bl?.memBytes) mem.push({ k: 'This page uses', v: bytes(bl.memBytes), src: 'live' })
  const rv = val(res.ram), cv = val(res.cache)
  if (rv) mem.push({ k: 'Memory speed', v: rv, src: 'measured' })
  if (cv) mem.push({ k: 'Cache speed', v: cv, src: 'measured' })
  g.push({ id: 'mem', title: 'Memory', icon: ICON.mem, hue: 'var(--p-memory)', rows: mem })

  const dpr = window.devicePixelRatio || 1
  const disp: Row[] = [
    { k: 'Resolution', v: `${Math.round(screen.width * dpr)} × ${Math.round(screen.height * dpr)}`, src: 'reported' },
    { k: 'Pixel density', v: `${+dpr.toFixed(2)}×`, src: 'reported' },
  ]
  if (hz) disp.push({ k: 'Refresh rate', v: `${hz} Hz`, src: 'measured' })
  const gamut = matchMedia('(color-gamut: rec2020)').matches ? 'very wide (Rec. 2020)' : matchMedia('(color-gamut: p3)').matches ? 'wide (P3)' : 'standard (sRGB)'
  disp.push({ k: 'Colour range', v: gamut, src: 'reported' })
  disp.push({ k: 'HDR', v: yes(matchMedia('(dynamic-range: high)').matches), src: 'reported' })
  if (navigator.maxTouchPoints > 0) disp.push({ k: 'Touch', v: `${navigator.maxTouchPoints} points`, src: 'reported' })
  g.push({ id: 'display', title: 'Display', icon: ICON.display, hue: 'var(--brand-2)', rows: disp })

  const st: Row[] = []
  const quota = bl?.storQuota ?? caps?.opfs.quotaBytes ?? null
  if (quota) st.push({ k: 'Room for this page', v: bytes(quota), src: 'reported', note: 'What the browser lets this site save, not the size of the drive.' })
  if (bl?.storUsage != null) st.push({ k: 'Saved so far', v: bytes(bl.storUsage), src: 'live' })
  const sv = val(res.storage); if (sv) st.push({ k: 'Speed', v: sv, src: 'measured' })
  if (caps) st.push({ k: 'Fast file access', v: yes(caps.opfs.available), src: 'reported' })
  g.push({ id: 'disk', title: 'Storage', icon: ICON.disk, hue: 'var(--p-storage)', rows: st })

  const conn = (navigator as any).connection
  const net: Row[] = [{ k: 'Online', v: yes(navigator.onLine), src: 'live' }]
  if (conn?.effectiveType) net.push({ k: 'Link quality', v: String(conn.effectiveType).toUpperCase(), src: 'reported', note: 'The browser\'s own rough class, capped at 4G.' })
  if (conn?.downlink) net.push({ k: 'Speed estimate', v: `${conn.downlink >= 10 ? '10 Mbit/s or more' : `${conn.downlink} Mbit/s`}`, src: 'reported' })
  if (conn?.rtt != null) net.push({ k: 'Round trip', v: `${conn.rtt} ms`, src: 'reported' })
  if (conn?.saveData) net.push({ k: 'Data saver', v: 'on', src: 'reported' })
  g.push({ id: 'net', title: 'Network', icon: ICON.net, hue: 'var(--neg)', rows: net })

  const bat = bl?.battery ?? caps?.battery ?? null
  g.push({ id: 'power', title: 'Power', icon: ICON.power, hue: 'var(--pos)', rows: bat
    ? [{ k: 'Battery', v: `${Math.round(bat.level * 100)}%`, src: 'live' }, { k: 'Charging', v: yes(bat.charging), src: 'live' }]
    : [{ k: 'Battery', v: 'none reported', src: 'reported', note: 'A desktop, or a browser that hides the battery.' }] })

  const sw: Row[] = [{ k: 'System', v: soft.os, src: 'reported' }, { k: 'Browser', v: soft.browser, src: 'reported' }]
  if (soft.model) sw.push({ k: 'Model', v: soft.model, src: 'reported' })
  if (caps) sw.push({ k: 'Isolated page', v: yes(caps.isolated), src: 'reported', note: 'Needed for many threads and precise timers.' })
  g.push({ id: 'soft', title: 'Software', icon: ICON.soft, hue: 'var(--est)', rows: sw })

  const model = Object.values(res).filter((r) => r.component.startsWith('model:') && r.value > 0)[0]
  const ai: Row[] = []
  if (caps) ai.push({ k: 'Models run on', v: caps.gpu.available && !caps.gpu.software ? 'the graphics chip (WebGPU)' : 'the processor (WebAssembly)', src: 'reported' })
  if (model) ai.push({ k: 'Language model speed', v: `${num(model.value)} ${model.unit}`, src: 'measured', note: String(model.component).replace('model:', '') })
  if (ai.length) g.push({ id: 'ai', title: 'AI on this device', icon: ICON.ai, hue: 'var(--p-model)', rows: ai })
  return g.filter((x) => x.rows.length)
}

/** A number that counts up once (at once when motion is reduced). */
function Count({ to }: { to: number }) {
  const [n, setN] = useState(() => (matchMedia('(prefers-reduced-motion: reduce)').matches ? to : 0))
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setN(to); return }
    let raf = 0, t0 = 0
    const tick = (t: number) => { if (!t0) t0 = t; const k = Math.min(1, (t - t0) / 1100); setN(Math.round(to * (1 - Math.pow(1 - k, 4)))); if (k < 1) raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to])
  return <>{n.toLocaleString('en-US')}</>
}

interface House { k: string; v: string; hue?: string }
/** The device as a chart: the square, its diagonals and the inner diamond make twelve houses. The four diamonds hold the
 *  four hardware scores; the eight corners hold what the browser reports; the score sits in the middle. */
function Chart({ score, houses, label }: { score: number | null; houses: House[]; label: string }) {
  const H = 200, [sq, dg, dm] = chartPaths(H)
  return (
    <svg className="dr-chart" viewBox="-224 -224 448 448" role="img" aria-label={label}>
      <defs><linearGradient id="dr-g" x1={-H} y1={-H} x2={H} y2={H} gradientUnits="userSpaceOnUse"><stop offset="0" className="k-g1" stopColor="#f6dfae" /><stop offset=".55" className="k-g2" stopColor="#ffb454" /><stop offset="1" className="k-g3" stopColor="#ff7d5a" /></linearGradient></defs>
      <rect className="c-frame" x="-216" y="-216" width="432" height="432" />
      <path className="c-ln" pathLength={1} d={sq} /><path className="c-ln thin d2" pathLength={1} d={dg} /><path className="c-ln d3" pathLength={1} d={dm} />
      {[[-H, -H], [H, -H], [H, H], [-H, H], [0, -H], [H, 0], [0, H], [-H, 0]].map(([x, y], i) => <circle key={i} className="c-dot" cx={x} cy={y} r={i < 4 ? 2.4 : 3.4} />)}
      {houses.map((h, i) => {
        const big = i % 3 === 0, [hx, y] = houseAt(i, H), x = Math.abs(hx) > H * 0.8 ? hx * 0.94 : hx   // the four side corners sit a little inward
        return (
          <g key={i} className="c-h" style={{ animationDelay: `${600 + i * 60}ms` }}>
            <text className="c-k" x={x} y={y - (big ? 21 : 6)} style={h.hue ? { fill: h.hue } : undefined}>{h.k}</text>
            <text className={big ? 'c-v big' : 'c-v'} x={x} y={y + (big ? 15 : 12)}>{h.v}</text>
          </g>
        )
      })}
      <circle className="c-core" r="47" />
      {score != null ? <text className="c-score" y="11">{score.toLocaleString('en-US')}</text> : <path className="c-star" d={STAR8(22)} />}
    </svg>
  )
}

const SRC_WORD: Record<Src, string> = { measured: 'measured', live: 'live', reported: 'reported' }

export default function DeviceReport({ onClose }: { onClose: () => void }) {
  const caps = useHW((s) => s.caps), res = useHW((s) => s.results), bl = useHW((s) => s.bl)
  const name = useStore((s) => s.name)
  const hz = useRefreshRate(), soft = useSoftware()
  const box = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!useHW.getState().caps) probe().then((c) => useHW.getState().setCaps(c)).catch(() => { /* rows that need it stay out */ }) }, [])
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    box.current?.focus()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('keydown', esc, true); prev?.focus?.() }
  }, [onClose])
  // live rows refresh once a second, not on every sample
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  const blNow = useMemo(() => useHW.getState().bl, [tick, bl == null])   // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => buildGroups(caps, res, blNow, hz, soft), [caps, res, blNow, hz, soft])
  const fin = useMemo(() => { try { const f = finalScore(res); return f.score > 0 && f.coverage.ran >= 3 ? f : null } catch { return null } }, [res])
  const title = caps?.gpu.adapter || soft.model || 'This device'
  const measured = groups.reduce((a, x) => a + x.rows.filter((r) => r.src === 'measured').length, 0)
  const copy = () => {
    const text = [`${name ? `${name}'s device` : 'Device'} · Kundali`, fin ? `Score ${Math.round(fin.score)} (${fin.tier})` : '', ...groups.flatMap((x) => ['', x.title, ...x.rows.map((r) => `  ${r.k}: ${r.v} (${SRC_WORD[r.src]})`)])].join('\n')
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }).catch(() => { /* clipboard blocked */ })
  }
  const houses = useMemo<House[]>(() => {
    const pil = (id: string) => { const row = fin?.pillars.find((x) => x.id === id); return !fin ? '—' : row && row.score != null && (row.status === 'measured' || row.status === 'imputed') ? Math.round(row.score).toLocaleString('en-US') : row?.status === 'unavailable' ? 'n/a' : '—' }
    const dpr = window.devicePixelRatio || 1, conn = (navigator as any).connection
    const threads = caps?.cores ?? navigator.hardwareConcurrency
    return [
      { k: 'CPU', v: pil('compute'), hue: 'var(--p-compute)' },
      { k: 'System', v: soft.os },
      { k: 'Threads', v: threads ? String(threads) : '—' },
      { k: 'Memory', v: pil('memory'), hue: 'var(--p-memory)' },
      { k: 'Refresh', v: hz ? `${hz} Hz` : '—' },
      { k: 'Screen', v: `${Math.round(screen.width * dpr)} × ${Math.round(screen.height * dpr)}` },
      { k: 'Storage', v: pil('storage'), hue: 'var(--p-storage)' },
      fin ? { k: 'Model', v: pil('model'), hue: 'var(--p-model)' } : { k: 'Engine', v: caps ? (caps.gpu.available && !caps.gpu.software ? 'WebGPU' : 'WebAssembly') : '—' },
      { k: 'Link', v: conn?.effectiveType ? String(conn.effectiveType).toUpperCase() : navigator.onLine ? 'Online' : 'Offline' },
      { k: 'GPU', v: pil('gpu'), hue: 'var(--p-gpu)' },
      { k: 'Density', v: `${+dpr.toFixed(2)}×` },
      { k: 'Browser', v: soft.browser },
    ]
  }, [fin, caps, soft, hz])
  return (
    <div className="dr-wall" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="dr" role="dialog" aria-modal="true" aria-labelledby="dr-t" data-device-report tabIndex={-1} ref={box}>
        <header className="dr-head">
          <div className="dr-id">
            <p className="dr-eyebrow">Your device</p>
            <h3 id="dr-t">{title}</h3>
            <p className="dr-sub">{[soft.os, soft.browser, caps ? `${caps.cores} threads` : null].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="dr-act">
            <button type="button" className="t5-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="t5-btn" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="dr-scroll">
          <div className="dr-hero">
            <Chart score={fin ? Math.round(fin.score) : null} houses={houses} label={fin ? `Your device chart. Score ${Math.round(fin.score)}, ${fin.tier}.` : 'Your device chart. Not tested yet.'} />
            <div className="dr-read">
              {fin
                ? <>
                  <p className="dr-k">Device score</p>
                  <p className="dr-score"><b><Count to={Math.round(fin.score)} /></b><em>{fin.tier}</em></p>
                  <div className="dr-pillars">
                    {PILLARS.map((p) => { const row = fin.pillars.find((x) => x.id === p.id), sc = row?.status === 'measured' || row?.status === 'imputed' ? row.score : null
                      return (
                        <div className="dr-pill" key={p.id}>
                          <span className="dr-pl">{p.label}</span>
                          <span className="dr-bar"><i style={{ width: `${sc ? Math.max(3, Math.min(100, (sc / 2000) * 100)) : 0}%`, background: p.hue }} /></span>
                          <b className="mono">{sc ? Math.round(sc).toLocaleString('en-US') : row?.status === 'unavailable' ? 'n/a' : '—'}</b>
                        </div>
                      ) })}
                  </div>
                  <p className="dr-foot">1,000 is the reference PC. {measured} measured values below.</p>
                </>
                : <>
                  <p className="dr-k">Not tested yet</p>
                  <p className="dr-lead">This chart is half read. Test your system to fill the four scores.</p>
                  <button type="button" className="t5-btn pri" data-report-test onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ns-test-all')) }}>Test your system</button>
                </>}
            </div>
          </div>
          <div className="dr-grid">
            {groups.map((x, i) => (
              <article className="dr-card" key={x.id} style={{ ['--hue' as any]: x.hue, animationDelay: `${60 + i * 35}ms` }}>
                <h4><span className="dr-ico" aria-hidden><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={x.icon} /></svg></span>{x.title}</h4>
                <dl>
                  {x.rows.map((r) => (
                    <div className="dr-row" key={r.k} title={r.note}>
                      <dt>{r.k}{r.note && <small>{r.note}</small>}</dt>
                      <dd><span>{r.v}</span><i className={`dr-src ${r.src}`}>{SRC_WORD[r.src]}</i></dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
          <p className="dr-note"><b>measured</b> a test ran on this device · <b>live</b> read right now · <b>reported</b> what the browser tells a page. All of it stays on your device; only your name and score go on the leaderboard.</p>
        </div>
      </section>
      <style>{CSS}</style>
    </div>
  )
}

const CSS = `
.dr-wall{position:fixed;inset:0;z-index:96;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--bg) 74%,transparent);backdrop-filter:blur(12px) saturate(120%);-webkit-backdrop-filter:blur(12px) saturate(120%);animation:ns-fade .2s var(--ease,ease) both}
.dr{width:min(1000px,100%);max-height:min(92dvh,960px);display:flex;flex-direction:column;overflow:hidden;color:var(--fg);background:linear-gradient(var(--glass-heavy,var(--panel)),var(--glass-heavy,var(--panel))) padding-box,linear-gradient(150deg,color-mix(in srgb,var(--gold) 70%,var(--line)),var(--line) 30%,var(--line) 70%,color-mix(in srgb,var(--gold) 40%,var(--line))) border-box;backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);border:1px solid transparent;border-radius:24px;box-shadow:var(--sh-2),0 0 120px -30px var(--glow,transparent);animation:dr-in .5s var(--ease-out,ease) both;outline:none}
@keyframes dr-in{from{opacity:0;transform:translateY(18px) scale(.985)}}
.dr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:20px 22px 14px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)}
.dr-id{min-width:0}
.dr-eyebrow{margin:0 0 6px;font:500 11px var(--mono);letter-spacing:.22em;text-transform:uppercase;color:var(--gold)}
.dr-head h3{margin:0;font:400 32px/1.08 var(--serif);letter-spacing:-.005em;overflow-wrap:anywhere}
.dr-sub{margin:4px 0 0;color:var(--muted);font-size:13px}
.dr-act{display:flex;gap:8px;flex:none}
.dr-scroll{overflow:auto;padding:18px 22px 22px;display:grid;gap:18px;overscroll-behavior:contain}
.dr-hero{display:grid;grid-template-columns:minmax(0,400px) minmax(0,1fr);gap:clamp(18px,4vw,44px);align-items:center;padding:clamp(14px,2.4vw,26px);border-radius:20px;border:1px solid color-mix(in srgb,var(--gold) 26%,var(--line));background:radial-gradient(520px circle at 22% 46%,color-mix(in srgb,var(--gold-2) 10%,transparent),transparent 70%),color-mix(in srgb,var(--surface) 60%,transparent)}
.dr-chart{width:100%;height:auto;display:block;overflow:visible}
.dr-chart text{text-anchor:middle}
.c-frame{fill:none;stroke:var(--gold);stroke-width:1;opacity:.28;vector-effect:non-scaling-stroke}
.c-ln{fill:none;stroke:url(#dr-g);stroke-width:1.5;stroke-linejoin:round;vector-effect:non-scaling-stroke;stroke-dasharray:1;animation:c-draw 1.5s var(--ease-out,ease) both}
.c-ln.thin{stroke-width:1;opacity:.7}.c-ln.d2{animation-delay:.25s}.c-ln.d3{animation-delay:.45s}
@keyframes c-draw{from{stroke-dashoffset:1}}
.c-dot{fill:var(--gold-2)}
.c-h{animation:c-pop .7s var(--ease-out,ease) both}
@keyframes c-pop{from{opacity:0}}
.c-k{font:500 10.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;fill:var(--muted)}
.c-v{font:550 14.5px var(--body);fill:var(--fg);font-variant-numeric:tabular-nums}
.c-v.big{font:400 36px var(--serif);letter-spacing:-.01em}
.c-core{fill:var(--panel);stroke:url(#dr-g);stroke-width:1.5;vector-effect:non-scaling-stroke;filter:drop-shadow(0 0 16px color-mix(in srgb,var(--gold-2) 55%,transparent))}
.c-score{font:400 31px var(--serif);fill:var(--fg);font-variant-numeric:tabular-nums}
.c-star{fill:var(--gold-2);opacity:.9;animation:c-breathe 2.4s ease-in-out infinite alternate}
@keyframes c-breathe{from{opacity:.35}}
.dr-read{display:grid;gap:10px;min-width:0;align-content:center}
.dr-k{margin:0;font:500 11px var(--mono);letter-spacing:.22em;text-transform:uppercase;color:var(--gold)}
.dr-score{margin:0;display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 16px}
.dr-score b{font:400 clamp(72px,9vw,112px)/.9 var(--serif);letter-spacing:-.02em;background:var(--brand);-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.dr-score em{font:italic 400 clamp(26px,3vw,36px)/1 var(--serif);color:var(--fg)}
.dr-lead{margin:0;font:400 clamp(24px,2.6vw,32px)/1.18 var(--serif);color:var(--fg);max-width:20ch}
.dr-read .t5-btn.pri{justify-self:start;margin-top:8px;min-height:46px;padding:0 22px;border-radius:999px}
.dr-pillars{display:grid;gap:8px;min-width:0;margin-top:6px}
.dr-pill{display:grid;grid-template-columns:64px minmax(0,1fr) 52px;align-items:center;gap:10px;font-size:13px}
.dr-pl{color:var(--muted)}
.dr-pill b{text-align:right;font-size:13px}
.dr-bar{height:4px;border-radius:99px;background:color-mix(in srgb,var(--fg) 10%,transparent);overflow:hidden}
.dr-bar i{display:block;height:100%;border-radius:99px;transform-origin:left;animation:dr-grow .7s var(--ease,ease) both}
@keyframes dr-grow{from{transform:scaleX(0)}}
.dr-foot{margin:4px 0 0;font-size:12px;color:var(--muted)}
.dr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.dr-card{--hue:var(--brand-1);position:relative;padding:16px 16px 8px;border-radius:16px;border:1px solid color-mix(in srgb,var(--fg) 9%,transparent);background:color-mix(in srgb,var(--fg) 2.5%,transparent);animation:ns-up .4s var(--ease,ease) both;transition:border-color var(--d2,220ms) ease,background-color var(--d2,220ms) ease}
.dr-card:hover{border-color:color-mix(in srgb,var(--hue) 46%,transparent);background:color-mix(in srgb,var(--hue) 4%,transparent)}
.dr-card h4{display:flex;align-items:center;gap:10px;margin:0 0 10px;font:400 22px/1 var(--serif);letter-spacing:0}
.dr-ico{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;color:var(--hue);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--hue) 45%,transparent)}
.dr-card dl{margin:0;display:grid}
.dr-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid color-mix(in srgb,var(--line) 50%,transparent)}
.dr-row dt{color:var(--muted);font-size:13px;min-width:0;flex:0 1 46%}
.dr-row dt small{display:block;font-size:11.5px;line-height:1.35;color:var(--faint);margin-top:2px}
.dr-row dd{margin:0;display:flex;flex-direction:column;align-items:flex-end;gap:3px;text-align:right;min-width:0;flex:1 1 54%;font:600 13px var(--body);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dr-src{font:500 9.5px var(--mono);font-style:normal;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;border-radius:99px;color:var(--faint);border:1px solid color-mix(in srgb,var(--fg) 14%,transparent)}
.dr-src.measured{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent);background:color-mix(in srgb,var(--ok) 9%,transparent)}
.dr-src.live{color:var(--neg-ink);border-color:color-mix(in srgb,var(--neg) 45%,transparent);background:color-mix(in srgb,var(--neg) 9%,transparent)}
.dr-note{margin:0;font-size:12.5px;line-height:1.55;color:var(--muted)}
.dr-note b{color:var(--fg);font-weight:600}
@media (max-width:640px){
.dr-wall{place-items:end stretch;padding:0}
.dr{width:min(1000px,100%);max-height:min(92dvh,960px);display:flex;flex-direction:column;overflow:hidden;color:var(--fg);background:linear-gradient(var(--glass-heavy,var(--panel)),var(--glass-heavy,var(--panel))) padding-box,linear-gradient(150deg,color-mix(in srgb,var(--gold) 70%,var(--line)),var(--line) 30%,var(--line) 70%,color-mix(in srgb,var(--gold) 40%,var(--line))) border-box;backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);border:1px solid transparent;border-radius:24px;box-shadow:var(--sh-2),0 0 120px -30px var(--glow,transparent);animation:dr-in .5s var(--ease-out,ease) both;outline:none}
@keyframes dr-in{from{opacity:0;transform:translateY(18px) scale(.985)}}
.dr-head{padding:16px 16px 12px}.dr-head h3{font-size:19px}
.dr-scroll{padding:14px 14px 18px;gap:14px}
.dr-hero{grid-template-columns:1fr;gap:16px;padding:14px}.dr-read{justify-items:center;text-align:center}.dr-score{justify-content:center}.dr-read .t5-btn.pri{justify-self:center}.dr-head h3{font-size:25px}
.dr-pillars{width:100%;text-align:left}
.dr-grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){.dr,.dr-wall,.dr-card,.dr-bar i,.c-ln,.c-h,.c-star{animation:none}}
`
