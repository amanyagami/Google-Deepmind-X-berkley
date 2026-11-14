import { create } from 'zustand'
import { activityAt, buildTimeline, locate, type Timeline, type Peaks } from './timeline'
import { apiUrl, detectBackend, wsUrl } from '../base'
import type { Capabilities } from './browserBench'
import { fromBench, resultKey } from './score'

let raf = 0
let last = 0
let praf = 0
let plast = 0
let telemetryWs: WebSocket | null = null
const pbuf: any[] = []
let pflush = 0
let lastProg = 0

/* ================================================================== CONTRACT (frozen in Phase 0; owner: S3)
 * One result shape for every test, browser or companion. S2 produces it, S3 scores and stores it, S5 shows it.
 * Change it only through the gate owner. */
export type ComponentId = 'cpu1' | 'cpun' | 'cache' | 'ram' | 'storage' | 'gpu' | 'net' | 'energy' | `model:${string}`
export type Pillar = 'compute' | 'memory' | 'gpu' | 'storage' | 'model'
export type Scale = 'browser' | 'native'
export type Flag = 'noisy' | 'hidden-tab' | 'on-battery' | 'not-isolated' | 'coarse-timer' | 'software-gpu' | 'size-halved' | 'estimated' | 'cancelled' | 'custom' | 'sustained-low' | 'no-knee' | 'cached-read' | 'small-quota' | 'confirm-needed' | 'save-data' | 'cellular' | `fallback:${string}`
export interface TestResult {
  v: 1
  component: ComponentId
  scale: Scale
  workload: { id: string; v: number }
  input: { kind: 'default' | 'custom'; summary: string }      // never raw user data
  samples: number[]; value: number; unit: string               // value = median of samples
  ci95: [number, number]; cv: number                           // cv in percent
  score: number | null                                         // null: custom input, failed gate, or unscored
  flags: Flag[]
  env: { where: 'companion' | 'webgpu' | 'wasm'; threads?: number; isolated?: boolean; adapter?: string }
  energy?: { joules: number; estimated: boolean }
  at: string                                                   // ISO time
  extra?: Record<string, unknown>                              // runner details: cache curve + knees, sustained ratio, latency stats
}
export interface InputSchema {
  type: 'number' | 'text' | 'file' | 'url'; label: string; unit?: string; min?: number; max?: number; step?: number; default: number | string; cap?: string
  /** Added by S3: the hard cap on this device. Returns the effective limits for the probed capabilities. */
  capFn?: (caps: Capabilities) => { min?: number; max?: number }
}
export type Progress = (p: { value?: number; unit?: string; fraction?: number; note?: string }) => void
/** One row per component. The UI, the scorer and the companion read this table; adding a component = adding a row. */
export interface RegistryRow {
  id: ComponentId; label: string; pillar: Pillar | null        // null = shown, not in the device score
  weight: number                                               // within its pillar
  input: InputSchema | null
  run(input: number | string | null, signal: AbortSignal, onProgress: Progress): Promise<TestResult>
  ref: Partial<Record<Scale, Record<number, number>>>          // reference value per scale and workload version
}
export const REGISTRY: RegistryRow[] = []                       // filled below (S3); S2 supplies the runners
/* ================================================================== */

/* ------------------------------------------------------------------ registry (S3)
 * REF v1 = the earlier placeholder references (score.ts REF / REF_BROWSER) rescaled from "best of n" to MEDIANS using
 * the spreads recorded on the test PC (median/max: 1-core 0.94, all-core 0.85, RAM 0.97). It is NOT frozen yet:
 * REF v1 is frozen later, on the reference device (5 sessions per engine, raw medians). Until then 1000 is a
 * placeholder, and a REF change re-scores stored results because results keep raw samples and medians. */
