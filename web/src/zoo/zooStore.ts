import { create } from 'zustand'
import { useStore } from '../store'
import * as api from '../api'
import type { DownloadPlan, Fit, ModelSpec, Task, TaskInput } from '../api'
import { consentFor, etaSecs, type InputCaps } from './nets'
import { accuracyAt, applyFx, cnn, FX0, mlp, rnn, SWEEP_LEVELS, timeNet, vit, vlm, type Fx, type Pack, type Speed, type Sweep } from './nets'

/** 'llm' is the real model loaded at the top of the page, run on the shared prompt; the others are the five tiny
 *  digit networks, all reading the same 8x8 image. */
export type NetId = 'llm' | 'mlp' | 'cnn' | 'rnn' | 'vit' | 'vlm'
export type DigitNet = Exclude<NetId, 'llm'>
export const NETS: { id: DigitNet; short: string }[] = [
  { id: 'mlp', short: 'MLP' }, { id: 'cnn', short: 'CNN' }, { id: 'rnn', short: 'RNN' }, { id: 'vit', short: 'ViT' }, { id: 'vlm', short: 'VLM' },
]

/** Stages of each network's flow, in order. Durations are visual seconds at 1x. */
export const STAGES: Record<NetId, { id: string; label: string; dur: number }[]> = {
  llm: [{ id: 'input', label: 'Prompt tokens', dur: 1.4 }, { id: 'blocks', label: 'Through every block', dur: 7.5 }, { id: 'out', label: 'Next-word scores', dur: 2.0 }],
  mlp: [{ id: 'input', label: 'Pixels in', dur: 1.2 }, { id: 'h1', label: 'Hidden layer 1', dur: 2.2 }, { id: 'h2', label: 'Hidden layer 2', dur: 1.8 }, { id: 'out', label: 'Scores', dur: 1.6 }],
  cnn: [{ id: 'input', label: 'Pixels in', dur: 1.0 }, { id: 'conv1', label: '8 filters slide', dur: 3.2 }, { id: 'pool1', label: 'Pool', dur: 1.0 }, { id: 'conv2', label: '16 filters slide', dur: 2.6 }, { id: 'pool2', label: 'Pool', dur: 0.9 }, { id: 'out', label: 'Scores', dur: 1.4 }],
  rnn: [{ id: 'input', label: 'Pixels in', dur: 0.8 }, ...Array.from({ length: 8 }, (_, t) => ({ id: `t${t}`, label: `Row ${t + 1}`, dur: 0.9 })), { id: 'out', label: 'Scores', dur: 1.4 }],
  vit: [{ id: 'input', label: 'Pixels in', dur: 1.0 }, { id: 'patch', label: 'Cut into patches', dur: 1.6 }, { id: 'embed', label: 'Patches become tokens', dur: 1.4 }, { id: 'attn', label: 'Attention', dur: 3.0 }, { id: 'mlp', label: 'Per-token MLP', dur: 1.2 }, { id: 'out', label: 'Scores', dur: 1.4 }],
  vlm: [{ id: 'input', label: 'Pixels in', dur: 0.8 }, { id: 'vision', label: 'Vision tower', dur: 2.0 }, { id: 'connect', label: 'Connector', dur: 1.2 }, { id: 'write', label: 'Writing the caption', dur: 7.0 }],
}

export function locateZ(net: NetId, t: number) {
  const st = STAGES[net]
  let acc = 0
  for (let i = 0; i < st.length; i++) {
    if (t < acc + st[i].dur || i === st.length - 1) return { i, id: st[i].id, p: Math.max(0, Math.min(1, (t - acc) / st[i].dur)), t0: acc }
    acc += st[i].dur
  }
  return { i: 0, id: st[0].id, p: 0, t0: 0 }
}
export const totalZ = (net: NetId) => STAGES[net].reduce((a, s) => a + s.dur, 0)
/** How far the flow has reached stage `id`: 0 before it, 0..1 during, 1 after. */
export function reach(net: NetId, t: number, id: string) {
  const st = STAGES[net]; let acc = 0
  for (const s of st) { if (s.id === id) return Math.max(0, Math.min(1, (t - acc) / s.dur)); acc += s.dur }
  return 0
}

/* CONTRACT (frozen in Phase 0; owner: S6). What the inspector is looking at. S8 sets it on click, S7 renders it.
 * Null = overview (the default). Never set by default. */
export type Inspect = { kind: 'block' | 'tensor' | 'token' | 'output'; layer?: number; part?: 'attn' | 'mlp' | 'norm' | 'embed'; name?: string; index?: number } | null
export type Sel = { kind: string; layer?: string; index: number; extra?: number } | null

