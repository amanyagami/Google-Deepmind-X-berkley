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