export const REF_V1: Record<Scale, Record<string, number>> = {
  native: { cpu1: 94, cpun: 340, cache: 100, ram: 39, storage: 2, gpu: 500 },
  browser: { cpu1: 28, cpun: 113, cache: 160, ram: 53, storage: 0.8, gpu: 500 },
}
/** Language-model decode reference (tokens/s of the 135M reference model) per runtime. */
export const MODEL_REF: Record<'companion' | 'webgpu' | 'wasm', number> = { companion: 20, webgpu: 63, wasm: 31 }
const refOf = (k: string): RegistryRow['ref'] => ({ native: { 1: REF_V1.native[k] }, browser: { 1: REF_V1.browser[k] } })
const lazy = (name: string): RegistryRow['run'] => (...a) => import('./browserBench').then((m) => (m as any)[name](...a))
const MB = 1024 * 1024
const memMB = (c: Capabilities) => (c.deviceMemoryGB ? c.deviceMemoryGB * 1024 : 4096)
const num = (label: string, unit: string, min: number, max: number, step: number, def: number, cap?: string, capFn?: InputSchema['capFn']): InputSchema => ({ type: 'number', label, unit, min, max, step, default: def, cap, capFn })
const notRunnable = (why: string): RegistryRow['run'] => async () => { throw new Error(why) }

REGISTRY.push(
  { id: 'cpu1', label: 'CPU, one core', pillar: 'compute', weight: 0.4, ref: refOf('cpu1'), run: lazy('run_cpu1'),
    input: num('Matrix size', 'n', 128, 1024, 128, 256, '128 to 1024, at most 5% of memory', (c) => ({ max: Math.max(128, Math.min(1024, Math.floor(Math.sqrt((memMB(c) * MB * 0.05) / 12) / 128) * 128)) })) },
  { id: 'cpun', label: 'CPU, all cores', pillar: 'compute', weight: 0.6, ref: refOf('cpun'), run: lazy('run_cpun'),
    input: num('Threads', 'threads', 1, 64, 1, 8, '1 to the number of cores', (c) => ({ max: Math.max(1, c.cores) })) },
  { id: 'cache', label: 'Cache', pillar: 'memory', weight: 0.4, ref: refOf('cache'), run: lazy('run_cache'),
    input: num('Largest size', 'MB', 1, 256, 1, 256, 'at most 25% of the memory budget (32 MB in lite mode)', (c) => ({ max: c.profile === 'lite' ? 32 : Math.max(1, Math.min(256, Math.floor(memMB(c) * 0.25))) })) },
  { id: 'ram', label: 'RAM', pillar: 'memory', weight: 0.6, ref: refOf('ram'), run: lazy('run_ram'),
    input: num('Array per worker', 'MB', 16, 128, 16, 64, '16 to 128 MB per worker, at most 12% of memory in total', (c) => ({ max: Math.max(16, Math.min(128, Math.floor((memMB(c) * 0.12) / Math.max(1, Math.min(8, c.cores))))) })) },
  { id: 'storage', label: 'File storage', pillar: 'storage', weight: 1, ref: refOf('storage'), run: lazy('run_storage'),
    input: num('File size', 'MB', 16, 512, 16, 128, '16 to 512 MB, at most 10% of the free quota', (c) => ({ max: Math.max(16, Math.min(512, Math.floor(((c.opfs.quotaBytes ?? 4096 * MB) * 0.1) / MB))) })) },
  { id: 'gpu', label: 'GPU', pillar: 'gpu', weight: 1, ref: refOf('gpu'), run: lazy('run_gpu'),
    input: num('Matrix size', 'N', 512, 4096, 512, 1024, 'buffers at most the smaller of 256 MB and the device limit', (c) => ({ max: Math.max(512, Math.min(4096, Math.floor(Math.sqrt(Math.min(256 * MB, c.gpu.maxBuffer ?? 256 * MB) / 4) / 512) * 512)) })) },
  { id: 'net', label: 'Connection', pillar: null, weight: 0, ref: {}, run: lazy('run_net'),
    input: { type: 'url', label: 'Test URL', default: '', cap: 'https with CORS, at most 100 MB or 15 s' } },
  { id: 'energy', label: 'Energy', pillar: null, weight: 0, ref: {}, input: null, run: notRunnable('Energy is measured during the other tests') },
)
/** `model:<task>` helper. Model rows are built on demand, one per task; S4 supplies the runner. */
export function modelRow(task: string, run?: RegistryRow['run']): RegistryRow {
  return { id: `model:${task}`, label: `Model, ${task}`, pillar: 'model', weight: 1, ref: {}, input: null, run: run ?? notRunnable('Models run from the model panel') }
}
export const rowFor = (id: string): RegistryRow | null => REGISTRY.find((r) => r.id === id) ?? (id.startsWith('model:') ? modelRow(id.slice(6)) : null)
/** Effective {min,max} of a row's input on this device, hard caps applied. */
export function inputLimits(row: RegistryRow, caps: Capabilities | null): { min: number; max: number } | null {
  const s = row.input
  if (!s || s.type !== 'number') return null
  const c = caps && s.capFn ? s.capFn(caps) : {}
  const min = Math.max(s.min ?? -Infinity, c.min ?? -Infinity), max = Math.min(s.max ?? Infinity, c.max ?? Infinity)
  return { min, max: Math.max(min, max) }
}
/** null/undefined input = the default, clamped to this device's caps. Anything else must be inside the caps. */
export function validateInput(row: RegistryRow, v: number | string | null | undefined, caps: Capabilities | null): { ok: true; value: number | string | null } | { ok: false; error: string } {
  const s = row.input
  if (!s) return v == null ? { ok: true, value: null } : { ok: false, error: `${row.label} takes no input` }
  const lim = inputLimits(row, caps)
  if (v == null && lim && typeof s.default === 'number') return { ok: true, value: Math.min(lim.max, Math.max(lim.min, s.default)) }
  const x = v ?? s.default
  if (s.type !== 'number') {
    if (typeof x !== 'string') return { ok: false, error: `${s.label} must be text` }
    if (s.type === 'url' && x !== '' && !/^https:\/\//i.test(x)) return { ok: false, error: `${s.label} must start with https://` }
    return { ok: true, value: x }
  }
  const n = typeof x === 'number' ? x : Number(x)
  if (!Number.isFinite(n)) return { ok: false, error: `${s.label} must be a number` }
  if (n < lim!.min || n > lim!.max) return { ok: false, error: `${s.label} must be between ${lim!.min} and ${lim!.max}${s.unit ? ' ' + s.unit : ''}` }
  return { ok: true, value: n }
}

/* ------------------------------------------------------------------ results store (S3) */
export const RESULTS_KEY = 'ns.results.v1'
export const RESULTS_VERSION = 1
export const RUN_ALL_ORDER: ComponentId[] = ['cpu1', 'cpun', 'cache', 'ram', 'storage', 'gpu']   // never net, energy or downloads
export interface Snapshot { at: string; scale: Scale | null; results: Record<string, TestResult> }
const HISTORY_MAX = 10
const validResult = (r: any): r is TestResult => !!r && r.v === 1 && typeof r.component === 'string' && Array.isArray(r.samples) && typeof r.value === 'number' && !!r.input && !!r.workload
/** Reads the stored results. Unknown versions, bad JSON and missing storage all give an empty store. */
export function loadStored(): { results: Record<string, TestResult>; history: Snapshot[] } {
  const empty = { results: {}, history: [] as Snapshot[] }
  try {
    const raw = localStorage.getItem(RESULTS_KEY)
    if (!raw) return empty
    const d = JSON.parse(raw)
    if (!d || d.v !== RESULTS_VERSION) { try { localStorage.removeItem(RESULTS_KEY) } catch { /* ignore */ } return empty }
    const clean = (o: any) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, r]) => validResult(r))) as Record<string, TestResult>
    const history = (Array.isArray(d.history) ? d.history : []).filter((h: any) => h && typeof h.at === 'string').map((h: any) => ({ at: h.at, scale: h.scale ?? null, results: clean(h.results) })).slice(-HISTORY_MAX)
    return { results: clean(d.results), history }
  } catch { return empty }
}
function storeResults(results: Record<string, TestResult>, history: Snapshot[]) {
  try { localStorage.setItem(RESULTS_KEY, JSON.stringify({ v: RESULTS_VERSION, results, history: history.slice(-HISTORY_MAX) })) } catch { /* private mode or full: keep going */ }
}
let current: AbortController | null = null
let cancelled = false

