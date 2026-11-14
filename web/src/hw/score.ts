import { useMemo } from 'react'
import { useHW } from './hwStore'
import type { Fit, RunStats } from '../api'

// Scores are linear against fixed reference values: 1000 points = the reference.
// The references are rounded figures for a recent mainstream laptop. This is a relative yardstick for
// this app, not an industry benchmark, and the numbers behind every score are shown next to it.
export const REF = { cpu1: 100, cpun: 400, cache: 100, ram: 40, disk: 2, net: 100, gpu: 500, ai: 20 }
// Browser-only mode measures through WebAssembly, Web Workers and the browser's file system, which differ from
// native code by a roughly fixed factor per test. Its references are scaled so that the test PC (Ryzen 7 8745HS,
// Radeon 780M) gets the same component scores both ways. Paired runs on that PC, 2026-11-14:
//   one core 125 native vs 37.3 WASM SIMD · all cores 570 vs 190 · cache peak 125 vs 208 (memcpy) · RAM 39.8 vs 54.6
//   storage 3.2 (raw SSD) vs 1.26 (browser file system) · language model 24 tok/s (PyTorch fp32, CPU)
//   vs 76 (transformers.js q4f16, WebGPU) and 36.9 (q8, WebAssembly on the CPU).
export const REF_BROWSER = { cpu1: 30, cpun: 133, cache: 166, ram: 55, disk: 0.8, net: 100, gpu: 500, ai: 63, ai_wasm: 31 }
// Efficiency (not part of the overall score): GFLOP per joule on all cores, and words written per kJ.
export const REF_EFF = { cpu: 8, ai: 500 }

export interface Sub {
  id: string            // sub-score id
  comp: 'cpu' | 'cache' | 'ram' | 'ssd' | 'nic' | 'gpu' | 'system' | 'power'
  label: string
  score: number | null
  value: string          // measured, human readable
  detail: string         // plain-language note
  peak?: string          // theoretical, if known
  pct?: number | null    // measured / theoretical
  live?: boolean
}
export interface CompScore { id: Sub['comp']; name: string; role: string; score: number | null; subs: Sub[] }
export interface Scores { comps: CompScore[]; overall: number | null; tier: string; by: Record<string, number | null>; count: number }

const pts = (v: number | undefined | null, ref: number) => (v === undefined || v === null || !isFinite(v) ? null : Math.round((1000 * v) / ref))
const mean = (xs: (number | null)[]) => { const a = xs.filter((x): x is number => x !== null); return a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null }

export function tierOf(s: number | null) {
  if (s === null) return '—'
  return s < 400 ? 'Entry' : s < 800 ? 'Everyday' : s < 1200 ? 'Strong' : s < 1800 ? 'Excellent' : 'Exceptional'
}

const spreadNote = (x: any, unit: string) => (x?.spread?.n > 1 ? ` Over ${x.spread.n} runs: ${x.spread.min}–${x.spread.max} ${unit}, varying ${x.spread.cv_pct}%.` : '')

