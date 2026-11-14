import { useEffect, useMemo, useRef, useState } from 'react'
import { scaleLinear } from 'd3'
import { useShallow } from 'zustand/react/shallow'
import { powerNow, SMOOTH_S, useHW, type PowerMode, type PowerSample } from './hwStore'

export const STAGE_NAME: Record<string, string> = {
  idle: 'Idle baseline', draw: 'Idle, drawing the live 3D view', matmul_1: 'CPU · one core', matmul_n: 'CPU · all cores', dram: 'Memory bandwidth', cache: 'Cache speed',
  disk: 'Storage read', net: 'Network download', gpu: 'GPU compute', ai_load: 'Loading the language model', ai: 'Language model writing', cool: 'Cool-down', live: 'Live',
}
const STAGE_COL: Record<string, string> = {
  idle: '#33405f', draw: '#4b5a85', matmul_1: '#ffa94d', matmul_n: '#ff8a3d', dram: '#55a8ff', cache: '#7cc4ff', disk: '#6f8cff', net: '#4fd1c5', gpu: '#c08bff', ai_load: '#56607d', ai: '#ffd166', cool: '#33405f',
}

function useNow(): { s: PowerSample | null; mode: PowerMode; energy: number } {
  const h = useHW(useShallow((st) => ({ power: st.power, powerLive: st.powerLive, benchRunning: st.benchRunning, pHead: st.pHead, pMode: st.pMode, telemetry: st.telemetry })))
  return useMemo(() => {
    const { s, mode } = powerNow(h)
    const samples = mode === 'recording' ? h.powerLive : mode === 'replay' ? h.power?.samples ?? [] : []
    const t = mode === 'recording' ? (h.powerLive[h.powerLive.length - 1]?.t ?? 0) : h.pHead
    let energy = 0
    for (let i = 0; i + 1 < samples.length && samples[i + 1].t <= t; i++) energy += ((samples[i].pkg_w + samples[i + 1].pkg_w) / 2) * (samples[i + 1].t - samples[i].t)
    return { s, mode, energy }
  }, [h])
}

export function PowerHUD() {
  const { s, mode, energy } = useNow()
  const info = useHW((st) => st.info)
  const power = useHW((st) => st.power)
  const hasLive = useHW((st) => st.source === 'companion' && st.info?.power?.measured !== false)
  const est = mode !== 'live' && !power?.reference && (s?.estimated || power?.estimated || info?.power?.measured === false)
  const loadRef = useHW((st) => st.loadReferencePower)
  const run = useHW((st) => st.runBench)
  const running = useHW((st) => st.benchRunning)
  const coreSum = s ? s.core_w.reduce((a, b) => a + (b ?? 0), 0) : 0
  const label = mode === 'recording' ? 'live · recording the test' : mode === 'replay' ? (power?.reference ? 'replay · test PC' : 'replay of the test') : mode === 'live' ? 'live' : 'no power data yet'
  return (
    <div className="phud" aria-live="polite">
      <div className="pbadge"><i className={mode} />{label}<span>{power?.reference && mode === 'replay' ? 'measured · RAPL' : est ? 'estimated' : 'measured · RAPL'}</span></div>
      {!running && (hasLive || power) && (
        <div className="seg sm" role="group" aria-label="Live or replay">
          {hasLive && <button className={mode === 'live' ? 'on' : ''} onClick={() => useHW.getState().goLive()}>Live now</button>}
          {power && <button className={mode === 'replay' ? 'on' : ''} onClick={() => useHW.getState().replay()}>Replay the test</button>}
        </div>
      )}
      {power?.reference && mode === 'replay' && <p className="hint small">Measured on {power.reference.cpu}, not on this computer.</p>}
      {s ? (
        <>
          <div className="pbig mono">{s.pkg_w.toFixed(1)}<small> W</small></div>
          <div className="psub">whole CPU package{s.stage && s.stage !== 'live' ? <> · <b style={{ color: STAGE_COL[s.stage] }}>{STAGE_NAME[s.stage] ?? s.stage}</b></> : null}</div>
          <div className="prow mono">
            <div><span>cores</span><b>{coreSum.toFixed(1)} W</b></div>
            <div><span>rest of chip</span><b>{Math.max(0, s.pkg_w - coreSum).toFixed(1)} W</b></div>
            {s.mhz ? <div><span>clock</span><b>{(s.mhz / 1000).toFixed(2)} GHz</b></div> : null}
            {mode !== 'live' && <div><span>energy so far</span><b>{energy.toFixed(0)} J</b></div>}
          </div>
        </>
      ) : (
        <p className="hint small">{info?.source === 'browser' ? 'Run the test to see where the electricity goes. Browsers cannot read power sensors, so this view will use an estimate.' : 'Waiting for the power sensors…'}</p>
      )}
      {s && <p className="hint small">{mode === 'live' ? `Straight from the CPU's sensors, averaged over ${SMOOTH_S} s. Open any app and watch it change.` : mode === 'recording' ? (s.stage === 'idle' ? 'Measuring idle: the 3D view pauses for a moment, so its own cost can be measured next.' : 'Every test drives the 3D view as it runs. The Energy tab shows what drawing it costs.') : `Averaged over ${SMOOTH_S} s. Drag along the chart to rewind.`}</p>}
      <div className="row">
        {!running && <button className="btn sm" onClick={() => run()}>{power && !power.reference ? 'Test again' : 'Run the test'}</button>}
        {!running && info?.source === 'browser' && !power?.reference && <button className="btn2 sm" onClick={() => loadRef()}>Replay a measured run</button>}
      </div>
    </div>
  )
}

