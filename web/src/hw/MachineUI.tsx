import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { animate, motion } from 'framer-motion'
import { scaleLinear, scaleLog } from 'd3'
import { jumpTo, useStore } from '../store'
import { useHW } from './hwStore'
import { MachineScene } from './MachineScene'
import { activityAt, captionFor, layerOps, locate } from './timeline'
import { REF, REF_BROWSER, tierOf, useScores } from './score'
import { PowerScene } from './PowerScene'
import { EnergyTab, PowerHUD, PowerTimeline, STAGE_NAME } from './PowerUI'

const fmtB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`)
const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

function Counter({ value, digits = 0 }: { value: number | null; digits?: number }) {
  const [v, setV] = useState(value ?? 0)
  const from = useRef(value ?? 0)
  useEffect(() => {
    if (value === null) return
    const c = animate(from.current, value, { duration: 0.6, ease: 'easeOut', onUpdate: (x) => { from.current = x; setV(x) } })
    return () => c.stop()
  }, [value])
  return <>{value === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}</>
}

function Gauge({ score, size = 150, max = 2000, label, small }: { score: number | null; size?: number; max?: number; label?: string; small?: boolean }) {
  const r = size / 2 - 12, c = size / 2
  const frac = score === null ? 0 : Math.min(1, score / max)
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2
  const pt = (a: number) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`
  const arc = `M ${pt(a0)} A ${r} ${r} 0 1 1 ${pt(a1)}`
  return (
    <div className="gauge" style={{ width: size, height: size * (small ? 0.82 : 0.9) }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${label ?? 'score'} ${score ?? 'not measured'}`}>
        <path d={arc} fill="none" stroke="var(--line)" strokeWidth={small ? 6 : 9} strokeLinecap="round" />
        <motion.path d={arc} fill="none" stroke="var(--pos)" strokeWidth={small ? 6 : 9} strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: frac }} transition={{ type: 'spring', stiffness: 60, damping: 16 }} style={{ filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--pos) 60%, transparent))' }} />
      </svg>
      <div className="gnum"><b className={small ? 's' : ''}><Counter value={score} /></b>{label && <span>{label}</span>}</div>
    </div>
  )
}

const STAGE_LABEL: Record<string, string> = { ...STAGE_NAME, disk: 'Storage read', gpu: 'GPU compute (WebGPU)' }

function BenchOverlay() {
  const running = useHW((s) => s.benchRunning)
  const stage = useHW((s) => s.benchStage)
  const live = useHW((s) => s.benchLive)
  const note = useHW((s) => (s.benchStage === 'ai_load' ? s.benchNote : null))
  if (!running || !stage) return null
  return (
    <div className="benchov" role="status">
      <span className="pulse" /> <b>Measuring {STAGE_LABEL[stage] ?? stage}</b>
      <span className="mono big">{live && live.name === stage ? <>{live.value.toLocaleString()} <small>{live.unit}</small></> : '…'}</span>
      {live && live.name === stage && <span className="mono dim">best {live.best.toLocaleString()}</span>}
      {note && <span className="hint small">{note}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ timeline */
function TimelineBar() {
  const { tl, playhead, playing, speed, expanded, journey } = useHW(useShallow((s) => ({ tl: s.tl, playhead: s.playhead, playing: s.playing, speed: s.speed, expanded: s.expanded, journey: s.journey })))
  const hw = useHW.getState()
  const track = useRef<HTMLDivElement>(null)
  const resume = useRef(false)
  const seek = (clientX: number) => { const r = track.current!.getBoundingClientRect(); hw.setPlayhead(((clientX - r.left) / r.width) * tl.total) }
  const cur = locate(tl, playhead)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'SELECT' || useStore.getState().appView !== 'journey') return
      if (e.code === 'Space') { e.preventDefault(); useHW.getState().toggle() }
      if (e.code === 'ArrowRight') useHW.getState().step(1)
      if (e.code === 'ArrowLeft') useHW.getState().step(-1)
      if (e.code === 'Escape') useHW.getState().back()
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [])
  if (!journey) return null
  return (
    <div className="tlbar">
      <div className="tlctl">
        <button className="ib" aria-label="Previous stage" onClick={() => hw.step(-1)}>⏮</button>
        <button className="ib big" aria-label={playing ? 'Pause' : 'Play'} onClick={() => hw.toggle()}>{playing ? '❚❚' : '▶'}</button>
        <button className="ib" aria-label="Next stage" onClick={() => hw.step(1)}>⏭</button>
        <span className="mono tm">{mmss(playhead)} / {mmss(tl.total)}</span>
        <select aria-label="Playback speed" value={speed} onChange={(e) => hw.setSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
        <label className="chk"><input type="checkbox" checked={expanded} onChange={(e) => hw.setExpanded(e.target.checked)} /> every block</label>
        <label className="chk"><input type="checkbox" checked={useHW.getState().follow} onChange={(e) => hw.setFollow(e.target.checked)} /> follow camera</label>
      </div>
      <div className="tltrack" ref={track}
        onPointerDown={(e) => { resume.current = hw.playing; hw.pause(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seek(e.clientX) }}
        onPointerMove={(e) => { if (e.buttons) seek(e.clientX) }}
        onPointerUp={() => { if (resume.current) hw.play() }}>
        {tl.segs.map((s, i) => (
          <div key={s.id} className={`tlseg ${i === cur.i ? 'on' : ''} ${i < cur.i ? 'done' : ''}`} style={{ width: `${((s.v1 - s.v0) / tl.total) * 100}%` }} title={s.label}>
            <i style={{ width: i < cur.i ? '100%' : i === cur.i ? `${cur.p * 100}%` : '0%' }} />
            <span>{s.short}</span>
          </div>
        ))}
        <div className="tlhead" style={{ left: `${(playhead / tl.total) * 100}%` }} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ caption + dive cards */
function usePlay() {
  const journey = useHW((s) => s.journey)
  const tl = useHW((s) => s.tl)
  const playhead = useHW((s) => s.playhead)
  const live = useHW(useShallow((s) => ({ info: s.info, bench: s.bench })))
  const rec = useHW((s) => (s.recorded ? s.recordedPack : null))
  // a recorded journey is shown with the hardware facts of the machine it was recorded on
  const { info, bench } = rec ?? live
  const peaks = useMemo(() => ({ gflops: bench.matmul_n?.gflops ?? info?.cpu?.peak_gflops_est ?? 100, gbps: bench.dram?.copy_gbps ?? info?.ram?.peak_gbps_est ?? 20 }), [bench, info])
  const act = useMemo(() => (journey ? activityAt(journey, tl, playhead, peaks, info?.cpu?.cores ?? 8) : null), [journey, tl, playhead, peaks, info])
  return { journey, act, peaks, info, bench }
}

function Caption() {
  const { journey, act, peaks, info } = usePlay()
  const dive = useHW((s) => s.dive)
  const recorded = useHW((s) => s.recorded)
  if (!journey || !act) return null
  const c = captionFor(journey, act, peaks, info)
  return (
    <div className="caption">
      <div className="ctitle"><span className="stg">{act.stage === 'blocks' ? 'blocks' : act.stage}</span><h3>{c.title}</h3>{recorded && <span className="chipscore">recorded on the test PC</span>}</div>
      <p>{c.text}</p>
      <div className="cnums">{c.nums.map((n) => <div key={n.k}><span>{n.k}</span><b className="mono">{n.v}</b></div>)}</div>
      {c.dive && <button className="btn2" onClick={() => dive(c.dive!.path)}>{c.dive.label} ›</button>}
      <p className="hint small">Double-click any part of the machine to look inside it.</p>
    </div>
  )
}

function MemMap({ j, activeLayer }: { j: any; activeLayer?: number }) {
  const segs = useMemo(() => {
    const per = new Map<number, number>()
    for (const o of j.decode.ops) per.set(o.layer, (per.get(o.layer) ?? 0) + o.wbytes)
    return [...per.entries()].sort((a, b) => a[0] - b[0]).filter(([, b]) => b > 0)
  }, [j])
  const tot = segs.reduce((a, [, b]) => a + b, 0)
  return (
    <div className="memmap" aria-label="Where each block's weights sit in RAM">
      {segs.map(([l, b]) => <i key={l} className={l === activeLayer ? 'on' : ''} style={{ width: `${(b / tot) * 100}%` }} title={l >= j.L ? 'output matrix' : `block ${l + 1}: ${fmtB(b)}`} />)}
    </div>
  )
}

/** The KV cache: every token's keys and values, kept for every block so later words can look back at them. */
function KvCache({ j }: { j: any }) {
  const act = usePlay().act
  const d = j.dims
  const perTok = 2 * j.L * d.nkv * d.hd * 4 // keys + values, every block, fp32
  const T = j.tokenize.tokens.length
  const total = T + j.decode.tokens.length
  const st = act?.stage
  const now = st === 'decode' || st === 'output' ? T + Math.max(1, act?.shown ?? 1) : st === 'input' || st === 'send' || st === 'tokenize' ? 0 : T
  return (
    <div className="kv2">
      <p className="hint small"><b>KV cache</b>: each token leaves its keys and values in RAM for every block ({fmtB(perTok)} per token = 2 × {j.L} blocks × {d.nkv} kv-heads × {d.hd} numbers × 4 bytes), so a new word only computes itself and reads the rest back.</p>
      <div className="kvbar" aria-label={`KV cache holds ${now} of ${total} tokens`}><i style={{ width: `${(100 * now) / total}%` }} /><span className="mono">{now} tokens · {fmtB(now * perTok)}</span></div>
    </div>
  )
}

function Micro() {
  const micro = useHW((s) => s.micro)
  if (!micro) return <p className="hint">Computing a real dot product…</p>
  const mx = Math.max(...micro.chunk_sums.map(Math.abs), 1e-6)
  const run = micro.running, lo = Math.min(0, ...run), hi = Math.max(0, ...run)
  const x = scaleLinear().domain([0, run.length - 1]).range([4, 296]), y = scaleLinear().domain([lo, hi]).range([66, 6])
  const path = run.map((v: number, i: number) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return (
    <div className="micro">
      <p>One row of the <b>{micro.op}</b> matrix of block {micro.layer + 1} meets the real numbers flowing through the model. The core handles <b>{micro.lanes}</b> numbers per instruction, so the {micro.length} products need <b>{micro.fma_instructions}</b> rounds.</p>
      <div className="mrows mono">
        <div><span>x</span>{micro.x.slice(0, 6).map((v: number, i: number) => <em key={i} className={v < 0 ? 'neg' : 'pos'}>{v.toFixed(3)}</em>)}…</div>
        <div><span>w</span>{micro.w.slice(0, 6).map((v: number, i: number) => <em key={i} className={v < 0 ? 'neg' : 'pos'}>{v.toFixed(3)}</em>)}…</div>
        <div><span>x×w</span>{micro.products.slice(0, 6).map((v: number, i: number) => <em key={i} className={v < 0 ? 'neg' : 'pos'}>{v.toFixed(4)}</em>)}…</div>
      </div>
      <svg viewBox="0 0 300 72" className="runchart" role="img" aria-label="Running total after each round of 16 products">
        <line x1="4" x2="296" y1={y(0)} y2={y(0)} stroke="var(--line)" />
        {micro.chunk_sums.map((v: number, i: number) => <rect key={i} x={x(i) - 3} width="6" y={v >= 0 ? y(0) - (v / mx) * 18 : y(0)} height={Math.max(0.5, (Math.abs(v) / mx) * 18)} fill={v >= 0 ? 'var(--pos)' : 'var(--neg)'} opacity="0.55" />)}
        <path d={path} fill="none" stroke="var(--fg)" strokeWidth="1.6" />
      </svg>
      <p className="mono res">Σ of {micro.length} products {micro.bias ? `+ bias ${micro.bias}` : ''} = <b>{micro.dot}</b> · the model's own output: <b>{micro.module_output}</b> {micro.match_err < 1e-4 ? '✓ match' : ''}</p>
      <p className="hint small">In memory terms: 16 floats are 64 bytes, exactly one <b>cache line</b>. This row of weights is {micro.length * 4} bytes = <b>{Math.ceil((micro.length * 4) / 64)} cache lines</b> streamed from RAM through L3 and L2 into the core's L1. The input x is reused by every row, so it stays in L1.</p>
      <p className="hint small">Real kernels (MKL/oneDNN) tile and unroll this loop. The arithmetic is identical.</p>
    </div>
  )
}

function DiveCard() {
  const path = useHW((s) => s.path)
  const back = useHW((s) => s.back)
  const { journey: j, act, peaks, info, bench } = usePlay()
  const recorded = useHW((s) => s.recorded)
  const latest = useHW((s) => s.latest)
  const sc = useScores()
  const comp = path[0]
  const isCore = comp === 'cpu' && path[1]?.startsWith('core')
  const dec = j?.decode
  const gp = bench.gpu && !bench.gpu.unavailable ? bench.gpu : null
  let title = comp, body: any = null
  if (isCore) {
    title = `Inside core ${path[1].slice(4)}`
    body = <Micro />
  } else if (comp === 'cpu') {
    title = 'Inside the CPU'
    body = (
      <>
        <p>The CPU is a small city of identical workers. Each of the <b>{info?.cpu?.cores}</b> cores has its own tiny fast memory (L1, L2) and a vector unit that handles <b>16 numbers per instruction</b>. They share a bigger memory (L3).</p>
        <ul className="facts">
          <li><span>caches</span><b>L1 {Math.round((info?.cpu?.per_core_cache?.L1 ?? 0) / 1024)} KB · L2 {Math.round((info?.cpu?.per_core_cache?.L2 ?? 0) / 2 ** 20)} MB per core · L3 {Math.round((info?.cpu?.caches?.L3 ?? 0) / 2 ** 20)} MB shared</b></li>
          <li><span>measured</span><b>{bench.matmul_1?.gflops ?? '…'} GFLOP/s one core · {bench.matmul_n?.gflops ?? '…'} all cores</b></li>
          {dec && <li><span>per word written</span><b>{(dec.flops / 1e6).toFixed(0)} MFLOP over {dec.ops.length} operations</b></li>}
          <li><span>busy right now</span><b>{latest ? `${latest.proc_cores} cores' worth by this program · ${latest.cpu_avg}% overall` : '…'}</b></li>
        </ul>
        <p className="hint small">Double-click a core to see one multiplication.</p>
      </>
    )
  } else if (comp === 'ram') {
    title = 'Inside the RAM'
    const minMs = dec ? (dec.weight_bytes / 1e9 / Math.max(1, peaks.gbps)) * 1000 : 0
    body = (
      <>
        <p>RAM holds the whole model while it runs. For every word written, <b>every weight is read once</b>, so the speed of RAM decides how fast the model can write.</p>
        <ul className="facts">
          <li><span>this RAM</span><b>{info?.ram?.type} {info?.ram?.mts} MT/s × {info?.ram?.channels} channels = {info?.ram?.peak_gbps_est} GB/s on paper</b></li>
          <li><span>measured</span><b>{bench.dram ? `${bench.dram.copy_gbps} GB/s copy · ${bench.dram.read_gbps} GB/s read` : '…'}</b></li>
          {dec && <li><span>one word</span><b>reads {fmtB(dec.weight_bytes)} → at least {minMs.toFixed(1)} ms at peak, took {dec.step_ms} ms</b></li>}
          {dec && <li><span>achieved</span><b>{dec.effective_gbps} GB/s = {Math.round((100 * dec.effective_gbps) / Math.max(1, peaks.gbps))}% of the measured peak</b></li>}
        </ul>
        {j && <><p className="hint small">Each segment is one block's weights in RAM{act?.layer !== undefined ? '; the lit one is being read now' : ''}.</p><MemMap j={j} activeLayer={act?.stage === 'blocks' ? act.layer : undefined} /></>}
        {j && <KvCache j={j} />}
      </>
    )
  } else if (comp === 'ssd') {
    title = 'Inside the SSD'
    body = (
      <>
        <p>The SSD keeps the model between runs. It is read <b>once</b>, when the model loads. After that, RAM does all the work.</p>
        <ul className="facts">
          <li><span>drive</span><b>{info?.disks?.[0]?.name} · {info?.disks?.[0]?.bus}</b></li>
          {info?.pcie?.[0] && <li><span>link</span><b>PCIe Gen{info.pcie[0].gen} ×{info.pcie[0].lanes} · {info.pcie[0].gbps} GB/s ceiling · measured {bench.disk ? Math.round((100 * bench.disk.gbps) / info.pcie[0].gbps) + '%' : '…'} of it</b></li>}
          <li><span>measured read</span><b>{bench.disk ? `${bench.disk.gbps} GB/s (${bench.disk.cached ? 'cached' : 'straight from the drive'})` : '…'}</b></li>
          <li><span>this model</span><b>269 MB on disk as bf16, widened to {j ? fmtB(j.prefill.wbytes) : '538 MB'} fp32 in RAM</b></li>
        </ul>
      </>
    )
  } else if (comp === 'nic') {
    title = 'Inside the network card'
    body = (
      <>
        <p>The network card was used <b>once</b>, to download the weights from the Hugging Face Hub. This run happens entirely on this PC.</p>
        <ul className="facts">
          <li><span>adapter</span><b>{info?.nics?.[0]?.name} · link {info?.nics?.[0]?.link}</b></li>
          <li><span>measured</span><b>{bench.net ? `${bench.net.mbps} Mbit/s · first byte after ${bench.net.latency_ms} ms` : '…'}</b></li>
          {bench.net && <li><span>269 MB would take</span><b>about {Math.round(269 / Math.max(0.1, bench.net.mbytes_s))} s</b></li>}
        </ul>
      </>
    )
  } else if (comp === 'keyboard' || comp === 'display') {
    title = comp === 'keyboard' ? 'The keyboard' : 'The screen'
    body = <p>{comp === 'keyboard' ? 'Each key press closes a tiny switch. The keyboard sends a code to the computer, and the operating system turns it into a letter.' : 'The model returns token IDs. They become text, the browser draws it, and the graphics hardware lights the pixels.'}</p>
  }
  if (!body) return null
  const extra = comp === 'cpu' || isCore ? sc.by.cpu : comp === 'ram' ? sc.by.ram : comp === 'ssd' ? sc.by.ssd : comp === 'nic' ? sc.by.nic : null
  return (
    <div className="caption dive">
      <div className="ctitle"><button className="ib" onClick={back} aria-label="Back">‹</button><h3>{title}</h3>{recorded ? <span className="chipscore">test PC, recorded</span> : extra ? <span className="chipscore">score {extra}</span> : null}</div>
      {body}
      {comp === 'cpu' && gp && <p className="hint small">GPU (WebGPU): {gp.gflops} GFLOP/s on {gp.adapter}. PyTorch here uses the CPU.</p>}
    </div>
  )
}

