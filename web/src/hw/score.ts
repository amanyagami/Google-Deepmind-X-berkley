import { useMemo } from 'react'
import { MODEL_REF, rowFor, useHW } from './hwStore'
import type { ComponentId, Flag, Pillar, Scale, TestResult } from './hwStore'
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

/* ------------------------------------------------------------------ component scores, final score (S3)
 * Results keep raw samples and medians, never scores, so a REF change re-scores everything stored. */
export const NOISY_CV = 15                                       // percent; a result at exactly 15 is flagged
export const isNoisy = (cvPercent: number) => cvPercent >= NOISY_CV
export const resultKey = (r: Pick<TestResult, 'component' | 'input'>) => (r.input.kind === 'custom' ? `${r.component}#custom` : r.component)

const medianOf = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y), n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : NaN }
/** CI of the median (normal approximation, 1.2533 x the standard error of the mean). */
export function ciOf(median: number, sd: number, n: number): [number, number] {
  if (n < 2 || !isFinite(sd)) return [median, median]
  const h = (1.96 * 1.2533 * sd) / Math.sqrt(n)
  return [Math.max(0, median - h), median + h]
}
/** value = median, cv in percent, ci95 of the median. */
export function summarize(samples: number[]): { value: number; ci95: [number, number]; cv: number } {
  const v = samples.filter((x) => isFinite(x))
  if (!v.length) return { value: 0, ci95: [0, 0], cv: 0 }
  const m = medianOf(v), mean = v.reduce((a, x) => a + x, 0) / v.length
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (v.length - 1)) : 0
  return { value: m, ci95: ciOf(m, sd, v.length), cv: mean ? (100 * sd) / Math.abs(mean) : 0 }
}
const cvFlags = (cv: number): Flag[] => (isNoisy(cv) ? ['noisy'] : [])

const UNAVAILABLE: Flag[] = ['fallback:unavailable', 'fallback:no-webgpu', 'fallback:no-opfs', 'software-gpu']
const GATE_FAILED: Flag[] = ['fallback:gate', 'fallback:gpu-incorrect', 'fallback:gpu-error', 'fallback:device-lost']
export const isUnavailable = (r: TestResult) => UNAVAILABLE.some((f) => r.flags.includes(f))
/** S = 1000 x median / REF[scale][workload v]. No cap. null: custom, cancelled, failed gate, unavailable, or no reference. */
export function componentScore(r: TestResult): number | null {
  if (r.input.kind === 'custom' || r.flags.includes('custom') || r.flags.includes('cancelled') || GATE_FAILED.some((f) => r.flags.includes(f)) || isUnavailable(r)) return null
  if (r.component.startsWith('model:')) return r.score !== null && isFinite(r.score) ? r.score : null
  const ref = rowFor(r.component)?.ref[r.scale]?.[r.workload.v]
  if (ref === undefined) return r.score
  return isFinite(r.value) && r.value > 0 ? (1000 * r.value) / ref : null
}
const scoreCi = (r: TestResult, s: number): [number, number] => {
  const m = r.value
  return m > 0 ? [s * (r.ci95[0] / m), s * (r.ci95[1] / m)] : [s, s]
}

export interface PillarResult { score: number | null; status: 'scored' | 'unavailable' | 'not-tested'; components: Partial<Record<ComponentId, number | 'unavailable'>> }
export interface FinalScore {
  score: number; ci95: [number, number]; tier: string
  coverage: { ran: number; of: 5 }
  provisional: boolean
  limiting: ComponentId | Pillar | null
  pillars: Record<Pillar, PillarResult>
  /** components counted as 50 because the device cannot run them ("not available") */
  unavailable: ComponentId[]
  /** components that were not tested; they also count as 50 so that leaving one out can never raise the score */
  imputed: ComponentId[]
  /** geometric mean of what was actually measured, shown as "of what ran" */
  measured: number | null
  flags: Flag[]
  workloads: Record<string, { id: string; v: number }>
  scale: Scale | null
}
export const PILLAR_WEIGHT: Record<Pillar, number> = { compute: 0.35, memory: 0.25, gpu: 0.15, storage: 0.10, model: 0.15 }
const PILLAR_LEAVES: Record<Exclude<Pillar, 'model'>, [ComponentId, number][]> = {
  compute: [['cpu1', 0.4], ['cpun', 0.6]], memory: [['ram', 0.6], ['cache', 0.4]], gpu: [['gpu', 1]], storage: [['storage', 1]],
}
const NOT_AVAILABLE = 50