export function PowerTimeline() {
  const power = useHW((s) => s.power)
  const live = useHW((s) => s.powerLive)
  const running = useHW((s) => s.benchRunning)
  const pHead = useHW((s) => s.pHead)
  const playing = useHW((s) => s.pPlaying)
  const speed = useHW((s) => s.pSpeed)
  const pMode = useHW((s) => s.pMode)
  const telemetry = useHW((s) => s.telemetry)
  const hw = useHW.getState()
  // callback ref: the chart unmounts while it has no samples, so the observer must follow the element it is on
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    if (!box) return
    const upd = () => { if (box.clientWidth > 0) setW(box.clientWidth) }
    upd(); const ro = new ResizeObserver(upd); ro.observe(box); return () => ro.disconnect()
  }, [box])
  // live: the last 15 s from the sensors, scrolling; recording: the test so far; replay: the whole recorded run
  const liveView = !running && (pMode === 'live' || !power)
  const liveSamples = useMemo(() => {
    if (!liveView) return []
    const pts = telemetry.filter((x) => x?.power?.pkg_w != null)
    const t0 = pts.length ? pts[pts.length - 1].t : 0
    return pts.map((x) => ({ t: 15 + x.t - t0, stage: 'live', pkg_w: x.power.pkg_w, core_w: x.power.core_w ?? [], mhz: null, util: [] } as PowerSample)).filter((x) => x.t >= 0)
  }, [liveView, telemetry])
  const samples = running ? live : liveView ? liveSamples : power?.samples ?? []
  if (!samples.length) return null
  const T = liveView ? 15 : Math.max(1, samples[samples.length - 1].t)
  const H = 92
  const maxW = Math.max(20, ...samples.map((s) => s.pkg_w)) * 1.1
  const x = scaleLinear().domain([0, T]).range([0, w]), y = scaleLinear().domain([0, maxW]).range([H - 16, 6])
  const area = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(s.pkg_w).toFixed(1)}`).join(' ')
  const cores = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(s.core_w.reduce((a, b) => a + (b ?? 0), 0)).toFixed(1)}`).join(' ')
  const bands: { st: string; a: number; b: number }[] = []
  for (const s of samples) { const l = bands[bands.length - 1]; if (l && l.st === s.stage) l.b = s.t; else bands.push({ st: s.stage, a: s.t, b: s.t }) }
  const head = running || liveView ? samples[samples.length - 1].t : pHead
  const canSeek = !running && !liveView
  const seek = (cx: number) => { if (!box) return; const r = box.getBoundingClientRect(); hw.setPHead(((cx - r.left) / r.width) * T) }
  return (
    <div className="ptl">
      <div className="tlctl">
        {liveView
          ? <><span className="livetag"><span className="livedot" />live</span><span className="mono tm">last 15 s</span>
              {power && <button className="btn2 sm" onClick={() => hw.replay()}>▶ Replay the test</button>}</>
          : <><button className="ib big" disabled={running} aria-label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? hw.pPause() : hw.pPlay())}>{playing ? '❚❚' : '▶'}</button>
              <span className="mono tm">{head.toFixed(1)} s / {T.toFixed(1)} s</span>
              {!running && <select aria-label="Replay speed" value={speed} onChange={(e) => hw.setPSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}</select>}</>}
        <span className="hint small">{running ? 'Live: every test drives the 3D view as it runs, and is recorded.' : liveView ? 'Package power right now (line) and the cores alone.' : 'Drag along the chart to rewind. Each band is one test.'}</span>
      </div>
      <div className="pchart" ref={setBox} style={{ cursor: canSeek ? 'ew-resize' : undefined }}
        onPointerDown={(e) => { if (!canSeek) return; hw.pPause(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seek(e.clientX) }}
        onPointerMove={(e) => { if (e.buttons && canSeek) seek(e.clientX) }}>
        <svg width={w} height={H} role="img" aria-label="CPU package power over the whole test">
          {bands.map((b, i) => <g key={i}><rect x={x(b.a)} width={Math.max(1, x(b.b) - x(b.a))} y={0} height={H - 14} fill={STAGE_COL[b.st] ?? '#334'} opacity={0.12} />
            {x(b.b) - x(b.a) > (STAGE_NAME[b.st] ?? b.st).replace('CPU · ', '').length * 5.9 + 8 && <text x={x(b.a) + 4} y={H - 3} className="pbl">{(STAGE_NAME[b.st] ?? b.st).replace('CPU · ', '')}</text>}</g>)}
          {[0, 20, 40, 60, 80].filter((v) => v < maxW).map((v) => <g key={v}><line x1={0} x2={w} y1={y(v)} y2={y(v)} stroke="var(--line)" opacity={0.45} /><text x={2} y={y(v) - 2} className="pbl">{v} W</text></g>)}
          <path d={`${area} L${x(samples[samples.length - 1].t)} ${y(0)} L${x(samples[0].t)} ${y(0)} Z`} fill="var(--pos)" opacity={0.16} />
          <path d={area} fill="none" stroke="var(--pos)" strokeWidth={1.6} />
          <path d={cores} fill="none" stroke="var(--neg)" strokeWidth={1.1} opacity={0.85} />
          <line x1={x(head)} x2={x(head)} y1={0} y2={H - 14} stroke="var(--fg)" strokeWidth={1.4} />
        </svg>
        <div className="plegend"><span><i style={{ background: 'var(--pos)' }} />package</span><span><i style={{ background: 'var(--neg)' }} />cores only</span></div>
      </div>
    </div>
  )
}