/** What the picker and the first-visit card know about one model: its Hub facts, the fit verdict and the download plan. */
export interface CatRow { id: string; title: string; repo: string; task: Task | null; recorded: boolean; bytes: number | null; plan: DownloadPlan | null; fit: Fit | null; spec: ModelSpec | null; verdict?: Fit['verdict'] }
export type Dl = { phase: 'idle' | 'warn' | 'downloading' | 'running' | 'error'; done: number; total: number | null; t0: number; eta?: number | null; id?: string; src?: 'card' | 'dock'; err?: string }

interface Z {
  custom: Partial<Record<Task, TaskInput>>
  remember: (t: Task, i: TaskInput) => void
  cardOff: boolean
  setCardOff: (v: boolean) => void
  caps: (InputCaps & { line: string }) | null
  loadCaps: () => Promise<void>
  catalog: Record<string, CatRow>
  loadCatalog: () => Promise<void>
  planFor: (spec: ModelSpec, fit: Fit | null) => Promise<DownloadPlan>
  dl: Dl
  startLive: (exampleId?: string, confirmed?: boolean, src?: 'card' | 'dock') => Promise<void>
  cancelLive: () => void
  net: NetId
  packs: Partial<Record<DigitNet, Pack>>
  digits: { images: number[][]; labels: number[] } | null
  /** what was drawn or picked; `img` is this after the stress test (what every network sees) */
  base: number[]
  img: number[]
  label: number | null
  fx: Fx
  timing: Partial<Record<DigitNet, Speed>>
  sweep: Sweep | null
  sweepBusy: string | null
  out: any
  err: string | null
  t: number
  playing: boolean
  speed: number
  sel: Sel
  inspect: Inspect
  setInspect(i: Inspect): void
  init: () => Promise<void>
  setNet: (n: NetId) => Promise<void>
  setImg: (img: number[], label?: number | null) => void
  setFx: (f: Partial<Fx>) => void
  loadAll: () => Promise<void>
  runSweep: () => Promise<void>
  recompute: () => void
  setT: (t: number) => void
  play: () => void
  pause: () => void
  setSpeed: (s: number) => void
  select: (s: Sel) => void
}

let raf = 0, last = 0
const base = () => `${import.meta.env.BASE_URL}zoo/`

let abort: AbortController | null = null, handle: { cancel(): void } | null = null
const dl0: Dl = { phase: 'idle', done: 0, total: null, t0: 0 }
const mbps = () => { const c: any = (navigator as any).connection; return c?.downlink > 0 ? c.downlink : 20 }

