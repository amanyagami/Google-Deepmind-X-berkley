// Uses the recorded pack from the test PC (web/public/examples/machine.json).
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { activityAt, buildTimeline, locate } from '../src/hw/timeline'
import { computeScores, REF, REF_BROWSER } from '../src/hw/score'

const pack = JSON.parse(readFileSync(new URL('../public/examples/machine.json', import.meta.url), 'utf8'))

test('timeline: segments are contiguous and locate() is monotonic', () => {
  for (const expanded of [false, true]) {
    const tl = buildTimeline(pack.journey.L, expanded)
    for (let i = 1; i < tl.segs.length; i++) expect(tl.segs[i].v0).toBeCloseTo(tl.segs[i - 1].v1)
    let last = -1
    for (let t = 0; t <= tl.total; t += tl.total / 200) { const { i } = locate(tl, t); expect(i).toBeGreaterThanOrEqual(last); last = i }
  }
})

test('activity is finite everywhere on the timeline (a NaN here crashes the 3D packets)', () => {
  const tl = buildTimeline(pack.journey.L, true)
  const peaks = { gflops: pack.bench.matmul_n.gflops, gbps: pack.bench.dram.copy_gbps }
  for (let t = 0; t <= tl.total; t += tl.total / 400) {
    const a = activityAt(pack.journey, tl, t, peaks, 8)
    for (const [k, v] of Object.entries(a.flow)) expect(Number.isFinite(v), `flow.${k} at ${t}`).toBe(true)
    for (const v of a.cores) expect(Number.isFinite(v)).toBe(true)
  }
})

test('scores: plain ratios to the references; efficiency stays out of the overall score', () => {
  const sc = computeScores(pack.bench, pack.journey, pack.info, pack.power)
  const cpu1 = sc.comps.find((c) => c.id === 'cpu')!.subs.find((s) => s.id === 'cpu1')!
  expect(cpu1.score).toBe(Math.round((1000 * pack.bench.matmul_1.gflops) / REF.cpu1))
  expect(sc.overall).toBeGreaterThan(400); expect(sc.overall).toBeLessThan(3000)
  const without = computeScores(pack.bench, pack.journey, pack.info, null)
  expect(without.overall).toBe(sc.overall)
  expect(sc.by.power).not.toBeNull()
})

test('scores: a replayed reference run never counts as this machine', () => {
  const sc = computeScores(pack.bench, pack.journey, pack.info, { ...pack.power, reference: { recorded: 'x', cpu: 'y', bench: pack.bench } })
  expect(sc.by.power).toBeNull()
})

test('browser references: the language-model reference follows the engine that ran it', () => {
  const info = { source: 'browser' }
  const gpu = computeScores({ ai: { tps: 63, device: 'webgpu', model: 'm' } }, null, info).comps.find((c) => c.id === 'system')!.score
  const wasm = computeScores({ ai: { tps: 31, device: 'wasm', model: 'm' } }, null, info).comps.find((c) => c.id === 'system')!.score
  expect(gpu).toBe(1000); expect(wasm).toBe(1000)
  expect(REF_BROWSER.ai).toBeGreaterThan(REF_BROWSER.ai_wasm)
})

// ---- any model, any computer: resolve + fit (no network: fetch is mocked) ----
import { afterEach, vi } from 'vitest'
import { checkFit, onnxDtype, onnxInfo, parseRepo, pickRuntime, resolveModel } from '../src/api'
import type { Budget, ModelSpec } from '../src/api'

const GiB = 1024 ** 3
const spec = (o: Partial<ModelSpec> = {}): ModelSpec => ({ repo: 'a/b', task: 'text-generation', arch: 'llama', params: 135e6, bytes: 270e6, onnx: null, companion: true, defaultInput: { kind: 'text', text: 'x' }, notes: [], ...o })
const budget = (o: Partial<Budget> = {}): Budget => ({ companionRam: null, browserRam: null, browserRamCapped: false, gpu: null, cacheQuota: null, ...o })

test('parseRepo: org/name, urls, bare names', () => {
  expect(parseRepo('HuggingFaceTB/SmolLM2-135M')).toBe('HuggingFaceTB/SmolLM2-135M')
  expect(parseRepo('https://huggingface.co/Qwen/Qwen2.5-0.5B/tree/main?x=1')).toBe('Qwen/Qwen2.5-0.5B')
  expect(parseRepo('gpt2')).toBe('openai-community/gpt2')
})

