import { create } from 'zustand'
import { activityAt, buildTimeline, locate, type Timeline, type Peaks } from './timeline'
import { gpuBench } from './gpuBench'
import { apiUrl, detectBackend, wsUrl } from '../base'

let raf = 0
let last = 0
let praf = 0
let plast = 0
let telemetryWs: WebSocket | null = null
const pbuf: any[] = []
let pflush = 0
let lastProg = 0

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
      }
      if (m.type === 'error') set({ benchErr: m.message })
    }
    const after = () => {
      const p = get().power
      // after the test the view stays live (sensors right now); the recorded run is one click away.
      // Without live sensors (browser-only mode) it shows the run that was just recorded instead.
      const liveSensors = get().source === 'companion'
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