function Crumbs() {
  const path = useHW((s) => s.path)
  const back = useHW((s) => s.back)
  const dive = useHW((s) => s.dive)
  const names: Record<string, string> = { cpu: 'CPU', ram: 'RAM', ssd: 'SSD', nic: 'Network', keyboard: 'Keyboard', display: 'Screen' }
  const nm = (p: string) => names[p] ?? (p.startsWith('core') ? `Core ${p.slice(4)}` : p)
  return (
    <div className="crumbs">
      <button onClick={() => dive([])} className={path.length ? '' : 'cur'}>Machine</button>
      {path.map((p, i) => <span key={i}> › <button onClick={() => dive(path.slice(0, i + 1))} className={i === path.length - 1 ? 'cur' : ''}>{nm(p)}</button></span>)}
      {path.length > 0 && <button className="ib" onClick={back} aria-label="Back one level">↩</button>}
    </div>
  )
}

/* ------------------------------------------------------------------ sidebar tabs */
function ScoreTab() {
  const s = useScores()
  const running = useHW((s) => s.benchRunning)
  const stage = useHW((s) => s.benchStage)
  const live = useHW((s) => s.benchLive)
  const dive = useHW((s) => s.dive)
  const run = useHW((s) => s.runBench)
  const browser = useHW((s) => s.info?.source === 'browser')
  const R = browser ? REF_BROWSER : REF
  return (
    <div className="stack">
      {browser && <p className="hint small">Browser-only mode: measured from inside this page (WebAssembly, Web Workers, browser storage, WebGPU). Run the companion for native numbers and real power readings.</p>}
      <div className="hero-score">
        <Gauge score={s.overall} size={180} label={s.tier} />
        <div>
          <h3>Device score</h3>
          <p className="hint">1000 points is a recent mainstream laptop. Scores update live as each test runs, and each one is a plain ratio against its reference.</p>
          <button className="btn" disabled={running} onClick={() => run()}>{running ? 'Measuring…' : s.count ? 'Measure again' : 'Measure this machine'}</button>
        </div>
      </div>
      {s.comps.map((c) => {
        const active = running && c.subs.some((x) => x.id === stage || (stage === 'matmul_1' && c.id === 'cpu') || (stage === 'matmul_n' && c.id === 'cpu'))
        return (
          <div key={c.id} className={`ccard ${active ? 'live' : ''}`}>
            <div className="chead">
              <div><h4>{c.name}<small>{c.role}</small></h4></div>
              <Gauge score={c.score} size={74} small max={2000} />
            </div>
            {c.subs.map((x) => {
              const lv = running && live && (live.name === x.id || (x.id === 'cpu1' && live.name === 'matmul_1') || (x.id === 'cpun' && live.name === 'matmul_n') || (x.id === 'disk' && live.name === 'disk'))
              return (
                <div key={x.id} className="sub">
                  <div className="srow"><span>{x.label}</span><b className="mono">{lv && live ? `${live.value.toLocaleString()} ${live.unit}` : x.value}</b><em className="mono">{x.score ?? '—'}</em></div>
                  <div className="sbar"><i style={{ width: `${Math.min(100, ((x.score ?? 0) / 20))}%` }} /></div>
                  <p className="hint small">{x.detail}{x.peak ? ` On paper: ${x.peak}${x.pct ? ` (${x.pct}% reached)` : ''}.` : ''}</p>
                </div>
              )
            })}
            {c.id !== 'system' && c.id !== 'cache' && c.id !== 'gpu' && c.id !== 'power' && <button className="btn2 sm" onClick={() => dive([c.id])}>Look inside ›</button>}
          </div>
        )
      })}
      <p className="hint small">Reference values (1000 points): one core {R.cpu1} GFLOP/s · all cores {R.cpun} GFLOP/s · cache {R.cache} GB/s · RAM {R.ram} GB/s · SSD {R.disk} GB/s · network {R.net} Mbit/s · GPU {R.gpu} GFLOP/s · writing {R.ai} tokens/s. Overall is a weighted geometric mean of what has been measured. {tierOf(s.overall) !== '—' && `Tiers: Entry < 400 < Everyday < 800 < Strong < 1200 < Excellent.`}</p>
    </div>
  )
}