/**
 * Weighted geometric mean of five pillars. A test that is missing counts as 50 (like "not available") so leaving a
 * component out cannot raise the score; it is listed in `imputed`, and `provisional` stays true until Compute, Memory
 * and one more pillar exist. (Guarantee: holds for every tested component scoring 50 or more.)
 * Net and energy never count. Results of different scales cannot be combined: this throws.
 */
export function finalScore(results: Record<string, TestResult>): FinalScore {
  const all = Object.values(results).filter((r) => r.input.kind !== 'custom' && !r.flags.includes('custom') && r.component !== 'net' && r.component !== 'energy')
  const scales = [...new Set(all.map((r) => r.scale))]
  if (scales.length > 1) throw new Error(`Cannot combine ${scales.join(' and ')} results in one score`)
  const by: Partial<Record<string, TestResult>> = {}
  for (const r of all) by[r.component] = r

  type Leaf = { id: ComponentId | Pillar; w: number; s: number; sd: number; measured: boolean }
  const leaves: Leaf[] = [], pillars = {} as Record<Pillar, PillarResult>, imputed: ComponentId[] = [], unavailable: ComponentId[] = [], flags = new Set<Flag>()
  const workloads: FinalScore['workloads'] = {}
  const lnsd = (r: TestResult, s: number) => { const [lo, hi] = scoreCi(r, s); return lo > 0 && hi > lo ? Math.log(hi / lo) / 3.92 : r.cv / 100 }
  const note = (r: TestResult) => { r.flags.forEach((f) => flags.add(f)); workloads[r.component] = r.workload }

  for (const p of Object.keys(PILLAR_WEIGHT) as Pillar[]) {
    const pw = PILLAR_WEIGHT[p]
    const out: PillarResult = { score: null, status: 'not-tested', components: {} }
    if (p === 'model') {
      const ms = all.filter((r) => r.component.startsWith('model:'))
      const scored = ms.map((r) => ({ r, s: componentScore(r) })).filter((x): x is { r: TestResult; s: number } => x.s !== null && x.s > 0)
      ms.forEach(note)
      scored.forEach((x) => (out.components[x.r.component] = x.s))
      if (scored.length) {
        out.status = 'scored'; out.score = Math.exp(scored.reduce((a, x) => a + Math.log(x.s), 0) / scored.length)
        scored.forEach((x) => leaves.push({ id: 'model', w: pw / scored.length, s: x.s, sd: lnsd(x.r, x.s), measured: true }))
      } else if (ms.some(isUnavailable)) {
        out.status = 'unavailable'; unavailable.push(ms.find(isUnavailable)!.component)
        leaves.push({ id: 'model', w: pw, s: NOT_AVAILABLE, sd: 0, measured: false })
      } else { imputed.push('model:*'); leaves.push({ id: 'model', w: pw, s: NOT_AVAILABLE, sd: 0, measured: false }) }
      pillars[p] = out
      continue
    }
    // leaves of this pillar
    const parts: { id: ComponentId; w: number; s: number; sd: number; kind: 'scored' | 'unavailable' | 'missing' }[] = []
    for (const [id, lw] of PILLAR_LEAVES[p]) {
      const r = by[id]
      if (r) note(r)
      const s = r ? componentScore(r) : null
      if (r && s !== null && s > 0) { parts.push({ id, w: lw, s, sd: lnsd(r, s), kind: 'scored' }); out.components[id] = s }
      else if (r && isUnavailable(r)) { parts.push({ id, w: lw, s: NOT_AVAILABLE, sd: 0, kind: 'unavailable' }); out.components[id] = 'unavailable'; unavailable.push(id) }
      else { parts.push({ id, w: lw, s: NOT_AVAILABLE, sd: 0, kind: 'missing' }); imputed.push(id) }
    }
    const tested = parts.filter((x) => x.kind !== 'missing')
    if (tested.length) out.status = tested.some((x) => x.kind === 'scored') ? 'scored' : 'unavailable'
    out.score = out.status === 'not-tested' ? null : Math.exp(parts.reduce((a, x) => a + x.w * Math.log(x.s), 0))
    for (const x of parts) leaves.push({ id: x.id, w: pw * x.w, s: x.s, sd: x.sd, measured: x.kind !== 'missing' })
    pillars[p] = out
  }

  const total = leaves.reduce((a, l) => a + l.w, 0)
  const lnS = leaves.reduce((a, l) => a + l.w * Math.log(l.s), 0) / total
  const anyTested = leaves.some((l) => l.measured)
  const score = anyTested ? Math.exp(lnS) : 0
  const sd = Math.sqrt(leaves.reduce((a, l) => a + (l.w * l.sd) ** 2, 0)) / total
  const ci95: [number, number] = [score * Math.exp(-1.96 * sd), score * Math.exp(1.96 * sd)]
  const ran = (Object.keys(pillars) as Pillar[]).filter((p) => pillars[p].status !== 'not-tested').length
  const has = (p: Pillar) => pillars[p].status !== 'not-tested'
  const provisional = !(has('compute') && has('memory') && ran >= 3)
  const lim = leaves.filter((l) => l.measured && anyTested).map((l) => ({ id: l.id, v: l.w * Math.log(l.s / score) })).sort((a, b) => a.v - b.v)[0]
  const meas = leaves.filter((l) => l.measured)
  const mw = meas.reduce((a, l) => a + l.w, 0)
  return {
    score, ci95, tier: tierOf(anyTested ? score : null), coverage: { ran, of: 5 }, provisional, limiting: lim ? lim.id : null, pillars, unavailable, imputed,
    measured: mw ? Math.exp(meas.reduce((a, l) => a + l.w * Math.log(l.s), 0) / mw) : null, flags: [...flags], workloads, scale: scales[0] ?? null,
  }
}

