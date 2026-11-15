import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { animate, motion } from 'framer-motion'
import { scaleLinear, scaleLog } from 'd3'
import { useStore } from '../store'
import { Explainer, Hint } from '../ui/charts'
import { fixSplit, inputLimits, peaksOf, splitOf, useHWThrottled, type Snapshot, rowFor, RUN_ALL_ORDER, useHW, validateInput, type ComponentId, type InputSchema, type TestResult } from './hwStore'
import { probe } from './browserBench'
import { activityAt, captionFor, layerOps } from './timeline'
import { exportResults, finalNow, componentScore, finalScore, isUnavailable, tierOf, useScores, type PillarRow } from './score'
import { currentSample, PowerScene } from './PowerScene'
import { EnergyTab, MachineTimeline, PowerHUD, STAGE_NAME } from './PowerUI'
import { Peek, PEEK_CSS } from './peek'
import { followModelRuns } from './modelRun'

const fmtB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`)

/* ================================================================== S5: test cards, score hero, share, score strip
 * The run state lives in useHW (hwStore). This file shows it. Test all is the one batch (in the strip); each card can
 * still test its own part. The final score of a Test all is produced in exactly one place: `onFinalScore` below. */
const TEST_IDS: ComponentId[] = RUN_ALL_ORDER   // the scored tests, no downloads
const HC = () => (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8

interface Fb { label: string; pillar: string | null; iw: number; secs: number; input: InputSchema | null; hint: string }
const FB: Record<string, Fb> = {
  cpu1: { label: 'CPU, one core', pillar: 'compute', iw: 0.4, secs: 3, input: { type: 'number', label: 'Grid size', unit: '', min: 128, max: 1024, step: 128, default: 256, cap: 'Up to 5 % of memory.' }, hint: 'One core multiplies two square grids of numbers. Faster means more work per second.' },
  cpun: { label: 'CPU, all cores', pillar: 'compute', iw: 0.6, secs: 7, input: { type: 'number', label: 'Threads', unit: 'threads', min: 1, max: Math.min(32, HC()), step: 1, default: Math.min(8, HC()), cap: 'At most one per core.' }, hint: 'Every core runs the same job at once. The test then holds the load for 3 s.' },
  cache: { label: 'Cache', pillar: 'memory', iw: 0.4, secs: 5, input: { type: 'number', label: 'Largest size', unit: 'MB', min: 1, max: 64, step: 1, default: 32, cap: 'Up to 25 % of the memory budget.' }, hint: 'Small data sits in fast memory next to the cores. The test finds where it stops fitting.' },
  ram: { label: 'RAM', pillar: 'memory', iw: 0.6, secs: 4, input: { type: 'number', label: 'Size per worker', unit: 'MB', min: 16, max: 128, step: 16, default: 128, cap: 'Total up to 12 % of device memory.' }, hint: 'It copies big blocks of memory and times it. Models stream their weights at this speed.' },
  storage: { label: 'Storage', pillar: 'storage', iw: 1, secs: 6, input: { type: 'number', label: 'File size', unit: 'MB', min: 16, max: 512, step: 16, default: 128, cap: 'Up to 10 % of free space.' }, hint: 'It writes and reads a file in browser storage. The file is deleted afterwards.' },
  gpu: { label: 'GPU', pillar: 'gpu', iw: 1, secs: 5, input: { type: 'number', label: 'Grid size', unit: '', min: 512, max: 4096, step: 512, default: 1024, cap: 'Buffers up to 256 MB.' }, hint: 'The graphics chip multiplies two big grids of numbers through WebGPU.' },
  net: { label: 'Network', pillar: null, iw: 0, secs: 10, input: { type: 'url', label: 'Test file link', default: '', cap: 'Needs https. Up to 100 MB or 15 s.' }, hint: 'It times small requests and a short download. Shown apart. It is not in the score.' },
  energy: { label: 'Energy', pillar: null, iw: 0, secs: 0, input: null, hint: 'Test all records the power of every test. In a browser this is an estimate. It is not in the score.' },
}
interface Info { id: ComponentId; label: string; pillar: string | null; iw: number; secs: number; input: InputSchema | null; hint: string }
function infoOf(id: ComponentId): Info {
  const fb = FB[id], row = rowFor(id)
  return { id, label: row?.label ?? fb?.label ?? id, pillar: row ? row.pillar : fb?.pillar ?? null, iw: row ? row.weight : fb?.iw ?? 0, secs: fb?.secs ?? 5, input: row ? row.input : fb?.input ?? null, hint: fb?.hint ?? '' }
}

const num = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : n >= 10 ? 1 : d || 2 })
const relCi = (r: TestResult) => (r.value > 0 && r.ci95 ? ((r.ci95[1] - r.ci95[0]) / 2 / r.value) * 100 : r.cv ?? 0)

/* ---- UI state: selection, the drawer tab, the running batch; the run state itself lives in useHW ---- */
interface UIs {
  batch: { ids: ComponentId[]; t0: number } | null; cancelled: boolean
  sel: { id: ComponentId; n: number } | null; tab: string
  open: string | null; more: boolean
  /** a Test all finished in this session (its score shows even if a test failed) */
  batchDone: boolean
}
const useUI = create<UIs>(() => ({ batch: null, cancelled: false, sel: null, tab: 'score', open: 'compute', more: false, batchDone: false }))
const useResults = (): Record<string, TestResult> => useHW((s) => s.results)
const useRunning = (): ComponentId | null => useHW((s) => s.running)
const useErr = (id: string): string | undefined => useHW((s) => s.testErrors[id]) || undefined
function useProg(id?: string) {
  const real = useHW((s) => s.progress)
  const running = useRunning()
  return real && running && (!id || running === id) ? real : null
}

const busyNow = () => !!useHW.getState().running || !!useUI.getState().batch || useHW.getState().benchRunning

/**
 * The one place a finished Test all produces the final score. Called once per completed Test all (not on cancel),
 * with the score as shown. The leaderboard submit goes here, as a single call.
 */
export function onFinalScore(f: Final): void {
  void f
}

/** Test all: the one batch. Records power while it runs (useHW.runAll), then hands the final score to onFinalScore. */
async function testAll() {
  if (busyNow()) return
  useUI.setState({ batch: { ids: TEST_IDS, t0: Date.now() }, cancelled: false })
  let ran = 0
  try { ran = await useHW.getState().runAll(TEST_IDS) } finally {
    const cancelled = useUI.getState().cancelled
    useUI.setState({ batch: null, cancelled: false, ...(ran && !cancelled ? { batchDone: true } : {}) })
    if (ran && !cancelled) { const h = useHW.getState(), f = computeFinal(h.results, h.history); if (f.score != null) onFinalScore(f) }
  }
}
async function runOne(id: ComponentId, input?: number | string | null) { if (!busyNow()) await useHW.getState().runComponent(id, input ?? null) }
function cancelAll() {
  useUI.setState({ cancelled: true })
  useHW.getState().cancel()
}
/** One name per part (C8): CPU, Memory, GPU, Storage, plus Model. */
const PILLARS: { id: string; label: string; hue: string; ids: ComponentId[] }[] = [
  { id: 'compute', label: 'CPU', hue: 'var(--pillar-compute, #7c5cff)', ids: ['cpu1', 'cpun'] },
  { id: 'memory', label: 'Memory', hue: 'var(--pillar-memory, #22d3ee)', ids: ['ram', 'cache'] },
  { id: 'gpu', label: 'GPU', hue: 'var(--pillar-gpu, #ff7ab6)', ids: ['gpu'] },
  { id: 'storage', label: 'Storage', hue: 'var(--pillar-storage, #a3e635)', ids: ['storage'] },
  { id: 'model', label: 'Model', hue: 'var(--pillar-model, #ffa94d)', ids: [] },
]
const pillarOf = (id: string) => PILLARS.find((p) => p.id === id || p.ids.includes(id as ComponentId) || (p.id === 'model' && id.startsWith('model')))?.id ?? (id === 'net' || id === 'energy' ? 'more' : null)
const select = (id: ComponentId) => {
  useStore.getState().setRail('machine', true)
  const pl = pillarOf(id)
  useUI.setState((u) => ({ sel: { id, n: (u.sel?.n ?? 0) + 1 }, tab: 'score', open: pl && pl !== 'more' ? pl : u.open, more: pl === 'more' ? true : u.more }))
}

/* ---- final score: S3's finalScore ---- */
const PILLAR_LABEL: Record<string, string> = Object.fromEntries(PILLARS.map((p) => [p.id, p.label]))
const PILLAR_CARD: Record<string, ComponentId> = { compute: 'cpu1', memory: 'ram', gpu: 'gpu', storage: 'storage' }
export interface Final { score: number | null; lo: number | null; hi: number | null; tested: number; total: number; provisional: boolean; limiting: string | null; tier: string; pillars: PillarRow[] | null; delta: number | null; rows: { id: ComponentId; label: string; score: number }[] }
function overallDelta(res: Record<string, TestResult>, history: Snapshot[], now: number): number | null {
  const last = history[history.length - 1], prev = last && last.results === res ? history[history.length - 2] : last
  try { return prev ? Math.round(now) - Math.round(finalScore(prev.results).score) || null : null } catch { return null }
}
function computeFinal(res: Record<string, TestResult>, history: Snapshot[] = []): Final {
  const have = TEST_IDS.filter((i) => res[i] && !res[i].flags.includes('cancelled'))
  const rows = have.map((i) => ({ id: i, label: infoOf(i).label, score: componentScore(res[i]) })).filter((r): r is { id: ComponentId; label: string; score: number } => r.score != null && r.score > 0)
    .map((r) => ({ ...r, score: Math.round(r.score) }))
  const base: Final = { score: null, lo: null, hi: null, tested: have.length, total: TEST_IDS.length, provisional: true, limiting: null, tier: tierOf(null), pillars: null, delta: null, rows }
  if (!have.length) return base
  try {
    const f = finalNow(res, history)
    return { ...base, score: Math.round(f.score), lo: Math.round(f.ci95[0]), hi: Math.round(f.ci95[1]), provisional: f.provisional, limiting: f.limiting, tier: f.tier, pillars: f.pillars, delta: overallDelta(res, history, f.score) }
  } catch { return base }   // results of two scales cannot be combined
}
const useFinal = () => { const r = useResults(), h = useHW((s) => s.history); return useMemo(() => computeFinal(r, h), [r, h]) }
/** C11: the number and tier show only once every test ran (or a Test all finished); before that, "2 / 6". */
const useComplete = (f: Final) => { const done = useUI((s) => s.batchDone); return f.score != null && (f.tested === f.total || done) }
/** "Weakest" always names a part (a pillar), never a single test (C8). */
const weakOf = (f: Final) => { const p = f.limiting ? pillarOf(f.limiting) : null; return p && p !== 'more' ? p : null }
const relPct = (f: Final) => (f.score && f.lo != null && f.hi != null ? Math.max(1, Math.round(((f.hi - f.lo) / 2 / f.score) * 100)) : null)
const arrow = (d: number) => `${d > 0 ? '↑' : '↓'} ${Math.abs(d)}`

/* ---- badges ---- */
function Badge({ kind }: { kind: 'measured' | 'estimated' | 'na' }) {
  return kind === 'measured' ? <span className="t5-badge m">● measured</span> : kind === 'estimated' ? <span className="t5-badge e">≈ estimated</span> : <span className="t5-badge n">— not available</span>
}
const NA_MSG: Record<string, string> = { gpu: 'No WebGPU on this device. Try a browser that has it.', storage: 'Browser storage is off here. Leave private mode, then try again.' }
const FLAG_WORD: Record<string, string> = { noisy: 'noisy', 'hidden-tab': 'tab hidden', 'on-battery': 'on battery', 'not-isolated': 'shared', 'coarse-timer': 'coarse timer', 'software-gpu': 'software GPU', 'size-halved': 'size halved', cancelled: 'cancelled', custom: 'custom' }

function validate(id: ComponentId, raw: string, caps: any): string | null {
  const row = rowFor(id)
  if (!row?.input) return null
  const v = raw.trim() === '' && row.input.type !== 'number' ? null : row.input.type === 'number' ? (raw.trim() === '' ? NaN : Number(raw)) : raw
  if (typeof v === 'number' && !isFinite(v)) return 'Type a number.'
  const r = validateInput(row, v, caps)
  return r.ok ? null : r.error
}

/** One result: the score (or the raw value when unscored), the value, and ONE honesty badge (C12). Flags go in the tooltip. */
function ResultRow({ r, custom }: { r: TestResult; custom?: boolean }) {
  const scored = r.score != null && !custom
  const est = r.flags.includes('estimated')
  const ci = relCi(r)
  const flags = r.flags.filter((f) => f !== 'estimated' && f !== 'custom').map((f) => FLAG_WORD[f] ?? (f.startsWith('fallback') ? 'fallback' : f))
  return (
    <div className="t5-row t5-res" title={flags.length ? `Notes: ${flags.join(', ')}` : undefined}>
      <span className={`t5-chip ${scored ? 'solid' : 'dash'}`}>{scored ? `${num(r.score as number)} ±${Math.max(1, Math.round(ci))}%` : `${num(r.value, 1)} ${r.unit}`}</span>
      {scored && <span className="mono t5-dim">{num(r.value, 1)} {r.unit}</span>}
      {custom && <span className="t5-dim" data-detail>Custom. Not scored.</span>}
      <Badge kind={est ? 'estimated' : 'measured'} />
    </div>
  )
}

function TestCard({ id }: { id: ComponentId }) {
  const info = infoOf(id)
  const res = useResults()
  const r = res[id]
  const rc = res[`${id}#custom`] ?? (r?.input.kind === 'custom' ? r : undefined)
  const std = r?.input.kind === 'custom' ? undefined : r
  const running = useRunning(), batch = useUI((s) => !!s.batch)
  const rawErr = useErr(id)
  const na = !!std && isUnavailable(std)
  const err = na ? NA_MSG[id] ?? 'This device cannot run this test.' : rawErr && /is not a function|not implemented|undefined|null/i.test(rawErr) ? 'This test is not ready. Reload the page, then try again.' : rawErr
  const caps = useHW((s) => s.caps)
  const sel = useUI((s) => s.sel)
  const prog = useProg(id)
  const mine = running === id
  const inp0 = info.input
  const [own, setOwn] = useState(false)
  const [raw, setRaw] = useState(String(info.input?.default ?? ''))
  const [shown, setShown] = useState(false)
  const [flash, setFlash] = useState(false)
  const el = useRef<HTMLElement>(null)
  const inp = info.input
  const row = rowFor(id), lim = row ? inputLimits(row, caps) : null
  const defVal = inp0 ? (inp0.type === 'number' && lim ? Math.min(lim.max, Math.max(lim.min, Number(inp0.default))) : inp0.default) : ''
  const bad = own && inp ? validate(id, raw, caps) : null
  const showErr = !!bad && shown
  useEffect(() => {
    if (!sel || sel.id !== id) return
    el.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    setFlash(true); const t = setTimeout(() => setFlash(false), 1600); return () => clearTimeout(t)
  }, [sel, id])
  const state = mine ? 'running' : err ? 'error' : std || rc ? 'result' : 'idle'
  const defLine = id === 'energy' ? 'Recorded by Test all.' : `~${info.secs} s`
  const pct = Math.round((prog?.fraction ?? 0) * 100)
  const tick = Math.round(pct / 10) * 10
  const energy = id === 'energy' ? Object.values(res).reduce((a, x) => a + (x.component !== 'energy' ? x.energy?.joules ?? 0 : 0), 0) : 0
  const line = state === 'running' ? `Running. ${tick} % done.` : state === 'error' ? err : state === 'result' ? (std ? 'Done.' : 'Done. Custom run.') : id === 'energy' && energy > 0 ? `${num(energy, 1)} J across your tests.` : defLine
  const memErr = !!err && /memory|too big|size/i.test(err)
  const naErr = na || (!!err && /not available|no webgpu|not supported|unsupported|no opfs/i.test(err))
  const half = inp?.type === 'number' && lim ? Math.max(lim.min, Math.round(Number(defVal) / 2)) : null
  const onTest = () => { setShown(true); if (bad) return; runOne(id, own && inp && raw !== '' ? (inp.type === 'number' ? Number(raw) : raw) : undefined) }
  const smaller = () => { if (half != null) { setOwn(true); setRaw(String(half)); runOne(id, half) } }
  return (
    <section ref={el} id={`t5-${id}`} className={`card t5-card ${flash ? 'sel' : ''}`} aria-label={info.label} data-card={id} data-state={state} tabIndex={-1}>
      <div className="t5-row t5-head">
        <h4>{info.label}<Hint label={`About ${info.label}`}>{info.hint}</Hint></h4>
        {state === 'error' && naErr ? <Badge kind="na" /> : id === 'energy' ? <Badge kind={energy > 0 ? (useHW.getState().source === 'companion' ? 'measured' : 'estimated') : 'na'} /> : null}
        {id !== 'energy' && (mine
          ? <button type="button" className="t5-btn" onClick={cancelAll}>Cancel</button>
          : <button type="button" className="t5-btn" disabled={!!running || batch || !!bad} onClick={onTest} data-test={id} aria-describedby={`t5-${id}-line`}>{state === 'result' ? 'Test again' : 'Test'}</button>)}
      </div>
      {state === 'error'
        ? <div className="t5-err" data-error role="alert"><p id={`t5-${id}-line`} className="t5-line bad" aria-live="polite">{line}</p>
          <button type="button" className="t5-btn" disabled={!!running || batch} onClick={memErr && half != null ? smaller : onTest}>{memErr && half != null ? 'Try a smaller size' : naErr ? 'Check again' : 'Try again'}</button></div>
        : <p id={`t5-${id}-line`} className="t5-line" aria-live="polite" {...(id === 'energy' && energy > 0 ? { 'data-est': '' } : {})}>{line}</p>}
      {mine && <div className="t5-prog"><div className="t5-bar" role="progressbar" aria-label={`${info.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
        <span className="mono t5-live">{prog?.value != null ? `${num(prog.value, 1)} ${prog.unit ?? ''}` : `${pct} %`}</span></div>}
      {!mine && std && !na && <ResultRow r={std} />}
      {!mine && rc && <ResultRow r={rc} custom />}
      {inp && id !== 'energy' && !mine && (
        <div className="t5-own">
          <button type="button" className="t5-link" aria-expanded={own} aria-controls={`t5-${id}-f`} onClick={() => { setOwn(!own); setShown(false) }}>{own ? 'Use the default' : 'Advanced'}</button>
          {own && (
            <div id={`t5-${id}-f`} className="t5-field">
              <label htmlFor={`t5-${id}-i`}>{inp.label}</label>
              <div className="t5-row">
                <input id={`t5-${id}-i`} className="t5-in" type={inp.type === 'number' ? 'number' : 'url'} inputMode={inp.type === 'number' ? 'numeric' : 'url'} min={inp.min} max={inp.max} step={inp.step} value={raw}
                  aria-invalid={showErr} aria-describedby={`t5-${id}-e`} placeholder={inp.type === 'url' ? 'https://' : undefined}
                  onChange={(e) => { setRaw(e.target.value); setShown(true) }} onBlur={() => setShown(true)} onKeyDown={(e) => { if (e.key === 'Enter') onTest(); if (e.key === 'Escape') setOwn(false) }} />
                {inp.unit && <span className="t5-dim">{inp.unit}</span>}
              </div>
              <p id={`t5-${id}-e`} className={`t5-line ${showErr ? 'bad' : ''}`} role={showErr ? 'alert' : undefined}>{showErr ? bad : `${lim ? `${lim.min} to ${lim.max}${inp.unit ? ' ' + inp.unit : ''}. ` : ''}${inp.cap ?? ''}`}</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/* ---- share ---- */
function deviceClass(res: Record<string, TestResult>): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const w = Object.values(res).map((r) => r.env.where)
  return `${b} · ${w.includes('companion') ? 'Companion' : w.includes('webgpu') ? 'WebGPU' : 'WebAssembly'}`
}
function drawShare(f: Final, dev: string, name: string | null, who = ''): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630
  const g = c.getContext('2d')!
  const sans = '"Segoe UI", Inter, system-ui, sans-serif'
  g.fillStyle = '#0a0e19'; g.fillRect(0, 0, 1200, 630)
  g.fillStyle = '#ffa94d'; g.fillRect(0, 0, 400, 8)
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#9aa5c7'; g.font = `600 26px ${sans}`; g.fillText(who ? `${who} · device score` : 'Kundali · device score', 64, 90)
  g.fillStyle = '#ffa94d'; g.font = `700 150px ${sans}`; g.fillText(f.score != null ? `▲ ${f.score.toLocaleString('en-US')}` : 'Not tested', 56, 270)
  g.fillStyle = '#e8ecf8'; g.font = `600 44px ${sans}`; g.fillText(f.tier, 64, 336)
  g.fillStyle = '#c3cbe6'; g.font = `400 30px ${sans}`
  g.fillText(`${f.tested} of ${f.total} tested${relPct(f) != null ? ` · ±${relPct(f)} %` : ''}`, 64, 394)
  if (f.provisional) { g.fillStyle = '#ffd36b'; g.fillText('Provisional. Some parts are not tested.', 64, 438) }
  g.fillStyle = '#b9a6ff'; g.font = `600 26px ${sans}`; g.fillText('≈ estimated in your browser', 64, f.provisional ? 486 : 438)
  g.fillStyle = '#9aa5c7'; g.font = `600 22px ${sans}`; g.fillText('By part', 700, 90)
  f.rows.slice(0, 7).forEach((r, i) => {
    const y = 120 + i * 56
    g.fillStyle = '#e8ecf8'; g.font = `400 24px ${sans}`; g.fillText(r.label, 700, y + 24)
    g.fillStyle = '#27314f'; g.fillRect(920, y + 8, 150, 14)
    g.fillStyle = '#ffa94d'; g.fillRect(920, y + 8, Math.max(4, Math.min(150, (r.score / 2000) * 150)), 14)
    g.fillStyle = '#e8ecf8'; g.font = `600 24px ${sans}`; g.textAlign = 'right'; g.fillText(r.score.toLocaleString('en-US'), 1140, y + 24); g.textAlign = 'left'
  })
  g.fillStyle = '#27314f'; g.fillRect(64, 548, 1072, 2)
  g.fillStyle = '#9aa5c7'; g.font = `400 26px ${sans}`
  g.fillText(`${dev}${name ? ' · ' + name : ''}`, 64, 592)
  g.textAlign = 'right'; g.fillText(new Date().toISOString().slice(0, 10), 1136, 592); g.textAlign = 'left'
  return c
}
function download(href: string, name: string) { const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove() }

function SharePanel({ f, name: who, onClose }: { f: Final; name: string; onClose: () => void }) {
  const res = useResults()
  const info = useHW((s) => s.info)
  const [withName, setWithName] = useState(false)
  const [msg, setMsg] = useState('')
  const name = withName ? (info?.cpu?.name ?? info?.cpu?.model ?? null) : null
  const url = useMemo(() => drawShare(f, deviceClass(res), name, who).toDataURL('image/png'), [f, res, name, who])
  const link = () => `${location.origin}${location.pathname}#score=${f.score}&tested=${f.tested}of${f.total}`
  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500) }
  const json = () => {
    const txt = exportResults({ includeDevice: withName, includeName: true }, res, info, who)
    const u = URL.createObjectURL(new Blob([txt], { type: 'application/json' })); download(u, 'kundali-results.json'); setTimeout(() => URL.revokeObjectURL(u), 1000)
  }
  const copy = async () => { try { history.replaceState(null, '', link()); await navigator.clipboard.writeText(link()); say('Link copied.') } catch { say('Could not copy. Use the address bar.') } }
  const share = async () => {
    try {
      const blob = await (await fetch(url)).blob(), file = new File([blob], 'kundali-score.png', { type: 'image/png' })
      const data: any = { title: 'My device score', text: `▲ ${f.score} · ${f.tested} of ${f.total} tested`, url: link() }
      if ((navigator as any).canShare?.({ files: [file] })) data.files = [file]
      await navigator.share(data)
    } catch (e: any) { if (e?.name !== 'AbortError') say('Sharing failed. Save the image instead.') }
  }
  return (
    <div className="t5-share" role="group" aria-label="Share your score" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <img src={url} alt={`Share card: score ${f.score}, ${f.tier}`} width={1200} height={630} className="t5-prev" data-testid="share-img" />
      <label className="t5-chk"><input type="checkbox" checked={withName} onChange={(e) => setWithName(e.target.checked)} /> Add my device name</label>
      <div className="t5-row">
        <button type="button" className="t5-btn" onClick={() => download(url, 'kundali-score.png')}>Save image</button>
        <button type="button" className="t5-btn" onClick={json}>Save data</button>
        <button type="button" className="t5-btn" onClick={copy}>Copy link</button>
        {typeof navigator !== 'undefined' && 'share' in navigator && <button type="button" className="t5-btn" onClick={share}>Share…</button>}
        <button type="button" className="t5-btn" onClick={onClose}>Close</button>
      </div>
      <p className="t5-line" aria-live="polite">{msg || 'The image has no host name and no browser string.'}</p>
    </div>
  )
}