export const useZoo = create<Z>((set, get) => ({
  custom: {}, remember: (t, i) => set((s) => ({ custom: { ...s.custom, [t]: i } })),
  cardOff: false, setCardOff: (cardOff) => set({ cardOff }),
  caps: null, catalog: {}, dl: dl0,

  async loadCaps() {
    if (get().caps) return
    let line = '', mem: number | null = (navigator as any).deviceMemory ?? null
    try {
      const m: any = await import('../hw/browserBench')
      const c = await m.probe()
      mem = c.deviceMemoryGB ?? mem
      line = `${c.cores} cores · ${c.gpu?.available ? (c.gpu.adapter || 'GPU') + ' with WebGPU' : 'no WebGPU, so the CPU'}${mem ? ` · ${mem} GB memory` : ''}`
    } catch {
      const gpu = !!(navigator as any).gpu
      line = `${navigator.hardwareConcurrency || '?'} cores · ${gpu ? 'WebGPU ready' : 'no WebGPU, so the CPU'}${mem ? ` · ${mem} GB memory` : ''}`
    }
    set({ caps: { line, deviceMemoryGB: mem } })
  },

  /** The download plan: the models engine's, or a local estimate from the Hub facts until it exists. */
  async planFor(spec, fit) {
    try { return await api.planDownload(spec) } catch { /* engine not present yet */ }
    const dt = fit?.dtype ?? (spec.onnx?.dtypes.length ? api.pickDtype(spec.onnx.dtypes, 'wasm') : null)
    const companion = fit?.where === 'companion'
    const bytes = companion ? null : (dt && spec.onnx?.sizes?.[dt]) || spec.bytes || null
    const sd = !!(navigator as any).connection?.saveData
    return { repo: spec.repo, bytes, cached: false, etaSeconds: etaSecs(bytes, mbps()), consent: consentFor(bytes, sd) }
  },

  /** Every example once (Hub facts only, no model files), so the picker can show size, time and fit. */
  async loadCatalog() {
    const ex = useStore.getState().examples
    const budget = await api.deviceBudget().catch(() => null)
    await Promise.all(ex.map(async (e) => {
      const row: CatRow = { id: e.id, title: e.title, repo: e.repo, task: e.task ?? 'text-generation', recorded: !!e.file, bytes: null, plan: null, fit: null, spec: null }
      set((s) => ({ catalog: { ...s.catalog, [e.id]: s.catalog[e.id] ?? row } }))
      try {
        const spec = await api.resolveModel(e.repo)
        const fit = budget ? api.checkFit(spec, budget) : null
        const plan = await get().planFor(spec, fit)
        set((s) => ({ catalog: { ...s.catalog, [e.id]: { ...row, spec, fit, plan, bytes: plan.bytes, verdict: fit?.verdict } } }))
      } catch { /* a row without facts still lists */ }
    }))
  },

  cancelLive() { abort?.abort(); handle?.cancel(); abort = null; handle = null; set({ dl: dl0 }) },

  /** The one primary action. Consent first (size shown, a warning above 150 MB), then the download with progress, then the run. */
  async startLive(exampleId, confirmed = false, src = 'dock') {
    const st = useStore.getState()
    const ex = exampleId ? st.examples.find((e) => e.id === exampleId) : undefined
    set({ dl: { ...dl0, phase: 'running', t0: performance.now(), src }, cardOff: true })
    try {
      // plan from the catalog while the recorded run keeps playing; the model loads (and replaces it) only when the run starts
      const pre = ex ? get().catalog[ex.id] : undefined
      const switching = !!ex && st.repo.toLowerCase() !== ex.repo.toLowerCase()
      if (switching && !pre?.spec) await st.loadExample(ex!.id)
      const now = useStore.getState()
      const spec = switching && pre?.spec ? pre.spec : now.spec, fit = switching && pre?.spec ? pre.fit : now.fit
      if (!spec) { set({ dl: { ...dl0, phase: 'error', src, err: now.probeErr ?? 'The model could not be read. Check the name and try again.' } }); return }
      const plan = await get().planFor(spec, fit)
      if (plan.consent === 'warn' && !plan.cached && !confirmed) { set({ dl: { ...dl0, phase: 'warn', total: plan.bytes, eta: plan.etaSeconds, id: exampleId, src } }); return }
      if (!plan.cached && fit && fit.where !== 'companion' && fit.verdict !== 'too-big') {
        abort = new AbortController()
        set({ dl: { phase: 'downloading', done: 0, total: plan.bytes, t0: performance.now(), src } })
        try {
          const h = api.ensureModel(spec, { onProgress: (done, total) => set((s) => ({ dl: { ...s.dl, done, total: total ?? s.dl.total } })), signal: abort.signal })
          handle = h
          await h.done
        } catch (e: any) {
          if (!/not implemented/i.test(String(e?.message))) {
            if (abort?.signal.aborted || /abort|cancel/i.test(String(e?.name ?? e?.message))) { set({ dl: dl0 }); return }
            set({ dl: { ...dl0, phase: 'error', src, err: e?.message ?? String(e) } }); return
          }
        }
      }
      set({ dl: { ...dl0, phase: 'running', t0: performance.now(), src } })
      if (switching && pre?.spec) await st.loadExample(ex!.id)
      await useStore.getState().run()
      const s2: any = useStore.getState()
      if (s2.pendingDownload && typeof s2.confirmDownload === 'function') await s2.confirmDownload()
      set({ dl: dl0 })
    } catch (e: any) {
      set({ dl: { ...dl0, phase: 'error', src, err: e?.message ?? String(e) } })
    } finally { abort = null; handle = null }
  },

  net: 'llm', packs: {}, digits: null, base: new Array(64).fill(0), img: new Array(64).fill(0), label: null, fx: FX0, timing: {}, sweep: null, sweepBusy: null, out: null, err: null, t: 0, playing: false, speed: 1, sel: null, inspect: null, setInspect(i) { set({ inspect: i }) },

  async init() {
    if (get().digits) return
    try {
      const d = await (await fetch(base() + 'digits.json')).json()
      set({ digits: d })
      await get().setNet(get().net)
      get().setImg(d.images[0], d.labels[0])
      get().loadAll()
    } catch (e: any) { set({ err: e.message ?? String(e) }) }
  },

  async setNet(net) {
    get().pause()
    if (net !== 'llm' && !get().packs[net]) {
      const p = await (await fetch(base() + `${net}.json`)).json()
      set((s) => ({ packs: { ...s.packs, [net]: p } }))
    }
    set({ net, sel: null, t: 0 })
    get().recompute()
    get().play()
  },

  setImg(base, label = null) { set({ base, img: applyFx(base, get().fx), label }); get().recompute() },
  setFx(f) { const fx = { ...get().fx, ...f }; set({ fx, img: applyFx(get().base, fx) }); get().recompute() },

  /** All five networks, so they can be compared side by side; then time each one on this device. */
  async loadAll() {
    const missing = NETS.map((n) => n.id).filter((id) => !get().packs[id])
    const got = await Promise.all(missing.map(async (id) => [id, await (await fetch(base() + `${id}.json`)).json()] as const))
    set((s) => ({ packs: { ...s.packs, ...Object.fromEntries(got) } }))
    const d = get().digits
    if (!d) return
    for (const n of NETS) {
      await new Promise((r) => setTimeout(r, 0))
      set((s) => ({ timing: { ...s.timing, [n.id]: timeNet(n.id, get().packs[n.id]!, d.images) } }))
    }
  },

  /** Accuracy of every network on the test digits as noise rises. Runs in small slices so the page stays smooth. */
  async runSweep() {
    const d = get().digits
    if (!d || get().sweepBusy) return
    await get().loadAll()
    const acc: Sweep['acc'] = {}
    set({ sweep: { levels: SWEEP_LEVELS, acc, n: d.images.length } })
    for (const n of NETS) {
      acc[n.id] = []
      for (const lv of SWEEP_LEVELS) {
        set({ sweepBusy: `${n.short} at ${Math.round(lv * 100)}% noise` })
        await new Promise((r) => setTimeout(r, 0))
        acc[n.id]!.push(accuracyAt(n.id, get().packs[n.id]!, d.images, d.labels, lv))
        set({ sweep: { levels: SWEEP_LEVELS, acc: { ...acc }, n: d.images.length } })
      }
    }
    set({ sweepBusy: null })
  },

  recompute() {
    const { net, packs, img } = get()
    if (net === 'llm') { set({ out: llmOut() }); return }
    const p = packs[net]
    if (!p) return
    const fn: any = { mlp, cnn, rnn, vit }[net as 'mlp']
    const out = net === 'vlm' ? vlm(p.weights, img, p.vocab!) : fn(p.weights, img)
    set({ out })
  },

  setT(t) { set({ t: Math.max(0, Math.min(totalZ(get().net), t)) }) },
  play() {
    if (get().playing) return
    if (get().t >= totalZ(get().net) - 0.02) set({ t: 0 })
    set({ playing: true }); last = performance.now()
    const loop = () => {
      raf = requestAnimationFrame((now) => {
        const s = get(); if (!s.playing) return
        const dt = Math.min(0.1, (now - last) / 1000); last = now
        const t = s.t + dt * s.speed, T = totalZ(s.net)
        if (t >= T) { set({ t: T, playing: false }); return }
        set({ t }); loop()
      })
    }
    loop()
  },
  pause() { cancelAnimationFrame(raf); set({ playing: false }) },
  setSpeed(speed) { set({ speed }) },
  select(sel) { set({ sel }) },
}))

