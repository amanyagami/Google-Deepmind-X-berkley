// The device report: everything this page can really read or has measured about the visitor's hardware, in one sheet.
// Every row says where its number comes from: "measured" (a test ran here), "live" (read right now), or "reported"
// (what the browser tells a page; some of it is rounded or capped by the browser, and the row says so).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHW, type TestResult } from '../hw/hwStore'
import { finalScore, tierOf } from '../hw/score'
import { probe, type Capabilities } from '../hw/browserBench'
import { useStore } from '../store'

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
  const R = 52, C = 2 * Math.PI * R, frac = fin ? Math.min(1, fin.score / 2000) : 0
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
            <div className="dr-ring" role="img" aria-label={fin ? `Score ${Math.round(fin.score)}, ${fin.tier}` : 'Not tested yet'}>
              <svg viewBox="0 0 128 128" width="128" height="128">
                <defs><linearGradient id="dr-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9a82ff" /><stop offset=".55" stopColor="#3ddcf5" /><stop offset="1" stopColor="#ff8fc4" /></linearGradient></defs>
                <circle cx="64" cy="64" r={R} fill="none" stroke="var(--line)" strokeWidth="8" opacity=".55" />
                {fin && <circle className="dr-arc" cx="64" cy="64" r={R} fill="none" stroke="url(#dr-g)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 64 64)" />}
              </svg>
              <div className="dr-ringtxt">{fin ? <><b>{Math.round(fin.score).toLocaleString('en-US')}</b><span>{fin.tier}</span></> : <><b className="dim">—</b><span>not tested</span></>}</div>
            </div>
            <div className="dr-pillars">
              {fin
                ? PILLARS.map((p) => { const row = fin.pillars.find((x) => x.id === p.id), s = row?.status === 'measured' || row?.status === 'imputed' ? row.score : null
                  return (
                    <div className="dr-pill" key={p.id}>
                      <span className="dr-pl">{p.label}</span>
                      <span className="dr-bar"><i style={{ width: `${s ? Math.max(3, Math.min(100, (s / 2000) * 100)) : 0}%`, background: p.hue }} /></span>
                      <b className="mono">{s ? Math.round(s).toLocaleString('en-US') : row?.status === 'unavailable' ? 'n/a' : '—'}</b>
                    </div>
                  ) })
                : <>
                  <p className="dr-lead">The facts below are read from your device right now. Test your system to add measured speeds and a score.</p>
                  <button type="button" className="t5-btn pri" data-report-test onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ns-test-all')) }}>Test your system</button>
                </>}
              {fin && <p className="dr-foot">1,000 is the reference PC. {tierOf(fin.score)} · {measured} measured values below.</p>}
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
.dr{width:min(960px,100%);max-height:min(90dvh,920px);display:flex;flex-direction:column;overflow:hidden;color:var(--fg);background:var(--glass-heavy,var(--panel));backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);border:1px solid var(--rim,var(--line));border-radius:22px;box-shadow:var(--sh-2),0 0 90px -24px var(--glow,transparent);animation:ns-up .36s var(--ease,ease) both;outline:none}
.dr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:20px 22px 14px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)}
.dr-id{min-width:0}
.dr-eyebrow{margin:0 0 2px;font:650 11.5px var(--body);letter-spacing:.09em;text-transform:uppercase;background:var(--brand-fill);-webkit-background-clip:text;background-clip:text;color:transparent;width:max-content}
.dr-head h3{margin:0;font:720 22px/1.2 var(--display);letter-spacing:-.02em;overflow-wrap:anywhere}
.dr-sub{margin:4px 0 0;color:var(--muted);font-size:13px}
.dr-act{display:flex;gap:8px;flex:none}
.dr-scroll{overflow:auto;padding:18px 22px 22px;display:grid;gap:18px;overscroll-behavior:contain}
.dr-hero{display:grid;grid-template-columns:auto minmax(0,1fr);gap:22px;align-items:center;padding:18px;border-radius:18px;border:1px solid color-mix(in srgb,var(--brand-1) 26%,var(--line));background:radial-gradient(420px circle at 0% 0%,color-mix(in srgb,var(--brand-1) 20%,transparent),transparent 70%),radial-gradient(380px circle at 100% 100%,color-mix(in srgb,var(--brand-3) 12%,transparent),transparent 70%),color-mix(in srgb,var(--surface) 70%,transparent)}
.dr-ring{position:relative;width:128px;height:128px;flex:none}
.dr-arc{filter:drop-shadow(0 0 8px color-mix(in srgb,var(--brand-2) 60%,transparent));animation:dr-draw .9s var(--ease,ease) both}
@keyframes dr-draw{from{stroke-dasharray:0 400}}
.dr-ringtxt{position:absolute;inset:0;display:grid;place-content:center;text-align:center;gap:0}
.dr-ringtxt b{font:760 30px/1 var(--display);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.dr-ringtxt b.dim{color:var(--faint)}
.dr-ringtxt span{font:600 12px var(--body);color:var(--muted);margin-top:4px}
.dr-pillars{display:grid;gap:7px;min-width:0}
.dr-pill{display:grid;grid-template-columns:64px minmax(0,1fr) 52px;align-items:center;gap:10px;font-size:13px}
.dr-pl{color:var(--muted)}
.dr-pill b{text-align:right;font-size:13px}
.dr-bar{height:8px;border-radius:99px;background:color-mix(in srgb,var(--line) 70%,transparent);overflow:hidden}
.dr-bar i{display:block;height:100%;border-radius:99px;transform-origin:left;animation:dr-grow .7s var(--ease,ease) both}
@keyframes dr-grow{from{transform:scaleX(0)}}
.dr-lead{margin:0 0 4px;font-size:14px;line-height:1.5;color:var(--fg);max-width:46ch}
.dr-pillars .t5-btn.pri{justify-self:start}
.dr-foot{margin:4px 0 0;font-size:12px;color:var(--muted)}
.dr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.dr-card{--hue:var(--brand-1);position:relative;padding:14px 14px 8px;border-radius:16px;border:1px solid var(--line);background:linear-gradient(180deg,color-mix(in srgb,var(--hue) 7%,var(--panel)),var(--panel) 46%);box-shadow:inset 0 1px 0 var(--rim);animation:ns-up .4s var(--ease,ease) both;transition:border-color var(--d1,120ms) ease,transform var(--d2,220ms) var(--ease,ease)}
.dr-card:hover{border-color:color-mix(in srgb,var(--hue) 50%,var(--line))}
.dr-card h4{display:flex;align-items:center;gap:9px;margin:0 0 8px;font:650 14px var(--display)}
.dr-ico{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;color:var(--hue);background:color-mix(in srgb,var(--hue) 15%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--hue) 32%,transparent)}
.dr-card dl{margin:0;display:grid}
.dr-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid color-mix(in srgb,var(--line) 50%,transparent)}
.dr-row dt{color:var(--muted);font-size:13px;min-width:0;flex:0 1 46%}
.dr-row dt small{display:block;font-size:11.5px;line-height:1.35;color:var(--faint);margin-top:2px}
.dr-row dd{margin:0;display:flex;flex-direction:column;align-items:flex-end;gap:3px;text-align:right;min-width:0;flex:1 1 54%;font:600 13px var(--body);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dr-src{font:600 10px var(--body);font-style:normal;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:99px;color:var(--faint);border:1px solid color-mix(in srgb,var(--line) 80%,transparent)}
.dr-src.measured{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent);background:color-mix(in srgb,var(--ok) 9%,transparent)}
.dr-src.live{color:var(--neg-ink);border-color:color-mix(in srgb,var(--neg) 45%,transparent);background:color-mix(in srgb,var(--neg) 9%,transparent)}
.dr-note{margin:0;font-size:12.5px;line-height:1.55;color:var(--muted)}
.dr-note b{color:var(--fg);font-weight:600}
@media (max-width:640px){
.dr-wall{place-items:end stretch;padding:0}
.dr{width:100%;max-height:92dvh;border-radius:22px 22px 0 0;border-bottom:0;padding-bottom:env(safe-area-inset-bottom,0px)}
.dr-head{padding:16px 16px 12px}.dr-head h3{font-size:19px}
.dr-scroll{padding:14px 14px 18px;gap:14px}
.dr-hero{grid-template-columns:1fr;justify-items:center;gap:14px;padding:16px}
.dr-pillars{width:100%}
.dr-grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){.dr,.dr-wall,.dr-card,.dr-arc,.dr-bar i{animation:none}}
`
