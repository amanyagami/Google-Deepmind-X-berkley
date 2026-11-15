// The hand-assembled WebAssembly SIMD matrix multiply must agree with a plain JavaScript reference.
import { expect, test } from 'vitest'
import {
  buildChase, cacheSizes, calibrateReps, chase, ci95, ciRel, clampInt, collectSamples, cvPct, findKnees, geomean, median, minSampleMs,
  planTriad, RunScope, fillSliced, repsFromRate, SWEEP_SIZES, sampleFlags, shouldStopEarly, triad, withHalving, chooseProfile, loadKernel, MAX_N,
} from '../src/hw/browserBench'

test('wasm kernel computes C += A x B exactly enough, for every supported size', async () => {
  const k = await loadKernel()
  for (const n of [16, 64, 128, MAX_N]) {
    const A = k.f32.subarray(0, n * n), B = k.f32.subarray(n * n, 2 * n * n), C = k.f32.subarray(2 * n * n, 3 * n * n)
    for (let i = 0; i < n * n; i++) { A[i] = Math.sin(i) * 0.5; B[i] = Math.cos(i * 0.7) * 0.5 }
    C.fill(1) // the kernel accumulates, so C starts at 1
    k.mm(n)
    let worst = 0
    for (let i = 0; i < n; i += 5) for (let j = 0; j < n; j += 3) {
      let s = 1; for (let q = 0; q < n; q++) s += A[i * n + q] * B[q * n + j]
      worst = Math.max(worst, Math.abs(s - C[i * n + j]))
    }
    expect(worst).toBeLessThan(1e-4 * Math.sqrt(n))
  }
})

test('median, CV, CI', () => {
  expect(median([5, 1, 3])).toBe(3)
  expect(median([4, 1, 3, 2])).toBe(2.5)
  expect(cvPct([10, 10, 10])).toBe(0)
  expect(cvPct([90, 100, 110])).toBeCloseTo(10, 5)
  const [lo, hi] = ci95([100, 101, 99, 100, 100])
  expect(lo).toBeLessThan(100); expect(hi).toBeGreaterThan(100)
  expect(ciRel([1])).toBe(Infinity)
  expect(geomean([4, 9])).toBeCloseTo(6, 9)
})

test('early stop needs >= 5 samples and a CI within 2 %', () => {
  expect(shouldStopEarly([100, 100, 100, 100])).toBe(false)
  expect(shouldStopEarly([100, 100.1, 99.9, 100, 100.05])).toBe(true)
  expect(shouldStopEarly([100, 140, 80, 120, 90, 110])).toBe(false)
})

test('flags: noisy above 15 % CV, hidden tab, coarse timer, battery, not isolated, halved, cancelled', () => {
  expect(sampleFlags({ cv: 15 })).toEqual([])
  expect(sampleFlags({ cv: 15.1 })).toContain('noisy')
  const f = sampleFlags({ cv: 1, hidden: true, timerMs: 1, onBattery: true, isolated: false, halved: true, cancelled: true })
  expect(f).toEqual(['hidden-tab', 'on-battery', 'not-isolated', 'coarse-timer', 'size-halved', 'cancelled'])
  expect(sampleFlags({ cv: 1, timerMs: 0.1 })).toEqual([])
  expect(minSampleMs(0.1)).toBe(50); expect(minSampleMs(1)).toBe(250)
})

test('knees: L1 / L2 / L3 from a synthetic latency curve, also with noise and a slow transition', () => {
  const sizes = Array.from({ length: 13 }, (_, i) => 16384 * 2 ** i) // 16 KB .. 64 MB
  const lat = [1, 1, 3.5, 3.5, 3.6, 3.6, 4, 9, 10, 10, 10.5, 40, 90]
  expect(findKnees(sizes, lat)).toEqual([32768, 1048576, 16777216])
  const noisy = lat.map((v, i) => v * (1 + 0.05 * Math.sin(i * 7)))
  expect(findKnees(sizes, noisy)).toEqual([32768, 1048576, 16777216])
  expect(findKnees(sizes, lat.map(() => 2))).toEqual([])
  const slow = [1, 1, 2, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5] // L1 edge spread over two steps
  expect(findKnees(sizes, slow)).toEqual([32768])
})

test('pointer chase is one cycle through every line; triad is a + b*s', () => {
  const a = buildChase(64 * 256)
  const seen = new Set<number>(); let p = 0
  for (let i = 0; i < 256; i++) { seen.add(p); p = a[p] }
  expect(seen.size).toBe(256); expect(p).toBe(0)
  expect(chase(a, 256 * 4)).toBe(chase(a, 256 * 4)) // deterministic landing point
  const x = new Float64Array(4), y = Float64Array.of(1, 2, 3, 4), z = Float64Array.of(1, 1, 1, 1)
  triad(x, y, z, 3, 2)
  expect(Array.from(x)).toEqual([4, 5, 6, 7])
})