function useDeviceName() { return useStore((s) => s.name) }
/** The score at the top of the drawer. Test all lives only in the strip (C1); this card's button is Share. */
function ScoreHero() {
  const f = useFinal()
  const complete = useComplete(f)
  const name = useDeviceName()
  const res = useResults()
  const [open, setOpen] = useState(false)
  // one tap: a phone opens its share sheet, a desktop saves the PNG
  const shareNow = async () => {
    const url = drawShare(f, deviceClass(res), null, name).toDataURL('image/png')
    if (typeof navigator !== 'undefined' && 'share' in navigator && matchMedia('(pointer: coarse)').matches) {
      try { const file = new File([await (await fetch(url)).blob()], 'kundali-score.png', { type: 'image/png' }); const d: any = { title: 'My device score', text: `▲ ${f.score ?? '—'} · ${f.tested} of ${f.total} tested` }; if ((navigator as any).canShare?.({ files: [file] })) d.files = [file]; await navigator.share(d); return } catch (e: any) { if (e?.name === 'AbortError') return }
    }
    download(url, 'kundali-score.png')
  }
  const browser = useHW((s) => s.source !== 'companion')
  const delta = complete ? f.delta : null
  const r = relPct(f)
  const weak = weakOf(f)
  return (
    <div className="card t5-hero" data-hero aria-label="Device score">
      <div className="t5-kick">Your device{name ? ` · ${name}` : ''}</div>
      <div className="t5-big" aria-live="polite">
        {complete
          ? <><b className="t5-score">▲ <Counter value={f.score} /></b><span className="t5-tier">{f.tier}</span><span>{f.tested} of {f.total} tested{r != null ? ` · ±${r} %` : ''}</span></>
          : <><b className="t5-score">{f.tested} / {f.total}</b><span>tested. Test all for your score.</span></>}
      </div>
      <div className="t5-row">
        {browser && <span className="t5-badge e">≈ estimated in your browser</span>}
        {complete && f.provisional && <span className="t5-dim">Provisional.</span>}
        {delta != null && <span className="t5-dim mono">{arrow(delta)} vs last run</span>}
      </div>
      {complete && weak && <p className="t5-line">Weakest: <button type="button" className="t5-link" onClick={() => select(PILLAR_CARD[weak] ?? 'cpu1')}>{PILLAR_LABEL[weak]}</button></p>}
      <div className="t5-row">
        <button type="button" className="t5-btn" data-share disabled={!complete} onClick={shareNow}>Share</button>
        <button type="button" className="t5-link" aria-expanded={open} disabled={!complete} onClick={() => setOpen(!open)}>{open ? 'Fewer options' : 'More options'}</button>
      </div>
      {open && complete && <SharePanel f={f} name={name} onClose={() => setOpen(false)} />}
    </div>
  )
}

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
/** Log scale: 100 is empty, 2000 is full. */
const logPct = (s: number | null) => (s && s > 0 ? Math.max(2, Math.min(100, (Math.log(s / 100) / Math.log(20)) * 100)) : 0)
const PILLAR_HINT: Record<string, string> = {
  compute: 'How fast the processor does maths. One core, then all cores.',
  memory: 'How fast data moves in RAM and cache. Models stream their weights from here.',
  gpu: 'The graphics chip multiplies big grids of numbers.',
  storage: 'How fast the browser writes and reads a file.',
  model: 'How fast this device runs a real AI model. Run one in the Model section.',
}

