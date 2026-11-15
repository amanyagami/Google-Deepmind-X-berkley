import { create } from 'zustand'
import { api, checkFit, clearModels, deviceBudget, loadInBrowser, loadSavedInput, parseRepo, persistAfterDownload, planDownload, resolveModel, runInBrowser, saveInput, savedInfo as savedInfoApi, streamRun } from './api'
import type { DownloadPlan, Fit, ModelSpec, RunStats, Task, TaskInput } from './api'

export type Tab = 'model' | 'run' | 'layer' | 'calc' | 'edit'
export interface Edit { type: string; layer?: number; head?: number; index?: number; name?: string; factor?: number; row?: number; col?: number; value?: number }
/** A recorded example has `file` and `prompt`; a default model per task has `task` and `input` only. */
export interface ExampleMeta { id: string; title: string; repo: string; prompt?: string; file?: string; task?: Task; input?: TaskInput }

const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
let timer: ReturnType<typeof setInterval> | null = null
let loadSeq = 0
let dlAbort: AbortController | null = null
let autoEnabled = false          // autoStart() was called: every model picked later also starts at once
const autoDone = new Set<string>()

/** Progress of the model download that a run started (bytes, speed, time left). */
export interface DownloadProgress { done: number; total: number | null; bytesPerSec: number | null; etaSeconds: number | null }