export function computeScores(bench: Record<string, any>, journey: any, info: any, power?: any): Scores {
  const browser = info?.source === 'browser'
  const R = browser ? { ...REF_BROWSER, ai: bench.ai?.device === 'wasm' ? REF_BROWSER.ai_wasm : REF_BROWSER.ai } : REF
  const aiTps: number | undefined = bench.ai?.tps ?? journey?.decode?.tps
  const aiModel: string = bench.ai ? `${bench.ai.model.split('/').pop()}${bench.ai.device ? ` on ${bench.ai.device === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU (WebAssembly)'}` : ''}` : journey ? journey.repo.split('/').pop() : ''
  const cacheMax = bench.cache ? Math.max(...bench.cache.map((c: any) => c.gbps)) : null
  const cacheTail = bench.cache ? bench.cache[bench.cache.length - 1].gbps : null
  const gpu = bench.gpu && !bench.gpu.unavailable ? bench.gpu : null
  const peakG = info?.cpu?.peak_gflops_est, peakM = info?.ram?.peak_gbps_est
  const pct = (v?: number, p?: number) => (v && p ? Math.round((100 * v) / p) : null)

  const cpu: Sub[] = [
    { id: 'cpu1', comp: 'cpu', label: 'Single core', score: pts(bench.matmul_1?.gflops, R.cpu1), value: bench.matmul_1 ? `${bench.matmul_1.gflops} GFLOP/s` : '…',
      detail: 'One core multiplying matrices, using its wide vector unit.' + spreadNote(bench.matmul_1, 'GFLOP/s'), peak: peakG && info?.cpu?.cores ? `${Math.round(peakG / info.cpu.cores)} GFLOP/s at base clock` : undefined, pct: pct(bench.matmul_1?.gflops, peakG && info?.cpu?.cores ? peakG / info.cpu.cores : undefined) },
    { id: 'cpun', comp: 'cpu', label: 'All cores', score: pts(bench.matmul_n?.gflops, R.cpun), value: bench.matmul_n ? `${bench.matmul_n.gflops} GFLOP/s` : '…',
      detail: `All ${info?.cpu?.threads_used ?? ''} worker threads on the same job.` + spreadNote(bench.matmul_n, 'GFLOP/s'), peak: peakG ? `${Math.round(peakG)} GFLOP/s at base clock` : undefined, pct: pct(bench.matmul_n?.gflops, peakG) },
  ]
  const cache: Sub[] = [{ id: 'cache', comp: 'cache', label: 'Cache speed', score: pts(cacheMax, R.cache), value: cacheMax ? `${cacheMax} GB/s peak` : '…',
    detail: cacheTail ? `Small data sits in fast cache. Large data falls to ${cacheTail} GB/s, the memory speed one core can pull.` : 'Streaming speed while the data still fits in cache.' }]
  const ram: Sub[] = [
    { id: 'ram', comp: 'ram', label: 'Memory bandwidth', score: pts(bench.dram?.copy_gbps, R.ram), value: bench.dram ? `${bench.dram.copy_gbps} GB/s` : '…',
      detail: (browser ? 'Copying large arrays in every worker at once.' : 'Copying a 160 MB array: how fast RAM can feed the CPU.') + spreadNote(bench.dram, 'GB/s'), peak: peakM ? `${peakM} GB/s on paper` : undefined, pct: pct(bench.dram?.copy_gbps, peakM) },
  ]
  const ssd: Sub[] = [{ id: 'disk', comp: 'ssd', label: 'Sequential read', score: pts(bench.disk?.gbps, R.disk), value: bench.disk ? `${bench.disk.gbps} GB/s` : '…',
    detail: bench.disk ? `Read ${bench.disk.mb} MB straight from the drive, skipping the OS cache.` : 'Reading a model file straight from the drive.' }]
  const nic: Sub[] = [{ id: 'net', comp: 'nic', label: 'Download speed', score: pts(bench.net?.mbps, R.net), value: bench.net ? `${bench.net.mbps} Mbit/s` : '…',
    detail: bench.net ? `Pulled ${bench.net.mb} MB from the Hub; first byte after ${bench.net.latency_ms} ms.` : 'Downloading from the Hugging Face Hub.', peak: info?.nics?.[0]?.link }]
  const gpuSub: Sub[] = [{ id: 'gpu', comp: 'gpu', label: 'GPU compute (WebGPU)', score: pts(gpu?.gflops, R.gpu),
    value: gpu ? `${gpu.gflops} GFLOP/s` : bench.gpu?.unavailable ? 'unavailable' : '…', detail: gpu ? `${gpu.adapter}. PyTorch here runs on the CPU, so this measures what the GPU could do.` : (bench.gpu?.reason ?? 'A matrix multiply on the graphics chip.') }]
  const sys: Sub[] = [{ id: 'ai', comp: 'system', label: 'Language model speed', score: pts(aiTps, R.ai), value: aiTps ? `${aiTps} tokens/s` : bench.matmul_1 && !bench.ai ? 'not run' : '…',
    detail: aiTps ? `${aiModel} writing one word at a time.${bench.ai?.spread ? ` Spread over ${bench.ai.spread.n} words: ${bench.ai.spread.min}–${bench.ai.spread.max}.` : ''}` : 'A real small language model writing text.' }]
  const S = power?.summary
  const measuredPower = power && !power.estimated && !power.reference
  const effCpu = measuredPower && bench.matmul_n && S?.matmul_n?.avg_w ? bench.matmul_n.gflops / S.matmul_n.avg_w : null
  const effAi = measuredPower && aiTps && bench.ai && S?.ai?.avg_w ? (1000 * aiTps) / S.ai.avg_w : null
  const pw: Sub[] = [
    { id: 'eff_cpu', comp: 'power', label: 'Math per joule', score: pts(effCpu, REF_EFF.cpu), value: effCpu ? `${effCpu.toFixed(1)} GFLOP/J` : power?.estimated ? 'needs a power sensor' : '…',
      detail: effCpu ? `All cores at ${S.matmul_n.avg_w} W average, measured by the CPU.` : 'All-core math divided by the measured package power.' },
    { id: 'eff_ai', comp: 'power', label: 'Words per kilojoule', score: pts(effAi, REF_EFF.ai), value: effAi ? `${effAi.toFixed(0)} words/kJ` : power?.estimated ? 'needs a power sensor' : '…',
      detail: effAi ? `${(S.ai.avg_w / aiTps!).toFixed(2)} J for each word the model writes.` : 'Language-model speed divided by the measured package power.' },
  ]

  const comps: CompScore[] = [
    { id: 'cpu', name: 'CPU', role: 'does the arithmetic', score: mean(cpu.map((s) => s.score)), subs: cpu },
    { id: 'cache', name: 'Cache', role: 'tiny, very fast memory on the chip', score: cache[0].score, subs: cache },
    { id: 'ram', name: 'RAM', role: 'holds the model while it runs', score: ram[0].score, subs: ram },
    { id: 'ssd', name: 'SSD', role: 'stores the model between runs', score: ssd[0].score, subs: ssd },
    { id: 'gpu', name: 'GPU', role: 'graphics chip, built for parallel math', score: gpuSub[0].score, subs: gpuSub },
    { id: 'nic', name: 'Network', role: 'brings models in from the internet', score: nic[0].score, subs: nic },
    { id: 'system', name: 'AI inference', role: 'the whole machine, end to end', score: sys[0].score, subs: sys },
    { id: 'power', name: 'Efficiency', role: 'work done per unit of electricity (not in the overall score)', score: mean(pw.map((s) => s.score)), subs: pw },
  ]
  // weighted geometric mean over whatever has been measured so far
  const W: Record<string, number> = { cpu1: 0.15, cpun: 0.2, cache: 0.1, ram: 0.2, disk: 0.1, gpu: 0.1, net: 0.05, ai: 0.1 }
  let sw = 0, sl = 0, count = 0
  for (const c of comps) for (const s of c.subs) if (s.score && s.score > 0 && W[s.id] !== undefined) { sw += W[s.id]; sl += W[s.id] * Math.log(s.score); count++ }
  const overall = sw ? Math.round(Math.exp(sl / sw)) : null
  const by: Record<string, number | null> = {}
  for (const c of comps) by[c.id] = c.score
  return { comps, overall, tier: tierOf(overall), by, count }
}

export function useScores(): Scores {
  const bench = useHW((s) => s.bench)
  // a journey recorded on the test PC says nothing about this machine
  const journey = useHW((s) => (s.recorded ? null : s.journey))
  const info = useHW((s) => s.info)
  const power = useHW((s) => s.power)
  return useMemo(() => computeScores(bench, journey, info, power), [bench, journey, info, power])
}

/* ------------------------------------------------------------------ run score
 * How well did THIS computer run THIS model? 1000 points = the reference, like the device score above. Scores are
 * normalised by work so a 22M and a 1B model are comparable: work rate = items/s x 2 x params (FLOP/s, the cost of one
 * forward pass per item). References come from the language-model rows of REF / REF_BROWSER, measured with the 135M
 * SmolLM2: 20 tok/s native (PyTorch fp32), 63 tok/s WebGPU, 31 tok/s WebAssembly. Native and browser stay separate. */
const REF_PARAMS = 135e6
export const REF_RUN = {
  companion: REF.ai * 2 * REF_PARAMS,              // 5.4 GFLOP/s
  webgpu: REF_BROWSER.ai * 2 * REF_PARAMS,         // 17.0 GFLOP/s
  wasm: REF_BROWSER.ai_wasm * 2 * REF_PARAMS,      // 8.4 GFLOP/s
  firstMs: 300,                                    // time to first output worth 1000 points
  joule: 0.5 * 2 * REF_PARAMS,                     // 0.5 tokens per joule (REF_EFF.ai = 500 words/kJ) = 135 MFLOP/J
  rtf: 5, rtfParams: 74e6,                         // speech: 5x real time for a 74M model
  needFrac: 0.5,                                   // headroom: 1000 points at half the memory budget
}
// One item is a forward pass over a whole input, not one token: tokens of work per item.
const ITEM_TOKENS: Record<string, number> = { 'text-classification': 16, 'fill-mask': 16, 'image-classification': 197, 'automatic-speech-recognition': 1500 }

export interface RunPart { id: 'speed' | 'response' | 'efficiency' | 'headroom'; label: string; score: number | null; value: string; detail: string }
export interface RunScore { overall: number; tier: string; parts: RunPart[]; summary: string; reference: string }

const RUN_W = { speed: 0.4, response: 0.2, efficiency: 0.2, headroom: 0.2 }
const cap = (x: number) => Math.max(0, Math.min(2000, Math.round(x)))
const si = (x: number, u: string) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)} G${u}` : x >= 1e6 ? `${(x / 1e6).toFixed(1)} M${u}` : `${(x / 1e3).toFixed(1)} k${u}`)
const nice = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2))
export const RUNTIME_NAME: Record<string, string> = { companion: 'Companion (PyTorch)', webgpu: 'WebGPU', wasm: 'WebAssembly', none: 'not run' }

/** ctx.audioSec (optional): length of the audio for speech tasks, to score by real-time factor. */
export function scoreRun(stats: RunStats, fit: Fit | null, ctx: { params: number | null; info: any | null; audioSec?: number }): RunScore {
  const where = stats.where
  const ref = where === 'companion' ? REF_RUN.companion : where === 'webgpu' ? REF_RUN.webgpu : REF_RUN.wasm
  const refTps = where === 'companion' ? REF.ai : where === 'webgpu' ? REF_BROWSER.ai : REF_BROWSER.ai_wasm
  const params = ctx.params && ctx.params > 0 ? ctx.params : null
  const tokens = stats.unit === 'tokens'
  const perItem = tokens ? 1 : ITEM_TOKENS[stats.task] ?? 16
  const flopsPerItem = params ? 2 * params * perItem : null
  const rate = flopsPerItem && isFinite(stats.perSec) && stats.perSec > 0 ? stats.perSec * flopsPerItem : null

  let speed: RunPart
  const rtf = ctx.audioSec && stats.totalMs > 0 ? ctx.audioSec / (stats.totalMs / 1000) : null
  if (stats.task === 'automatic-speech-recognition' && rtf && params) {
    const sc = cap((1000 * rtf * params) / (REF_RUN.rtf * REF_RUN.rtfParams))
    speed = { id: 'speed', label: 'Speed', score: sc, value: `${nice(rtf)}x real time`,
      detail: `${nice(rtf)}x real time (${ctx.audioSec!.toFixed(1)} s of audio in ${(stats.totalMs / 1000).toFixed(2)} s) x ${si(params, '')} params / (${REF_RUN.rtf}x x ${si(REF_RUN.rtfParams, '')}) x 1000 = ${sc}` }
  } else if (rate) {
    const sc = cap((1000 * rate) / ref)
    speed = { id: 'speed', label: 'Speed', score: sc, value: `${nice(stats.perSec)} ${tokens ? 'tok/s' : 'items/s'} · ${si(rate, 'FLOP/s')}`,
      detail: `${nice(stats.perSec)} ${tokens ? 'tokens' : 'items'}/s x 2 x ${si(params!, '')} params${tokens ? '' : ` x ${perItem} tokens per item`} = ${si(rate, 'FLOP/s')}; / ${si(ref, 'FLOP/s')} reference (${refTps} tok/s on a 135M model) x 1000 = ${sc}` }
  } else speed = { id: 'speed', label: 'Speed', score: null, value: stats.perSec ? `${nice(stats.perSec)} ${tokens ? 'tok/s' : 'items/s'}` : '—', detail: 'Needs the parameter count to compare models of different sizes.' }

  const first = stats.firstMs > 0 ? stats.firstMs : null
  const rsc = first ? cap((1000 * REF_RUN.firstMs) / first) : null
  const response: RunPart = { id: 'response', label: 'Response', score: rsc, value: first ? `${first >= 1000 ? (first / 1000).toFixed(2) + ' s' : Math.round(first) + ' ms'} to first output` : '—',
    detail: first ? `${REF_RUN.firstMs} ms / ${Math.round(first)} ms x 1000 = ${rsc} (capped at 2000)` : 'No timing recorded.' }

  const work = flopsPerItem ? flopsPerItem * stats.items : null
  let efficiency: RunPart
  if (stats.joules && stats.joules > 0 && work) {
    const wpj = work / stats.joules, sc = cap((1000 * wpj) / REF_RUN.joule), est = stats.estimatedEnergy
    efficiency = { id: 'efficiency', label: est ? 'Efficiency (est.)' : 'Efficiency', score: sc, value: `${si(wpj, 'FLOP/J')} · ${stats.joules.toFixed(1)} J${est ? ' est.' : ''}`,
      detail: `${si(work, 'FLOP')} / ${stats.joules.toFixed(1)} J (${est ? 'estimated from load and TDP' : 'measured'}) = ${si(wpj, 'FLOP/J')}; / ${si(REF_RUN.joule, 'FLOP/J')} reference x 1000 = ${sc}` }
  } else efficiency = { id: 'efficiency', label: 'Efficiency', score: null, value: 'no energy data', detail: 'Needs a power sensor (companion) or an energy estimate.' }

  let headroom: RunPart
  if (fit) {
    const frac = fit.haveBytes ? fit.needBytes / fit.haveBytes : null
    let sc: number
    if (fit.verdict === 'too-big') sc = 50
    else if (frac !== null) sc = Math.min(fit.verdict === 'tight' ? 600 : 2000, Math.max(50, cap((1000 * (1 - frac)) / (1 - REF_RUN.needFrac))))
    else sc = fit.verdict === 'tight' ? 400 : 1000
    const mem = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`)
    headroom = { id: 'headroom', label: 'Headroom', score: sc, value: frac !== null ? `${Math.round(frac * 100)}% of memory · ${fit.verdict}` : fit.verdict,
      detail: frac !== null ? `${mem(fit.needBytes)} of ${mem(fit.haveBytes!)} = ${Math.round(frac * 100)}% of budget; (1 - ${frac.toFixed(2)}) / ${1 - REF_RUN.needFrac} x 1000 = ${sc}${fit.verdict === 'tight' ? ' (capped at 600: tight)' : fit.verdict === 'too-big' ? ' (floor 50: too big)' : ''}` : `Verdict ${fit.verdict}; memory budget unknown.` }
  } else headroom = { id: 'headroom', label: 'Headroom', score: null, value: '—', detail: 'No fit estimate for this model.' }

  const parts = [speed, response, efficiency, headroom]
  let sw = 0, sl = 0
  for (const p of parts) if (p.score !== null) { const w = RUN_W[p.id]; sw += w; sl += w * Math.log(Math.max(p.score, 1)) }
  const overall = sw ? Math.round(Math.exp(sl / sw)) : 0
  const rel = speed.score === null ? null : speed.score / 1000
  const dev = ctx.info?.cpu?.name ?? ctx.info?.cpu?.model
  const pace = rel === null ? '' : rel >= 1 ? ` at ${nice(rel)}x the reference speed` : ` at ${Math.round(rel * 100)}% of the reference speed`
  const summary = `${stats.repo.split('/').pop()} ran on ${RUNTIME_NAME[where]}${dev ? ` (${dev})` : ''}${pace}.`
  const reference = `1000 = ${refTps} tok/s on a 135M model (${RUNTIME_NAME[where]}) · ${REF_RUN.firstMs} ms to first output · ${Math.round(REF_RUN.joule / 1e6)} MFLOP/J · half the memory budget used`
  return { overall, tier: tierOf(sw ? overall : null), parts, summary, reference }
}