function ModelRows() {
  const res = useResults()
  const rows = Object.values(res).filter((r) => r.component.startsWith('model:'))
  if (!rows.length) return <p className="t5-line" data-detail>Run a model in the Model section. Its speed counts here.</p>
  return <>{rows.map((r) => (
    <div key={r.component} className="card t5-card" data-card={r.component}>
      <div className="t5-row t5-head"><h4>{r.component.slice(6).split('/').pop()}</h4></div>
      <ResultRow r={r} />
    </div>
  ))}</>
}

function PillarRowView({ p, f }: { p: (typeof PILLARS)[number]; f: Final }) {
  const open = useUI((u) => u.open === p.id)
  const st = f.pillars?.find((x) => x.id === p.id)
  const score = st && st.status === 'measured' && st.score != null ? Math.round(st.score) : null
  const delta = score != null && st?.delta ? Math.round(st.delta) : null
  const set = () => flushSync(() => useUI.setState({ open: open ? null : p.id }))
  return (
    <div data-open={open ? '1' : '0'} className={`t5-prow ${open ? 'open' : ''}`} style={{ ['--hue' as any]: p.hue }} data-pillar={p.id}>
      <div className="t5-phead">
        <button type="button" className="t5-pmain" aria-expanded={open} aria-controls={`t5-p-${p.id}`} onClick={set}>
          <span className="t5-plab"><i aria-hidden="true" />{p.label}</span>
          <span className="t5-pbar" aria-hidden="true"><motion.i initial={{ width: 0 }} animate={{ width: `${logPct(score)}%` }} transition={reduced() ? { duration: 0 } : { type: 'spring', duration: 0.5, bounce: 0.15 }} /></span>
          <b className="t5-pnum mono">{score != null ? <Counter value={score} /> : st?.status === 'unavailable' ? 'n/a' : '—'}</b>
          <span className="t5-pdelta mono">{delta != null ? arrow(delta) : ''}</span>
        </button>
        <Hint label={`About ${p.label}`}>{PILLAR_HINT[p.id]}</Hint>
      </div>
      {open && (
        <div id={`t5-p-${p.id}`} className="t5-pbody">
          {p.ids.length ? p.ids.map((id) => <TestCard key={id} id={id} />) : <ModelRows />}
        </div>
      )}
    </div>
  )
}