/* ------------------------------------------------------------------ mapping: companion bench entries and model runs -> TestResult */
const BENCH_COMPONENT: Record<string, ComponentId> = { matmul_1: 'cpu1', matmul_n: 'cpun', dram: 'ram', cache: 'cache', disk: 'storage', net: 'net', gpu: 'gpu', ai: 'model:text-generation', power: 'energy' }
export const BENCH_KEYS = Object.keys(BENCH_COMPONENT)
const WORKLOAD: Record<string, { id: string; v: number }> = {
  cpu1: { id: 'matmul_f32_simd', v: 1 }, cpun: { id: 'matmul_f32_simd', v: 1 }, cache: { id: 'cache_sweep', v: 1 }, ram: { id: 'stream_copy', v: 1 },
  storage: { id: 'file_read', v: 1 }, gpu: { id: 'matmul_f32_gpu', v: 1 }, net: { id: 'download', v: 1 }, energy: { id: 'package_watts', v: 1 }, 'model:text-generation': { id: 'decode_tps', v: 1 },
}
interface MkOpts { cv?: number; ci?: [number, number]; flags?: Flag[]; env?: Partial<TestResult['env']>; score?: number | null; energy?: TestResult['energy'] }
export interface FromBenchCtx { scale?: Scale; at?: string; params?: number | null; audioSec?: number; goldenOk?: boolean | null; fit?: Fit | null; info?: any }

/**
 * The one mapping function. Companion `bench` entries (name = matmul_1, matmul_n, dram, cache, disk, net, gpu, ai, power)
 * and finished model runs (name = 'run', data = RunStats) both become a TestResult. Unknown names give null.
 */