export type AppView = 'model' | 'journey' | 'power' | 'zoo'
let lockUntil = 0
/** True while the page is gliding to a section the user picked, so the top bar shows the target, not every section passed. */
export const jumpLocked = () => performance.now() < lockUntil
/** Scroll the page to a section. */
export function jumpTo(id: AppView, smooth = true) {
  const el = document.getElementById(`sec-${id}`)
  if (!el) return
  const glide = smooth && !reduceMotion
  useStore.getState().setAppView(id)
  lockUntil = performance.now() + (glide ? 900 : 100)
  const behavior = glide ? 'smooth' : 'auto'
  if (getComputedStyle(el.parentElement!).overflowY === 'auto') el.scrollIntoView({ behavior, block: 'start' })
  else {
    // phone: the page itself scrolls, and the row of section links stays on top of it
    const bar = document.querySelector<HTMLElement>('.top > .seg')
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight + 8 : 0), behavior })
  }
}
const DETAILS_KEY = 'ns.machine.details'
const readDetails = () => { try { return localStorage.getItem(DETAILS_KEY) === '1' } catch { return false } }
interface S {
  /** ROUND 2 CONTRACT (frozen in the gate; owner S4, implemented small here so every lane can use it today) */
  /** drawer open state per section, remembered (ns.rail) */
  railOpen: Record<'model' | 'machine', boolean>
  setRail: (id: 'model' | 'machine', open: boolean) => void
  /** the visitor's name: stays on this device (ns.name); '' until the name card is answered */
  name: string
  setName: (n: string) => void
  /** theme choice (ns.theme): 'system' follows the OS */
  theme: 'system' | 'light' | 'dark'
  setTheme: (t: 'system' | 'light' | 'dark') => void
  /** the section the page is scrolled to (most of the screen) */
  appView: AppView
  setAppView: (v: AppView) => void
  /** which sections are on screen right now: only those draw their 3D scene */
  visible: Partial<Record<AppView, boolean>>
  setVisible: (v: Partial<Record<AppView, boolean>>) => void
  /** the optional side panel of the two machine sections (score, timings, charts, specs) */
  details: boolean
  setDetails: (v: boolean) => void
  backend: 'unknown' | 'online' | 'offline'
  mode: 'live' | 'replay'
  examples: ExampleMeta[]
  pack: any | null
  repo: string
  /** what the Hub says about the repo, whether it fits this computer, and what to run it on */
  spec: ModelSpec | null
  fit: Fit | null
  input: TaskInput
  setInput: (i: TaskInput) => void
  lastStats: RunStats | null
  /** size, time and consent level of the model download this model would need (null until known / not a browser model) */
  plan: DownloadPlan | null
  /** The download in progress (size, time), null otherwise. Since round 2 it only holds progress: nothing waits for a click. */
  pendingDownload: DownloadPlan | null
  /** always false now (kept so older UI code compiles) */
  needsConsent: boolean
  consent: DownloadPlan['consent'] | null
  /** bytes, speed and time left while a model downloads; null otherwise */
  download: DownloadProgress | null
  /** no-op alias kept for older UI code: downloads start by themselves */
  confirmDownload: () => Promise<void>
  /** same as cancelDownload */
  declineDownload: () => void
  /** stop a running download (the run ends without an error) */
  cancelDownload: () => void
  /** one quiet line (metered connection, cancelled download); null when there is nothing to say */
  note: string | null
  /** Start the default model by itself: download, then run. Call it once the model is known; safe to call again. */
  autoStart: () => Promise<void>
  /** how much is saved on this device, and whether the browser promised to keep it */
  savedInfo: () => Promise<{ bytes: number; persisted: boolean | null }>
  /** delete every downloaded model */
  clear: () => Promise<void>
  /** the language of the prompt (ns.lang): a BCP-47 code such as 'en', 'es', 'hi' */
  language: string
  setLanguage: (l: string) => void
  /** the last finished live run, remembered between visits (ns.last) */
  last: { repo: string; task: string; at: number; final: any; stats: RunStats | null } | null
  /** machine-readable reason of the last failed run: a BrowserRunError code, or null */
  runErrCode: string | null
  probe: any | null
  probing: boolean
  probeErr: string | null
  prompt: string
  tokens: string[]
  embed: any | null
  layers: any[]
  final: any | null
  maxes: { attn: number; mlp: number; head: number }
  revealed: number
  running: boolean
  streaming: boolean
  runStatus: string | null
  runErr: string | null
  selLayer: number | null
  selHead: number | null
  qpos: number
  hover: string | null
  tab: Tab
  tensors: Record<string, any>
  tensorErr: string | null
  edits: Edit[]
  useEdits: boolean
  compare: any | null
  comparing: boolean
  compareErr: string | null
  calc: any | null
  calcing: boolean
  calcErr: string | null
  scan: any | null
  scanning: boolean
  scanErr: string | null
  scanMax: number
  showImportance: boolean
  runScan: () => Promise<void>
  setShowImportance: (v: boolean) => void
  init: () => Promise<void>
  loadModel: (text: string, prompt?: string, input?: TaskInput) => Promise<void>
  loadExample: (id: string) => Promise<void>
  setPrompt: (p: string) => void
  /** Start a run. `auto: true` (the page started it, not the user) never downloads a model: it runs only the recorded replay or an already cached model. */
  run: (opts?: { auto?: boolean }) => Promise<void>
  /** finished runs of the shared prompt (the Journey replays the same prompt on the hardware after each) */
  runSeq: number
  setTab: (t: Tab) => void
  selectLayer: (i: number | null) => void
  selectHead: (h: number | null) => void
  setQpos: (q: number) => void
  setHover: (h: string | null) => void
  openTensor: (name: string) => Promise<void>
  addEdit: (e: Edit) => void
  removeEdit: (i: number) => void
  clearEdits: () => void
  setUseEdits: (v: boolean) => void
  runCompare: () => Promise<void>
  showRecorded: (i: number) => void
  fetchCalc: () => Promise<void>
}

const resetRun = {
  tokens: [], embed: null, layers: [], final: null, revealed: 0, running: false, streaming: false,
  runStatus: null, runErr: null, runErrCode: null as string | null, lastStats: null as RunStats | null, maxes: { attn: 1, mlp: 1, head: 1 },
}

