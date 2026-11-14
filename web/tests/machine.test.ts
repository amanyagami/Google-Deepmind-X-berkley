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