test('caps: clamping, RAM plan <= 12 % of memory, cache sizes per profile', () => {
  expect(clampInt(5000, 512, 4096, 64)).toEqual({ value: 4096, clamped: true })
  expect(clampInt(1000, 512, 4096, 64).value).toBe(1024)
  const MB = 2 ** 20
  const big = planTriad({ deviceMemoryGB: 8, threads: 8, kneeBytes: 16 * MB, requestedMB: null })
  expect(big.arrayBytes * 3 * 8).toBeLessThanOrEqual(8 * 2 ** 30 * 0.12)
  const phone = planTriad({ deviceMemoryGB: 2, threads: 4, kneeBytes: 16 * MB, requestedMB: null })
  expect(phone.halved).toBe(true)
  expect(phone.arrayBytes * 3 * 4).toBeLessThanOrEqual(2 * 2 ** 30 * 0.12)
  expect(planTriad({ deviceMemoryGB: null, threads: 4, kneeBytes: null, requestedMB: 500 }).memoryUnknown).toBe(true)
  expect(cacheSizes('standard', 8)).toEqual(SWEEP_SIZES)
  expect(Math.max(...cacheSizes('lite', 2))).toBeLessThanOrEqual(32 * MB)
  expect(chooseProfile({ deviceMemoryGB: 2, cores: 8, mobile: false, gpuOk: true })).toBe('lite')
  expect(chooseProfile({ deviceMemoryGB: 8, cores: 16, mobile: false, gpuOk: true })).toBe('full')
  expect(chooseProfile({ deviceMemoryGB: 4, cores: 4, mobile: false, gpuOk: false })).toBe('standard')
})

test('RangeError halves the size until it fits, and gives up below the minimum', async () => {
  const tried: number[] = []
  const r = await withHalving(async (s) => { tried.push(s); if (s > 100) throw new RangeError('too big'); return s }, 512, 16)
  expect(tried).toEqual([512, 256, 128, 64]); expect(r).toEqual({ result: 64, size: 64, halved: true })
  await expect(withHalving(async () => { throw new RangeError('x') }, 32, 16)).rejects.toThrow('x')
  await expect(withHalving(async () => { throw new Error('other') }, 512, 16)).rejects.toThrow('other')
})

test('sampling loop: warm-up discarded, early stop, budget, and cancel with a fake clock', async () => {
  let t = 0
  const clock = { now: () => t }
  const calls: number[] = []
  const steady = collectSamples(() => { t += 50; calls.push(1); return 100 }, { clock, budgetMs: 5000, warmups: 2 })
  const r = await steady
  expect(r.samples).toHaveLength(5); expect(r.stopped).toBe('ci'); expect(calls).toHaveLength(7) // 2 warm-ups discarded

  t = 0; let k = 0
  const noisy = await collectSamples(() => { t += 100; return k++ % 2 ? 50 : 150 }, { clock, budgetMs: 1000, warmups: 0, minSamples: 5 })
  expect(noisy.stopped).toBe('budget'); expect(noisy.samples.length).toBeGreaterThanOrEqual(5)

  t = 0
  const ctl = new AbortController(); let n = 0
  const c = await collectSamples(() => { t += 50; if (++n === 3) ctl.abort(); return 1 + n }, { clock, signal: ctl.signal, budgetMs: 5000, warmups: 0, tol: 0 })
  expect(c.cancelled).toBe(true); expect(c.samples.length).toBeLessThanOrEqual(3)
})

test('cancel: every disposer (worker terminate, GPU destroy) runs at once, within 250 ms on a fake clock', () => {
  let t = 0
  const ctl = new AbortController()
  const scope = new RunScope(ctl.signal, { now: () => t })
  const done: string[] = []
  scope.add(() => { t += 20; done.push('worker1') })
  scope.add(() => { t += 20; done.push('worker2') })
  scope.add(() => { t += 30; done.push('gpu'); throw new Error('destroy failed') }) // a failing disposer must not stop the rest
  scope.add(() => { done.push('last') })
  t = 1000; ctl.abort()
  expect(done).toEqual(['worker1', 'worker2', 'gpu', 'last'])
  expect(scope.latencyMs).toBeLessThanOrEqual(250)
  scope.add(() => done.push('late')) // added after abort: runs immediately
  expect(done.at(-1)).toBe('late')
  const pre = new AbortController(); pre.abort()
  let hit = 0; new RunScope(pre.signal).add(() => hit++)
  expect(hit).toBe(1)
})

test('calibrateReps doubles until a run is long enough', () => {
  let t = 0
  const reps = calibrateReps((r) => { t += r * 0.5 }, 50, { now: () => t })
  expect(reps * 0.5).toBeGreaterThanOrEqual(50); expect(reps).toBeLessThan(400)
})

test('fillSliced yields every <= 8 ms of work and fills everything', async () => {
  let t = 0
  const arr = new Float32Array(20000)
  const y = await fillSliced(arr, (i) => { t += 0.01; return i }, 8, { now: () => t }, async () => {})
  expect(arr[19999]).toBe(19999)
  expect(y).toBeGreaterThanOrEqual(15) // 200 ms of work -> about 25 slices
})

test('repsFromRate sizes the next run from the last rate; the sweep reuses one chain buffer', () => {
  expect(repsFromRate(50, 1000, 100)).toBe(Math.ceil((50 * 1.1 * 1000) / 100))
  expect(repsFromRate(50, 0.0001, 100)).toBe(1)
  const buf = new Uint32Array(64 * 1024 / 4)
  const a = buildChase(4096, Math.random, buf)
  expect(a.buffer).toBe(buf.buffer); expect(a.length).toBe(1024)
  let p = 0; const seen = new Set<number>(); for (let i = 0; i < 64; i++) { seen.add(p); p = a[p] }
  expect(seen.size).toBe(64)
  expect(SWEEP_SIZES.length).toBe(12)
})