export type Source = 'companion' | 'browser'
export type PowerSample = { t: number; stage: string; pkg_w: number; core_w: number[]; mhz: number | null; util: number[]; estimated?: boolean }
export interface PowerRun { samples: PowerSample[]; summary: Record<string, any>; source: string; estimated?: boolean; reference?: { recorded: string; cpu: string; bench: any } }

interface HW {
  source: Source | null
  info: any | null
  infoErr: string | null
  telemetry: any[]
  latest: any | null
  bench: Record<string, any>
  benchRunning: boolean
  benchErr: string | null
  benchStage: string | null
  benchLive: { name: string; value: number; best: number; unit: string; extra?: number[] } | null
  benchNote: string | null
  // results (S3)
  results: Record<string, TestResult>
  history: Snapshot[]
  running: ComponentId | null
  progress: { value?: number; unit?: string; fraction?: number; note?: string } | null
  testErrors: Record<string, string>
  caps: Capabilities | null
  setCaps: (c: Capabilities | null) => void
  addResult: (r: TestResult | null) => void
  snapshot: () => void
  clearResults: () => void
  runComponent: (id: ComponentId, input?: number | string | null) => Promise<TestResult | null>
  runAll: () => Promise<void>
  cancel: () => void
  // electricity
  powerLive: PowerSample[]
  power: PowerRun | null
  pHead: number
  pMode: 'live' | 'replay' | 'journey'   // what the machine shows: the sensors now, a recorded test, or the prompt's journey
  pPlaying: boolean
  pSpeed: number
  tdp: number
  aiInBrowser: boolean
  recorded: boolean          // the journey on screen is a recording, not this machine
  recordedPack: { info: any; bench: any } | null
  // journey
  journey: any | null
  journeyBusy: string | null
  journeyErr: string | null
  micro: any | null
  tl: Timeline
  playhead: number
  playing: boolean
  speed: number
  follow: boolean
  expanded: boolean
  path: string[]
  hover: string | null
  loadInfo: () => Promise<void>
  startTelemetry: () => void
  runBench: () => Promise<void>
  runJourney: (repo: string, prompt: string) => Promise<void>
  loadRecorded: () => Promise<boolean>
  loadReferencePower: () => Promise<void>
  loadMicro: (repo: string, prompt: string, layer?: number, row?: number) => Promise<void>
  peaks: () => Peaks
  setPlayhead: (t: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  step: (dir: 1 | -1) => void
  setSpeed: (s: number) => void
  setFollow: (f: boolean) => void
  setExpanded: (e: boolean) => void
  dive: (path: string[]) => void
  back: () => void
  setHover: (h: string | null) => void
  showJourney: () => void
  setPHead: (t: number) => void
  pPlay: () => void
  pPause: () => void
  goLive: () => void
  replay: () => void
  setPSpeed: (s: number) => void
  setTdp: (w: number) => void
  setAiInBrowser: (b: boolean) => void
}

const pDuration = (p: PowerRun | null) => (p && p.samples.length ? p.samples[p.samples.length - 1].t : 0)

export const useHW = create<HW>((set, get) => ({
  source: null, info: null, infoErr: null, telemetry: [], latest: null, bench: {}, benchRunning: false, benchErr: null, benchStage: null, benchLive: null, benchNote: null,
  ...(() => { const st = loadStored(); return { results: st.results, history: st.history } })(), running: null, progress: null, testErrors: {}, caps: null,
  powerLive: [], power: null, pHead: 0, pMode: 'live', pPlaying: false, pSpeed: 1, tdp: 45, aiInBrowser: true, recorded: false, recordedPack: null,
  journey: null, journeyBusy: null, journeyErr: null, micro: null,
  tl: buildTimeline(30, false), playhead: 0, playing: false, speed: 1, follow: true, expanded: false, path: [], hover: null,

  async loadInfo() {
    try {
      const b = await detectBackend()
      if (b === 'none') {
        const { browserInfo } = await import('./browserBench')
        set({ info: await browserInfo(), source: 'browser', infoErr: null })
        return
      }
      const r = await fetch(apiUrl('/api/hw/info'))
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      set({ info: await r.json(), source: 'companion', infoErr: null })
    } catch (e: any) { set({ infoErr: e.message ?? String(e) }) }
  },

  startTelemetry() {
    if (telemetryWs || get().source !== 'companion') return
    try {
      const ws = new WebSocket(wsUrl('/ws/telemetry'))
      telemetryWs = ws
      // while a test records, its own (faster, stage-tagged) power stream drives the view
      ws.onmessage = (ev) => { if (get().benchRunning) return; const s = JSON.parse(ev.data); set((st) => ({ latest: s, telemetry: [...st.telemetry.slice(-149), s] })) }
      ws.onclose = () => { telemetryWs = null }
      ws.onerror = () => { telemetryWs = null }
    } catch { telemetryWs = null }
  },

  runBench() {
    if (get().benchRunning) return Promise.resolve()
    get().pPause()
    set({ benchRunning: true, benchErr: null, bench: {}, benchStage: 'idle', benchLive: null, benchNote: null, powerLive: [], power: null, pHead: 0, pMode: 'live' })
    const handle = (m: any) => {
      if (m.type === 'stage') set({ benchStage: m.name, benchLive: null })
      if (m.type === 'progress' && performance.now() - lastProg > 250) { lastProg = performance.now(); set({ benchLive: { name: m.name, value: m.value, best: m.best, unit: m.unit, extra: m.extra } }) }
      if (m.type === 'power') {
        // every sample reaches the live 3D view; updates are grouped to at most 10 a second
        pbuf.push(m as PowerSample)
        if (performance.now() - pflush > 100) { pflush = performance.now(); const add = pbuf.splice(0); set((s) => ({ powerLive: [...s.powerLive, ...add], pHead: m.t })) }
      }
      if (m.type === 'note') set({ benchNote: m.message })
      if (m.type === 'result') {
        if (m.name === 'power') { pbuf.length = 0; set({ power: m.data }) }
        else set((s) => ({ bench: { ...s.bench, [m.name]: m.data } }))
        try { get().addResult(fromBench(m.name, m.data, { scale: get().source === 'browser' ? 'browser' : 'native' })) } catch { /* the legacy bench view keeps working */ }
      }
      if (m.type === 'error') set({ benchErr: m.message })
    }
    const after = () => {
      const p = get().power
      // after the test the view stays live (sensors right now); the recorded run is one click away.
      // Without live sensors (browser-only mode) it shows the run that was just recorded instead.
      const liveSensors = get().source === 'companion'
      get().snapshot()
      set({ benchRunning: false, benchStage: null, benchLive: null, pMode: liveSensors ? 'live' : 'replay', pHead: p?.samples.length ? p.samples[p.samples.length - 1].t : 0 })
    }
    if (get().source === 'browser') {
      return import('./browserBench').then(async ({ runBrowserBench }) => {
        try { await runBrowserBench(handle, { tdp: get().tdp, ai: get().aiInBrowser }) } catch (e: any) { set({ benchErr: e.message ?? String(e) }) }
        after()
      })
    }
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl('/ws/bench'))
      ws.onmessage = async (ev) => {
        const m = JSON.parse(ev.data)
        // the companion pauses at the GPU stage (still recording power) while the page runs the WebGPU test
        if (m.type === 'client_task' && m.name === 'gpu') {
          const { gpuBench } = await import('./browserBench')
          const r = await gpuBench((value, best) => { if (performance.now() - lastProg > 250) { lastProg = performance.now(); set({ benchLive: { name: 'gpu', value: Math.round(value), best: Math.round(best), unit: 'GFLOP/s' } }) } })
          ws.send(JSON.stringify({ type: 'client_result', name: 'gpu', data: r }))
          return
        }
        handle(m)
        if (m.type === 'done' || m.type === 'error') { ws.close(); after(); resolve() }
      }
      ws.onerror = () => { set({ benchRunning: false, benchStage: null, benchErr: 'Benchmark connection failed.' }); resolve() }
    })
  },