export function fromBench(name: string, data: any, ctx: FromBenchCtx = {}): TestResult | null {
  if (data == null) return null
  const scale: Scale = ctx.scale ?? 'native'
  const at = ctx.at ?? new Date().toISOString()
  const where: TestResult['env']['where'] = scale === 'browser' ? 'wasm' : 'companion'
  if (name === 'run') return fromRun(data as RunStats, ctx)
  const component = BENCH_COMPONENT[name]
  if (!component) return null
  const workload = WORKLOAD[component]
  const mk = (value: number, unit: string, samples: number[], o: MkOpts = {}): TestResult => {
    const s = samples.length > 1 ? summarize(samples) : null
    const cv = o.cv ?? s?.cv ?? 0
    return {
      v: 1, component, scale, workload, input: { kind: 'default', summary: 'default' }, samples, value, unit,
      ci95: o.ci ?? s?.ci95 ?? [value, value], cv, score: o.score ?? null, flags: [...(o.flags ?? []), ...cvFlags(cv)], env: { where, ...o.env }, ...(o.energy ? { energy: o.energy } : {}), at,
    }
  }
  // the companion sends min / median / max / cv_pct, not every sample
  const spread = (x: any, fallback: number, unit: string, o: MkOpts = {}) => {
    const sp = x?.spread
    if (sp && sp.n > 1) {
      const med = sp.median ?? fallback, cv = sp.cv_pct ?? 0
      return mk(med, unit, [sp.min, med, sp.max], { cv, ci: ciOf(med, (cv / 100) * med, sp.n), ...o })
    }
    return mk(fallback, unit, [fallback], o)
  }
  const withScore = (r: TestResult) => ({ ...r, score: componentScore(r) })
  switch (name) {
    case 'matmul_1': return withScore(spread(data, data.gflops, 'GFLOP/s', { env: { threads: 1 } }))
    case 'matmul_n': return withScore(spread(data, data.gflops, 'GFLOP/s', { env: { threads: data.threads } }))
    case 'dram': return withScore(spread(data, data.copy_gbps, 'GB/s'))
    case 'cache': {
      const g: number[] = Array.isArray(data) ? data.map((c: any) => c.gbps).filter((x: number) => isFinite(x)) : []
      return g.length ? withScore(mk(Math.max(...g), 'GB/s', g, { cv: 0, ci: [Math.max(...g), Math.max(...g)] })) : null
    }
    case 'disk': return withScore(spread({ ...data, spread: undefined }, data.gbps * 1000, 'MB/s', { flags: data.cached ? ['fallback:cached-read'] : [] }))
    case 'net': return mk(data.mbps, 'Mbit/s', [data.mbps])
    case 'gpu':
      if (data.unavailable) return mk(0, 'GFLOP/s', [], { flags: ['fallback:unavailable'], env: { where: 'webgpu' } })
      return withScore(spread(data, data.gflops, 'GFLOP/s', { env: { where: 'webgpu', adapter: data.adapter } }))
    case 'ai': {
      const dev: 'companion' | 'webgpu' | 'wasm' = data.device === 'webgpu' ? 'webgpu' : data.device === 'wasm' ? 'wasm' : scale === 'browser' ? 'wasm' : 'companion'
      const r = spread(data, data.tps, 'tokens/s', { env: { where: dev === 'companion' ? 'companion' : dev } })
      return { ...r, score: r.value > 0 ? (1000 * r.value) / MODEL_REF[dev] : null }
    }
    case 'power': {
      const S = data?.summary ?? {}
      const w = S.matmul_n?.avg_w ?? S.ai?.avg_w ?? S.idle?.avg_w ?? 0
      return mk(w, 'W', w ? [w] : [], { flags: data?.estimated ? ['estimated'] : [] })
    }
  }
  return null
}

function fromRun(st: RunStats, ctx: FromBenchCtx): TestResult {
  const rs = scoreRun(st, ctx.fit ?? null, { params: ctx.params ?? null, info: ctx.info ?? null, audioSec: ctx.audioSec, goldenOk: ctx.goldenOk })
  const scale: Scale = st.where === 'companion' ? 'native' : 'browser'
  const decode = rs.decode?.tps ?? st.perSec
  const flags: Flag[] = []
  if (st.estimatedEnergy) flags.push('estimated')
  if (rs.gate === 'fail') flags.push('fallback:gate')
  return {
    v: 1, component: `model:${st.task}`, scale, workload: { id: `${st.task}_run`, v: 1 }, input: { kind: 'default', summary: st.repo.split('/').pop() ?? st.repo },
    samples: st.perSec ? [st.perSec] : [], value: decode, unit: st.unit === 'tokens' ? 'tokens/s' : 'items/s', ci95: [decode, decode], cv: 0,
    score: rs.score, flags, env: { where: st.where === 'none' ? 'wasm' : st.where }, ...(st.joules ? { energy: { joules: st.joules, estimated: st.estimatedEnergy } } : {}), at: ctx.at ?? new Date().toISOString(),
  }
}