/** The real model's run, shaped for the zoo scene. Signal sizes grow a lot with depth and the first token is often
 *  huge (an "attention sink"), so they are drawn on a log scale. */
function llmOut() {
  const st = useStore.getState()
  const T = st.tokens.length, L = st.layers.length
  if (!T || !L) return null
  const lg = (v: number) => Math.log1p(Math.abs(v))
  const resid = st.layers.flatMap((l: any) => l.resid_norm.slice(0, T).map(lg))
  const rmax = Math.max(1e-6, ...resid)
  const nh = st.layers[0].head_norm.length
  const heads = st.layers.flatMap((l: any) => l.head_norm)
  const hmax = Math.max(1e-6, ...heads)
  const emb = (st.embed?.norm ?? []).slice(0, T)
  const emax = Math.max(1e-6, ...emb)
  // attention of the last token (the one that predicts the next word), averaged over the heads of each block
  const attn = st.layers.map((l: any) => { const row = new Array(T).fill(0); for (const h of l.attn) { const r = h[T - 1] ?? []; for (let j = 0; j < T; j++) row[j] += (r[j] ?? 0) / l.attn.length } return row })
  const top = (st.final?.topk ?? []).slice(0, 10)
  return {
    id: `${st.repo}|${st.tokens.join('')}|${L}|${top[0]?.token ?? ''}`,
    T, L, nh, tokens: st.tokens as string[], emb: emb.map((v: number) => v / emax), resid: resid.map((v: number) => v / rmax),
    heads: heads.map((v: number) => v / hmax), attn, done: !!st.final,
    probs: Array.from({ length: 10 }, (_, i) => top[i]?.p ?? 0), labels: Array.from({ length: 10 }, (_, i) => (top[i]?.token ?? '').replace(/\n/g, '⏎')),
  }
}

// The real model follows the shared run: new layers redraw it, and a finished run plays from the start.
useStore.subscribe((s, p) => {
  const z = useZoo.getState()
  if (z.net !== 'llm' || (s.layers === p.layers && s.final === p.final && s.tokens === p.tokens)) return
  z.recompute()
  if (s.final && s.final !== p.final) { z.pause(); useZoo.setState({ t: 0 }); z.play() }
})
