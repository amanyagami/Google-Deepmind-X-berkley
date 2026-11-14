import { useEffect, useMemo, useRef, useState } from 'react'
import { scaleLinear } from 'd3'
import { useShallow } from 'zustand/react/shallow'
import { journeyPowerAt, powerNow, SMOOTH_S, useHW, type PowerMode, type PowerSample } from './hwStore'
import { LABEL, locate } from './timeline'
import { useStore } from '../store'
import { Hint } from '../ui/charts'

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

export const STAGE_NAME: Record<string, string> = {
  idle: 'Idle baseline', draw: 'Idle, drawing the live 3D view', matmul_1: 'CPU · one core', matmul_n: 'CPU · all cores', dram: 'Memory bandwidth', cache: 'Cache speed',
  disk: 'Storage read', net: 'Network download', gpu: 'GPU compute', ai_load: 'Loading the language model', ai: 'Language model writing', cool: 'Cool-down', live: 'Live',
}
const STAGE_COL: Record<string, string> = {
  idle: '#33405f', draw: '#4b5a85', matmul_1: '#ffa94d', matmul_n: '#ff8a3d', dram: '#55a8ff', cache: '#7cc4ff', disk: '#6f8cff', net: '#4fd1c5', gpu: '#c08bff', ai_load: '#56607d', ai: '#ffd166', cool: '#33405f',
  input: '#6f8cff', send: '#4fd1c5', tokenize: '#c08bff', embed: '#55a8ff', blocks: '#ffa94d', logits: '#ff8a3d', pick: '#ffd166', output: '#7cc4ff', decode: '#ffc27a',
}

function useNow(): { s: PowerSample | null; mode: PowerMode; energy: number } {
  const h = useHW(useShallow((st) => ({ power: st.power, powerLive: st.powerLive, benchRunning: st.benchRunning, pHead: st.pHead, pMode: st.pMode, telemetry: st.telemetry, journey: st.journey, tl: st.tl, playhead: st.playhead, info: st.info, recorded: st.recorded, recordedPack: st.recordedPack, bench: st.bench })))
  return useMemo(() => {
    const { s, mode } = powerNow(h)
    const samples = mode === 'recording' ? h.powerLive : mode === 'replay' ? h.power?.samples ?? [] : []
    const t = mode === 'recording' ? (h.powerLive[h.powerLive.length - 1]?.t ?? 0) : h.pHead
    let energy = 0
    for (let i = 0; i + 1 < samples.length && samples[i + 1].t <= t; i++) energy += ((samples[i].pkg_w + samples[i + 1].pkg_w) / 2) * (samples[i + 1].t - samples[i].t)
    return { s, mode, energy }
  }, [h])
}