/* ------------------------------------------------------------------ export */
/** JSON of the current results. Device strings (adapter name, CPU name) only with includeDevice. */
export function exportResults(opts: { includeDevice: boolean }, results: Record<string, TestResult> = useHW.getState().results, info: any = useHW.getState().info): string {
  const rs = Object.entries(results).map(([k, r]) => [k, opts.includeDevice ? r : { ...r, env: { ...r.env, adapter: undefined } }] as const)
  let final: FinalScore | null = null
  try { final = finalScore(results) } catch { /* mixed scales: export the raw results only */ }
  const doc = {
    app: 'neural-studio', v: 1, at: new Date().toISOString(),
    final: final && { score: Math.round(final.score), ci95: final.ci95.map(Math.round), provisional: final.provisional, coverage: final.coverage, limiting: final.limiting, scale: final.scale, workloads: final.workloads, flags: final.flags },
    results: Object.fromEntries(rs),
    ...(opts.includeDevice && info ? { device: { cpu: info.cpu?.name ?? null, gpu: info.gpu?.name ?? null, cores: info.cpu?.cores ?? null } } : {}),
  }
  return JSON.stringify(doc, null, 2)
}

/* ------------------------------------------------------------------ run score
 * How well did THIS computer run THIS model? 1000 points = the reference, like the device score above.
 * Only speed and response make the score. Fit (memory headroom) and energy are returned apart: `fit` and the
 * efficiency part are shown but never averaged in. Scores are normalised by work so a 22M and a 1B model compare:
 * work rate = items/s x 2 x params x (real tokens, patches or frames per item). Reference: the 135M SmolLM2, 20 tok/s
 * native, 63 WebGPU, 31 WebAssembly. Speech uses Whisper's fixed 30 s window, so a 5 s and a 30 s clip score alike.
 * Expected protocol: 1 warm-up run then >= 3 timed runs (ctx.samples / ctx.timedRuns); fewer is flagged `reliable: false`.
 * Accuracy gate: a golden-output check (ctx.goldenOk). Failing it gives no score. */
const REF_PARAMS = 135e6
export const REF_RUN = {
  companion: REF.ai * 2 * REF_PARAMS,              // 5.4 GFLOP/s
  webgpu: REF_BROWSER.ai * 2 * REF_PARAMS,         // 17.0 GFLOP/s
  wasm: REF_BROWSER.ai_wasm * 2 * REF_PARAMS,      // 8.4 GFLOP/s
  firstMs: 300,                                    // time to first output worth 1000 points
  joule: 0.5 * 2 * REF_PARAMS,                     // 0.5 tokens per joule (REF_EFF.ai = 500 words/kJ) = 135 MFLOP/J
  rtf: 5, rtfParams: 74e6,                         // speech: 5x real time for a 74M model
  needFrac: 0.5,                                   // headroom: 1000 points at half the memory budget
  whisperWindowSec: 30,
}
// Fallback tokens of work per item when the caller does not know the real count (ctx.itemTokens).
const ITEM_TOKENS: Record<string, number> = { 'text-classification': 16, 'fill-mask': 16, 'image-classification': 197, 'automatic-speech-recognition': 1500 }

export interface RunPart { id: 'speed' | 'response' | 'efficiency' | 'headroom'; label: string; score: number | null; value: string; detail: string }
export interface RunScore {
  overall: number; tier: string; parts: RunPart[]; summary: string; reference: string
  // added by S3 (the fields above keep their shape)
  score: number | null                               // null without a passed accuracy gate
  gate: 'pass' | 'fail' | 'unchecked'
  reliable: boolean                                  // 1 warm-up + at least 3 timed runs
  fit: RunPart | null                                // memory verdict, separate from the score
  prefill?: { ms: number; tokensPerSec: number | null }
  decode?: { tps: number | null }
}