/** Sidebar: energy per test, efficiency, and per-core energy. */
export function EnergyTab() {
  const power = useHW((s) => s.power)
  const bench = useHW((s) => s.bench)
  const info = useHW((s) => s.info)
  const tdp = useHW((s) => s.tdp)
  const ai = useHW((s) => s.aiInBrowser)
  const [sel, setSel] = useState('matmul_n')
  const browser = info?.source === 'browser'
  const settings = browser && (
    <div className="ccard">
      <h4>Browser-only mode</h4>
      <p className="hint small">Web pages cannot read power sensors. Watts here come from a simple model of how a CPU's power rises with busy cores, scaled by its power class. For measured watts, run the companion on this PC (start.ps1); this page connects to it automatically.</p>
      <label className="lbl">CPU power class: <b className="mono">{tdp} W</b></label>
      <input type="range" min={10} max={170} step={5} value={tdp} onChange={(e) => useHW.getState().setTdp(+e.target.value)} aria-label="CPU power class in watts" />
      <label className="chk"><input type="checkbox" checked={ai} onChange={(e) => useHW.getState().setAiInBrowser(e.target.checked)} /> include a real language model running in this page (downloads ~120 MB once)</label>
    </div>
  )
  if (!power) return <div className="stack">{settings}<p className="hint">Run the test. Every test is recorded with its power, and afterwards the whole run replays in 3D.</p></div>
  const S = power.summary
  const B = power.reference ? power.reference.bench : bench
  const order = ['idle', 'draw', 'matmul_1', 'matmul_n', 'dram', 'cache', 'disk', 'net', 'gpu', 'ai_load', 'ai', 'cool'].filter((k) => S[k])
  const throttled: number | undefined = S._throttle?.seconds
  const idleW = S.idle?.avg_w ?? null
  const eff: { k: string; v: string; note: string }[] = []
  if (B.matmul_n && S.matmul_n?.avg_w) eff.push({ k: 'All-core math', v: `${(B.matmul_n.gflops / S.matmul_n.avg_w).toFixed(1)} GFLOP per joule`, note: `${B.matmul_n.gflops} GFLOP/s at ${S.matmul_n.avg_w} W` })
  if (B.matmul_1 && S.matmul_1?.avg_w) eff.push({ k: 'One-core math', v: `${(B.matmul_1.gflops / S.matmul_1.avg_w).toFixed(1)} GFLOP per joule`, note: 'one busy core still powers the whole chip' })
  if (B.ai && S.ai?.avg_w) eff.push({ k: 'Language model', v: `${((B.ai.tps / S.ai.avg_w) * 1000).toFixed(0)} tokens per kJ`, note: `${(S.ai.avg_w / B.ai.tps).toFixed(2)} J per word written` })
  if (B.dram && S.dram?.avg_w) eff.push({ k: 'Memory', v: `${(B.dram.copy_gbps / S.dram.avg_w).toFixed(2)} GB moved per joule`, note: `${B.dram.copy_gbps} GB/s at ${S.dram.avg_w} W` })
  const cur = S[sel] ?? S[order[0]]
  const cmax = Math.max(0.01, ...(cur?.core_j ?? [0]))
  return (
    <div className="stack">
      <div>
        <h4>Energy per test <small>{power.reference ? `measured on the test PC, ${power.reference.recorded}` : power.estimated ? 'estimated' : 'measured by the CPU (RAPL)'}</small></h4>
        <table className="optab mono"><thead><tr><th>test</th><th>s</th><th>avg W</th><th>peak W</th><th>J</th></tr></thead>
          <tbody>{order.map((k) => <tr key={k} className={k === sel ? 'now' : ''} onClick={() => setSel(k)} style={{ cursor: 'pointer' }}><td><i className="dot" style={{ background: STAGE_COL[k] }} />{STAGE_NAME[k] ?? k}</td><td>{S[k].seconds}</td><td>{S[k].avg_w}</td><td>{S[k].peak_w}</td><td>{S[k].joules}</td></tr>)}</tbody></table>
        {!power.estimated && <p className={`hint small ${throttled ? 'warnline' : ''}`}>{throttled ? `The thermal zone reported throttling for about ${throttled.toFixed(1)} s of this run, so results may be lower than this machine reaches when cool.` : 'No thermal throttling was reported during this run.'}</p>}
        {idleW !== null && <p className="hint small">Idle baseline {idleW} W: that is the cost of the chip just being awake. Each test's extra power is its average minus that.</p>}
        {idleW !== null && S.draw?.avg_w != null && (() => {
          const d = S.draw.avg_w - idleW
          return <p className="hint small">The live 3D view: {d >= 1
            ? <><b className="mono">+{d.toFixed(1)} W</b> while it draws (idle with it {S.draw.avg_w} W, without {idleW} W).</>
            : <>too small to separate from background activity in this run (idle with it {S.draw.avg_w} W, without {idleW} W).</>}
            {' '}On a laptop chip the graphics are inside the CPU package, so this is part of every test's reading; the view pauses only for the idle baseline.</p>
        })()}
      </div>
      {eff.length > 0 && (
        <div>
          <h4>Work per unit of electricity</h4>
          <ul className="facts">{eff.map((e) => <li key={e.k}><span>{e.k}</span><b>{e.v}</b><em className="hint small">{e.note}</em></li>)}</ul>
        </div>
      )}
      {cur?.core_j?.length > 0 && (
        <div>
          <h4>Energy per core · {STAGE_NAME[sel] ?? sel}</h4>
          <div className="cores">{cur.core_j.map((j: number, k: number) => <div key={k} title={`core ${k}: ${j} J`}><i style={{ height: `${Math.max(3, (100 * j) / cmax)}%`, background: 'var(--pos)' }} /><span>{k}</span></div>)}</div>
          <p className="hint small">{power.estimated ? 'Estimated: the model assumes the busy threads land on separate cores.' : 'Measured per core. With one busy thread, the operating system moves it between cores, so the energy spreads over a few of them.'} Click a test in the table to see its split.</p>
        </div>
      )}
      <p className="hint small">Source: {power.source}. RAM, SSD and network supplies are not metered on this PC; in 3D they glow with activity only.</p>
      {settings}
    </div>
  )
}
