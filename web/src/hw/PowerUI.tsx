import { useEffect, useMemo, useRef, useState } from 'react'
import { scaleLinear } from 'd3'
import { useShallow } from 'zustand/react/shallow'
import { fixSplit, journeyPowerAt, powerNow, SMOOTH_S, splitOf, useHW, type PowerMode, type PowerSample, useHWThrottled } from './hwStore'
import { LABEL, locate } from './timeline'
import { useStore } from '../store'
import { Hint, Peek } from '../ui/charts'

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/** One name per part (C8): CPU, Memory, GPU, Storage, Network. */
export const STAGE_NAME: Record<string, string> = {
  idle: 'Idle', draw: 'Idle, drawing the 3D view', matmul_1: 'CPU · one core', matmul_n: 'CPU · all cores', dram: 'Memory', cache: 'Cache',
  disk: 'Storage', net: 'Network', gpu: 'GPU', ai_load: 'Loading the language model', ai: 'Language model writing', cool: 'Cool-down', live: 'Live',
}
const STAGE_COL: Record<string, string> = {
  idle: '#33405f', draw: '#4b5a85', matmul_1: '#ffa94d', matmul_n: '#ff8a3d', dram: '#55a8ff', cache: '#7cc4ff', disk: '#6f8cff', net: '#4fd1c5', gpu: '#c08bff', ai_load: '#56607d', ai: '#ffd166', cool: '#33405f',
  input: '#6f8cff', send: '#4fd1c5', tokenize: '#c08bff', embed: '#55a8ff', blocks: '#ffa94d', logits: '#ff8a3d', pick: '#ffd166', output: '#7cc4ff', decode: '#ffc27a',
}
/** Sum of the core watts after the D19 check: never above the package. */
export const coresOf = (s: PowerSample) => Math.min(s.pkg_w, fixSplit(s).core_w.reduce((a, b) => a + Math.max(0, b ?? 0), 0))

function useNow(): { s: PowerSample | null; mode: PowerMode; energy: number } {
  const live = useHWThrottled((st) => ({ powerLive: st.powerLive, telemetry: st.telemetry }), 250, (a, b) => a.powerLive === b.powerLive && a.telemetry === b.telemetry)
  const h0 = useHW(useShallow((st) => ({ power: st.power, benchRunning: st.benchRunning, pHead: st.pHead, pMode: st.pMode, journey: st.journey, tl: st.tl, playhead: st.playhead, info: st.info, recorded: st.recorded, recordedPack: st.recordedPack, bench: st.bench })))
  const h = { ...h0, ...live }
  return useMemo(() => {
    const { s, mode } = powerNow(h)
    const samples = mode === 'recording' ? h.powerLive : mode === 'replay' ? h.power?.samples ?? [] : []
    const t = mode === 'recording' ? (h.powerLive[h.powerLive.length - 1]?.t ?? 0) : h.pHead
    let energy = 0
    for (let i = 0; i + 1 < samples.length && samples[i + 1].t <= t; i++) energy += ((samples[i].pkg_w + samples[i + 1].pkg_w) / 2) * (samples[i + 1].t - samples[i].t)
    return { s, mode, energy }
  }, [h])
}