test('ONNX dtypes come from the file names', () => {
  const f = ['model.onnx', 'model_fp16.onnx', 'model_q4f16.onnx', 'model_q4.onnx', 'model_quantized.onnx', 'model_int8.onnx', 'model_uint8.onnx', 'model_bnb4.onnx']
  expect(f.map((n) => onnxDtype(`onnx/${n}`))).toEqual(['fp32', 'fp16', 'q4f16', 'q4', 'q8', 'q8', 'q8', 'bnb4'])
  expect(onnxDtype('model.safetensors')).toBeNull()
  const info = onnxInfo([{ rfilename: 'onnx/model_q4.onnx', size: 10 }, { rfilename: 'onnx/model_q4.onnx_data', size: 90 }, { rfilename: 'onnx/model.onnx', size: 400 }])
  expect(info.dtypes).toEqual(['q4', 'fp32']); expect(info.sizes.q4).toBe(100)
  // an encoder-decoder sums its parts and ignores the unmerged decoders
  const w = onnxInfo([{ rfilename: 'onnx/encoder_model_q4.onnx', size: 5 }, { rfilename: 'onnx/decoder_model_merged_q4.onnx', size: 7 }, { rfilename: 'onnx/decoder_model_q4.onnx', size: 99 }])
  expect(w.sizes.q4).toBe(12)
})

test('fit: companion needs params x 4 x 1.2 and the verdict follows 50% / 85%', () => {
  const s = spec({ params: 1e9 })                       // 4.8e9 bytes
  const ram = (g: number) => checkFit(s, budget({ companionRam: g * GiB }))
  expect(ram(32).verdict).toBe('fits')
  expect(ram(32).needBytes).toBeCloseTo(4.8e9)
  expect(ram(32).where).toBe('companion')
  expect(ram(7).verdict).toBe('tight')
  expect(ram(5).verdict).toBe('too-big')
  expect(ram(5).where).toBe('none')
})

test('fit: browser picks webgpu, falls back to wasm, and refuses when nothing fits', () => {
  const s = spec({ companion: false, onnx: { repo: 'x/y', dtypes: ['q4f16', 'q8', 'fp32'], sizes: { q4f16: 100e6, q8: 140e6, fp32: 540e6 } } })
  const gpu = { maxBuffer: 2 * GiB, maxStorage: 2 * GiB }
  expect(checkFit(s, budget({ browserRam: 8 * GiB, gpu })).where).toBe('webgpu')
  expect(checkFit(s, budget({ browserRam: 8 * GiB })).where).toBe('wasm')
  const big = spec({ companion: false, onnx: { repo: 'x/y', dtypes: ['q4f16', 'q8'], sizes: { q4f16: 6 * GiB, q8: 9 * GiB } } })
  const f = checkFit(big, budget({ browserRam: 8 * GiB, gpu }))
  expect(f.verdict).toBe('too-big'); expect(f.where).toBe('none'); expect(f.reason).toMatch(/GB/)
  // a single weight buffer must fit the GPU binding limit
  const r = checkFit(s, budget({ browserRam: 8 * GiB, gpu: { maxBuffer: 1e6, maxStorage: 1e6 } }))
  expect(r.where).toBe('wasm')
})

test('pickRuntime: no ONNX and no companion means nowhere; unsupported tasks never run', () => {
  const none = spec({ companion: false })
  expect(checkFit(none, budget({ browserRam: 8 * GiB })).where).toBe('none')
  expect(checkFit(spec({ task: null }), budget({ companionRam: 32 * GiB })).where).toBe('none')
  const f = checkFit(spec(), budget({ companionRam: 32 * GiB }))
  expect(pickRuntime(spec(), f, true)).toBe('companion')
  expect(pickRuntime(spec(), f, false)).toBe('none')
})

function hub(models: Record<string, any>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const id = /\/api\/models\/([^?]+)/.exec(String(url))?.[1] ?? ''
    const m = models[id]
    return m ? { ok: true, status: 200, json: async () => m } : { ok: false, status: 401, json: async () => ({}) }
  }))
}
afterEach(() => vi.unstubAllGlobals())