function FlowTab() {
  const { journey: j, act } = usePlay()
  const expanded = useHW((s) => s.expanded)
  if (!j || !act) return <p className="hint">Press “Start the journey” to follow one prompt through the machine.</p>
  const ops = act.stage === 'blocks' && act.layer !== undefined ? layerOps(j, act.layer) : []
  const ph = act.stage === 'decode' ? j.decode : j.prefill
  const top = [...ph.ops].sort((a: any, b: any) => b.ms - a.ms).slice(0, 8)
  return (
    <div className="stack">
      <div>
        <h4>Everything below was timed on this PC</h4>
        <p className="hint">{act.hud}</p>
      </div>
      {ops.length > 0 && (
        <div>
          <h4>Block {(act.layer ?? 0) + 1}: every operation</h4>
          <table className="optab mono"><thead><tr><th>op</th><th>ms</th><th>GB/s</th><th>GFLOP/s</th><th>limit</th></tr></thead>
            <tbody>{ops.map((o: any, i: number) => <tr key={i} className={act.op === o ? 'now' : ''}><td>{o.name}</td><td>{o.ms.toFixed(3)}</td><td>{o.gbps}</td><td>{o.gflops}</td><td>{o.bound ?? ''}</td></tr>)}</tbody></table>
        </div>
      )}
      <div>
        <h4>Slowest operations in {act.stage === 'decode' ? 'one new word' : 'the prompt pass'}</h4>
        <table className="optab mono"><thead><tr><th>op</th><th>block</th><th>ms</th><th>GB/s</th><th>limit</th></tr></thead>
          <tbody>{top.map((o: any, i: number) => <tr key={i}><td>{o.name}</td><td>{o.layer >= j.L ? '—' : o.layer < 0 ? '—' : o.layer + 1}</td><td>{o.ms.toFixed(3)}</td><td>{o.gbps}</td><td>{o.bound ?? ''}</td></tr>)}</tbody></table>
        <p className="hint small">“memory” means the operation spends its time waiting for weights from RAM; “compute” means the cores are the limit. Tiny operations are mostly framework overhead.</p>
      </div>
      <label className="chk"><input type="checkbox" checked={expanded} onChange={(e) => useHW.getState().setExpanded(e.target.checked)} /> Slow the timeline down to show every block</label>
    </div>
  )
}