/** The power card. At rest: "52.7 W · CPU" and a mode dot. On hover, focus or tap: where the watts go (D16, D19). */
export function PowerHUD() {
  const { s, mode, energy } = useNow()
  const info = useHW((st) => st.info)
  const power = useHW((st) => st.power)
  const browser = info?.source === 'browser'
  const est = mode !== 'live' && mode !== 'journey' && !power?.reference && (s?.estimated || power?.estimated || info?.power?.measured === false)
  const sp = splitOf(s)
  const label = mode === 'recording' ? 'Recording' : mode === 'replay' ? (power?.reference ? 'Replay of the test PC' : 'Replay') : mode === 'journey' ? 'Journey' : 'Live'
  const kind = mode === 'journey' ? 'modelled' : est ? 'estimated' : 'measured'
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const data = sp ? { 'data-pkg': sp.pkg.toFixed(2), 'data-cores': sp.cores != null ? sp.cores.toFixed(2) : '', 'data-rest': sp.rest != null ? sp.rest.toFixed(2) : '', 'data-split': sp.state } : {}
  if (!s || !sp) {
    // no sensor and nothing recorded: no badge, one plain line (C3)
    return (
      <div className="phud" aria-live="polite" data-mode="none">
        <Peek label="Power" summary={<span className="psub">{browser ? 'No power sensor' : 'Waiting for sensors…'}</span>} details={<>
          <p className="t5-line">{browser ? 'No power sensor in the browser. Test all to estimate.' : 'Waiting for the power sensors.'}</p>
        </>} />
      </div>
    )
  }
  return (
    <div className="phud" aria-live="polite" data-mode={mode} {...data}>
      <Peek label="Where the watts go" summary={<><i className={`pdot ${mode}`} aria-label={`${label}, ${kind}`} /><b className="pbig mono">{s.pkg_w.toFixed(1)}<small> W</small></b><span className="psub">· CPU</span></>} details={<>
        <div className="pbadge"><i className={mode} />{label}<span>{kind}</span></div>
        {s.stage && s.stage !== 'live' && mode !== 'journey' && <div className="psub"><b style={{ color: STAGE_COL[s.stage] }}>{STAGE_NAME[s.stage] ?? s.stage}</b></div>}
        <div className="prow mono">
          {sp.state === 'unavailable'
            ? <div className="pwide"><span>cores · rest of chip</span><b>split unavailable</b></div>
            : <>
              <div><span>cores</span><b>{sp.state === 'scaled' ? '≈ ' : ''}{sp.cores!.toFixed(1)} W · {pct(sp.share!)}</b></div>
              <div><span>rest of chip</span><b>{sp.state === 'scaled' ? '≈ ' : ''}{sp.rest!.toFixed(1)} W</b></div>
            </>}
          {s.mhz ? <div><span>clock</span><b>{(s.mhz / 1000).toFixed(2)} GHz</b></div> : null}
          {(mode === 'replay' || mode === 'recording') && <div><span>energy</span><b>{energy.toFixed(0)} J</b></div>}
        </div>
        <p className="t5-line">
          {sp.state === 'unavailable' ? 'The core sensors disagree with the package, so only the package is shown.' : sp.state === 'scaled' ? 'Cores scaled to fit inside the package.' : 'Cores are part of the package.'}
          <Hint label="About these numbers">
            {mode === 'live' && <>Straight from the CPU's own sensors, averaged over {SMOOTH_S} s. </>}
            {mode === 'recording' && <>Test all records the power of every test as it runs. </>}
            {mode === 'replay' && <>Averaged over {SMOOTH_S} s. Drag along the chart to rewind.{power?.reference ? ` Measured on ${power.reference.cpu}, not on this computer.` : ''} </>}
            {mode === 'journey' && <>The journey records work, not power, so these watts are modelled from what each part does. </>}
            {sp.state !== 'ok' && sp.ratio != null && isFinite(sp.ratio) ? <>The core sensors read {pct(sp.ratio)} of the package. On some chips they are not a strict part of it. </> : null}
            Rest of chip = package minus cores (graphics, caches, memory controller).
          </Hint>
        </p>
      </>} />
    </div>
  )
}

/** The one bar under the machine. Its power chart is always there; what it scrubs depends on the mode:
 *  live (the last 15 s), the prompt's journey (stages, with modelled watts) or the recorded power test.
 *  At rest it shows play and the current stage; the other controls open on hover, focus or tap (D16). */
export function MachineTimeline() {
  const live = useHWThrottled((s) => ({ powerLive: s.powerLive, telemetry: s.telemetry }), 250, (a, b) => a.powerLive === b.powerLive && a.telemetry === b.telemetry)
  const h0 = useHW(useShallow((s) => ({ power: s.power, running: s.benchRunning, pHead: s.pHead, pPlaying: s.pPlaying, pSpeed: s.pSpeed, pMode: s.pMode, journey: s.journey, tl: s.tl, playhead: s.playhead, playing: s.playing, speed: s.speed, expanded: s.expanded, follow: s.follow, info: s.info, recorded: s.recorded, recordedPack: s.recordedPack, bench: s.bench, source: s.source, busy: s.journeyBusy, err: s.journeyErr })))
  const h = { ...h0, ...live }
  const { power, running, journey, tl } = h
  const hw = useHW.getState()
  const browser = h.source !== 'companion'
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
    // C3: a browser has no power sensor, so there is no live chart to wait for
    if (!samples.length) return <div className="pchart empty">{m === 'live' && browser ? 'No power sensor in the browser. Test all to estimate.' : m === 'live' ? 'Waiting for power samples…' : 'Recording…'}</div>
    const T = m === 'live' ? 15 : m === 'journey' ? tl.total : Math.max(1, samples[samples.length - 1].t)
    const H = 84
    const maxW = Math.max(20, ...samples.map((s) => s.pkg_w)) * 1.1
    const x = scaleLinear().domain([0, T]).range([0, w]), y = scaleLinear().domain([0, maxW]).range([H - 16, 6])
    const area = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(s.pkg_w).toFixed(1)}`).join(' ')
    const cores = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(coresOf(s)).toFixed(1)}`).join(' ')
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
        <svg width={w} height={H} role="img" aria-label={m === 'journey' ? 'Journey stages with the modelled CPU power' : 'CPU package power, and the cores inside it'}>
          {bands.map((b, i) => {
            const on = m === 'journey' && i === cur.i
            return <g key={i}><rect x={x(b.a)} width={Math.max(1, x(b.b) - x(b.a))} y={0} height={H - 14} fill={STAGE_COL[b.st] ?? '#334'} opacity={on ? 0.28 : 0.12} />
              {x(b.b) - x(b.a) > name(b.st).length * 6.6 + 8 && <text x={x(b.a) + 4} y={H - 3} className="pbl" style={on ? { fill: 'var(--fg)' } : undefined}>{name(b.st)}</text>}</g>
          })}
          {[0, 20, 40, 60, 80].filter((v) => v < maxW).map((v) => <g key={v}><line x1={0} x2={w} y1={y(v)} y2={y(v)} stroke="var(--line)" opacity={0.45} /><text x={2} y={y(v) - 2} className="pbl">{v} W</text></g>)}
          <path d={`${area} L${x(samples[samples.length - 1].t)} ${y(0)} L${x(samples[0].t)} ${y(0)} Z`} fill="var(--pos)" opacity={0.16} />
          <path d={area} fill="none" stroke="var(--pos)" strokeWidth={1.6} />
          <path d={cores} fill="none" stroke="var(--neg)" strokeWidth={1.1} opacity={0.85} />
          <line x1={x(head)} x2={x(head)} y1={0} y2={H - 14} stroke="var(--fg)" strokeWidth={1.4} />
        </svg>
      </div>
    )
  })()
  // one recorded-run button (C7): the journey recorded on the test PC, plus its measured power run if this device has none
  const playRecorded = async () => { if (browser && !useHW.getState().power) await hw.loadReferencePower(); await hw.loadRecorded() }
  const startJourney = () => { const st = useStore.getState(); hw.runJourney(st.repo, st.prompt) }
  const repo = useStore((s) => s.repo)
  const T0 = m === 'journey' ? tl.total : samples.length ? samples[samples.length - 1].t : 0
  const modes = [hasLive && 'live', journey && 'journey', power && 'replay'].filter(Boolean) as string[]
  const stageNow = m === 'journey' ? tl.segs[cur.i]?.label ?? '' : m === 'replay' ? (STAGE_NAME[samples.find((s, i) => s.t >= h.pHead || i === samples.length - 1)?.stage ?? ''] ?? '') : ''
  return (
    <div className="mtl">
      <div className="tlctl">
        {m === 'rec' && <span className="livetag rec"><span className="pulse" />Recording the tests</span>}
        {m === 'journey' && <button className="ib big" aria-label={h.playing ? 'Pause' : 'Play'} onClick={() => hw.toggle()}>{h.playing ? '❚❚' : '▶'}</button>}
        {m === 'replay' && <button className="ib big" aria-label={h.pPlaying ? 'Pause' : 'Play'} onClick={() => (h.pPlaying ? hw.pPause() : hw.pPlay())}>{h.pPlaying ? '❚❚' : '▶'}</button>}
        {m === 'live' && hasLive && <span className="livetag"><span className="livedot" />Live</span>}
        {(m === 'journey' || m === 'replay') && (
          <Peek className="tlpeek" label="Timeline controls" summary={<span className="tlstage">{stageNow || (m === 'journey' ? 'Journey' : 'Power run')}</span>} details={<>
            {m === 'journey' && <>
              <div className="t5-row">
                <button className="ib" aria-label="Previous stage" onClick={() => hw.step(-1)}>⏮</button>
                <button className="ib" aria-label="Next stage" onClick={() => hw.step(1)}>⏭</button>
                <span className="mono tm">{mmss(h.playhead)} / {mmss(tl.total)}</span>
                <select aria-label="Playback speed" value={h.speed} onChange={(e) => hw.setSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
              </div>
              <div className="t5-row">
                <label className="chk"><input type="checkbox" checked={h.expanded} onChange={(e) => hw.setExpanded(e.target.checked)} /> every block</label>
                <label className="chk"><input type="checkbox" checked={h.follow} onChange={(e) => hw.setFollow(e.target.checked)} /> follow</label>
              </div>
            </>}
            {m === 'replay' && <div className="t5-row">
              <span className="mono tm">{h.pHead.toFixed(1)} s / {T0.toFixed(1)} s</span>
              <select aria-label="Replay speed" value={h.pSpeed} onChange={(e) => hw.setPSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
            </div>}
          </>} />
        )}
        <span className="tlgrow" />
        {m !== 'rec' && modes.length > 1 && (
          <div className="seg sm modes" role="group" aria-label="What the machine shows">
            {hasLive && <button className={m === 'live' ? 'on' : ''} onClick={() => hw.goLive()}>Live</button>}
            {journey && <button className={m === 'journey' ? 'on' : ''} onClick={() => hw.showJourney()}>Journey</button>}
            {power && <button className={m === 'replay' ? 'on' : ''} onClick={() => hw.replay()}>Power</button>}
          </div>
        )}
        {m !== 'rec' && !journey && (browser
          ? <button className="btn2 sm startj" data-recorded data-replay disabled={!!h.busy} onClick={playRecorded}>{h.busy ? 'Loading…' : 'Play recorded run'}</button>
          : <button className="btn2 sm startj" disabled={!!h.busy || !repo} onClick={startJourney}>{h.busy ? 'Working…' : 'Start the journey'}</button>)}
        {h.busy && h.source === 'companion' && <span className="busy mono"><span className="pulse" /> {h.busy}</span>}
        <Hint label="About the timeline">
          {m === 'journey' ? <>Each band is a stage of the prompt's journey; drag along the chart to scrub. The cores, RAM and the blue data rails light as the stage uses them. Watts are modelled from that activity.</>
            : m === 'replay' ? <>Drag along the chart to rewind. Each band is one test; the 3D machine shows the watts recorded at that moment.</>
            : m === 'rec' ? <>Every test drives the 3D view as it runs, and is recorded.</>
            : browser ? <>A web page cannot read power sensors. Test all records an estimate of every test. Play recorded run to see a run measured on the test PC.</>
            : <>Package power right now, and the cores inside it. Start the journey to follow a prompt through the machine.</>}
          {' '}Amber line: the CPU package. Blue line: the cores inside it, never above the package.
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
  const results = useHW((s) => s.results)
  const info = useHW((s) => s.info)
  const tdp = useHW((s) => s.tdp)
  const ai = useHW((s) => s.aiInBrowser)
  const [sel, setSel] = useState('matmul_n')
  const browser = info?.source === 'browser'
  const settings = browser && (
    <div className="ccard">
      <h4>Browser only<Hint>Web pages cannot read power sensors, so these watts are estimates. Run the companion on this PC for measured watts.</Hint></h4>
      <label className="lbl">CPU power class · <b className="mono">{tdp} W</b></label>
      <input type="range" min={10} max={170} step={5} value={tdp} onChange={(e) => useHW.getState().setTdp(+e.target.value)} aria-label="CPU power class in watts" />
      <label className="chk"><input type="checkbox" checked={ai} onChange={(e) => useHW.getState().setAiInBrowser(e.target.checked)} /> include a real language model running in this page (downloads ~120 MB once)</label>
    </div>
  )
  if (!power) return <div className="stack">{settings}<p className="hint">No test yet<Hint>Press Test all. Every test is recorded with its power, and afterwards the whole run replays in 3D.</Hint></p></div>
  const S = power.summary
  // the device's own Test all results stand in for the older companion bench entries
  const own = { ...(results.cpun ? { matmul_n: { gflops: results.cpun.value } } : {}), ...(results.cpu1 ? { matmul_1: { gflops: results.cpu1.value } } : {}), ...(results.ram ? { dram: { copy_gbps: results.ram.value } } : {}) }
  const B = power.reference ? power.reference.bench : { ...own, ...bench }
  const order = ['idle', 'draw', 'matmul_1', 'matmul_n', 'dram', 'cache', 'disk', 'net', 'gpu', 'ai_load', 'ai', 'cool'].filter((k) => S[k])
  const throttled: number | undefined = S._throttle?.seconds
  const idleW = S.idle?.avg_w ?? null
  const r1 = (x: number) => +x.toFixed(1)
  const eff: { k: string; v: string; note: string }[] = []
  if (B.matmul_n && S.matmul_n?.avg_w) eff.push({ k: 'All-core math', v: `${(B.matmul_n.gflops / S.matmul_n.avg_w).toFixed(1)} GFLOP per joule`, note: `${r1(B.matmul_n.gflops)} GFLOP/s at ${S.matmul_n.avg_w} W` })
  if (B.matmul_1 && S.matmul_1?.avg_w) eff.push({ k: 'One-core math', v: `${(B.matmul_1.gflops / S.matmul_1.avg_w).toFixed(1)} GFLOP per joule`, note: 'one busy core still powers the whole chip' })
  if (B.ai && S.ai?.avg_w) eff.push({ k: 'Language model', v: `${((B.ai.tps / S.ai.avg_w) * 1000).toFixed(0)} tokens per kJ`, note: `${(S.ai.avg_w / B.ai.tps).toFixed(2)} J per word written` })
  if (B.dram && S.dram?.avg_w) eff.push({ k: 'Memory', v: `${(B.dram.copy_gbps / S.dram.avg_w).toFixed(2)} GB moved per joule`, note: `${r1(B.dram.copy_gbps)} GB/s at ${S.dram.avg_w} W` })
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
      <p className="hint small mono">{power.source}<Hint>RAM, storage and network supplies are not metered on this PC; in 3D they glow with activity only.</Hint></p>
      {settings}
    </div>
  )
}