test('resolveModel: uses a converted ONNX copy, and explains gated, missing and unsupported repos', async () => {
  hub({
    'org/tiny': { pipeline_tag: 'text-generation', config: { model_type: 'llama' }, safetensors: { total: 1e8 }, siblings: [{ rfilename: 'model.safetensors', size: 2e8 }] },
    'onnx-community/tiny': { siblings: [{ rfilename: 'onnx/model_q4.onnx', size: 5e7 }] },
    'org/closed': { gated: 'manual', pipeline_tag: 'text-generation', siblings: [] },
    'org/painter': { pipeline_tag: 'text-to-image', config: {}, siblings: [] },
  })
  const s = await resolveModel('https://huggingface.co/org/tiny')
  expect(s).toMatchObject({ repo: 'org/tiny', task: 'text-generation', arch: 'llama', params: 1e8, bytes: 2e8, onnx: { repo: 'onnx-community/tiny', dtypes: ['q4'] } })
  await expect(resolveModel('org/closed')).rejects.toThrow(/gated/)
  await expect(resolveModel('org/nope')).rejects.toThrow(/not found/)
  const p = await resolveModel('org/painter')
  expect(p.task).toBeNull(); expect(p.notes.join(' ')).toMatch(/not supported/)
})

// ---- S3: registry, results store, component scores and the final score ----
import { BENCH_KEYS, NOISY_CV, componentScore, finalNow, tierKey, exportResults, finalScore, fromBench, isNoisy, scoreRun, summarize } from '../src/hw/score'
import { REF_V1, REGISTRY, RESULTS_KEY, RUN_ALL_ORDER, loadStored, rowFor, useHW, validateInput, inputLimits } from '../src/hw/hwStore'
import type { ComponentId, Scale, TestResult } from '../src/hw/hwStore'
import type { Capabilities } from '../src/hw/browserBench'

const caps = (o: Partial<Capabilities> = {}): Capabilities => ({
  isolated: true, cores: 8, deviceMemoryGB: 8, simd: true, timerResolutionMs: { page: 0.1, worker: 0.005 },
  gpu: { available: true, software: false, f16: true, timestamps: true, adapter: 'x', canaryOk: true, maxBuffer: 2 ** 30 },
  opfs: { available: true, syncHandle: true, quotaBytes: 10 * 1024 ** 3 }, net: { type: null, saveData: false, online: true }, battery: null, profile: 'standard', ...o,
})
const mk = (component: ComponentId, value: number, scale: Scale = 'native', o: Partial<TestResult> = {}): TestResult => ({
  v: 1, component, scale, workload: { id: 'w', v: 1 }, input: { kind: 'default', summary: 'default' }, samples: [value * 0.99, value, value * 1.01], value, unit: 'u',
  ci95: [value * 0.98, value * 1.02], cv: 1, score: null, flags: [], env: { where: 'companion' }, at: '2026-01-01T00:00:00Z', ...o,
})
const ref = (c: string, scale: Scale) => REF_V1[scale][c]
const atRef = (scale: Scale): Record<string, TestResult> => {
  const o: Record<string, TestResult> = {}
  for (const c of ['cpu1', 'cpun', 'cache', 'ram', 'storage', 'gpu'] as const) o[c] = mk(c, ref(c, scale), scale)
  o['model:text-generation'] = mk('model:text-generation', 20, scale, { score: 1000 })
  return o
}
const worked = (gpu = 252): Record<string, TestResult> => {
  const b = pack.bench
  const r = (name: string, data: any) => fromBench(name, data, { scale: 'native' })!
  return { cpu1: r('matmul_1', b.matmul_1), cpun: r('matmul_n', b.matmul_n), cache: r('cache', b.cache), ram: r('dram', b.dram), storage: r('disk', b.disk),
    gpu: r('gpu', { gflops: gpu, adapter: 'Radeon 780M' }), 'model:text-generation': r('ai', b.ai) }
}