function TestsTab() {
  const f = useFinal()
  const more = useUI((u) => u.more)
  return (
    <div className="t5-list">
      <ScoreHero />
      <div className="t5-rows">{PILLARS.map((p) => <PillarRowView key={p.id} p={p} f={f} />)}</div>
      <div className="t5-more">
        <button type="button" className="t5-link t5-moreb" aria-expanded={more} onClick={() => useUI.setState({ more: !more })}>More {more ? '▴' : '▾'} <span className="t5-dim">Network · Energy</span></button>
        {more && <div className="t5-pbody">{(['net', 'energy'] as ComponentId[]).map((id) => <TestCard key={id} id={id} />)}</div>}
      </div>
    </div>
  )
}

/* ---- score strip: one slim line, always visible. Rest: "▲661 Everyday" + Test all; the rest on hover/focus/tap. ---- */
function ScoreStrip() {
  const f = useFinal()
  const complete = useComplete(f)
  const running = useRunning(), batch = useUI((s) => s.batch)
  const prog = useProg(running ?? undefined)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t) }, [running])
  const idx = batch && running ? Math.max(0, batch.ids.indexOf(running)) : 0
  const frac = batch ? (idx + (prog?.fraction ?? 0)) / batch.ids.length : prog?.fraction ?? 0
  const secs = batch ? Math.round((now - batch.t0) / 1000) : 0
  const r = relPct(f), weak = weakOf(f)
  const browser = useHW((s) => s.source !== 'companion')
  return (
    <div className="card t5-strip" data-score-strip data-card="strip" role="group" aria-label="Device score">
      {running
        ? <>
          {batch && <b className="t5-scount mono">{idx + 1}/{batch.ids.length}</b>}
          <span className="t5-srun mono"><span className="t5-slab">{infoOf(running).label}{batch ? ` · ${secs} s` : ''}</span>
            <span className="t5-bar" role="progressbar" aria-label="Test progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}><i style={{ width: `${Math.round(frac * 100)}%` }} /></span></span>
          <button type="button" className="t5-btn" onClick={cancelAll}>Cancel</button></>
        : <>
          <Peek label="Device score details" summary={complete
            ? <><b className="t5-ssc" data-score={f.score!}>▲{f.score!.toLocaleString('en-US')}</b><span className="t5-stier">{f.tier}</span></>
            : <span className="t5-sinfo"><b className="mono">{f.tested} / {f.total}</b> tested</span>}>
            <p className="t5-line">{f.tested} of {f.total} tested{complete && r != null ? ` · ±${r} %` : ''}{complete && f.provisional ? '. Provisional.' : ''}</p>
            {complete && weak && <p className="t5-line">Weakest: <button type="button" className="t5-link" onClick={() => select(PILLAR_CARD[weak] ?? 'cpu1')}>{PILLAR_LABEL[weak]}</button></p>}
            {!complete && <p className="t5-line">Test all runs six short tests, about 30 s.</p>}
            {browser && <span className="t5-badge e">≈ estimated in your browser</span>}
          </Peek>
          <button type="button" className="t5-btn pri" data-testall data-test="all" disabled={!!batch} onClick={testAll}>{complete ? 'Test again' : 'Test all'}</button></>}
    </div>
  )
}
function StripHost() {
  const [slot, setSlot] = useState<HTMLElement | null>(() => document.getElementById('score-strip-slot'))
  useEffect(() => {
    if (slot) return
    let n = 0; const t = setInterval(() => { const e = document.getElementById('score-strip-slot'); if (e) { setSlot(e); clearInterval(t) } else if (++n > 20) clearInterval(t) }, 500)
    return () => clearInterval(t)
  }, [slot])
  return slot ? createPortal(<ScoreStrip />, slot) : <div className="t5-inline"><ScoreStrip /></div>
}

