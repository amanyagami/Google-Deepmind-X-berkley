import { create } from 'zustand'
import { useStore } from '../store'
import * as api from '../api'
import type { DownloadPlan, Fit, ModelSpec, Task, TaskInput } from '../api'
import type { InputCaps, LangId } from './nets'
import { useHW } from '../hw/hwStore'
import { inputHash, readFrom, runNet, timeNet, type Pack, type Read, type Speed } from './nets'

/** 'llm' is the real model loaded at the top of the page, run on the shared prompt; the others are the five tiny
 *  digit networks, all reading the same 8x8 image. */
export type NetId = 'llm' | 'mlp' | 'cnn' | 'rnn' | 'vit' | 'vlm'
export type DigitNet = Exclude<NetId, 'llm'>
export const NETS: { id: DigitNet; short: string }[] = [
  { id: 'mlp', short: 'MLP' }, { id: 'cnn', short: 'CNN' }, { id: 'rnn', short: 'RNN' }, { id: 'vit', short: 'ViT' }, { id: 'vlm', short: 'VLM' },
]

/** Stages of each network's flow, in order. Durations are visual seconds at 1x. */
export const STAGES: Record<NetId, { id: string; label: string; dur: number }[]> = {
  llm: [{ id: 'input', label: 'Words', dur: 1.4 }, { id: 'blocks', label: 'Blocks', dur: 7.5 }, { id: 'out', label: 'Guess', dur: 2.0 }],
  mlp: [{ id: 'input', label: 'Pixels', dur: 1.2 }, { id: 'h1', label: 'Layer 1', dur: 2.2 }, { id: 'h2', label: 'Layer 2', dur: 1.8 }, { id: 'out', label: 'Guess', dur: 1.6 }],
  cnn: [{ id: 'input', label: 'Pixels', dur: 1.0 }, { id: 'conv1', label: 'Filters 1', dur: 3.2 }, { id: 'pool1', label: 'Pool 1', dur: 1.0 }, { id: 'conv2', label: 'Filters 2', dur: 2.6 }, { id: 'pool2', label: 'Pool 2', dur: 0.9 }, { id: 'out', label: 'Guess', dur: 1.4 }],
  rnn: [{ id: 'input', label: 'Pixels', dur: 0.8 }, ...Array.from({ length: 8 }, (_, t) => ({ id: `t${t}`, label: `Row ${t + 1}`, dur: 0.9 })), { id: 'out', label: 'Guess', dur: 1.4 }],
  vit: [{ id: 'input', label: 'Pixels', dur: 1.0 }, { id: 'patch', label: 'Patches', dur: 1.6 }, { id: 'embed', label: 'Tokens', dur: 1.4 }, { id: 'attn', label: 'Attention', dur: 3.0 }, { id: 'mlp', label: 'MLP', dur: 1.2 }, { id: 'out', label: 'Guess', dur: 1.4 }],
  vlm: [{ id: 'input', label: 'Pixels', dur: 0.8 }, { id: 'vision', label: 'Vision', dur: 2.0 }, { id: 'connect', label: 'Connect', dur: 1.2 }, { id: 'write', label: 'Writing', dur: 7.0 }],
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

interface Z {
  /** language of the prompt (R2-1) and, for speech models, the spoken language */
  lang: LangId
  setLang: (l: LangId) => void
  custom: Partial<Record<Task, TaskInput>>
  remember: (t: Task, i: TaskInput) => void
  cardOff: boolean
  setCardOff: (v: boolean) => void
  caps: (InputCaps & { line: string }) | null
  loadCaps: () => Promise<void>
  catalog: Record<string, CatRow>
  loadCatalog: () => Promise<void>
  planFor: (spec: ModelSpec, fit: Fit | null) => Promise<DownloadPlan>
  /** The one primary action: switch to the example if needed, then run (consent and download progress live in the main store). */
  startLive: (exampleId?: string) => Promise<void>
  net: NetId
  packs: Partial<Record<DigitNet, Pack>>
  digits: { images: number[][]; labels: number[] } | null
  /** what was drawn or picked; `img` is what every network sees (the pad centred like MNIST) */
  base: number[]
  img: number[]
  label: number | null
  /** the VLM's text input: the user's first words, which the model then finishes */
  words: string
  setWords: (w: string) => void
  timing: Partial<Record<DigitNet, Speed>>
  out: any
  /** What each tiny net reads from the current picture: ONE forward pass each, the source for the table, the pad verdict and the 3D label. */
  reads: Partial<Record<DigitNet, NetRead>>
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
  loadAll: () => Promise<void>
  recompute: () => void
  setT: (t: number) => void
  play: () => void
  pause: () => void
  setSpeed: (s: number) => void
  select: (s: Sel) => void
  /** The real counterpart of a tiny net, run in the page (small ViT for the ViT tab, small vision-language model for the VLM tab) */
  real: Real
  /** Run the real counterpart on the picture now. `tap` is the user's own click (the VLM download starts only on one). */
  runReal: (tap?: boolean) => void
}
/** A net's answer, with the fingerprint of the input it came from and when it was computed. */
export interface NetRead extends Read { net: DigitNet; hash: string; at: number }
export interface Real {
  net: 'vit' | 'vlm' | null
  state: 'idle' | 'running' | 'ok' | 'err' | 'off' | 'ask'
  title: string; repo: string; size: string
  items: { token: string; p: number }[]; text: string
  ms: number | null; device: string | null
  /** download progress 0..1 while the first run fetches the model */
  dl: number | null
  err: string | null
}
const NO_REAL: Real = { net: null, state: 'idle', title: '', repo: '', size: '', items: [], text: '', ms: null, device: null, dl: null, err: null }
export const REAL_VIT = { repo: 'Xenova/mobilevit-small', title: 'MobileViT small', size: '6 MB' }
export const REAL_VLM = { repo: api.VLM_REPO, title: 'SmolVLM 256M', size: 'about 190 MB' }

let raf = 0, last = 0
const base = () => `${import.meta.env.BASE_URL}zoo/`


export const useZoo = create<Z>((set, get) => ({
  lang: 'en', setLang: (lang) => set({ lang }),
  custom: {}, remember: (t, i) => set((s) => ({ custom: { ...s.custom, [t]: i } })),
  cardOff: false, setCardOff: (cardOff) => set({ cardOff }),
  caps: null, catalog: {},

  async loadCaps() {
    if (get().caps) return
    const hw: any = useHW.getState().caps
    if (hw) { const mem = hw.deviceMemoryGB ?? null; set({ caps: { deviceMemoryGB: mem, line: `${hw.cores} threads · ${hw.gpu?.available ? (hw.gpu.adapter || 'GPU') + ' with WebGPU' : 'no WebGPU, so the CPU'}${mem ? ` · ${mem} GB memory` : ''}` } }); return }
    let line = '', mem: number | null = (navigator as any).deviceMemory ?? null
    try {
      const m: any = await import('../hw/browserBench')
      const c = await m.probe()
      mem = c.deviceMemoryGB ?? mem
      line = `${c.cores} threads · ${c.gpu?.available ? (c.gpu.adapter || 'GPU') + ' with WebGPU' : 'no WebGPU, so the CPU'}${mem ? ` · ${mem} GB memory` : ''}`
    } catch {
      const gpu = !!(navigator as any).gpu
      line = `${navigator.hardwareConcurrency || '?'} cores · ${gpu ? 'WebGPU ready' : 'no WebGPU, so the CPU'}${mem ? ` · ${mem} GB memory` : ''}`
    }
    set({ caps: { line, deviceMemoryGB: mem } })
  },

  /** The download plan from the models engine; a companion run downloads nothing in the browser. */
  async planFor(spec, fit) {
    const dev = fit?.where === 'webgpu' || fit?.where === 'wasm' ? fit.where : undefined
    if (!dev) return { repo: spec.repo, bytes: null, cached: false, etaSeconds: null, consent: 'none' }
    return api.planDownload(spec, { device: dev })
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

  async startLive(exampleId) {
    set({ cardOff: true })
    const st = useStore.getState()
    const ex = exampleId ? st.examples.find((e) => e.id === exampleId) : undefined
    if (ex && st.repo.toLowerCase() !== ex.repo.toLowerCase()) await st.loadExample(ex.id)
    const cur = useStore.getState()
    if (cur.probeErr || (!cur.spec && !cur.probe)) { useStore.setState({ runErr: cur.probeErr ?? 'This model could not be read. Pick another model.', runErrCode: 'unsupported' }); return }
    // offline and not cached: say so now, not after a failed download
    if (cur.spec && cur.fit && (cur.fit.where === 'webgpu' || cur.fit.where === 'wasm') && typeof navigator !== 'undefined' && navigator.onLine === false) {
      const plan = await get().planFor(cur.spec, cur.fit).catch(() => null)
      if (plan && !plan.cached) { useStore.setState({ runErr: 'You are offline, so the model cannot download. Connect, then try again.', runErrCode: 'offline' }); return }
    }
    await useStore.getState().run()
    // the button showed the size, so the click is the consent for a normal download; a big one waits for its own button
    const p = useStore.getState().pendingDownload
    if (p && p.consent === 'size') await useStore.getState().confirmDownload()
  },

  real: NO_REAL, reads: {},
  runReal(tap) { realKick(tap === true) },
  net: 'llm', packs: {}, digits: null, base: new Array(64).fill(0), img: new Array(64).fill(0), label: null, timing: {}, out: null, err: null, t: 0, playing: false, speed: 1, sel: null, inspect: null, setInspect(i) { set({ inspect: i }) },

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
    set({ net, sel: null, t: 0, real: net === 'vit' || net === 'vlm' ? { ...NO_REAL, net } : NO_REAL })
    get().recompute()
    if (!get().out?.draft) get().play()
    if (net === 'vit' || net === 'vlm') realKick(false)
    else if (net === 'llm') llmAgain()
  },

  setImg(base, label = null) { set({ base, img: base, label }); get().recompute(); if (get().net === 'vit' || get().net === 'vlm') realKick(false) },
  words: 'this is', setWords(words) { set({ words }); if (get().net === 'vlm') get().recompute() },

  /** All five networks, so they can be compared side by side; then time each one on this device. */
  async loadAll() {
    const missing = NETS.map((n) => n.id).filter((id) => !get().packs[id])
    const got = await Promise.all(missing.map(async (id) => [id, await (await fetch(base() + `${id}.json`)).json()] as const))
    set((s) => ({ packs: { ...s.packs, ...Object.fromEntries(got) } }))
    get().recompute()
    const d = get().digits
    if (!d) return
    for (const n of NETS) {
      await new Promise((r) => setTimeout(r, 0))
      set((s) => ({ timing: { ...s.timing, [n.id]: timeNet(n.id, get().packs[n.id]!, d.images) } }))
    }
  },

  recompute() {
    const { net, packs, img, words } = get()
    // one forward pass per net on this picture; the table, the pad verdict and the 3D scene all read these same results
    const hash = inputHash(img, words.trim().toLowerCase())
    const outs: Partial<Record<DigitNet, any>> = {}
    let reads = get().reads
    const stale = NETS.some((n) => packs[n.id] && reads[n.id]?.hash !== hash)
    if (stale) {
      const at = performance.now(), next: Partial<Record<DigitNet, NetRead>> = {}
      for (const n of NETS) { const p = packs[n.id]; if (!p) continue; const o = runNet(n.id, p, img, words); outs[n.id] = o; next[n.id] = { ...readFrom(n.id, p, o), net: n.id, hash, at } }
      reads = next
    }
    if (net === 'llm') {
      const out: any = llmOut(), was = get().out
      set({ out, reads })
      // typed but not run yet: show the words as they arrive, with the blocks waiting
      if (out?.draft && !was?.draft) { get().pause(); set({ t: STAGES.llm[0].dur }) }
      else if (!out?.draft && was?.draft) { set({ t: 0 }); get().play() }
      return
    }
    const p = packs[net]
    if (!p) { set({ reads }); return }
    const out = outs[net] ?? runNet(net, p, img, words)
    set({ out: { ...out, hash }, reads })
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
/** The prompt the shown tokens came from, and the size of the last real run (a draft reuses it). */
let ranText = ''
let lastShape = { L: 12, nh: 8 }
const norm = (t: string) => t.trim().replace(/\s+/g, ' ')
const MAX_DRAFT = 48
/** Typed words, split the way a reader would (the real tokenizer runs with the model). */
export function draftPieces(text: string, lang: string): string[] {
  try {
    const seg = new (Intl as any).Segmenter(lang, { granularity: 'word' })
    return [...seg.segment(text)].map((x: any) => (x.segment as string).trim()).filter(Boolean).slice(0, MAX_DRAFT)
  } catch { return text.split(/\s+/).filter(Boolean).slice(0, MAX_DRAFT) }
}

function llmOut() {
  const st = useStore.getState()
  const real = llmReal()
  const typed = st.input.kind === 'text' ? st.input.text : ''
  const same = norm(typed) === norm(ranText)
  if (!norm(typed) || (real && same)) return real
  // a browser run gives tokens and the next-word scores but no inside view: show its real tokens, blocks left dark
  if (same && st.tokens.length) return shell(st.tokens.slice(0, MAX_DRAFT).map((t: string) => t.trim() || '·'), `ran|${st.tokens.join('')}`, { noInside: true, done: !!st.final })
  // while a run or its download is under way the scene waits for the real tokens (no draft that is about to be replaced)
  if (st.running || st.download || st.pendingDownload || st.probing) return real
  // the user typed something that has not been run: their words become the prompt tiles, the blocks wait for Run
  return shell(draftPieces(typed, useZoo.getState().lang), `draft|${typed}`, { draft: true })
}

/** The real-model scene's data with no block values: the prompt tiles only (a draft, or a run without an inside view). */
function shell(tokens: string[], id: string, extra: Record<string, unknown>) {
  const st = useStore.getState()
  const T = tokens.length, { L, nh } = lastShape
  const top = extra.noInside ? (st.final?.topk ?? []).slice(0, 10) : []
  return {
    id, T, L, nh, tokens, emb: tokens.map(() => 0.6), resid: new Array(T * L).fill(0),
    heads: new Array(L * nh).fill(0), attn: Array.from({ length: L }, () => new Array(T).fill(0)), done: false,
    probs: Array.from({ length: 10 }, (_, i) => top[i]?.p ?? 0), labels: Array.from({ length: 10 }, (_, i) => (top[i]?.token ?? '').replace(/\n/g, '⏎')),
    ...extra,
  }
}

function llmReal() {
  const st = useStore.getState()
  const T = st.tokens.length, L = st.layers.length
  if (!T || !L) return null
  lastShape = { L, nh: st.layers[0].head_norm.length }
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

{ const s = useStore.getState(); if (s.tokens.length) ranText = s.input.kind === 'text' ? s.input.text : s.prompt }
// The real model follows the shared run: new layers redraw it, and a finished run plays from the start.
useStore.subscribe((s, p) => {
  const z = useZoo.getState()
  // new tokens belong to the prompt that was sent (the box may change again while it runs)
  if (s.tokens !== p.tokens && s.tokens.length) ranText = s.input.kind === 'text' ? s.input.text : s.prompt
  if (z.net !== 'llm' || (s.layers === p.layers && s.final === p.final && s.tokens === p.tokens && s.input === p.input && s.running === p.running && !s.download === !p.download && !s.pendingDownload === !p.pendingDownload && s.probing === p.probing)) return
  z.recompute()
  if (s.final && s.final !== p.final) { z.pause(); useZoo.setState({ t: 0 }); z.play() }
})


/* ------------------------------------------------------------------ the real counterparts (never recorded: each answer is computed just now) */
let realCtl: AbortController | null = null
let realBusy = false
let realDirty = false
const realSpecs = new Map<string, Promise<{ spec: ModelSpec; fit: Fit }>>()
const specFor = (repo: string) => {
  let p = realSpecs.get(repo)
  if (!p) { p = (async () => { const spec = await api.resolveModel(repo); return { spec, fit: api.checkFit(spec, await api.deviceBudget()) } })(); realSpecs.set(repo, p); p.catch(() => realSpecs.delete(repo)) }
  return p
}
/** The 8 by 8 picture as a 224 by 224 PNG (white ink on black, hard pixel edges): what a real vision model is shown. */
function picture(img: number[]): string {
  const cv = document.createElement('canvas'); cv.width = cv.height = 224
  const c = cv.getContext('2d')!
  c.fillStyle = '#000'; c.fillRect(0, 0, 224, 224)
  img.slice(0, 64).forEach((v, i) => { const g = Math.round(255 * Math.max(0, Math.min(1, v))); c.fillStyle = `rgb(${g},${g},${g})`; c.fillRect((i % 8) * 28, Math.floor(i / 8) * 28, 28, 28) })
  return cv.toDataURL('image/png')
}
const setReal = (r: Partial<Real>) => useZoo.setState((s) => ({ real: { ...s.real, ...r } }))
const VLM_ASKED = 'ns.vlm.ok'
const lsHas = (k: string) => { try { return localStorage.getItem(k) === '1' } catch { return false } }

/** Start (or queue) the real run for the current tab and picture: one at a time, the newest picture always gets its turn. */
function realKick(tap: boolean) {
  const net = useZoo.getState().net
  if (net !== 'vit' && net !== 'vlm') return
  if (net === 'vlm' && !tap && !lsHas(VLM_ASKED)) { const m = REAL_VLM; setReal({ net, state: 'ask', title: m.title, repo: m.repo, size: m.size }); return }
  if (realBusy) { realDirty = true; return }
  void realLoop(net)
}
async function realLoop(net: 'vit' | 'vlm') {
  realBusy = true
  const m = net === 'vit' ? REAL_VIT : REAL_VLM
  try {
    do {
      realDirty = false
      const z = useZoo.getState()
      if (z.net !== net) break
      if (z.img.every((v) => v === 0)) { setReal({ net, state: 'idle', title: m.title, repo: m.repo, size: m.size, items: [], text: '', err: null }); break }
      const ctl = (realCtl = new AbortController())
      setReal({ net, state: 'running', title: m.title, repo: m.repo, size: m.size, err: null, dl: null })
      try {
        const { spec, fit } = await specFor(net === 'vit' ? REAL_VIT.repo : 'Xenova/mobilevit-small')
        const where = fit.where
        if (where !== 'webgpu' && where !== 'wasm') { setReal({ state: 'off', err: 'This device cannot run a real model in the page.' }); break }
        const url = picture(z.img)
        const onProgress = (d: number, t: number | null) => setReal({ dl: t && d < t ? d / t : null })
        if (net === 'vit') {
          let items: Real['items'] = []
          const stats = await api.runInBrowser(spec, { kind: 'image', url }, (f) => { if (f.type === 'final' && f.labels) items = f.labels.map((l: any) => ({ token: String(l.label), p: l.score })) }, { device: where, signal: ctl.signal, onProgress })
          setReal({ state: 'ok', items, ms: stats.totalMs, device: stats.where, dl: null })
        } else {
          setReal({ text: '' })
          try { localStorage.setItem(VLM_ASKED, '1') } catch { /* private mode */ }
          const r = await api.askVlm({ image: url, question: 'What number is written in this picture? Answer in one short sentence.', device: where }, { signal: ctl.signal, onProgress, onToken: (t) => setReal({ text: useZoo.getState().real.text + t }) })
          setReal({ state: 'ok', text: r.text, ms: r.ms, device: r.device, dl: null })
        }
      } catch (e: any) {
        if (e?.code === 'aborted') break
        setReal({ state: 'err', err: String(e?.message ?? e), dl: null }); break
      }
    } while (realDirty)
  } finally { realBusy = false; realCtl = null }
}

/** Back on the language-model tab: a result that is not live for this prompt is computed again by the real model. */
function llmAgain() {
  const s = useStore.getState()
  const w = s.fit?.where
  if (!s.spec || s.running || s.download || s.pendingDownload || s.probing || (w !== 'webgpu' && w !== 'wasm')) return
  const typed = s.input.kind === 'text' ? s.input.text : s.prompt
  if (s.provenance === 'live' && s.ranPrompt === typed) return
  if (s.runErr && !s.runErrCode) return
  void s.run({ auto: true })
}

// Clicking a block, token or output in the 3D asks for real data: if what is on screen is not a live result for this prompt, the real model runs first.
useZoo.subscribe((z, p) => {
  if (!z.inspect || z.inspect === p.inspect || z.net !== 'llm') return
  llmAgain()
})