test('reference inputs score about 1000 for every component and both scales', () => {
  for (const scale of ['native', 'browser'] as Scale[]) {
    const all = atRef(scale)
    for (const r of Object.values(all)) expect(componentScore(r)).toBeCloseTo(1000, 6)
    const f = finalScore(all)
    expect(f.score).toBeCloseTo(1000, 3); expect(f.provisional).toBe(false); expect(f.coverage).toEqual({ ran: 5, of: 5 }); expect(f.scale).toBe(scale)
  }
  expect(Object.values(REF_V1.native).every((x) => x > 0)).toBe(true)
})

test('worked example on the test PC: about 1196, limited by the GPU, and no omission raises it', () => {
  const all = worked()
  const f = finalScore(all)
  expect(f.score).toBeGreaterThan(1193); expect(f.score).toBeLessThan(1199)
  expect(f.limiting).toBe('gpu'); expect(f.provisional).toBe(false)
  expect(f.ci95[0]).toBeLessThan(f.score); expect(f.ci95[1]).toBeGreaterThan(f.score)
  for (const k of Object.keys(all)) {
    const { [k]: _, ...rest } = all
    expect(finalScore(rest).score, `without ${k}`).toBeLessThanOrEqual(f.score + 1e-9)
  }
  const some = ['cpu1', 'cache', 'storage']
  for (let i = 0; i < some.length; i++) {
    const rest = Object.fromEntries(Object.entries(all).filter(([k]) => !some.slice(0, i + 1).includes(k)))
    expect(finalScore(rest).score).toBeLessThanOrEqual(f.score)
  }
})

test('not available counts as 50 and is labelled; not tested is listed and the score is provisional', () => {
  const all = atRef('native')
  const noGpu = finalScore({ ...all, gpu: fromBench('gpu', { unavailable: true, reason: 'no WebGPU' }, { scale: 'native' })! })
  expect(noGpu.unavailable).toEqual(['gpu']); expect(noGpu.pillars.find((p) => p.id === 'gpu')!.status).toBe('unavailable'); expect(noGpu.provisional).toBe(false)
  expect(noGpu.score).toBeCloseTo(Math.exp(0.85 * Math.log(1000) + 0.15 * Math.log(50)), 3)
  const some = finalScore({ cpu1: all.cpu1, ram: all.ram })
  expect(some.provisional).toBe(true); expect(some.coverage.ran).toBe(2); expect(some.imputed).toContain('gpu'); expect(some.measured).toBeCloseTo(1000, 3)
  expect(finalScore({ cpu1: all.cpu1, cpun: all.cpun, ram: all.ram, cache: all.cache, storage: all.storage }).provisional).toBe(false)
  expect(finalScore({}).score).toBe(0)
})

test('net, energy and custom results never count; mixing scales throws', () => {
  const all = atRef('native')
  const base = finalScore(all).score
  expect(finalScore({ ...all, net: mk('net', 1), energy: mk('energy', 99) }).score).toBe(base)
  expect(finalScore({ ...all, 'cpu1#custom': mk('cpu1', 1, 'native', { input: { kind: 'custom', summary: 'n=128' } }) }).score).toBe(base)
  expect(() => finalScore({ ...all, cpu1: mk('cpu1', 30, 'browser') })).toThrow(/combine/)
})

test('CV flag is set at exactly 15 percent', () => {
  expect(NOISY_CV).toBe(15); expect(isNoisy(14.999)).toBe(false); expect(isNoisy(15)).toBe(true)
  const s = summarize([85, 100, 115]); expect(s.cv).toBeCloseTo(15, 9); expect(s.value).toBe(100)
  const noisy = fromBench('matmul_1', { gflops: 100, spread: { n: 5, min: 80, median: 100, max: 120, cv_pct: 15 } })!
  expect(noisy.flags).toContain('noisy')
  expect(fromBench('matmul_1', { gflops: 100, spread: { n: 5, min: 80, median: 100, max: 120, cv_pct: 14.9 } })!.flags).not.toContain('noisy')
})