const T5_CSS = `
.t5-list{display:grid;gap:10px;align-content:start}
.t5-hero,.t5-card{border:1px solid var(--line);background:var(--surface,#141c32);border-radius:var(--r-md,12px);padding:12px;display:grid;gap:8px;scroll-margin:8px;min-width:0}
.t5-hero{background:var(--surface2,#1b2542)}
.t5-card.sel{border-color:var(--pos);box-shadow:0 0 0 2px color-mix(in srgb,var(--pos) 30%,transparent)}
@media (pointer:coarse),(max-width:600px){.main.machine .mtl button,.main.machine .mtl select,.main.machine .tabs button,.main.machine .crumbs button,.main.machine .startj,.main.machine .ib,.main.machine .btn,.main.machine .btn2{min-height:44px;min-width:44px}}
@media (max-width:900px){
.main.machine .stage.powerview{display:flex;flex-direction:column;min-height:0}
.main.machine .stage.powerview .scenewrap{position:relative;inset:auto;flex:1 1 auto;min-height:320px;order:1}
.main.machine .stage.powerview .stagebottom{position:static;order:2;margin:8px 14px 12px;flex:none}
}
@media (max-width:600px){.main.machine .mcol{top:12px}}
@media (min-width:901px){
.main.machine{position:relative;grid-template-columns:minmax(0,1fr)!important}
.main.machine>.inspector{position:absolute;right:0;top:0;bottom:0;width:min(380px,100%);z-index:30;box-shadow:-12px 0 32px #0006}
}
.main.machine .stagebottom{left:56px}
@media (max-width:900px){.main.machine .stage.powerview .stagebottom{margin-left:56px}}
.t5-err{display:grid;gap:6px;justify-items:start}
.t5-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.t5-head h4{margin:0;flex:1;font-size:14px;display:flex;align-items:center;gap:4px}
.t5-big{font-size:14px;color:var(--muted);line-height:1.3;display:flex;align-items:baseline;flex-wrap:wrap;gap:0 6px}
.t5-score{font:700 var(--t4,44px)/1.05 var(--display);letter-spacing:-.02em;background:var(--brand,linear-gradient(135deg,var(--pos),var(--neg)));-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.t5-kick{font:600 13px var(--body);color:var(--muted);overflow-wrap:anywhere}
.t5-tier{font:600 var(--t1,16px) var(--display);color:var(--fg);margin:0 6px}
.t5-list{padding:8px}
.t5-rows{display:grid}
.t5-prow{border-top:1px solid var(--line)}
.t5-phead{display:flex;align-items:center;gap:4px}
.t5-pmain{flex:1;min-width:0;display:grid;grid-template-columns:minmax(86px,104px) minmax(36px,1fr) 52px 44px;align-items:center;gap:8px;min-height:var(--hit,40px);background:none;border:0;color:var(--fg);cursor:pointer;text-align:left;padding:0 4px;font:600 13px var(--body)}
.t5-plab i{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--hue);margin-right:8px;vertical-align:1px}
.t5-pbar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;display:block}
.t5-pbar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--hue),color-mix(in srgb,var(--hue) 55%,var(--fg)))}
.t5-pnum{text-align:right;font-variant-numeric:tabular-nums}
.t5-pdelta{font-size:12px;color:var(--muted)}
.t5-pbody{display:grid;gap:8px;padding:4px 0 12px}
.t5-more{border-top:1px solid var(--line)}.t5-moreb{display:flex;gap:6px;align-items:center;text-decoration:none;color:var(--fg)}
.t5-strip.card{border:0;border-radius:0;background:transparent}
.t5-strip{display:flex;align-items:center;flex-wrap:nowrap;gap:4px 12px;padding:0 12px;height:52px;white-space:nowrap;contain:layout;min-width:0}
.t5-strip>.peek{flex:1 1 auto;min-width:0}
.t5-strip .peek-sum{overflow:hidden}
.t5-ssc{font:700 var(--t2,20px) var(--display);background:var(--brand,linear-gradient(135deg,var(--pos),var(--neg)));-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.t5-scount{font:700 15px var(--mono);font-variant-numeric:tabular-nums;color:var(--fg)}
.t5-stier{font:600 13px var(--display)}.t5-sinfo{font-size:13px;color:var(--muted)}.t5-sinfo b{color:var(--fg);font-size:15px}
.t5-srun{display:flex;align-items:center;gap:10px;font-size:12.5px;flex:1;min-width:0}
.t5-slab{overflow:hidden;text-overflow:ellipsis;min-width:0}
.t5-srun .t5-bar{min-width:48px}
.t5-strip>.t5-btn:last-child{margin-left:auto;flex:none}
@media (max-width:600px){.t5-slab{display:none}.t5-score{font-size:var(--t3,28px)}}
.t5-btn{min-height:var(--hit,40px);min-width:var(--hit,40px);padding:0 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;font:600 13px var(--body);white-space:nowrap}
.t5-btn:hover:not(:disabled){border-color:var(--muted)}
.t5-btn.pri{background:var(--pos);color:#0a0e19;border-color:transparent}
.t5-btn.pri:focus-visible{outline:2px solid #0a0e19;outline-offset:-4px;box-shadow:0 0 0 2px var(--fg)}
.t5-btn.pri:hover:not(:disabled){filter:brightness(1.08)}
.t5-btn:disabled{opacity:.45;cursor:default}
.t5-link{background:none;border:0;color:var(--neg-ink,#86beff);cursor:pointer;font:600 13px var(--body);min-height:var(--hit,40px);padding:0 4px;text-decoration:underline}
.t5-link:disabled{opacity:.45;cursor:default}
.t5-line{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.t5-line.bad{color:var(--bad)}
.t5-dim{color:var(--muted);font-size:12.5px}
.t5-bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;flex:1}
.t5-bar i{display:block;height:100%;background:var(--pos);transition:width var(--d2,220ms) var(--ease,ease)}
.t5-prog{display:flex;align-items:center;gap:10px}
.t5-live{font-size:12.5px;color:var(--fg);min-width:92px;text-align:right}
.t5-chip{font:600 13px var(--mono);border-radius:999px;padding:3px 10px;white-space:nowrap}
.t5-chip.solid{background:color-mix(in srgb,var(--pos) 18%,transparent);color:var(--pos-ink,#ffb867);border:1px solid var(--pos)}
.t5-chip.dash{border:1px dashed var(--neg);color:var(--neg-ink,#86beff)}
.t5-badge{font:600 12px var(--body);border-radius:999px;padding:2px 8px;border:1px solid var(--line);white-space:nowrap;justify-self:start;width:max-content}
.t5-badge.m{color:var(--ok)}.t5-badge.e{color:var(--est,#b9a6ff)}.t5-badge.n{color:var(--muted)}
.t5-field{display:grid;gap:4px;margin-top:4px}.t5-field label{font-size:12.5px;color:var(--muted)}
.t5-field .t5-in{flex:0 0 auto;max-width:60%;min-height:var(--hit,40px);width:140px;background:var(--bg,#0a0e19);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:0 10px;font:14px var(--mono)}
.t5-field .t5-in[aria-invalid=true]{border-color:var(--bad)}
.t5-chk{display:flex;align-items:center;gap:8px;min-height:var(--hit,40px);font-size:13px;color:var(--fg)}
.t5-chk input{width:20px;height:20px}
.t5-share{display:grid;gap:8px}.t5-prev{width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
.t5-inline{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--dock,64px) + 8px);width:min(640px,calc(100vw - 16px));z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;box-shadow:0 8px 24px #0008}
@media (pointer:coarse),(max-width:600px){.t5-btn,.t5-link{min-height:44px}.t5-in,.t5-chk{min-height:44px}}
@media (prefers-reduced-motion:reduce){.t5-bar i{transition:none}}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* calm machine HUD (D16): one line at rest; details overlay on hover, focus or tap */
.main.machine .phud{width:auto;max-width:min(320px,calc(100% - 28px));padding:4px 12px;gap:0;border-radius:14px}
.main.machine .phud .peek-sum{gap:8px}
.main.machine .phud .pbig{font-size:28px}
.main.machine .phud .pbig small{font-size:14px}
.main.machine .phud .psub{font-size:13px;color:var(--fg)}
.main.machine .phud .peek-det{min-width:260px}
.main.machine .phud .pbadge{font:600 12px var(--body);text-transform:none;letter-spacing:0}
.main.machine .phud .pbadge span{font:600 12px var(--body)}
.main.machine .phud .prow span{font-size:12px}
.main.machine .phud .pwide{grid-column:1/-1}
.pdot{width:9px;height:9px;border-radius:50%;background:var(--faint);flex:none}
.pdot.recording{background:var(--bad);box-shadow:0 0 10px var(--bad)}
.pdot.live{background:var(--ok);box-shadow:0 0 10px var(--ok)}
.pdot.replay{background:var(--pos);box-shadow:0 0 10px var(--pos)}
.pdot.journey{background:var(--neg);box-shadow:0 0 10px var(--neg)}
@media (max-width:900px){.main.machine .phud{right:auto;top:12px}}
.main.machine .mtl .tlctl{flex-wrap:nowrap;min-width:0}
.main.machine .mtl .tlgrow{flex:1}
.main.machine .mtl .tlstage{font:600 13px var(--body);color:var(--fg);overflow:hidden;text-overflow:ellipsis;max-width:220px}
.main.machine .mtl .pchart.empty{min-height:84px;display:grid;place-items:center;font-size:13px;color:var(--muted);text-align:center;padding:0 12px}
.main.machine .caption .peek-sum h3{margin:0;font-size:1rem}
.main.machine .caption{padding:6px 12px;gap:4px}
.main.machine .caption .peek-det{min-width:min(320px,calc(100vw - 48px));top:auto;bottom:calc(100% + 4px)}
.main.machine .iostrip{padding:4px 12px}
.main.machine .iostrip .peek-det{top:calc(100% + 4px)}
.benchov.slim{padding:6px 14px;gap:8px;font-size:13px;width:min(320px,calc(100% - 28px));height:auto;white-space:nowrap;overflow:hidden;justify-content:flex-start;font-variant-numeric:tabular-nums}
.main.machine .mcol{align-items:flex-start}
.main.machine .mcol .phud .peek-sum .psub{display:inline}
.main.machine .iostrip>.peek{display:block}
.main.machine .ioline{display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:baseline;min-width:0}
.main.machine .iostrip .peek-sum{min-height:32px}
.main.machine .caption.dive{overflow:visible;max-height:none}
.main.machine .caption.dive .peek-det{max-height:46vh;overflow:auto}
.main.machine .lbl{text-transform:none;letter-spacing:0;font:500 13px var(--body)}
@media (max-width:600px){.main.machine .mtl .modes{display:none}}
${PEEK_CSS}
`

function Counter({ value, digits = 0 }: { value: number | null; digits?: number }) {
  const [v, setV] = useState(value ?? 0)
  const from = useRef(value ?? 0)
  useEffect(() => {
    if (value === null) return
    if (reduced()) { from.current = value; setV(value); return }
    const c = animate(from.current, value, { duration: 0.5, ease: 'easeOut', onUpdate: (x) => { from.current = x; setV(x) } })
    return () => c.stop()
  }, [value])
  return <>{value === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}</>
}

const STAGE_LABEL: Record<string, string> = { ...STAGE_NAME, disk: 'Storage', gpu: 'GPU' }