  setCaps(caps) { set({ caps }) },
  addResult(r) {
    if (!r) return
    set((s) => { const results = { ...s.results, [resultKey(r)]: r }; storeResults(results, s.history); return { results } })
  },
  snapshot() {
    set((s) => {
      const first = Object.values(s.results)[0]
      if (!first) return {}
      const history = [...s.history, { at: new Date().toISOString(), scale: first.scale, results: s.results }].slice(-HISTORY_MAX)
      storeResults(s.results, history)
      return { history }
    })
  },
  clearResults() { set({ results: {}, history: [], testErrors: {} }); storeResults({}, []) },

  async runComponent(id, input) {
    if (current) return null                                        // one test at a time
    const row = rowFor(id)
    if (!row) { set({ testErrors: { ...get().testErrors, [id]: `Unknown test ${id}` } }); return null }
    const v = validateInput(row, input, get().caps)
    if (!v.ok) { set({ testErrors: { ...get().testErrors, [id]: v.error } }); return null }
    const ctrl = new AbortController()
    current = ctrl
    set((s) => ({ running: id, progress: null, testErrors: Object.fromEntries(Object.entries(s.testErrors).filter(([k]) => k !== id)) }))
    try {
      let r = await row.run(v.value, ctrl.signal, (p) => { if (current === ctrl) set({ progress: p }) })
      if (ctrl.signal.aborted) return null
      // a custom input never overwrites the standard result: it is stored apart and never scored
      if (input != null && row.input && input !== row.input.default && r.input.kind !== 'custom')
        r = { ...r, input: { ...r.input, kind: 'custom' }, score: null, flags: r.flags.includes('custom') ? r.flags : [...r.flags, 'custom'] }
      get().addResult(r)
      return r
    } catch (e: any) {
      if (!ctrl.signal.aborted) set((s) => ({ testErrors: { ...s.testErrors, [id]: e?.message ?? String(e) } }))
      return null
    } finally { current = null; set({ running: null, progress: null }) }
  },