test('fromBench maps every bench key; companion and model runs feed the same shape', () => {
  const b: any = { ...pack.bench, gpu: { gflops: 186, adapter: 'a' }, power: pack.power }
  for (const k of BENCH_KEYS) {
    const r = fromBench(k, b[k], { scale: 'native' })
    expect(r, k).not.toBeNull(); expect(r!.v).toBe(1); expect(r!.scale).toBe('native'); expect(Number.isFinite(r!.value)).toBe(true)
  }
  expect(fromBench('nope', {})).toBeNull()
  expect(fromBench('matmul_1', pack.bench.matmul_1)!.value).toBe(pack.bench.matmul_1.spread.median)
  const stats = { where: 'webgpu', repo: 'a/b', task: 'text-generation', loadMs: 1, firstMs: 200, totalMs: 1200, items: 33, unit: 'tokens', perSec: 33, memBytes: null, joules: null, estimatedEnergy: false }
  const run = fromBench('run', stats, { params: 135e6, goldenOk: true })!
  expect(run.component).toBe('model:text-generation'); expect(run.scale).toBe('browser'); expect(run.score).toBeGreaterThan(0)
  const bad = { ...stats, task: 'fill-mask', unit: 'items', items: 1, perSec: 10, totalMs: 100, firstMs: 20 }
  expect(fromBench('run', bad, { params: 1e8, goldenOk: false })!.score).toBeNull()
})

test('registry rows: pillars, weights, references and caps', () => {
  expect(REGISTRY.map((r) => r.id)).toEqual(['cpu1', 'cpun', 'cache', 'ram', 'storage', 'gpu', 'net', 'energy'])
  expect(rowFor('model:fill-mask')!.pillar).toBe('model')
  for (const r of REGISTRY.filter((r) => r.pillar)) { expect(r.ref.native![1]).toBeGreaterThan(0); expect(r.ref.browser![1]).toBeGreaterThan(0) }
  expect(REGISTRY.find((r) => r.id === 'net')!.pillar).toBeNull(); expect(REGISTRY.find((r) => r.id === 'energy')!.pillar).toBeNull()
  const cpu1 = rowFor('cpu1')!, ram = rowFor('ram')!, cache = rowFor('cache')!
  expect(validateInput(cpu1, 512, caps()).ok).toBe(true)
  expect(validateInput(cpu1, 64, caps()).ok).toBe(false)
  expect(validateInput(cpu1, 2048, caps()).ok).toBe(false)
  expect(validateInput(cpu1, 1024, caps({ deviceMemoryGB: 0.1 })).ok).toBe(false)
  expect(inputLimits(cache, caps({ profile: 'lite' }))!.max).toBe(32)
  expect(inputLimits(ram, caps({ deviceMemoryGB: 1 }))!.max).toBeLessThanOrEqual(16)
  expect(validateInput(rowFor('cpun')!, 12, caps({ cores: 4 })).ok).toBe(false)
  expect(validateInput(rowFor('energy')!, 5, caps()).ok).toBe(false)
  expect(validateInput(rowFor('net')!, 'http://x.test', caps()).ok).toBe(false)
  expect(validateInput(cpu1, null, caps({ deviceMemoryGB: 0.1 }))).toMatchObject({ ok: true })
})

test('stored results: round trip, unknown versions and bad data are dropped', () => {
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v }, removeItem: (k: string) => { delete mem[k] } })
  expect(loadStored().results).toEqual({})
  const r = mk('cpu1', 100)
  mem[RESULTS_KEY] = JSON.stringify({ v: 1, results: { cpu1: r, junk: { v: 9 } }, history: Array.from({ length: 14 }, (_, i) => ({ at: `t${i}`, scale: 'native', results: { cpu1: r } })) })
  const ok = loadStored()
  expect(Object.keys(ok.results)).toEqual(['cpu1']); expect(ok.history).toHaveLength(10); expect(ok.history[9].at).toBe('t13')
  mem[RESULTS_KEY] = JSON.stringify({ v: 2, results: { cpu1: r }, history: [] })
  expect(loadStored().results).toEqual({}); expect(mem[RESULTS_KEY]).toBeUndefined()
  mem[RESULTS_KEY] = '{not json'
  expect(loadStored().history).toEqual([])
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
  expect(loadStored().results).toEqual({})
  expect(() => useHW.getState().addResult(r)).not.toThrow()
})