function SpecsTab() {
  const info = useHW((s) => s.info)
  if (!info) return <p className="hint">Reading hardware…</p>
  const c = info.cpu, r = info.ram
  if (info.source === 'browser') {
    const rows: [string, string][] = [
      ['Mode', 'browser only: no companion found on this PC'],
      ['CPU', `${c.threads} logical processors (the CPU model, clocks and caches are hidden from web pages)`],
      ['RAM', r.total ? `${Math.round(r.total / 2 ** 30)} GB reported · ${r.total_note}` : r.total_note],
      ...info.gpus.map((g: any): [string, string] => ['GPU', g.name]),
      ['Storage', `browser storage, quota ${info.disks[0]?.bytes ? Math.round(info.disks[0].bytes / 1e9) + ' GB' : 'unknown'}`],
      ...info.nics.slice(0, 1).map((n: any): [string, string] => ['Network', `${n.name} ${n.link}`]),
      ['Platform', info.os],
      ['Power', 'no sensor access from a web page: watts are estimated'],
    ]
    return <dl className="specs2">{rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  }
  const rows: [string, string][] = [
    ['CPU', `${c.name}`], ['Cores', `${c.cores} cores / ${c.threads} threads · ${c.isa}`], ['Clock', `${c.base_mhz} MHz base`],
    ['Cache', `L1 ${Math.round((c.per_core_cache.L1 ?? 0) / 1024)} KB, L2 ${Math.round((c.per_core_cache.L2 ?? 0) / 2 ** 20)} MB per core · L3 ${Math.round((c.caches.L3 ?? 0) / 2 ** 20)} MB`],
    ['Peak math (est.)', `${c.peak_gflops_est} GFLOP/s · ${c.flops_basis}`],
    ['RAM', `${Math.round(r.total / 2 ** 30)} GB ${r.type ?? ''} ${r.mts} MT/s · ${r.channels} channels · ${r.peak_gbps_est} GB/s on paper`],
    ...info.gpus.map((g: any): [string, string] => ['GPU', `${g.name}${g.integrated ? ' (integrated, shares RAM)' : ''} · not used by PyTorch here`]),
    ...info.disks.map((d: any): [string, string] => ['Storage', `${d.name} · ${d.bus} ${d.media} · ${Math.round(d.bytes / 1e9)} GB`]),
    ...(info.pcie ?? []).map((l: any): [string, string] => ['Storage link', `${l.note} = ${l.gbps} GB/s`]),
    ...info.nics.slice(0, 1).map((n: any): [string, string] => ['Network', `${n.name} · ${n.link}`]),
    ['Power sensors', info.power?.measured ? `${info.power.source}${info.power.per_core ? ' · per core' : ''}` : 'none found'],
    ['Software', `${info.os} · PyTorch ${info.torch} · ${c.threads_used} worker threads`],
  ]
  return <dl className="specs2">{rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}

function Spark({ data, color = 'var(--pos)', max = 100 }: { data: number[]; color?: string; max?: number }) {
  const x = scaleLinear().domain([0, Math.max(1, data.length - 1)]).range([0, 200]), y = scaleLinear().domain([0, max]).range([34, 2])
  const d = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return <svg viewBox="0 0 200 36" className="spark2" preserveAspectRatio="none"><path d={`${d} L200 36 L0 36 Z`} fill={color} opacity="0.15" /><path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
}

function LiveTab() {
  const { latest: l, telemetry: t, info } = useHW(useShallow((s) => ({ latest: s.latest, telemetry: s.telemetry, info: s.info })))
  if (info?.source === 'browser') return <p className="hint">Live operating-system counters need the companion (start.ps1 on this PC). The page connects to it automatically when it is running.</p>
  if (!l) return <p className="hint">Waiting for the first live sample…</p>
  const cores = info?.cpu?.cores ?? 8
  const per = Array.from({ length: cores }, (_, k) => ((l.cpu[k * 2] ?? 0) + (l.cpu[k * 2 + 1] ?? 0)) / 2)
  return (
    <div className="stack">
      <div><h4>CPU <small>{l.cpu_avg}% · this program uses {l.proc_cores} cores' worth · {l.mhz ? `${Math.round(l.mhz)} MHz` : ''}</small></h4><Spark data={t.map((s: any) => s.cpu_avg)} /></div>
      <div className="cores">{per.map((v, k) => <div key={k}><i style={{ height: `${Math.max(3, v)}%` }} /><span>{k}</span></div>)}</div>
      {l.power?.pkg_w != null && <div><h4>CPU power <small>{l.power.pkg_w} W package · {l.power.eff_mhz ? `${(l.power.eff_mhz / 1000).toFixed(2)} GHz effective` : ''}</small></h4><Spark data={t.map((s: any) => s.power?.pkg_w ?? 0)} max={Math.max(30, ...t.map((s: any) => s.power?.pkg_w ?? 0))} /></div>}
      {l.power?.core_w?.length > 0 && <div className="cores">{l.power.core_w.map((w: number, k: number) => <div key={k} title={`core ${k}: ${w} W`}><i style={{ height: `${Math.max(3, Math.min(100, w * 10))}%`, background: 'var(--pos)' }} /><span>{w?.toFixed(1)}</span></div>)}</div>}
      <div><h4>Memory <small>{(l.ram_used / 2 ** 30).toFixed(1)} of {(l.ram_total / 2 ** 30).toFixed(0)} GB · this program {(l.rss / 2 ** 30).toFixed(2)} GB</small></h4><Spark data={t.map((s: any) => (100 * s.ram_used) / s.ram_total)} color="var(--neg)" /></div>
      <div className="two"><div><h4>Disk read <small>{(l.disk_read_bps / 1e6).toFixed(1)} MB/s</small></h4><Spark data={t.map((s: any) => s.disk_read_bps / 1e6)} max={Math.max(50, ...t.map((s: any) => s.disk_read_bps / 1e6))} color="var(--neg)" /></div>
        <div><h4>Network in <small>{(l.net_recv_bps / 1e6).toFixed(2)} MB/s</small></h4><Spark data={t.map((s: any) => s.net_recv_bps / 1e6)} max={Math.max(1, ...t.map((s: any) => s.net_recv_bps / 1e6))} color="var(--neg)" /></div></div>
      <p className="hint small">Sampled from the operating system 10 times a second.</p>
    </div>
  )
}

function SpeedTab() {
  const { bench, journey: j } = useHW(useShallow((s) => ({ bench: s.bench, journey: s.journey })))
  const peaks = useHW.getState().peaks()
  const cache: any[] = bench.cache ?? []
  const W = 300, H = 150
  const cx = scaleLog().domain([32, 262144]).range([34, W - 8]), cy = scaleLinear().domain([0, Math.max(150, ...cache.map((c) => c.gbps))]).range([H - 22, 8])
  const ticks = [32, 1024, 32768, 262144]
  const rf = scaleLog().domain([0.1, 200]).range([34, W - 8]), rp = scaleLog().domain([0.1, Math.max(1000, peaks.gflops * 1.6)]).range([H - 22, 8])
  const ridge = peaks.gflops / Math.max(0.1, peaks.gbps)
  const pts = j ? j.decode.ops.filter((o: any) => o.ai && o.gflops > 0).map((o: any) => ({ x: o.ai, y: o.gflops, k: o.name })) : []
  const pre = j ? j.prefill.ops.filter((o: any) => o.ai && o.gflops > 0 && o.kind === 'matmul').map((o: any) => ({ x: o.ai, y: o.gflops })) : []
  return (
    <div className="stack">
      <div>
        <h4>Cache and memory speed <small>one core, data size vs speed</small></h4>
        {cache.length ? (
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Streaming bandwidth versus working set size">
            {ticks.map((t) => <g key={t}><line x1={cx(t)} x2={cx(t)} y1="8" y2={H - 22} stroke="var(--line)" /><text x={cx(t)} y={H - 8} textAnchor="middle">{t >= 1024 ? `${t / 1024} MB` : `${t} KB`}</text></g>)}
            {[0, 50, 100, 150].map((v) => <g key={v}><line x1="34" x2={W - 8} y1={cy(v)} y2={cy(v)} stroke="var(--line)" opacity=".5" /><text x="30" y={cy(v) + 3} textAnchor="end">{v}</text></g>)}
            <path d={cache.map((c, i) => `${i ? 'L' : 'M'}${cx(c.kb).toFixed(1)} ${cy(c.gbps).toFixed(1)}`).join(' ')} fill="none" stroke="var(--pos)" strokeWidth="2" />
            {cache.map((c) => <circle key={c.kb} cx={cx(c.kb)} cy={cy(c.gbps)} r="2.4" fill="var(--pos)" />)}
            <text x={W - 8} y="14" textAnchor="end" className="axl">GB/s</text>
          </svg>
        ) : <p className="hint">Run “Measure this machine” on the Score tab.</p>}
        <p className="hint small">The staircase is the memory hierarchy: fast and small at the left, big and slow at the right. Model weights are far larger than any cache, so they stream from RAM at the right-hand speed.</p>
      </div>
      <div>
        <h4>Is each operation limited by RAM or by math?</h4>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Roofline chart">
          <path d={`M${rf(0.1)} ${rp(0.1 * peaks.gbps)} L${rf(ridge)} ${rp(peaks.gflops)} L${rf(200)} ${rp(peaks.gflops)}`} fill="none" stroke="var(--neg)" strokeWidth="1.8" />
          {pre.map((p: any, i: number) => <circle key={`a${i}`} cx={rf(p.x)} cy={rp(p.y)} r="1.8" fill="var(--neg)" opacity=".5" />)}
          {pts.map((p: any, i: number) => <circle key={`b${i}`} cx={rf(p.x)} cy={rp(p.y)} r="2" fill="var(--pos)" opacity=".7" />)}
          <text x="36" y="18" className="axl">GFLOP/s</text><text x={W - 8} y={H - 8} textAnchor="end" className="axl">FLOPs per byte moved →</text>
        </svg>
        <p className="hint small">Blue line: the machine's limits from the measured speeds. Amber dots: each operation when writing a word. Every dot sits far left of the bend, so RAM, not math, is the limit. Blue dots: the same operations on the whole prompt, which reuse each weight more.</p>
      </div>
    </div>
  )
}

function Sidebar({ mode }: { mode: 'journey' | 'power' }) {
  const [tab, setTab] = useState<'score' | 'energy' | 'flow' | 'live' | 'specs' | 'speed'>('score')
  const tabs: [typeof tab, string][] = [['score', 'Score'], mode === 'power' ? ['energy', 'Energy'] : ['flow', 'Flow'], ['live', 'Live'], ['speed', 'Speed'], ['specs', 'Specs']]
  return (
    <aside className="inspector" aria-label="Machine details">
      <div className="tabs" role="tablist">{tabs.map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
      <div className="pane" role="tabpanel">
        {tab === 'score' && <ScoreTab />}{tab === 'energy' && <EnergyTab />}{tab === 'flow' && <FlowTab />}{tab === 'live' && <LiveTab />}{tab === 'speed' && <SpeedTab />}{tab === 'specs' && <SpecsTab />}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ start card + view */
function StartCard() {
  const hw = useHW(useShallow((s) => ({ journey: s.journey, journeyBusy: s.journeyBusy, journeyErr: s.journeyErr, info: s.info, infoErr: s.infoErr, source: s.source, benchRunning: s.benchRunning, runJourney: s.runJourney, loadRecorded: s.loadRecorded, runBench: s.runBench })))
  const repo = useStore((s) => s.repo)
  const prompt = useStore((s) => s.prompt)
  const setP = useStore((s) => s.setPrompt)
  const p = prompt
  const busy = hw.journeyBusy
  if (hw.journey) return null
  return (
    <div className="startcard">
      <h2>Follow one prompt through this PC</h2>
      <p className="hint small">The numbers on the machine are live. Double-click any part to look inside.</p>
      <label className="sr" htmlFor="hwprompt">Prompt</label>
      <textarea id="hwprompt" rows={1} value={p} onChange={(e) => setP(e.target.value)} />
      {hw.source === 'browser' ? (
        <>
          <p className="hint small">Running without the companion. A journey needs PyTorch on this PC, so you can play one recorded on the test PC, or measure this machine from the browser.</p>
          <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => hw.loadRecorded()}>{busy ? 'Working…' : 'Play a recorded journey'}</button>
            <button className="btn2" disabled={hw.benchRunning} onClick={() => hw.runBench()}>Measure this machine</button>
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <button className="btn" disabled={!!busy || !repo} onClick={() => hw.runJourney(repo, p)}>{busy ? 'Working…' : 'Start the journey'}</button>
            <button className="btn2" onClick={() => jumpTo('power')}>See the electricity live</button>
            <span className="hint small mono">{repo || 'no model loaded'}</span>
          </div>

        </>
      )}
      {busy && <p className="hint busy"><span className="pulse" /> {busy}</p>}
      {hw.journeyErr && <div className="err">{hw.journeyErr}</div>}
      {!hw.info && !hw.infoErr && <p className="hint small">Reading hardware…</p>}
      {hw.infoErr && <div className="err">Could not read the hardware: {hw.infoErr}</div>}
    </div>
  )
}

/** Loads the hardware facts and starts the 10 Hz telemetry once, whichever machine section mounts first. */
let booted = false
function useMachineBoot() {
  const appView = useStore((s) => s.appView)
  useEffect(() => { if (!booted) { booted = true; useHW.getState().loadInfo().then(() => useHW.getState().startTelemetry()) } }, [])
  // the section the page is scrolled to is the one whose player runs; the other one pauses (see setView)
  useEffect(() => { if ((appView === 'journey' || appView === 'power') && useHW.getState().view !== appView) useHW.getState().setView(appView) }, [appView])
}

function DetailsButton() {
  const details = useStore((s) => s.details)
  return <div className="topright"><button className="detbtn" aria-expanded={details} onClick={() => useStore.getState().setDetails(!details)}>{details ? 'Hide details' : 'Details'}</button></div>
}

/** The machine as a 3D board: one prompt travels through it, and every part shows its live numbers. */
export function JourneyView() {
  useMachineBoot()
  // the same prompt the model just ran is replayed on the hardware (needs the companion: PyTorch on this PC)
  const runSeq = useStore((s) => s.runSeq)
  const first = useRef(runSeq)
  useEffect(() => {
    if (runSeq === first.current) return
    const h = useHW.getState(), st = useStore.getState()
    if (h.source === 'companion' && !h.journeyBusy && !h.benchRunning && st.repo) h.runJourney(st.repo, st.prompt)
  }, [runSeq])
  const details = useStore((s) => s.details)
  const shown = useStore((s) => !!s.visible.journey)
  const measuring = useHW((s) => s.benchRunning || (!!s.journeyBusy && s.source === 'companion'))
  return (
    <main className={`main machine ${measuring ? 'measuring' : ''} ${details ? '' : 'nodetails'}`}>
      <section className="stage" aria-label="3D machine">
        <div className="scenewrap"><MachineScene active={shown} /></div>
        <DetailsButton />
        <BenchOverlay />
        <MachineOverlays />
      </section>
      {details && <Sidebar mode="journey" />}
    </main>
  )
}

/** The same machine drawn as electricity: live watts per core, from the CPU's own sensors. */
export function PowerView() {
  useMachineBoot()
  const details = useStore((s) => s.details)
  const shown = useStore((s) => !!s.visible.power)
  const measuring = useHW((s) => s.benchRunning || (!!s.journeyBusy && s.source === 'companion'))
  return (
    <main className={`main machine ${measuring ? 'measuring' : ''} ${details ? '' : 'nodetails'}`}>
      <section className="stage powerview" aria-label="3D view of the electricity in this machine, live">
        <div className="scenewrap"><PowerScene active={shown} /></div>
        <DetailsButton />
        <BenchOverlay />
        <PowerHUD />
        <div className="stagebottom"><PowerTimeline /></div>
      </section>
      {details && <Sidebar mode="power" />}
    </main>
  )
}

function MachineOverlays() {
  const journey = useHW((s) => s.journey)
  const path = useHW((s) => s.path)
  return (
    <>
        <Crumbs />
        <StartCard />
        <div className="stagebottom">
          {journey && (path.length ? <DiveCard /> : <Caption />)}
          <TimelineBar />
        </div>
        {path.length > 0 && path[0] === 'cpu' && path[1]?.startsWith('core') && <MicroLoader />}
    </>
  )
}

function MicroLoader() {
  const repo = useStore((s) => s.repo)
  const prompt = useStore((s) => s.prompt)
  const micro = useHW((s) => s.micro)
  const load = useHW((s) => s.loadMicro)
  useEffect(() => { if (!micro) load(repo, prompt, 0, 0) }, [micro, repo, prompt, load])
  return null
}