/** One line while a test runs: "Measuring CPU, all cores · 128 GFLOP/s" (C4). */
function BenchOverlay() {
  const running = useHW((s) => s.running)
  const prog = useHW((s) => s.progress)
  const legacy = useHW((s) => (s.benchRunning && !s.running ? s.benchStage : null))
  const live = useHW((s) => s.benchLive)
  const label = running ? infoOf(running).label : legacy && legacy !== 'idle' ? STAGE_LABEL[legacy] ?? legacy : null
  if (!label) return null
  const v = running ? (prog?.value != null ? `${num(prog.value, 1)} ${prog.unit ?? ''}` : null) : live && live.name === legacy ? `${live.value.toLocaleString()} ${live.unit}` : null
  return (
    <div className="benchov slim" role="status">
      <span className="pulse" /> <b>Measuring {label}</b>{v && <span className="mono"> · {v}</span>}
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
  const peaks = useMemo(() => peaksOf({ recorded: !!rec, recordedPack: rec, bench, info }), [rec, bench, info])
  const act = useMemo(() => (journey ? activityAt(journey, tl, playhead, peaks, info?.cpu?.cores ?? 8) : null), [journey, tl, playhead, peaks, info])
  return { journey, act, peaks, info, bench }
}

function Caption() {
  const { journey, act, peaks, info } = usePlay()
  const dive = useHW((s) => s.dive)
  const recorded = useHW((s) => s.recorded)
  const mode = useHW((s) => s.pMode)
  if (!journey || !act || mode !== 'journey') return null
  const c = captionFor(journey, act, peaks, info)
  return (
    <div className="caption">
      <Peek label="This stage" summary={<span className="ctitle"><span className="stg">{act.stage}</span><h3>{c.title}</h3></span>}>
        <p className="t5-line">{c.text}</p>
        <div className="cnums">{c.nums.map((n) => <div key={n.k}><span>{n.k}</span><b className="mono">{n.v}</b></div>)}</div>
        {recorded && <span className="t5-dim">Recorded on the test PC.</span>}
        {c.dive && <button className="btn2 sm" onClick={() => dive(c.dive!.path)}>{c.dive.label} ›</button>}
      </Peek>
    </div>
  )
}

/** The prompt as typed and the answer as written so far, driven by the journey's playhead. */
function IoStrip() {
  const { journey: j, act } = usePlay()
  const mode = useHW((s) => s.pMode)
  if (!j || !act || mode !== 'journey') return null
  const typed: string = j.input.text.slice(0, act.typed)
  const answer: string = j.decode.tokens.slice(0, Math.max(0, act.shown)).map((t: any) => t.text).join('')
  return (
    <div className="iostrip" aria-label="Prompt and answer">
      <Peek label="The prompt" summary={<span className="ioline"><span>model</span><b className="mono">{answer || '…'}{(act.stage === 'decode' || act.stage === 'output') && <i className="caret" />}</b></span>}>
        <div className="ioline"><span>you</span><b className="mono">{typed}{act.stage === 'input' && <i className="caret" />}</b></div>
      </Peek>
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
      <p className="hint small"><b>KV cache</b> · {fmtB(perTok)} per token<Hint>Each token leaves its keys and values in RAM for every block ({fmtB(perTok)} per token = 2 × {j.L} blocks × {d.nkv} kv-heads × {d.hd} numbers × 4 bytes), so a new word only computes itself and reads the rest back.</Hint></p>
      <div className="kvbar" aria-label={`KV cache holds ${now} of ${total} tokens`}><i style={{ width: `${(100 * now) / total}%` }} /><span className="mono">{now} tokens · {fmtB(now * perTok)}</span></div>
    </div>
  )
}

function Micro() {
  const micro = useHW((s) => s.micro)
  if (!micro) return <p className="hint"><span className="pulse" /> computing a real dot product…</p>
  const mx = Math.max(...micro.chunk_sums.map(Math.abs), 1e-6)
  const run = micro.running, lo = Math.min(0, ...run), hi = Math.max(0, ...run)
  const x = scaleLinear().domain([0, run.length - 1]).range([4, 296]), y = scaleLinear().domain([lo, hi]).range([66, 6])
  const path = run.map((v: number, i: number) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return (
    <div className="micro">
      <p className="hint small"><b>{micro.op}</b> · block {micro.layer + 1} · {micro.lanes} numbers per instruction = <b>{micro.fma_instructions}</b> rounds<Hint>One row of the {micro.op} matrix of block {micro.layer + 1} meets the real numbers flowing through the model. The core handles {micro.lanes} numbers per instruction, so the {micro.length} products need {micro.fma_instructions} rounds.</Hint></p>
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
      <p className="mono res">Σ of {micro.length} products {micro.bias ? `+ bias ${micro.bias}` : ''} = <b>{micro.dot}</b> · model's own: <b>{micro.module_output}</b> {micro.match_err < 1e-4 ? '✓ match' : ''}
        <Hint>16 floats are 64 bytes, exactly one cache line. This row of weights is {micro.length * 4} bytes = {Math.ceil((micro.length * 4) / 64)} cache lines streamed from RAM through L3 and L2 into the core's L1. The input x is reused by every row, so it stays in L1. Real kernels (MKL/oneDNN) tile and unroll this loop; the arithmetic is identical.</Hint></p>
    </div>
  )
}

function DiveCard() {
  const path = useHW((s) => s.path)
  const { journey: j, act, peaks, info, bench } = usePlay()
  const res = useResults()
  const recorded = useHW((s) => s.recorded)
  const latest = useHWThrottled((s) => s.latest, 250)
  const sc = useScores()
  const power = currentSample().s
  const comp = path[0]
  const isCore = comp === 'cpu' && path[1]?.startsWith('core')
  const dec = j?.decode
  const gp = bench.gpu && !bench.gpu.unavailable ? bench.gpu : null
  let title = comp, body: any = null
  const pw = power ? splitOf(power) : null
  // the one number at rest
  const head = isCore ? (power?.core_w?.[+path[1].slice(4)] != null ? `${power.core_w[+path[1].slice(4)].toFixed(1)} W` : '')
    : comp === 'cpu' ? (bench.matmul_n?.gflops ? `${bench.matmul_n.gflops} GFLOP/s` : res.cpun ? `${num(res.cpun.value)} GFLOP/s` : '')
    : comp === 'vrm' ? (pw ? `${pw.pkg.toFixed(1)} W` : '')
    : comp === 'ram' ? (bench.dram ? `${bench.dram.copy_gbps} GB/s` : res.ram ? `${num(res.ram.value)} GB/s` : '')
    : comp === 'ssd' ? (bench.disk ? `${bench.disk.gbps} GB/s` : res.storage ? `${num(res.storage.value)} ${res.storage.unit}` : '')
    : comp === 'nic' ? (bench.net ? `${bench.net.mbps} Mbit/s` : res.net ? `${num(res.net.value)} ${res.net.unit}` : '') : ''
  if (isCore) {
    title = `Inside core ${path[1].slice(4)}`
    body = <Micro />
  } else if (comp === 'cpu') {
    title = 'Inside the CPU'
    body = (
      <>
        <ul className="facts">
          <li><span>caches</span><b>L1 {Math.round((info?.cpu?.per_core_cache?.L1 ?? 0) / 1024)} KB · L2 {Math.round((info?.cpu?.per_core_cache?.L2 ?? 0) / 2 ** 20)} MB per core · L3 {Math.round((info?.cpu?.caches?.L3 ?? 0) / 2 ** 20)} MB shared</b></li>
          <li><span>measured</span><b>{bench.matmul_1?.gflops ?? '…'} GFLOP/s one core · {bench.matmul_n?.gflops ?? '…'} all cores</b></li>
          {dec && <li><span>per word written</span><b>{(dec.flops / 1e6).toFixed(0)} MFLOP over {dec.ops.length} operations</b></li>}
          <li><span>busy right now</span><b>{latest ? `${latest.proc_cores} cores' worth by this program · ${latest.cpu_avg}% overall` : '…'}</b></li>
        </ul>
        <Hint label="About the CPU">The CPU is a small city of identical workers. Each of the {info?.cpu?.cores} cores has its own tiny fast memory (L1, L2) and a vector unit that handles 16 numbers per instruction. They share a bigger memory (L3). Double-click a core to see one multiplication.</Hint>
      </>
    )
  } else if (comp === 'vrm') {
    title = 'Inside the voltage regulator'
    body = (
      <>
        <ul className="facts">
          <li><span>package</span><b>{pw ? `${pw.pkg.toFixed(1)} W` : '…'}</b></li>
          <li><span>cores</span><b>{!pw ? '…' : pw.state === 'unavailable' ? 'split unavailable' : `${pw.state === 'scaled' ? '≈ ' : ''}${pw.cores!.toFixed(1)} W · ${Math.round(pw.share! * 100)}% of the package`}</b></li>
          <li><span>sensors</span><b>{info?.power?.source ?? 'not measured'}</b></li>
        </ul>
        <Hint label="About the regulator">The adapter delivers a high DC voltage. Several regulator phases take turns converting it down to about 1 V for the cores; each phase switches hundreds of thousands of times a second. More load means more phases firing for longer.</Hint>
      </>
    )
  } else if (comp === 'ram') {
    title = 'Inside the RAM'
    const minMs = dec ? (dec.weight_bytes / 1e9 / Math.max(1, peaks.gbps)) * 1000 : 0
    body = (
      <>
        <ul className="facts">
          <li><span>this RAM</span><b>{info?.ram?.type} {info?.ram?.mts} MT/s × {info?.ram?.channels} channels = {info?.ram?.peak_gbps_est} GB/s on paper</b></li>
          <li><span>measured</span><b>{bench.dram ? `${bench.dram.copy_gbps} GB/s copy · ${bench.dram.read_gbps} GB/s read` : '…'}</b></li>
          {dec && <li><span>one word</span><b>reads {fmtB(dec.weight_bytes)} → at least {minMs.toFixed(1)} ms at peak, took {dec.step_ms} ms</b></li>}
          {dec && <li><span>achieved</span><b>{dec.effective_gbps} GB/s = {Math.round((100 * dec.effective_gbps) / Math.max(1, peaks.gbps))}% of the measured peak</b></li>}
        </ul>
        {j && <><p className="hint small">weights map<Hint>Each segment is one block's weights in RAM{act?.layer !== undefined ? '; the lit one is being read now' : ''}. RAM holds the whole model while it runs. For every word written, every weight is read once, so the speed of RAM decides how fast the model can write.</Hint></p><MemMap j={j} activeLayer={act?.stage === 'blocks' ? act.layer : undefined} /></>}
        {j && <KvCache j={j} />}
      </>
    )
  } else if (comp === 'ssd') {
    title = 'Inside the storage'
    body = (
      <>
        <ul className="facts">
          <li><span>drive</span><b>{info?.disks?.[0]?.name} · {info?.disks?.[0]?.bus}</b></li>
          {info?.pcie?.[0] && <li><span>link</span><b>PCIe Gen{info.pcie[0].gen} ×{info.pcie[0].lanes} · {info.pcie[0].gbps} GB/s ceiling · measured {bench.disk ? Math.round((100 * bench.disk.gbps) / info.pcie[0].gbps) + '%' : '…'} of it</b></li>}
          <li><span>measured read</span><b>{bench.disk ? `${bench.disk.gbps} GB/s (${bench.disk.cached ? 'cached' : 'straight from the drive'})` : '…'}</b></li>
          <li><span>this model</span><b>269 MB on disk as bf16, widened to {j ? fmtB(j.prefill.wbytes) : '538 MB'} fp32 in RAM</b></li>
        </ul>
        <Hint label="About the storage">The SSD keeps the model between runs. It is read once, when the model loads. After that, RAM does all the work.</Hint>
      </>
    )
  } else if (comp === 'nic') {
    title = 'Inside the network card'
    body = (
      <>
        <ul className="facts">
          <li><span>adapter</span><b>{info?.nics?.[0]?.name} · link {info?.nics?.[0]?.link}</b></li>
          <li><span>measured</span><b>{bench.net ? `${bench.net.mbps} Mbit/s · first byte after ${bench.net.latency_ms} ms` : '…'}</b></li>
          {bench.net && <li><span>269 MB would take</span><b>about {Math.round(269 / Math.max(0.1, bench.net.mbytes_s))} s</b></li>}
        </ul>
        <Hint label="About the network card">The network card was used once, to download the weights from the Hugging Face Hub. This run happens entirely on this PC.</Hint>
      </>
    )
  } else if (comp === 'keyboard' || comp === 'display') {
    title = comp === 'keyboard' ? 'The keyboard' : 'The screen'
    body = <p className="hint">{comp === 'keyboard' ? 'key press → code → letter' : 'token IDs → text → pixels'}<Hint>{comp === 'keyboard' ? 'Each key press closes a tiny switch. The keyboard sends a code to the computer, and the operating system turns it into a letter.' : 'The model returns token IDs. They become text, the browser draws it, and the graphics hardware lights the pixels.'}</Hint></p>
  }
  if (!body) return null
  const extra = comp === 'cpu' || isCore ? sc.by.cpu : comp === 'ram' ? sc.by.ram : comp === 'ssd' ? sc.by.ssd : comp === 'nic' ? sc.by.nic : null
  return (
    <div className="caption dive">
      <Peek label={title} summary={<span className="ctitle"><h3>{title}</h3>{head ? <b className="mono chipscore">{head}</b> : null}</span>}>
        {recorded ? <span className="t5-dim">Recorded on the test PC.</span> : extra ? <span className="t5-dim">Score {extra}</span> : null}
        {body}
        {comp === 'cpu' && gp && <p className="hint small mono">GPU (WebGPU): {gp.gflops} GFLOP/s · {gp.adapter}<Hint>PyTorch here uses the CPU.</Hint></p>}
      </Peek>
    </div>
  )
}

function Crumbs() {
  const path = useHW((s) => s.path)
  const dive = useHW((s) => s.dive)
  const names: Record<string, string> = { cpu: 'CPU', ram: 'RAM', ssd: 'Storage', nic: 'Network', keyboard: 'Keyboard', display: 'Screen', vrm: 'Regulator' }
  const nm = (p: string) => names[p] ?? (p.startsWith('core') ? `Core ${p.slice(4)}` : p)
  return (
    <nav className="crumbs" aria-label="Where you are in the machine">
      <button onClick={() => dive([])} className={path.length ? '' : 'cur'}>Machine</button>
      {path.map((p, i) => <span key={i}> › <button onClick={() => dive(path.slice(0, i + 1))} className={i === path.length - 1 ? 'cur' : ''} aria-current={i === path.length - 1 ? 'location' : undefined}>{nm(p)}</button></span>)}
    </nav>
  )
}

/* ------------------------------------------------------------------ sidebar tabs */
function FlowTab() {
  const { journey: j, act } = usePlay()
  const expanded = useHW((s) => s.expanded)
  if (!j || !act) return <p className="hint">No journey yet<Hint>Press “Start the journey” under the machine to follow one prompt through it.</Hint></p>
  const ops = act.stage === 'blocks' && act.layer !== undefined ? layerOps(j, act.layer) : []
  const ph = act.stage === 'decode' ? j.decode : j.prefill
  const top = [...ph.ops].sort((a: any, b: any) => b.ms - a.ms).slice(0, 8)
  return (
    <div className="stack">
      <div>
        <h4>Timed on this PC<Hint>Every number below was measured with a stopwatch on each operation.</Hint></h4>
        <p className="hint mono">{act.hud}</p>
      </div>
      {ops.length > 0 && (
        <div>
          <h4>Block {(act.layer ?? 0) + 1}: every operation</h4>
          <table className="optab mono"><thead><tr><th>op</th><th>ms</th><th>GB/s</th><th>GFLOP/s</th><th>limit</th></tr></thead>
            <tbody>{ops.map((o: any, i: number) => <tr key={i} className={act.op === o ? 'now' : ''}><td>{o.name}</td><td>{o.ms.toFixed(3)}</td><td>{o.gbps}</td><td>{o.gflops}</td><td>{o.bound ?? ''}</td></tr>)}</tbody></table>
        </div>
      )}
      <div>
        <h4>Slowest operations · {act.stage === 'decode' ? 'one new word' : 'prompt pass'}<Hint>“memory” means the operation spends its time waiting for weights from RAM; “compute” means the cores are the limit. Tiny operations are mostly framework overhead.</Hint></h4>
        <table className="optab mono"><thead><tr><th>op</th><th>block</th><th>ms</th><th>GB/s</th><th>limit</th></tr></thead>
          <tbody>{top.map((o: any, i: number) => <tr key={i}><td>{o.name}</td><td>{o.layer >= j.L ? '—' : o.layer < 0 ? '—' : o.layer + 1}</td><td>{o.ms.toFixed(3)}</td><td>{o.gbps}</td><td>{o.bound ?? ''}</td></tr>)}</tbody></table>
      </div>
      <label className="chk"><input type="checkbox" checked={expanded} onChange={(e) => useHW.getState().setExpanded(e.target.checked)} /> every block</label>
    </div>
  )
}

function SpecsTab() {
  const info = useHW((s) => s.info)
  if (!info) return <p className="hint"><span className="pulse" /> reading hardware…</p>
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
  const l = useHWThrottled((s) => s.latest, 250), t = useHWThrottled((s) => s.telemetry, 250), info = useHW((s) => s.info)
  if (info?.source === 'browser') return <p className="hint">needs the companion<Hint>Live operating-system counters need the companion (start.ps1 on this PC). The page connects to it automatically when it is running.</Hint></p>
  if (!l) return <p className="hint"><span className="pulse" /> waiting for the first sample…</p>
  const cores = info?.cpu?.cores ?? 8
  const per = Array.from({ length: cores }, (_, k) => ((l.cpu[k * 2] ?? 0) + (l.cpu[k * 2 + 1] ?? 0)) / 2)
  return (
    <div className="stack">
      <div><h4>CPU <small>{l.cpu_avg}% · this program uses {l.proc_cores} cores' worth · {l.mhz ? `${Math.round(l.mhz)} MHz` : ''}</small></h4><Spark data={t.map((s: any) => s.cpu_avg)} /></div>
      <div className="cores">{per.map((v, k) => <div key={k}><i style={{ height: `${Math.max(3, v)}%` }} /><span>{k}</span></div>)}</div>
      {l.power?.pkg_w != null && <div><h4>CPU power <small>{l.power.pkg_w} W package · {l.power.eff_mhz ? `${(l.power.eff_mhz / 1000).toFixed(2)} GHz effective` : ''}</small></h4><Spark data={t.map((s: any) => s.power?.pkg_w ?? 0)} max={Math.max(30, ...t.map((s: any) => s.power?.pkg_w ?? 0))} /></div>}
      {l.power?.core_w?.length > 0 && <div className="cores">{fixSplit(l.power).core_w.map((w: number, k: number) => <div key={k} title={`core ${k}: ${w?.toFixed(2)} W`}><i style={{ height: `${Math.max(3, Math.min(100, (w ?? 0) * 10))}%`, background: 'var(--pos)' }} /><span>{w?.toFixed(1)}</span></div>)}</div>}
      <div><h4>Memory <small>{(l.ram_used / 2 ** 30).toFixed(1)} of {(l.ram_total / 2 ** 30).toFixed(0)} GB · this program {(l.rss / 2 ** 30).toFixed(2)} GB</small></h4><Spark data={t.map((s: any) => (100 * s.ram_used) / s.ram_total)} color="var(--neg)" /></div>
      <div className="two"><div><h4>Disk read <small>{(l.disk_read_bps / 1e6).toFixed(1)} MB/s</small></h4><Spark data={t.map((s: any) => s.disk_read_bps / 1e6)} max={Math.max(50, ...t.map((s: any) => s.disk_read_bps / 1e6))} color="var(--neg)" /></div>
        <div><h4>Network in <small>{(l.net_recv_bps / 1e6).toFixed(2)} MB/s</small></h4><Spark data={t.map((s: any) => s.net_recv_bps / 1e6)} max={Math.max(1, ...t.map((s: any) => s.net_recv_bps / 1e6))} color="var(--neg)" /></div></div>
      <p className="hint small">10 samples a second<Hint>Sampled from the operating system.</Hint></p>
    </div>
  )
}

function SpeedTab() {
  const { bench, journey: j, rc } = useHW(useShallow((s) => ({ bench: s.bench, journey: s.journey, rc: s.results.cache })))
  const peaks = useHW.getState().peaks()
  const ex = rc?.extra as { sizes?: number[]; bandwidthGBs?: number[] } | undefined
  const cache: any[] = bench.cache ?? (ex?.sizes && ex.bandwidthGBs ? ex.sizes.map((b, i) => ({ kb: b / 1024, gbps: ex.bandwidthGBs![i] })).filter((c) => c.kb >= 32 && isFinite(c.gbps)) : [])
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
        <h4>Cache and memory speed <small>one core</small><Hint>The staircase is the memory hierarchy: fast and small at the left, big and slow at the right. Model weights are far larger than any cache, so they stream from RAM at the right-hand speed.</Hint></h4>
        {cache.length ? (
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Streaming bandwidth versus working set size">
            {ticks.map((t) => <g key={t}><line x1={cx(t)} x2={cx(t)} y1="8" y2={H - 22} stroke="var(--line)" /><text x={cx(t)} y={H - 8} textAnchor="middle">{t >= 1024 ? `${t / 1024} MB` : `${t} KB`}</text></g>)}
            {[0, 50, 100, 150].map((v) => <g key={v}><line x1="34" x2={W - 8} y1={cy(v)} y2={cy(v)} stroke="var(--line)" opacity=".5" /><text x="30" y={cy(v) + 3} textAnchor="end">{v}</text></g>)}
            <path d={cache.map((c, i) => `${i ? 'L' : 'M'}${cx(c.kb).toFixed(1)} ${cy(c.gbps).toFixed(1)}`).join(' ')} fill="none" stroke="var(--pos)" strokeWidth="2" />
            {cache.map((c) => <circle key={c.kb} cx={cx(c.kb)} cy={cy(c.gbps)} r="2.4" fill="var(--pos)" />)}
            <text x={W - 8} y="14" textAnchor="end" className="axl">GB/s</text>
          </svg>
        ) : <p className="hint">Not measured yet. Press Test all.</p>}
      </div>
      {pts.length > 0 && <div>
        <h4>Limited by RAM or by math?<Hint>Blue line: the machine's limits from the measured speeds. Amber dots: each operation when writing a word. Every dot sits far left of the bend, so RAM, not math, is the limit. Blue dots: the same operations on the whole prompt, which reuse each weight more.</Hint></h4>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Roofline chart">
          <path d={`M${rf(0.1)} ${rp(0.1 * peaks.gbps)} L${rf(ridge)} ${rp(peaks.gflops)} L${rf(200)} ${rp(peaks.gflops)}`} fill="none" stroke="var(--neg)" strokeWidth="1.8" />
          {pre.map((p: any, i: number) => <circle key={`a${i}`} cx={rf(p.x)} cy={rp(p.y)} r="1.8" fill="var(--neg)" opacity=".5" />)}
          {pts.map((p: any, i: number) => <circle key={`b${i}`} cx={rf(p.x)} cy={rp(p.y)} r="2" fill="var(--pos)" opacity=".7" />)}
          <text x="36" y="18" className="axl">GFLOP/s</text><text x={W - 8} y={H - 8} textAnchor="end" className="axl">FLOPs per byte moved →</text>
        </svg>
      </div>}
    </div>
  )
}

type Tab = 'score' | 'energy' | 'flow' | 'live' | 'speed' | 'specs'
const TABS: [Tab, string][] = [['score', 'Score'], ['energy', 'Energy'], ['flow', 'Flow'], ['live', 'Live'], ['speed', 'Speed'], ['specs', 'Specs']]
function Sidebar({ open }: { open: boolean }) {
  const companion = useHW((s) => s.source === 'companion')
  const tabs = TABS.filter(([id]) => companion || (id !== 'live' && id !== 'flow'))
  const t0 = useUI((u) => u.tab) as Tab
  const tab = tabs.some(([id]) => id === t0) ? t0 : 'score'
  const setTab = (t: Tab) => useUI.setState({ tab: t })
  return (
    <aside className="inspector" aria-label="Machine details" hidden={!open} style={open ? undefined : { display: 'none' }}>
      <div className="tabs" role="tablist">{tabs.map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
      <div className="pane" role="tabpanel">
        {tab === 'score' && <TestsTab />}{tab === 'energy' && <EnergyTab />}{tab === 'flow' && <FlowTab />}{tab === 'live' && <LiveTab />}{tab === 'speed' && <SpeedTab />}{tab === 'specs' && <SpecsTab />}
      </div>
    </aside>
  )
}

/** Loads the hardware facts and starts the 10 Hz telemetry once. */
let booted = false
function useMachineBoot() {
  useEffect(() => { if (!booted) { booted = true; useHW.getState().loadInfo().then(() => useHW.getState().startTelemetry()) } }, [])
  // what this device can do: S2's probe, once, if nobody has set it yet
  useEffect(() => { if (!useHW.getState().caps) probe().then((c) => { if (!useHW.getState().caps) useHW.getState().setCaps(c) }).catch(() => { /* stub or blocked: caps stay null */ }) }, [])
}

/** A part clicked in the 3D scene opens its test card. */
const PART_TO_TEST: Record<string, ComponentId> = { cpu: 'cpun', ram: 'ram', ssd: 'storage', nic: 'net', gpu: 'gpu', cache: 'cache', vrm: 'energy' }
function useSelectToCard() {
  const part = useHW((s) => s.path[0])
  const sub = useHW((s) => s.path[1])
  useEffect(() => {
    const id = part ? (part === 'cpu' && sub?.startsWith('core') ? 'cpu1' : PART_TO_TEST[part]) : undefined
    if (!id) return
    select(id)
  }, [part, sub])
}

/** The one machine section: the electricity scene, live always, with the prompt's journey played on it. */
export function MachineView() {
  useMachineBoot()
  useSelectToCard()
  // B7: a finished model run fills the Model pillar; "Your score" in the Model drawer opens the score here
  useEffect(() => {
    followModelRuns()
    const on = (e: Event) => { const pl = (e as CustomEvent).detail?.pillar ?? null; useUI.setState((u) => ({ tab: 'score', open: pl ?? u.open })) }
    window.addEventListener('ns-open-score', on); return () => window.removeEventListener('ns-open-score', on)
  }, [])
  // a link straight to the machine opens its drawer once
  useEffect(() => { if (/^#(machine|power|journey)/.test(location.hash)) useStore.getState().setRail('machine', true) }, [])
  // the same prompt the model just ran is replayed on the hardware (needs the companion: PyTorch on this PC)
  const runSeq = useStore((s) => s.runSeq)
  const first = useRef(runSeq)
  useEffect(() => {
    if (runSeq === first.current) return
    const h = useHW.getState(), st = useStore.getState()
    if (h.source === 'companion' && !h.journeyBusy && !h.benchRunning && st.repo) h.runJourney(st.repo, st.prompt)
  }, [runSeq])
  const details = useStore((s) => s.railOpen.machine)
  const shown = useStore((s) => !!s.visible.power)
  const measuring = useHW((s) => s.benchRunning || (!!s.journeyBusy && s.source === 'companion'))
  const path = useHW((s) => s.path)
  return (
    <main className={`main machine ${measuring ? 'measuring' : ''} ${details ? '' : 'nodetails'}`}>
      <section className="stage powerview" aria-label="3D machine: live electricity, and a prompt's journey through it">
        <div className="scenewrap"><PowerScene active={shown} /></div>
        <div className="mcol">{path.length > 0 && <Crumbs />}<PowerHUD /><IoStrip /></div>
        <Explainer id="machine" placement="bottom-left">
          <span>Amber rails carry power. Blue rails carry data.</span>
          <span>Bright lines show where the numbers move.</span>
          <span>Press Test all to score this device.</span>
        </Explainer>
        <BenchOverlay />
        <div className="stagebottom">
          {path.length > 0 ? <DiveCard /> : <Caption />}
          <MachineTimeline />
        </div>
        {path[0] === 'cpu' && path[1]?.startsWith('core') && <MicroLoader />}
      </section>
      <Sidebar open={details} />
      <style>{T5_CSS}</style>
      <StripHost />
    </main>
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