test('runComponent: one test at a time, cancel, custom input is stored apart, runAll order', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  useHW.getState().clearResults()
  const started: string[] = []
  const saved = REGISTRY.map((r) => r.run)
  REGISTRY.forEach((row) => {
    row.run = (input, signal, onProgress) => new Promise((resolve, reject) => {
      started.push(`${row.id}:${input}`)
      onProgress({ fraction: 0.5 })
      const t = setTimeout(() => resolve(mk(row.id, REF_V1.native[row.id] ?? 1)), 1000)
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
    })
  })
  try {
    const a = useHW.getState().runComponent('cpu1')
    expect(useHW.getState().running).toBe('cpu1')
    expect(await useHW.getState().runComponent('ram')).toBeNull()
    expect(started).toEqual(['cpu1:null'])
    useHW.getState().cancel()
    expect(await a).toBeNull()
    expect(useHW.getState().running).toBeNull(); expect(useHW.getState().results.cpu1).toBeUndefined(); expect(useHW.getState().testErrors.cpu1).toBeUndefined()

    const b = useHW.getState().runComponent('cpu1'); await vi.advanceTimersByTimeAsync(1000)
    expect((await b)!.component).toBe('cpu1')
    const c = useHW.getState().runComponent('cpu1', 512); await vi.advanceTimersByTimeAsync(1000)
    expect((await c)!.input.kind).toBe('custom')
    expect(useHW.getState().results['cpu1#custom'].flags).toContain('custom'); expect(useHW.getState().results.cpu1.input.kind).toBe('default')
    expect(await useHW.getState().runComponent('cpu1', 99999)).toBeNull(); expect(useHW.getState().testErrors.cpu1).toMatch(/between/)

    started.length = 0
    const all = useHW.getState().runAll()
    for (let i = 0; i < RUN_ALL_ORDER.length; i++) await vi.advanceTimersByTimeAsync(1000)
    await all
    expect(started.map((s) => s.split(':')[0])).toEqual(RUN_ALL_ORDER)
    expect(useHW.getState().history.length).toBe(1)
    started.length = 0
    const again = useHW.getState().runAll(); await vi.advanceTimersByTimeAsync(10); useHW.getState().cancel(); await again
    expect(started).toHaveLength(1)
  } finally {
    REGISTRY.forEach((row, i) => { row.run = saved[i] })
    vi.useRealTimers()
  }
})

test('export: no device strings unless asked', () => {
  const all = worked()
  const plain = JSON.parse(exportResults({ includeDevice: false }, all, { cpu: { name: 'Secret CPU' } }))
  expect(JSON.stringify(plain)).not.toMatch(/Radeon|Secret/); expect(plain.final.score).toBeGreaterThan(1000)
  const full = JSON.parse(exportResults({ includeDevice: true }, all, { cpu: { name: 'Secret CPU' } }))
  expect(full.device.cpu).toBe('Secret CPU'); expect(JSON.stringify(full)).toMatch(/Radeon/)
})

test('scoreRun: speed and response only, fit apart, gate, whisper window, prefill and decode', () => {
  const base: any = { where: 'webgpu', repo: 'a/m', task: 'text-generation', loadMs: 0, firstMs: 300, totalMs: 1300, items: 21, unit: 'tokens', perSec: 16, memBytes: null, joules: null, estimatedEnergy: false }
  const fit: any = { verdict: 'tight', needBytes: 9e9, haveBytes: 10e9, where: 'webgpu', reason: '' }
  const a = scoreRun(base, null, { params: 135e6, info: null, goldenOk: true, timedRuns: 3 })
  const b = scoreRun(base, fit, { params: 135e6, info: null, goldenOk: true, timedRuns: 3 })
  expect(b.overall).toBe(a.overall); expect(b.fit!.score).not.toBeNull(); expect(a.score).toBe(a.overall); expect(a.reliable).toBe(true)
  expect(a.decode!.tps).toBeCloseTo(20); expect(a.prefill!.ms).toBe(300)
  expect(scoreRun(base, null, { params: 135e6, info: null, goldenOk: false }).score).toBeNull()
  expect(scoreRun(base, null, { params: 135e6, info: null }).gate).toBe('unchecked')
  expect(scoreRun(base, null, { params: 135e6, info: null }).reliable).toBe(false)
  const w = { ...base, task: 'automatic-speech-recognition', unit: 'items', items: 1, totalMs: 2000, firstMs: 2000, perSec: 0.5 }
  const s5 = scoreRun(w, null, { params: 74e6, info: null, audioSec: 5 }), s30 = scoreRun(w, null, { params: 74e6, info: null, audioSec: 30 })
  expect(s5.parts[0].score).toBe(s30.parts[0].score)
  const img = { ...base, task: 'image-classification', unit: 'items', items: 1, perSec: 10 }
  expect(scoreRun(img, null, { params: 86e6, info: null, itemTokens: 50 }).parts[0].score!).toBeLessThan(scoreRun(img, null, { params: 86e6, info: null, itemTokens: 197 }).parts[0].score!)
})