/** The power card: watts now, split into cores and the rest of the chip. Numbers and labels; the explanation is the 💡. */
export function PowerHUD() {
  const { s, mode, energy } = useNow()
  const info = useHW((st) => st.info)
  const power = useHW((st) => st.power)
  const est = mode !== 'live' && mode !== 'journey' && !power?.reference && (s?.estimated || power?.estimated || info?.power?.measured === false)
  const loadRef = useHW((st) => st.loadReferencePower)
  const run = useHW((st) => st.runBench)
  const running = useHW((st) => st.benchRunning)
  const coreSum = s ? s.core_w.reduce((a, b) => a + (b ?? 0), 0) : 0
  const label = mode === 'recording' ? 'recording' : mode === 'replay' ? (power?.reference ? 'replay · test PC' : 'replay') : mode === 'journey' ? 'journey' : mode === 'live' ? 'live' : 'no data'
  const kind = mode === 'journey' ? 'modelled' : est ? 'estimated' : 'measured'
  return (
    <div className="phud" aria-live="polite">
      <div className="pbadge"><i className={mode} />{label}<span>{kind}</span>
        <Hint label="About these numbers">
          {mode === 'live' && <>Straight from the CPU's own sensors, averaged over {SMOOTH_S} s. Open any app and watch it change.</>}
          {mode === 'recording' && <>Every test drives this view as it runs and is recorded. The Energy tab shows what drawing it costs. During the idle baseline the view pauses for a moment, so its own cost can be measured next.</>}
          {mode === 'replay' && <>Averaged over {SMOOTH_S} s. Drag along the chart to rewind.{power?.reference ? ` Measured on ${power.reference.cpu}, not on this computer.` : ''}</>}
          {mode === 'journey' && <>The journey is a recording of work, not of power, so these watts are modelled: each core idles near 0.2 W and rises to what a full-load test measured here as the model uses it.</>}
          {mode === 'none' && (info?.source === 'browser' ? <>Browsers cannot read power sensors, so run the test and this view will use an estimate.</> : <>Waiting for the power sensors.</>)}
          {' '}Amber is power and compute, blue is data. Double-click the CPU, a core, RAM, SSD, network, keyboard or screen to look inside.
        </Hint>
      </div>
      {s ? (
        <>
          <div className="pbig mono">{s.pkg_w.toFixed(1)}<small> W</small></div>
          <div className="psub">CPU package{s.stage && s.stage !== 'live' && mode !== 'journey' ? <> · <b style={{ color: STAGE_COL[s.stage] }}>{STAGE_NAME[s.stage] ?? s.stage}</b></> : null}</div>
          <div className="prow mono">
            <div><span>cores</span><b>{coreSum.toFixed(1)} W</b></div>
            <div><span>rest of chip</span><b>{Math.max(0, s.pkg_w - coreSum).toFixed(1)} W</b></div>
            {s.mhz ? <div><span>clock</span><b>{(s.mhz / 1000).toFixed(2)} GHz</b></div> : null}
            {(mode === 'replay' || mode === 'recording') && <div><span>energy</span><b>{energy.toFixed(0)} J</b></div>}
          </div>
        </>
      ) : <div className="psub">{info?.source === 'browser' ? 'Run the test for watts' : 'Waiting for sensors…'}</div>}
      <div className="row">
        {!running && <button className="btn sm" onClick={() => run()}>{power && !power.reference ? 'Test again' : 'Run the test'}</button>}
        {!running && info?.source === 'browser' && !power?.reference && <button className="btn2 sm" onClick={() => loadRef()}>Replay a measured run</button>}
      </div>
    </div>
  )
}

/** The one bar under the machine. Its power chart is always there; what it scrubs depends on the mode:
 *  live (the last 15 s), the prompt's journey (stages, with modelled watts) or the recorded power test. */
export function MachineTimeline() {
  const h = useHW(useShallow((s) => ({ power: s.power, powerLive: s.powerLive, running: s.benchRunning, pHead: s.pHead, pPlaying: s.pPlaying, pSpeed: s.pSpeed, pMode: s.pMode, telemetry: s.telemetry, journey: s.journey, tl: s.tl, playhead: s.playhead, playing: s.playing, speed: s.speed, expanded: s.expanded, follow: s.follow, info: s.info, recorded: s.recorded, recordedPack: s.recordedPack, bench: s.bench, source: s.source, busy: s.journeyBusy, err: s.journeyErr })))
  const { power, running, journey, tl } = h
  const hw = useHW.getState()
  const hasLive = h.source === 'companion' && h.info?.power?.measured !== false
  const m = running ? 'rec' : h.pMode === 'journey' && journey ? 'journey' : h.pMode === 'live' || !power ? 'live' : 'replay'
  const resume = useRef(false)
  // callback ref: the chart unmounts while it has no samples, so the observer must follow the element it is on
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    if (!box) return
    const upd = () => { if (box.clientWidth > 0) setW(box.clientWidth) }
    upd(); const ro = new ResizeObserver(upd); ro.observe(box); return () => ro.disconnect()
  }, [box])
  // keys: space plays or pauses, arrows step between journey stages, Escape goes back out of a dive
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || useStore.getState().appView !== 'power') return
      const g = useHW.getState()
      if (e.code === 'Escape') g.back()
      if (g.benchRunning) return
      if (e.code === 'Space') { e.preventDefault(); if (g.pMode === 'journey' && g.journey) g.toggle(); else if (g.power && g.pMode === 'replay') (g.pPlaying ? g.pPause() : g.pPlay()) }
      if (g.pMode === 'journey' && g.journey) { if (e.code === 'ArrowRight') g.step(1); if (e.code === 'ArrowLeft') g.step(-1) }
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [])
  const jsamples = useMemo(() => {
    if (m !== 'journey' || !journey) return []
    const st = { journey, tl, info: h.info, power, recorded: h.recorded, recordedPack: h.recordedPack, bench: h.bench }
    return Array.from({ length: 97 }, (_, i) => journeyPowerAt(st, (i / 96) * tl.total)!)
  }, [m, journey, tl, h.info, power, h.recorded, h.recordedPack, h.bench])
  const liveSamples = useMemo(() => {
    if (m !== 'live') return []
    const pts = h.telemetry.filter((x) => x?.power?.pkg_w != null)
    const t0 = pts.length ? pts[pts.length - 1].t : 0
    return pts.map((x) => ({ t: 15 + x.t - t0, stage: 'live', pkg_w: x.power.pkg_w, core_w: x.power.core_w ?? [], mhz: null, util: [] } as PowerSample)).filter((x) => x.t >= 0)
  }, [m, h.telemetry])
  const samples = m === 'rec' ? h.powerLive : m === 'journey' ? jsamples : m === 'live' ? liveSamples : power?.samples ?? []
  const name = (st: string) => (m === 'journey' ? (LABEL as Record<string, string[]>)[st]?.[1] : STAGE_NAME[st]?.replace('CPU · ', '')) ?? st
  const cur = locate(tl, h.playhead)
  const canSeek = m === 'journey' || m === 'replay'
  const chart = (() => {
    if (!samples.length) return <div className="pchart empty mono">waiting for power samples…</div>
    const T = m === 'live' ? 15 : m === 'journey' ? tl.total : Math.max(1, samples[samples.length - 1].t)
    const H = 84
    const maxW = Math.max(20, ...samples.map((s) => s.pkg_w)) * 1.1
    const x = scaleLinear().domain([0, T]).range([0, w]), y = scaleLinear().domain([0, maxW]).range([H - 16, 6])
    const area = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(s.pkg_w).toFixed(1)}`).join(' ')
    const cores = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(s.core_w.reduce((a, b) => a + (b ?? 0), 0)).toFixed(1)}`).join(' ')
    const bands: { st: string; a: number; b: number }[] = []
    if (m === 'journey') for (const sg of tl.segs) bands.push({ st: sg.id, a: sg.v0, b: sg.v1 })
    else for (const s of samples) { const l = bands[bands.length - 1]; if (l && l.st === s.stage) l.b = s.t; else bands.push({ st: s.stage, a: s.t, b: s.t }) }
    const head = m === 'journey' ? h.playhead : m === 'replay' ? h.pHead : samples[samples.length - 1].t
    const seek = (cx: number) => { if (!box) return; const r = box.getBoundingClientRect(); const t = ((cx - r.left) / r.width) * T; if (m === 'journey') hw.setPlayhead(t); else hw.setPHead(t) }
    return (
      <div className="pchart" ref={setBox} style={{ cursor: canSeek ? 'ew-resize' : undefined }}
        onPointerDown={(e) => { if (!canSeek) return; if (m === 'journey') { resume.current = hw.playing; hw.pause() } else hw.pPause(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seek(e.clientX) }}
        onPointerMove={(e) => { if (e.buttons && canSeek) seek(e.clientX) }}
        onPointerUp={() => { if (m === 'journey' && resume.current) { resume.current = false; hw.play() } }}>
        <svg width={w} height={H} role="img" aria-label={m === 'journey' ? 'Journey stages with the modelled CPU power' : 'CPU package power'}>
          {bands.map((b, i) => {
            const on = m === 'journey' && i === cur.i
            return <g key={i}><rect x={x(b.a)} width={Math.max(1, x(b.b) - x(b.a))} y={0} height={H - 14} fill={STAGE_COL[b.st] ?? '#334'} opacity={on ? 0.28 : 0.12} />
              {x(b.b) - x(b.a) > name(b.st).length * 5.9 + 8 && <text x={x(b.a) + 4} y={H - 3} className="pbl" style={on ? { fill: 'var(--fg)' } : undefined}>{name(b.st)}</text>}</g>
          })}
          {[0, 20, 40, 60, 80].filter((v) => v < maxW).map((v) => <g key={v}><line x1={0} x2={w} y1={y(v)} y2={y(v)} stroke="var(--line)" opacity={0.45} /><text x={2} y={y(v) - 2} className="pbl">{v} W</text></g>)}
          <path d={`${area} L${x(samples[samples.length - 1].t)} ${y(0)} L${x(samples[0].t)} ${y(0)} Z`} fill="var(--pos)" opacity={0.16} />
          <path d={area} fill="none" stroke="var(--pos)" strokeWidth={1.6} />
          <path d={cores} fill="none" stroke="var(--neg)" strokeWidth={1.1} opacity={0.85} />
          <line x1={x(head)} x2={x(head)} y1={0} y2={H - 14} stroke="var(--fg)" strokeWidth={1.4} />
        </svg>
        <div className="plegend"><span><i style={{ background: 'var(--pos)' }} />package</span><span><i style={{ background: 'var(--neg)' }} />cores</span></div>
      </div>
    )
  })()
  const startJourney = () => { const st = useStore.getState(); if (h.source === 'browser') hw.loadRecorded(); else hw.runJourney(st.repo, st.prompt) }
  const repo = useStore((s) => s.repo)
  const T0 = m === 'journey' ? tl.total : samples.length ? samples[samples.length - 1].t : 0
  return (
    <div className="mtl">
      <div className="tlctl">
        {m !== 'rec' && (
          <div className="seg sm modes" role="group" aria-label="What the machine shows">
            {hasLive && <button className={m === 'live' ? 'on' : ''} onClick={() => hw.goLive()}>Live now</button>}
            {journey && <button className={m === 'journey' ? 'on' : ''} onClick={() => hw.showJourney()}>Journey</button>}
            {power && <button className={m === 'replay' ? 'on' : ''} onClick={() => hw.replay()}>Replay the test</button>}
          </div>
        )}
        {m === 'rec' && <span className="livetag rec"><span className="pulse" />recording the test</span>}
        {m === 'journey' && (
          <>
            <button className="ib" aria-label="Previous stage" onClick={() => hw.step(-1)}>⏮</button>
            <button className="ib big" aria-label={h.playing ? 'Pause' : 'Play'} onClick={() => hw.toggle()}>{h.playing ? '❚❚' : '▶'}</button>
            <button className="ib" aria-label="Next stage" onClick={() => hw.step(1)}>⏭</button>
            <span className="mono tm">{mmss(h.playhead)} / {mmss(tl.total)}</span>
            <select aria-label="Playback speed" value={h.speed} onChange={(e) => hw.setSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
            <label className="chk"><input type="checkbox" checked={h.expanded} onChange={(e) => hw.setExpanded(e.target.checked)} /> every block</label>
            <label className="chk"><input type="checkbox" checked={h.follow} onChange={(e) => hw.setFollow(e.target.checked)} /> follow</label>
          </>
        )}
        {m === 'replay' && (
          <>
            <button className="ib big" aria-label={h.pPlaying ? 'Pause' : 'Play'} onClick={() => (h.pPlaying ? hw.pPause() : hw.pPlay())}>{h.pPlaying ? '❚❚' : '▶'}</button>
            <span className="mono tm">{h.pHead.toFixed(1)} s / {T0.toFixed(1)} s</span>
            <select aria-label="Replay speed" value={h.pSpeed} onChange={(e) => hw.setPSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
          </>
        )}
        {m === 'live' && <><span className="livetag"><span className="livedot" />live</span><span className="mono tm">last 15 s</span></>}
        {m !== 'rec' && !journey && (
          <button className="btn sm startj" disabled={!!h.busy || (h.source !== 'browser' && !repo)} onClick={startJourney}>{h.busy ? 'Working…' : h.source === 'browser' ? 'Play a recorded journey' : 'Start the journey'}</button>
        )}
        {h.busy && h.source === 'companion' && <span className="busy mono"><span className="pulse" /> {h.busy}</span>}
        <Hint label="About the timeline">
          {m === 'journey' ? <>Each band is a stage of the prompt's journey; drag along the chart to scrub, rewind or replay. The cores, RAM and the blue data rails light as the stage uses them. Watts are modelled from that activity.</>
            : m === 'replay' ? <>Drag along the chart to rewind. Each band is one test; the 3D machine shows the watts recorded at that moment.</>
            : m === 'rec' ? <>Every test drives the 3D view as it runs, and is recorded.</>
            : <>Package power right now (line) and the cores alone. Start the journey to follow a prompt through the machine, or run the test to record where the watts go.</>}
        </Hint>
      </div>
      {h.err && <div className="err">{h.err}</div>}
      {chart}
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
      <h4>Browser-only mode<Hint>Web pages cannot read power sensors. Watts here come from a simple model of how a CPU's power rises with busy cores, scaled by its power class. For measured watts, run the companion on this PC (start.ps1); this page connects to it automatically.</Hint></h4>
      <label className="lbl">CPU power class: <b className="mono">{tdp} W</b></label>
      <input type="range" min={10} max={170} step={5} value={tdp} onChange={(e) => useHW.getState().setTdp(+e.target.value)} aria-label="CPU power class in watts" />
      <label className="chk"><input type="checkbox" checked={ai} onChange={(e) => useHW.getState().setAiInBrowser(e.target.checked)} /> include a real language model running in this page (downloads ~120 MB once)</label>
    </div>
  )
  if (!power) return <div className="stack">{settings}<p className="hint">No test yet<Hint>Run the test. Every test is recorded with its power, and afterwards the whole run replays in 3D.</Hint></p></div>
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
        {!power.estimated && <p className={`hint small ${throttled ? 'warnline' : ''}`}>{throttled ? `throttled for ~${throttled.toFixed(1)} s` : 'no throttling'}<Hint>{throttled ? 'The thermal zone reported throttling during this run, so results may be lower than this machine reaches when cool.' : 'No thermal throttling was reported during this run.'}</Hint></p>}
        {idleW !== null && <p className="hint small">idle baseline <b className="mono">{idleW} W</b><Hint>The cost of the chip just being awake. Each test's extra power is its average minus that.</Hint></p>}
        {idleW !== null && S.draw?.avg_w != null && (() => {
          const d = S.draw.avg_w - idleW
          return <p className="hint small">drawing this view: {d >= 1 ? <b className="mono">+{d.toFixed(1)} W</b> : <b className="mono">~0 W</b>}
            <Hint>{d >= 1 ? `Idle with the view drawing ${S.draw.avg_w} W, without ${idleW} W.` : `Too small to separate from background activity in this run (idle with it ${S.draw.avg_w} W, without ${idleW} W).`} On a laptop chip the graphics are inside the CPU package, so this is part of every test's reading; the view pauses only for the idle baseline.</Hint></p>
        })()}
      </div>
      {eff.length > 0 && (
        <div>
          <h4>Work per joule</h4>
          <ul className="facts">{eff.map((e) => <li key={e.k}><span>{e.k}</span><b>{e.v}<Hint>{e.note}</Hint></b></li>)}</ul>
        </div>
      )}
      {cur?.core_j?.length > 0 && (
        <div>
          <h4>Energy per core · {STAGE_NAME[sel] ?? sel}<Hint>{power.estimated ? 'Estimated: the model assumes the busy threads land on separate cores.' : 'Measured per core. With one busy thread, the operating system moves it between cores, so the energy spreads over a few of them.'} Click a test in the table to see its split.</Hint></h4>
          <div className="cores">{cur.core_j.map((j: number, k: number) => <div key={k} title={`core ${k}: ${j} J`}><i style={{ height: `${Math.max(3, (100 * j) / cmax)}%`, background: 'var(--pos)' }} /><span>{k}</span></div>)}</div>
        </div>
      )}
      <p className="hint small mono">{power.source}<Hint>RAM, SSD and network supplies are not metered on this PC; in 3D they glow with activity only.</Hint></p>
      {settings}
    </div>
  )
}