/** Can the Run button work now? True for a recorded replay, a browser-runnable model, or a model the companion can run. */
export const canRun = (s: Pick<S, 'mode' | 'pack' | 'fit' | 'probe' | 'running' | 'probing'>): boolean => {
  if (s.running || s.probing) return false
  if (s.mode === 'replay') return !!s.pack
  const w = s.fit?.where
  if (s.fit?.verdict !== 'too-big' && (w === 'webgpu' || w === 'wasm' || w === 'companion')) return true
  return !!s.probe?.graph?.runnable
}


// ---- round 2 contract helpers: tiny, defensive localStorage (private windows throw)
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private window */ } }
const loadRail = (): Record<'model' | 'machine', boolean> => { try { const j = JSON.parse(lsGet('ns.rail') ?? '{}'); return { model: !!j.model, machine: !!j.machine } } catch { return { model: false, machine: false } } }

/** Remember a small JSON value for another part of the app (last results, last journey): key `ns.memo.<key>`. */
export const remember = (key: string, value: unknown) => lsSet(`ns.memo.${key}`, JSON.stringify(value))
export const recall = <T = unknown>(key: string): T | null => { try { return JSON.parse(lsGet(`ns.memo.${key}`) ?? 'null') } catch { return null } }

export const useStore = create<S>((set, get) => {
  function startReveal() {
    if (timer) clearInterval(timer)
    if (reduceMotion) { set((s) => ({ revealed: s.layers.length })); }
    timer = setInterval(() => {
      const { layers, revealed, streaming } = get()
      if (revealed < layers.length) set({ revealed: revealed + 1 })
      else if (!streaming) { if (timer) clearInterval(timer); timer = null; set({ running: false }) }
    }, reduceMotion ? 5 : 55)
  }

  function onFrame(f: any) {
    if (f.type === 'status') set({ runStatus: f.message })
    else if (f.type === 'start') set({ tokens: f.tokens, runStatus: null })
    else if (f.type === 'embed') set({ embed: f })
    else if (f.type === 'layer') {
      set((s) => {
        const last = (a: number[]) => Math.abs(a[a.length - 1])
        return {
          layers: [...s.layers, f],
          maxes: {
            attn: Math.max(s.maxes.attn, last(f.attn_norm)),
            mlp: Math.max(s.maxes.mlp, last(f.mlp_norm)),
            head: Math.max(s.maxes.head, ...f.head_norm),
          },
        }
      })
    } else if (f.type === 'final') set({ final: f })
  }

  /** play the recorded run (a pack): the scene is never empty while a model downloads */
  function playRecorded() {
    const s = get()
    if (!s.pack) return
    set({ ...resetRun, running: true, streaming: true, tab: 'run' })
    startReveal()
    for (const f of s.pack.run.frames) onFrame(f)
    set({ streaming: false })
  }

  /** download progress, with a smoothed speed and time left */
  function progressMeter() {
    let last = { t: performance.now(), done: 0 }
    let rate: number | null = null
    return (done: number, total: number | null) => {
      const now = performance.now()
      if (now - last.t >= 500) { const r = ((done - last.done) * 1000) / (now - last.t); rate = rate == null ? r : rate * 0.6 + r * 0.4; last = { t: now, done } }
      set({ download: { done, total, bytesPerSec: rate, etaSeconds: total != null && rate && rate > 0 ? Math.max(0, Math.ceil((total - done) / rate)) : null } })
    }
  }

  /** Download (and compile) the model in the background thread. False when it was cancelled or failed (the reason is in the store). */
  async function downloadModel(plan: DownloadPlan): Promise<RunStats | null> {
    const s = get()
    const ctl = (dlAbort = new AbortController())
    try {
      const loaded = await loadInBrowser(s.spec!, { device: s.fit!.where as 'webgpu' | 'wasm', dtype: plan.dtype, signal: ctl.signal, onProgress: progressMeter() })
      if (!plan.cached) void persistAfterDownload()   // the browser keeps what was just downloaded
      set((st) => ({ plan: st.plan ? { ...st.plan, cached: true } : plan }))
      return loaded
    } catch (e: any) {
      const code: string | null = e?.code ?? null
      if (code === 'aborted') set({ note: 'Download cancelled.' })
      else set({ runErr: e?.message ?? String(e), runErrCode: code, running: false })
      return null
    } finally {
      dlAbort = null
      set({ download: null, pendingDownload: null })
    }
  }

  /** A live run in the browser: starts the download at once when the files are not saved, then runs. Never asks. */
  async function beginBrowser(o: { recordedFirst?: boolean }) {
    const s = get()
    const where = s.fit!.where as 'webgpu' | 'wasm'
    let plan: DownloadPlan
    try { plan = await planDownload(s.spec!, { device: where }) } catch (e: any) { set({ ...resetRun, tab: 'run', runErr: e.message ?? String(e) }); return }
    const mb = plan.bytes ? `${Math.round(plan.bytes / 1048576)} MB` : 'a model'
    set({ plan, pendingDownload: plan.cached ? null : plan, needsConsent: false, consent: null, note: plan.metered && !plan.cached ? `You may be on a metered connection. This model is ${mb}.` : null })
    const keep = !!s.pack && s.mode === 'replay'   // a recorded example keeps its layers; the live run only fills in the result
    let loaded: RunStats | null = null
    if (!plan.cached) {
      if (o.recordedFirst && s.pack) playRecorded()
      loaded = await downloadModel(plan)
      if (!loaded) return
    }
    await execute({ live: true, keep, loaded })
  }

  /** Run now with what is in the store. `live`: use the browser even when a recording exists; `keep`: keep the recorded frames, take only the final result. */
  async function execute(o: { live?: boolean; keep?: boolean; loaded?: RunStats | null } = {}) {
    const s = get()
    const replay = !o.live && s.mode === 'replay' && !!s.pack
    const where = s.fit?.where ?? 'none'
    const viaBrowser = !replay && (where === 'webgpu' || where === 'wasm')
    if (o.keep) set({ running: true, streaming: true, runErr: null, runErrCode: null })
    else set({ ...resetRun, running: true, streaming: true, tab: 'run', pendingDownload: null, needsConsent: false })
    if (!o.keep) startReveal()
    const frame = o.keep ? (f: any) => { if (f.type === 'final') set({ final: f }) } : onFrame
    const t0 = performance.now()
    try {
      if (replay) {
        for (const f of s.pack.run.frames) onFrame(f)
      } else if (viaBrowser) {
        const ctl = (dlAbort = new AbortController())
        const stats: RunStats = await runInBrowser(s.spec!, s.input, frame, { device: where as 'webgpu' | 'wasm', signal: ctl.signal, onProgress: progressMeter() })
        // the model was fetched and compiled just before the run: report that load, not the warm one
        if (o.loaded) Object.assign(stats, { loadMs: o.loaded.loadMs, cached: (o.loaded as any).cached })
        set({ lastStats: stats })
        const fin = get().final
        if (fin) { const last = { repo: s.repo, task: s.spec?.task ?? '', at: Date.now(), final: fin, stats }; set({ last }); remember('lastRun', last) }
      } else {
        await streamRun(s.repo, s.prompt, s.useEdits ? s.edits : [], onFrame)
        const totalMs = performance.now() - t0, fin = get().final
        set({ lastStats: { where: 'companion', repo: s.repo, task: s.spec?.task ?? 'text-generation', loadMs: 0, firstMs: (fin?.seconds ?? totalMs / 1000) * 1000, totalMs, items: 1, unit: 'items', perSec: 1000 / totalMs, memBytes: null, joules: null, estimatedEnergy: false } })
      }
    } catch (e: any) {
      const code: string | null = e?.code ?? null
      set({ runErr: code === 'aborted' ? null : (e.message ?? String(e)), runErrCode: code, running: false })
    } finally {
      dlAbort = null
      set((st) => ({ streaming: false, download: null, runSeq: st.runSeq + 1, ...(o.keep ? { running: false } : {}) }))
    }
  }

  return {
    railOpen: loadRail(),
    setRail: (id, open) => set((s) => { const railOpen = { ...s.railOpen, [id]: open }; lsSet('ns.rail', JSON.stringify(railOpen)); return { railOpen } }),
    name: lsGet('ns.name') ?? '',
    setName: (n) => { const name = n.trim().slice(0, 40); lsSet('ns.name', name); set({ name }) },
    theme: (lsGet('ns.theme') as 'system' | 'light' | 'dark') || 'system',
    setTheme: (theme) => { lsSet('ns.theme', theme); set({ theme }) },
    appView: location.hash === '#machine' || location.hash === '#journey' ? 'journey' : location.hash === '#power' ? 'power' : 'model',
    setAppView: (appView: AppView) => set({ appView } as any),
    visible: { model: true }, setVisible: (visible) => set({ visible } as any),
    details: readDetails(), setDetails: (details) => { set({ details } as any); try { localStorage.setItem(DETAILS_KEY, details ? '1' : '0') } catch { /* private mode */ } },
    plan: null, pendingDownload: null, needsConsent: false, consent: null, download: null, note: null, language: lsGet('ns.lang') || 'en', last: recall('lastRun'), backend: 'unknown', mode: 'live', examples: [], pack: null, repo: '', spec: null, fit: null, input: { kind: 'text', text: 'The capital of France is' } as TaskInput, probe: null, probing: false, probeErr: null,
    prompt: 'The capital of France is', ...resetRun, selLayer: null, selHead: null, qpos: -1, hover: null, tab: 'model',
    runSeq: 0, tensors: {}, tensorErr: null, edits: [], useEdits: true, compare: null, comparing: false, compareErr: null,
    calc: null, calcing: false, calcErr: null,
    scan: null, scanning: false, scanErr: null, scanMax: 1, showImportance: false,

    setShowImportance: (showImportance) => set({ showImportance }),

    setInput: (input) => {
      const t = get().spec?.task
      if (t) saveInput(t, input)
      set(input.kind === 'text' ? { input, prompt: input.text } : { input })
    },

    async runScan() {
      const s = get()
      if (!s.probe) return
      set({ scanning: true, scanErr: null })
      try {
        const scan = s.mode === 'live' ? await api.scan({ repo: s.repo, prompt: s.prompt }) : s.pack?.scan
        if (!scan) throw new Error('No scan recorded for this example.')
        set({ scan, scanMax: Math.max(1e-6, ...scan.heads.flat()), showImportance: true })
      } catch (e: any) { set({ scanErr: e.message ?? String(e) }) } finally { set({ scanning: false }) }
    },

    async init() {
      try { await api.health(); set({ backend: 'online' }) } catch { set({ backend: 'offline' }) }
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}examples/index.json`)
        if (r.ok) set({ examples: await r.json() })
      } catch { /* no recorded examples */ }
      const saved = lsGet('ns.model')
      const first = get().examples[0]
      if (saved) await get().loadModel(saved)
      else if (first) await get().loadExample(first.id)
      else await get().loadModel('HuggingFaceTB/SmolLM2-135M')
    },

    async loadModel(text, prompt, input) {
      const repo = parseRepo(text)
      if (timer) { clearInterval(timer); timer = null }
      const mySeq = ++loadSeq
      dlAbort?.abort()
      lsSet('ns.model', repo)
      const prevTask = get().spec?.task
      set({ repo, spec: null, fit: null, plan: null, pendingDownload: null, needsConsent: false, consent: null, download: null, note: null, probing: true, probeErr: null, probe: null, ...resetRun, selLayer: null, selHead: null, tensors: {}, edits: [], compare: null, calc: null, scan: null, showImportance: false, tab: 'model', ...(prompt ? { prompt, input: { kind: 'text', text: prompt } as TaskInput } : {}) })
      // what the Hub says and whether it fits here (needs no companion)
      let spec: ModelSpec | null = null, fit: Fit | null = null, specErr: string | null = null
      try {
        spec = await resolveModel(repo)
        fit = checkFit(spec, await deviceBudget())
      } catch (e: any) { specErr = e.message ?? String(e) }
      if (mySeq !== loadSeq) return
      if (spec) {
        const keep = !prompt && !input && prevTask === spec.task && get().input.kind === 'text'
        const inp: TaskInput = input ?? (prompt ? { kind: 'text', text: prompt } : keep ? get().input : (spec.task && loadSavedInput(spec.task)) || spec.defaultInput)
        set({ spec, fit, input: inp, ...(inp.kind === 'text' ? { prompt: inp.text } : {}) })
        // size and time are shown before anything downloads (metadata only: no model file is requested)
        if (fit && (fit.where === 'webgpu' || fit.where === 'wasm')) {
          planDownload(spec, { device: fit.where }).then((plan) => { if (mySeq === loadSeq) set({ plan }) }, () => { /* the size is optional */ })
        }
      }
      const browserOk = !!fit && (fit.where === 'webgpu' || fit.where === 'wasm')
      try {
        if (get().backend === 'online') {
          try {
            const probe = await api.probe(repo)
            set({ probe, mode: 'live', pack: null })
          } catch (e) {
            if (!browserOk) throw e
            set({ mode: 'live', pack: null })   // the browser can still run it; only the companion's deep views are missing
          }
        } else {
          const meta = get().examples.find((e) => e.file && e.repo.toLowerCase() === repo.toLowerCase())
          if (meta) {
            const pack = await (await fetch(`${import.meta.env.BASE_URL}examples/${meta.file}`)).json()
            set({ probe: pack.probe, pack, mode: 'replay', prompt: pack.prompt, input: { kind: 'text', text: pack.prompt } })
          } else if (browserOk) set({ mode: 'live', pack: null })
          else throw new Error(specErr ?? fit?.reason ?? 'The backend is offline and this model has no recorded example. Start the server to load any model.')
        }
      } catch (e: any) {
        // a repo the Hub could not resolve (gated, private, missing) is reported as such, not as a failed probe
        if (mySeq === loadSeq) set({ probeErr: specErr ?? e.message ?? String(e) })
      } finally {
        if (mySeq === loadSeq) set({ probing: false })
      }
      if (mySeq === loadSeq && autoEnabled) void get().autoStart()
    },

    async loadExample(id) {
      const meta = get().examples.find((e) => e.id === id)
      if (meta) await get().loadModel(meta.repo, meta.prompt, meta.input)
    },

    setPrompt: (prompt) => {
      const t = get().spec?.task
      if (t) saveInput(t, { kind: 'text', text: prompt })
      set({ prompt, input: { kind: 'text', text: prompt } })
    },

    async run(opts) {
      const s = get()
      if (!s.probe && !s.spec) return
      const replay = s.mode === 'replay' && !!s.pack
      const where = s.fit?.where ?? 'none'
      if (!replay && s.fit?.verdict === 'too-big') {
        const same = (e: ExampleMeta) => e.repo.toLowerCase() !== s.repo.toLowerCase()
        const alt = s.examples.find((e) => same(e) && (e.task ?? 'text-generation') === s.spec?.task) ?? s.examples.find(same)
        set({ ...resetRun, tab: 'run', runErr: `${s.fit.reason}${alt ? ` Try ${alt.repo} instead, a smaller model for the same task.` : ''}` })
        return
      }
      const viaBrowser = !replay && (where === 'webgpu' || where === 'wasm')
      // the companion path, also for repos the probe can read but the fit rules do not list (kept from before)
      const viaCompanion = !replay && !viaBrowser && s.mode === 'live' && !!s.probe
      if (!replay && !viaBrowser && !viaCompanion) {
        if (opts?.auto) return
        set({ ...resetRun, tab: 'run', runErr: s.fit?.reason ?? 'This model cannot run on this computer.' })
        return
      }
      if (viaBrowser) { await beginBrowser({}); return }
      await execute()
    },

    async confirmDownload() { /* downloads start by themselves now */ },

    declineDownload() { dlAbort?.abort() },

    cancelDownload() { dlAbort?.abort() },

    async autoStart() {
      autoEnabled = true
      const s = get()
      if (!s.spec || s.probing) return   // loadModel calls this again when the model is known
      const where = s.fit?.where
      if ((where !== 'webgpu' && where !== 'wasm') || s.fit?.verdict === 'too-big' || s.running || s.download) return
      const key = `${s.repo}|${s.spec.task}`
      if (autoDone.has(key)) return
      autoDone.add(key)
      await beginBrowser({ recordedFirst: true })
    },

    savedInfo: async () => { const i = await savedInfoApi(); return { bytes: i.bytes, persisted: i.persisted } },
    async clear() { await clearModels(); set((st) => ({ plan: st.plan ? { ...st.plan, cached: false } : null })) },
    setLanguage: (language) => { lsSet('ns.lang', language); set({ language }) },

    setTab: (tab) => set({ tab }),
    selectLayer: (i) => set({ selLayer: i, selHead: null, calc: null, ...(i !== null ? { tab: 'layer' as Tab } : {}) }),
    selectHead: (h) => set({ selHead: h, calc: null }),
    setQpos: (qpos) => set({ qpos, calc: null }),
    setHover: (hover) => set({ hover }),

    async openTensor(name) {
      const s = get()
      set({ tensorErr: null })
      try {
        if (s.mode === 'live') {
          const t = await api.tensor(s.repo, name)
          set({ tensors: { ...s.tensors, [name]: t } })
        } else {
          const t = s.pack?.tensors?.[name]
          if (!t) throw new Error('This tensor was not recorded. Start the backend to read any tensor.')
          set({ tensors: { ...s.tensors, [name]: t } })
        }
      } catch (e: any) { set({ tensorErr: e.message ?? String(e) }) }
    },

    addEdit: (e) => set((s) => ({ edits: [...s.edits, e] })),
    removeEdit: (i) => set((s) => ({ edits: s.edits.filter((_, j) => j !== i) })),
    clearEdits: () => set({ edits: [], compare: null }),
    setUseEdits: (useEdits) => set({ useEdits }),

    async runCompare() {
      const s = get()
      if (s.mode !== 'live' || !s.probe) return
      set({ comparing: true, compareErr: null })
      try {
        const compare = await api.compare({ repo: s.repo, prompt: s.prompt, edits: s.edits, topk: 8, max_new: 24 })
        set({ compare })
      } catch (e: any) { set({ compareErr: e.message ?? String(e) }) } finally { set({ comparing: false }) }
    },

    showRecorded(i) {
      const c = get().pack?.compares?.[i]
      if (c) set({ compare: c.result, edits: c.result.edits, compareErr: null })
    },

    async fetchCalc() {
      const s = get()
      if (s.selLayer === null || s.selHead === null) return
      set({ calcing: true, calcErr: null })
      try {
        if (s.mode === 'live') {
          const calc = await api.calc({ repo: s.repo, prompt: s.prompt, layer: s.selLayer, head: s.selHead, qpos: s.qpos, edits: s.useEdits ? s.edits : [] })
          set({ calc })
        } else {
          const hit = s.pack?.calcs?.find((c: any) => c.layer === s.selLayer && c.head === s.selHead)
          if (!hit) throw new Error(`Recorded for layers ${[...new Set(s.pack.calcs.map((c: any) => c.layer))].join(', ')} only. Pick one of those, or start the backend.`)
          set({ calc: hit })
        }
      } catch (e: any) { set({ calcErr: e.message ?? String(e) }) } finally { set({ calcing: false }) }
    },
  }
})