test('final score rows: dashboard-ready pillars, status, delta against the previous entry, tier key', () => {
  const all = atRef('native')
  const f = finalScore(all)
  expect(f.pillars.map((p) => p.id)).toEqual(['compute', 'memory', 'gpu', 'storage', 'model'])
  expect(f.pillars.every((p) => p.status === 'measured' && p.delta === null && Math.abs(p.score! - 1000) < 1e-6)).toBe(true)
  expect(f.pillars[0].components).toEqual(['cpu1', 'cpun']); expect(f.tierKey).toBe('strong'); expect(tierKey(null)).toBe('none'); expect(tierKey(1800)).toBe('exceptional')
  const faster = { ...all, gpu: mk('gpu', 2 * ref('gpu', 'native')) }
  const g = finalScore(faster, all)
  expect(g.pillars.find((p) => p.id === 'gpu')!.delta).toBeCloseTo(1000, 6); expect(g.pillars.find((p) => p.id === 'compute')!.delta).toBeCloseTo(0, 6)
  const part = finalScore({ cpu1: all.cpu1, ram: all.ram, cache: all.cache })
  expect(part.pillars.find((p) => p.id === 'compute')!.status).toBe('imputed')
  expect(part.pillars.find((p) => p.id === 'memory')!.status).toBe('measured')
  expect(part.pillars.find((p) => p.id === 'gpu')).toMatchObject({ status: 'untested', score: null })
  // finalNow compares with the entry before the one just saved
  const hist = [{ at: 'a', scale: 'native' as const, results: all }, { at: 'b', scale: 'native' as const, results: faster }]
  expect(finalNow(faster, hist).pillars.find((p) => p.id === 'gpu')!.delta).toBeCloseTo(1000, 6)
  expect(finalNow(all, []).pillars[0].delta).toBeNull()
})

test('export carries the name only when allowed, never the theme; history entries keep the name', () => {
  const all = worked()
  const withName = JSON.parse(exportResults({ includeDevice: false }, all, null, 'Ada'))
  expect(withName.name).toBe('Ada')
  expect(JSON.parse(exportResults({ includeDevice: false, includeName: false }, all, null, 'Ada')).name).toBeUndefined()
  expect(JSON.parse(exportResults({ includeDevice: false }, all, null, '')).name).toBeUndefined()
  expect(JSON.stringify(withName).toLowerCase()).not.toContain('theme')
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  useHW.getState().clearResults(); useHW.getState().addResult(all.cpu1); useHW.getState().snapshot()
  expect(useHW.getState().history).toHaveLength(1)
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v }, removeItem: () => {} })
  mem[RESULTS_KEY] = JSON.stringify({ v: 1, results: {}, history: [{ at: 't', scale: 'native', results: {}, name: 'Ada' }] })
  expect(loadStored().history[0].name).toBe('Ada')
})

/* ---- B7: a model run fills the Model pillar of the one device score ---- */
import { finalScore } from '../src/hw/score'
import { modelResult } from '../src/hw/score'
import type { RunStats } from '../src/api'

test('a finished model run becomes model:<repo> and fills the Model pillar', () => {
  const st: RunStats = { where: 'webgpu', repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', task: 'text-generation', loadMs: 900, firstMs: 400, totalMs: 3000, items: 40, unit: 'tokens', perSec: 40, memBytes: null, joules: null, estimatedEnergy: true }
  const r = modelResult(st, { params: null, fit: null })!
  expect(r.component).toBe('model:HuggingFaceTB/SmolLM2-135M-Instruct')
  expect(r.scale).toBe('browser')
  expect(r.score).toBeGreaterThan(0)
  const f = finalScore({ [r.component]: r })
  expect(f.pillars.find((p) => p.id === 'model')!.status).toBe('measured')
  expect(modelResult({ ...st, where: 'none' })).toBeNull()
})