const RUN_W = { speed: 0.65, response: 0.35 }
const cap = (x: number) => Math.max(0, Math.min(2000, Math.round(x)))
const si = (x: number, u: string) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)} G${u}` : x >= 1e6 ? `${(x / 1e6).toFixed(1)} M${u}` : `${(x / 1e3).toFixed(1)} k${u}`)
const nice = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2))
export const RUNTIME_NAME: Record<string, string> = { companion: 'Companion (PyTorch)', webgpu: 'WebGPU', wasm: 'WebAssembly', none: 'not run' }

export interface RunCtx {
  params: number | null; info: any | null
  audioSec?: number                // length of the clip (speech runs use Whisper's fixed 30 s window per started window)
  itemTokens?: number              // real tokens / patches / frames per item
  promptTokens?: number            // text generation: prompt length, for the prefill rate
  goldenOk?: boolean | null        // accuracy gate: true pass, false fail, undefined/null not checked
  timedRuns?: number               // timed runs behind these numbers
  samples?: number[]               // per-run items/s; the median is used
}

export function scoreRun(stats: RunStats, fit: Fit | null, ctx: RunCtx): RunScore {
  const where = stats.where
  const ref = where === 'companion' ? REF_RUN.companion : where === 'webgpu' ? REF_RUN.webgpu : REF_RUN.wasm
  const refTps = where === 'companion' ? REF.ai : where === 'webgpu' ? REF_BROWSER.ai : REF_BROWSER.ai_wasm
  const params = ctx.params && ctx.params > 0 ? ctx.params : null
  const tokens = stats.unit === 'tokens'
  const gen = stats.task === 'text-generation'
  const asr = stats.task === 'automatic-speech-recognition'
  const perItem = tokens ? 1 : ctx.itemTokens && ctx.itemTokens > 0 ? ctx.itemTokens : ITEM_TOKENS[stats.task] ?? 16
  const flopsPerItem = params ? 2 * params * perItem : null
  const sampled = ctx.samples?.filter((x) => isFinite(x) && x > 0)
  const perSec0 = sampled && sampled.length ? medianOf(sampled) : stats.perSec

  // text generation: the first output is the prefill, the rest is decode; they are reported separately
  const decodeTps = gen && stats.items > 1 && stats.totalMs > stats.firstMs && stats.firstMs > 0 ? (stats.items - 1) / ((stats.totalMs - stats.firstMs) / 1000) : null
  const perSec = gen && decodeTps ? decodeTps : perSec0
  const prefill = gen && stats.firstMs > 0 ? { ms: stats.firstMs, tokensPerSec: ctx.promptTokens ? ctx.promptTokens / (stats.firstMs / 1000) : null } : undefined
  const rate = flopsPerItem && isFinite(perSec) && perSec > 0 ? perSec * flopsPerItem : null

  let speed: RunPart
  const windows = Math.max(1, Math.ceil((ctx.audioSec ?? REF_RUN.whisperWindowSec) / REF_RUN.whisperWindowSec))
  const rtf = asr && stats.totalMs > 0 ? (REF_RUN.whisperWindowSec * windows) / (stats.totalMs / 1000) : null
  if (asr && rtf && params) {
    const sc = Math.max(0, Math.round((1000 * rtf * params) / (REF_RUN.rtf * REF_RUN.rtfParams)))
    speed = { id: 'speed', label: 'Speed', score: sc, value: `${nice(rtf)}x real time`,
      detail: `${nice(rtf)}x real time (${windows} fixed ${REF_RUN.whisperWindowSec} s window${windows > 1 ? 's' : ''} in ${(stats.totalMs / 1000).toFixed(2)} s) x ${si(params, '')} params / (${REF_RUN.rtf}x x ${si(REF_RUN.rtfParams, '')}) x 1000 = ${sc}` }
  } else if (rate) {
    const sc = Math.max(0, Math.round((1000 * rate) / ref))
    speed = { id: 'speed', label: gen ? 'Speed (decode)' : 'Speed', score: sc, value: `${nice(perSec)} ${tokens ? 'tok/s' : 'items/s'} · ${si(rate, 'FLOP/s')}`,
      detail: `${nice(perSec)} ${tokens ? 'tokens' : 'items'}/s x 2 x ${si(params!, '')} params${tokens ? '' : ` x ${perItem} tokens per item`} = ${si(rate, 'FLOP/s')}; / ${si(ref, 'FLOP/s')} reference (${refTps} tok/s on a 135M model) x 1000 = ${sc}` }
  } else speed = { id: 'speed', label: 'Speed', score: null, value: perSec ? `${nice(perSec)} ${tokens ? 'tok/s' : 'items/s'}` : '—', detail: 'Needs the parameter count to compare models of different sizes.' }

  const first = stats.firstMs > 0 ? stats.firstMs : null
  const rsc = first ? cap((1000 * REF_RUN.firstMs) / first) : null
  const response: RunPart = { id: 'response', label: gen ? 'Response (prefill)' : 'Response', score: rsc, value: first ? `${first >= 1000 ? (first / 1000).toFixed(2) + ' s' : Math.round(first) + ' ms'} to first output` : '—',
    detail: first ? `${REF_RUN.firstMs} ms / ${Math.round(first)} ms x 1000 = ${rsc} (capped at 2000)` : 'No timing recorded.' }

  const work = flopsPerItem ? flopsPerItem * stats.items : null
  let efficiency: RunPart
  if (stats.joules && stats.joules > 0 && work) {
    const wpj = work / stats.joules, sc = cap((1000 * wpj) / REF_RUN.joule), est = stats.estimatedEnergy
    efficiency = { id: 'efficiency', label: est ? 'Efficiency (est.)' : 'Efficiency', score: sc, value: `${si(wpj, 'FLOP/J')} · ${stats.joules.toFixed(1)} J${est ? ' est.' : ''}`,
      detail: `${si(work, 'FLOP')} / ${stats.joules.toFixed(1)} J (${est ? 'estimated from load and TDP' : 'measured'}) = ${si(wpj, 'FLOP/J')}; / ${si(REF_RUN.joule, 'FLOP/J')} reference x 1000 = ${sc}. Shown, not in the score.` }
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
      detail: (frac !== null ? `${mem(fit.needBytes)} of ${mem(fit.haveBytes!)} = ${Math.round(frac * 100)}% of budget; (1 - ${frac.toFixed(2)}) / ${1 - REF_RUN.needFrac} x 1000 = ${sc}${fit.verdict === 'tight' ? ' (capped at 600: tight)' : fit.verdict === 'too-big' ? ' (floor 50: too big)' : ''}` : `Verdict ${fit.verdict}; memory budget unknown.`) + ' A separate verdict: not in the score.' }
  } else headroom = { id: 'headroom', label: 'Headroom', score: null, value: '—', detail: 'No fit estimate for this model.' }

  const parts = [speed, response, efficiency, headroom]
  let sw = 0, sl = 0
  for (const p of [speed, response]) if (p.score !== null) { const w = RUN_W[p.id as 'speed' | 'response']; sw += w; sl += w * Math.log(Math.max(p.score, 1)) }
  const gate: RunScore['gate'] = ctx.goldenOk === true ? 'pass' : ctx.goldenOk === false ? 'fail' : 'unchecked'
  const raw = sw ? Math.round(Math.exp(sl / sw)) : 0
  const overall = gate === 'fail' ? 0 : raw
  const score = gate === 'pass' && sw ? raw : null
  const reliable = (ctx.timedRuns ?? sampled?.length ?? 0) >= 3
  const rel = speed.score === null ? null : speed.score / 1000
  const dev = ctx.info?.cpu?.name ?? ctx.info?.cpu?.model
  const pace = rel === null ? '' : rel >= 1 ? ` at ${nice(rel)}x the reference speed` : ` at ${Math.round(rel * 100)}% of the reference speed`
  const summary = gate === 'fail' ? `${stats.repo.split('/').pop()} gave a wrong answer on the check, so it has no score.` : `${stats.repo.split('/').pop()} ran on ${RUNTIME_NAME[where]}${dev ? ` (${dev})` : ''}${pace}.`
  const reference = `1000 = ${refTps} tok/s on a 135M model (${RUNTIME_NAME[where]}) · ${REF_RUN.firstMs} ms to first output`
  return { overall, tier: tierOf(sw && gate !== 'fail' ? overall : null), parts, summary, reference, score, gate, reliable, fit: headroom, ...(prefill ? { prefill } : {}), ...(gen ? { decode: { tps: decodeTps ?? (perSec0 > 0 ? perSec0 : null) } } : {}) }
}

/* ------------------------------------------------------------------ test hook
 * window.__score: read by the Playwright check A24 (omitting a component never raises the final score).
 * final() takes component scores (1000 = reference) and returns the final score. Tiny and side-effect free. */
if (typeof window !== 'undefined') {
  const components: string[] = ['cpu1', 'cpun', 'cache', 'ram', 'storage', 'gpu', 'model:text-generation']
  ;(window as any).__score = {
    components, finalOf: finalScore, componentScore,
    final(scores: Record<string, number>) {
      const rs: Record<string, TestResult> = {}
      for (const [id, s] of Object.entries(scores)) {
        const r = id.startsWith('model:') ? undefined : rowFor(id)?.ref.native?.[1]
        rs[id] = { v: 1, component: id as ComponentId, scale: 'native', workload: { id: 'hook', v: 1 }, input: { kind: 'default', summary: 'hook' }, samples: [], value: r ? (s * r) / 1000 : s, unit: '', ci95: [0, 0], cv: 0, score: s, flags: [], env: { where: 'companion' }, at: '' }
      }
      const f = finalScore(rs)
      return { score: f.score, ci95: f.ci95, provisional: f.provisional }
    },
  }
}