  /** Every scored component with its default input, in a fixed order. No downloads, never `net`. */
  async runAll() {
    if (current) return
    cancelled = false
    let ran = 0
    for (const id of RUN_ALL_ORDER) {
      const r = await get().runComponent(id, null)
      if (r) ran++
      if (cancelled) break
    }
    cancelled = false
    if (ran) get().snapshot()
  },

  cancel() { if (current) { cancelled = true; current.abort() } },

  peaks() { return peaksOf(get()) },

  async runJourney(repo, prompt) {
    if (get().source === 'browser') { await get().loadRecorded(); return }
    set({ journeyErr: null, journeyBusy: 'Preparing…', playing: false })
    try {
      if (!get().bench.dram) { set({ journeyBusy: 'Measuring this machine first (about 30 s)…' }); await get().runBench(); get().pPause() }
      set({ journeyBusy: 'Running the model with a stopwatch on every operation…' })
      const pk = get().peaks()
      const r = await fetch(apiUrl('/api/hw/journey'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, prompt, new_tokens: 24, peak_gflops: pk.gflops, peak_gbps: pk.gbps }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      set({ journey: j, recorded: false, recordedPack: null, tl: buildTimeline(j.L, get().expanded), playhead: 0, path: [], micro: null, journeyBusy: null })
      get().play()
    } catch (e: any) { set({ journeyErr: e.message ?? String(e), journeyBusy: null }) }
  },

  /** Browser-only mode: play a journey recorded on the test PC (clearly labelled as such). */
  async loadRecorded() {
    try {
      set({ journeyBusy: 'Loading a recorded journey…', journeyErr: null })
      const r = await fetch(`${import.meta.env.BASE_URL}examples/machine.json`)
      if (!r.ok) throw new Error('No recorded journey is bundled with this build.')
      const pack = await r.json()
      set({ journey: pack.journey, micro: pack.micro, recorded: true, recordedPack: { info: pack.info, bench: pack.bench }, tl: buildTimeline(pack.journey.L, get().expanded), playhead: 0, path: [], journeyBusy: null })
      get().play()
      return true
    } catch (e: any) { set({ journeyErr: e.message ?? String(e), journeyBusy: null }); return false }
  },

  /** Browser-only mode: replay the measured (RAPL) run recorded on the test PC, labelled as such. */
  async loadReferencePower() {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}examples/machine.json`)
      if (!r.ok) throw new Error('No recorded run is bundled with this build.')
      const pack = await r.json()
      get().pPause()
      set({ power: { ...pack.power, source: `recorded on the test PC (${pack.info.cpu.name}), ${pack.power.source}`, reference: { recorded: pack.recorded, cpu: pack.info.cpu.name, bench: pack.bench } }, pHead: 0, pMode: 'replay' })
      get().pPlay()
    } catch (e: any) { set({ benchErr: e.message ?? String(e) }) }
  },

  async loadMicro(repo, prompt, layer = 0, row = 0) {
    if (get().recorded) return
    try {
      const r = await fetch(apiUrl('/api/hw/microscope'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, prompt, layer, row }) })
      const m = await r.json()
      if (r.ok) set({ micro: m })
    } catch { /* leave micro empty */ }
  },

  setPlayhead(t) { set({ playhead: Math.max(0, Math.min(get().tl.total, t)) }) },
  play() {
    if (get().playing) return
    if (get().playhead >= get().tl.total - 0.02) set({ playhead: 0 })
    get().pPause(); set({ playing: true, pMode: 'journey' }); last = performance.now()
    const loop = () => {
      raf = requestAnimationFrame((now) => {
        const s = get()
        if (!s.playing) return
        const dt = Math.min(0.1, (now - last) / 1000); last = now
        const t = s.playhead + dt * s.speed
        if (t >= s.tl.total) { set({ playhead: s.tl.total, playing: false }); return }
        set({ playhead: t }); loop()
      })
    }
    loop()
  },
  pause() { cancelAnimationFrame(raf); set({ playing: false }) },
  toggle() { get().playing ? get().pause() : get().play() },
  step(dir) {
    const { tl, playhead } = get()
    const i = locate(tl, playhead).i
    const cur = tl.segs[i]
    const target = dir > 0 ? tl.segs[Math.min(tl.segs.length - 1, i + 1)] : (playhead - cur.v0 > 0.4 ? cur : tl.segs[Math.max(0, i - 1)])
    set({ playhead: target.v0 + 0.001 })
  },
  setSpeed(speed) { set({ speed }) },
  setFollow(follow) { set({ follow }) },
  setExpanded(expanded) {
    const s = get(); const { i, p } = locate(s.tl, s.playhead)
    const tl = buildTimeline(s.journey?.L ?? 30, expanded)
    const seg = tl.segs[i]
    set({ expanded, tl, playhead: seg.v0 + p * (seg.v1 - seg.v0) })
  },
  dive(path) { set({ path, follow: false }) },
  back() { const p = get().path; set({ path: p.slice(0, -1), follow: p.length <= 1 }) },
  setHover(hover) { set({ hover }) },

  showJourney() { get().pPause(); set({ pMode: 'journey' }) },
  setPHead(t) { set({ pHead: Math.max(0, Math.min(pDuration(get().power), t)), pMode: get().power ? 'replay' : 'live' }) },
  goLive() { get().pPause(); get().pause(); set({ pMode: 'live' }) },
  replay() { get().pPause(); get().pause(); set({ pHead: 0, pMode: 'replay' }); get().pPlay() },
  pPlay() {
    const s0 = get()
    if (s0.pPlaying || !s0.power) return
    get().pause(); set({ pMode: 'replay' })
    if (s0.pHead >= pDuration(s0.power) - 0.05) set({ pHead: 0 })
    set({ pPlaying: true }); plast = performance.now()
    const loop = () => {
      praf = requestAnimationFrame((now) => {
        const s = get()
        if (!s.pPlaying) return
        const dt = Math.min(0.1, (now - plast) / 1000); plast = now
        const t = s.pHead + dt * s.pSpeed
        const end = pDuration(s.power)
        if (t >= end) { set({ pHead: end, pPlaying: false }); return }
        set({ pHead: t }); loop()
      })
    }
    loop()
  },
  pPause() { cancelAnimationFrame(praf); set({ pPlaying: false }) },
  setPSpeed(pSpeed) { set({ pSpeed }) },
  setTdp(tdp) { set({ tdp }) },
  setAiInBrowser(aiInBrowser) { set({ aiInBrowser }) },
}))

export type PowerMode = 'recording' | 'replay' | 'live' | 'journey' | 'none'

/** Power from the live telemetry stream (companion, 10 Hz), averaged over the last 0.4 s. */
export function telemetryPower(telemetry: any[]): PowerSample | null {
  const win = telemetry.slice(-4).map((x) => x?.power).filter((p) => p?.pkg_w != null)
  if (!win.length) return null
  const n = win.length, last = win[n - 1]
  const cores = (last.core_w ?? []) as number[]
  return {
    t: 0, stage: 'live', pkg_w: win.reduce((a, p) => a + p.pkg_w, 0) / n,
    core_w: cores.map((_, k) => win.reduce((a, p) => a + (p.core_w?.[k] ?? 0), 0) / n),
    mhz: last.eff_mhz ?? null, util: ((telemetry[telemetry.length - 1]?.cpu ?? []) as number[]).map((x) => x / 100),
  }
}

/** Peak speeds of the machine a journey is judged against (the test PC for a recorded journey). */
export function peaksOf(h: Pick<HW, 'recorded' | 'recordedPack' | 'bench' | 'info'>): Peaks {
  const { bench, info } = h.recorded && h.recordedPack ? h.recordedPack : h
  return { gflops: bench.matmul_n?.gflops ?? info?.cpu?.peak_gflops_est ?? 100, gbps: bench.dram?.copy_gbps ?? info?.ram?.peak_gbps_est ?? 20 }
}

type JourneyState = Pick<HW, 'journey' | 'tl' | 'info' | 'power' | 'recorded' | 'recordedPack' | 'bench'>
/** Watts for the prompt's journey at visual time t. The journey is a recording of work, not of power, so the watts are
 *  modelled: each core idles near 0.2 W and rises to the per-core watts a full-load test measured here (or 6 W), and the
 *  rest of the chip (caches, memory controller) follows the cache activity. Labelled "modelled" wherever it is shown. */
export function journeyPowerAt(h: JourneyState, t: number): PowerSample | null {
  if (!h.journey) return null
  const nc = h.info?.cpu?.logical_only ? Math.max(1, Math.round((h.info?.cpu?.cores ?? 8) / 2)) : (h.info?.cpu?.cores ?? 8)
  const a = activityAt(h.journey, h.tl, t, peaksOf(h), nc)
  const S = h.power?.summary
  const peak = S?.matmul_n?.avg_w && S?.idle?.avg_w ? Math.min(10, Math.max(2.5, ((S.matmul_n.avg_w - S.idle.avg_w) / nc) * 1.1)) : 6
  const core_w = a.cores.map((v) => 0.2 + v * peak)
  const pkg_w = core_w.reduce((x, y) => x + y, 0) + 2 + 5 * a.l3 + 2 * a.ram
  return { t, stage: a.stage, pkg_w, core_w, mhz: null, util: [], estimated: true }
}

/** What the machine shows now: the test being recorded, the prompt's journey, the sensors right now, or a recorded run. */
export function powerNow(h: Pick<HW, 'benchRunning' | 'powerLive' | 'power' | 'pHead' | 'pMode' | 'telemetry'> & Partial<JourneyState> & { playhead?: number }): { s: PowerSample | null; mode: PowerMode } {
  if (h.benchRunning && h.powerLive.length) return { s: powerAt(h.powerLive, h.powerLive[h.powerLive.length - 1].t - 0.2), mode: 'recording' }
  if (h.pMode === 'journey' && h.journey) { const s = journeyPowerAt(h as JourneyState, h.playhead ?? 0); if (s) return { s, mode: 'journey' } }
  if (h.pMode === 'replay' && h.power?.samples.length) return { s: powerAt(h.power.samples, h.pHead), mode: 'replay' }
  const live = telemetryPower(h.telemetry)
  if (live) return { s: live, mode: 'live' }
  if (h.power?.samples.length) return { s: powerAt(h.power.samples, h.pHead), mode: 'replay' }
  return { s: null, mode: 'none' }
}

/** The power at time t, averaged over a 0.4 s window. Package and per-core counters tick at slightly different
 *  moments, so single 0.1 s samples can disagree; over a window (and over each test) they agree within a few %. */
export const SMOOTH_S = 0.4
export function powerAt(samples: PowerSample[], t: number): PowerSample | null {
  if (!samples.length) return null
  const half = SMOOTH_S / 2
  const win = samples.filter((s) => Math.abs(s.t - t) <= half)
  if (win.length < 2) return interp(samples, t)
  const n = win.length
  const avg = (f: (s: PowerSample) => number) => win.reduce((a, s) => a + f(s), 0) / n
  const nearest = win.reduce((a, s) => (Math.abs(s.t - t) < Math.abs(a.t - t) ? s : a), win[0])
  return {
    t, stage: nearest.stage, pkg_w: avg((s) => s.pkg_w), core_w: nearest.core_w.map((_, k) => avg((s) => s.core_w[k] ?? 0)),
    mhz: nearest.mhz ? avg((s) => s.mhz ?? nearest.mhz!) : null, util: nearest.util.map((_, k) => avg((s) => s.util[k] ?? 0)), estimated: nearest.estimated,
  }
}

function interp(samples: PowerSample[], t: number): PowerSample | null {
  if (!samples.length) return null
  let lo = 0, hi = samples.length - 1
  if (t <= samples[0].t) return samples[0]
  if (t >= samples[hi].t) return samples[hi]
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].t <= t) lo = m; else hi = m }
  const a = samples[lo], b = samples[hi], u = (t - a.t) / Math.max(1e-6, b.t - a.t)
  const mix = (x: number, y: number) => x + (y - x) * u
  return { t, stage: a.stage, pkg_w: mix(a.pkg_w, b.pkg_w), core_w: a.core_w.map((x, k) => mix(x ?? 0, b.core_w[k] ?? x ?? 0)), mhz: a.mhz && b.mhz ? mix(a.mhz, b.mhz) : a.mhz, util: a.util.map((x, k) => mix(x, b.util[k] ?? x)), estimated: a.estimated }
}
