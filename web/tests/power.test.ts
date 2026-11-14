import { expect, test } from 'vitest'
import { powerAt, powerNow, SMOOTH_S, telemetryPower, type PowerSample } from '../src/hw/hwStore'
import { estimatePower, summarise } from '../src/hw/browserBench'

const mk = (t: number, stage: string, w: number): PowerSample => ({ t, stage, pkg_w: w, core_w: [w / 4, w / 4], mhz: 4000, util: [50, 50] })

test('powerAt averages over its window and is a pure function of time (scrub and rewind agree)', () => {
  const s = Array.from({ length: 50 }, (_, i) => mk(i * 0.1, i < 25 ? 'a' : 'b', i < 25 ? 10 : 50))
  const a = powerAt(s, 1.0)!, b = powerAt(s, 4.0)!, again = powerAt(s, 1.0)!
  expect(a.pkg_w).toBeCloseTo(10)
  expect(b.pkg_w).toBeCloseTo(50)
  expect(again).toEqual(a)
  const edge = powerAt(s, 2.45)! // inside the window around the step: between the two levels
  expect(edge.pkg_w).toBeGreaterThan(10); expect(edge.pkg_w).toBeLessThan(50)
  expect(SMOOTH_S).toBeGreaterThan(0)
  expect(powerAt([], 1)).toBeNull()
})

test('energy per test: each interval belongs to the sample that starts it, so average never exceeds peak', () => {
  const s = [mk(0, 'idle', 8), mk(0.1, 'idle', 9), mk(0.2, 'busy', 60), mk(0.3, 'busy', 62), mk(0.4, 'cool', 9), mk(0.5, 'cool', 8)]
  const S = summarise(s)
  for (const k of Object.keys(S)) expect(S[k].avg_w).toBeLessThanOrEqual(S[k].peak_w + 1e-9)
  expect(S.busy.joules).toBeCloseTo((60 + 62) * 0.1)
  expect(S.idle.seconds).toBeCloseTo(0.2)
})

test('powerNow: recording beats everything, then the chosen mode, then whatever exists', () => {
  const run = { samples: [mk(0, 'idle', 10), mk(0.1, 'idle', 10), mk(5, 'matmul_n', 50)], summary: {}, source: 'x' }
  const tele = [12, 14, 16, 18].map((w) => ({ cpu: [50, 100], power: { pkg_w: w, core_w: [w / 2, w / 4], eff_mhz: 4000 } }))
  const base = { benchRunning: false, powerLive: [] as PowerSample[], power: run, pHead: 5, telemetry: tele }
  const live = powerNow({ ...base, pMode: 'live' })
  expect(live.mode).toBe('live'); expect(live.s!.pkg_w).toBeCloseTo(15); expect(live.s!.util).toEqual([0.5, 1])
  expect(powerNow({ ...base, pMode: 'replay' }).mode).toBe('replay')
  expect(powerNow({ ...base, pMode: 'live', telemetry: [] }).mode).toBe('replay') // no sensors: show the run
  expect(powerNow({ ...base, pMode: 'replay', benchRunning: true, powerLive: [mk(0, 'disk', 20), mk(0.1, 'disk', 22)] }).mode).toBe('recording')
  expect(powerNow({ ...base, power: null, telemetry: [], pMode: 'live' }).mode).toBe('none')
  expect(telemetryPower([{ power: { pkg_w: null } }])).toBeNull()
})

test('the browser power estimate rises with busy cores and stays below the power class', () => {
  const tdp = 45, idle = estimatePower(tdp, 0, 16), one = estimatePower(tdp, 1, 16), all = estimatePower(tdp, 8, 16)
  expect(idle.pkg_w).toBeLessThan(one.pkg_w); expect(one.pkg_w).toBeLessThan(all.pkg_w)
  expect(all.pkg_w).toBeLessThan(tdp * 1.2)
  expect(all.core_w.length).toBe(8)
})

import { REF, REF_BROWSER, scoreRun } from '../src/hw/score'
import type { Fit, RunStats } from '../src/api'

const rs = (o: Partial<RunStats> = {}): RunStats => ({ where: 'companion', repo: 'a/smol', task: 'text-generation', loadMs: 1000, firstMs: 300, totalMs: 3250, items: 60, unit: 'tokens', perSec: 20, memBytes: null, joules: null, estimatedEnergy: false, ...o })
const fitOk = (o: Partial<Fit> = {}): Fit => ({ verdict: 'fits', needBytes: 5e8, haveBytes: 1e9, where: 'companion', reason: '', ...o })
const part = (r: ReturnType<typeof scoreRun>, id: string) => r.parts.find((p) => p.id === id)!

test('scoreRun: the reference run (135M, 20 tok/s, 300 ms, half the memory) scores about 1000', () => {
  const j = (60 * 2 * 135e6) / (0.5 * 2 * 135e6) // joules at exactly the reference work per joule
  const r = scoreRun(rs({ joules: j }), fitOk(), { params: 135e6, info: null })
  for (const p of r.parts) { expect(p.score).toBeGreaterThan(995); expect(p.score).toBeLessThan(1005) }
  expect(r.overall).toBeGreaterThan(990); expect(r.overall).toBeLessThan(1010)
  expect(r.tier).toBe('Strong')
  expect(part(r, 'speed').detail).toContain('20')
})

test('scoreRun: same tokens/s on a bigger model means more work; browser runtimes use their own reference', () => {
  const small = part(scoreRun(rs(), null, { params: 135e6, info: null }), 'speed').score!
  const big = part(scoreRun(rs(), null, { params: 270e6, info: null }), 'speed').score!
  expect(big).toBe(2 * small)
  const gpu = part(scoreRun(rs({ where: 'webgpu', perSec: REF_BROWSER.ai, totalMs: 300 + (59 / REF_BROWSER.ai) * 1000 }), null, { params: 135e6, info: null }), 'speed').score!
  const wasm = part(scoreRun(rs({ where: 'wasm', perSec: REF_BROWSER.ai_wasm, totalMs: 300 + (59 / REF_BROWSER.ai_wasm) * 1000 }), null, { params: 135e6, info: null }), 'speed').score!
  expect(gpu).toBe(1000); expect(wasm).toBe(1000)
  expect(part(scoreRun(rs({ perSec: REF.ai }), null, { params: 135e6, info: null }), 'speed').score).toBe(1000)
})

test('scoreRun: missing energy, params or fit leave that part null; the overall comes from the rest', () => {
  const r = scoreRun(rs(), fitOk(), { params: 135e6, info: null })
  expect(part(r, 'efficiency').score).toBeNull()
  expect(r.overall).toBeGreaterThan(0)
  expect(part(scoreRun(rs(), fitOk(), { params: null, info: null }), 'speed').score).toBeNull()
  const est = scoreRun(rs({ joules: 50, estimatedEnergy: true }), null, { params: 135e6, info: null })
  expect(part(est, 'efficiency').label).toContain('est')
  expect(part(est, 'headroom').score).toBeNull()
})

test('scoreRun: a too-big model does not change the score; the fit verdict is returned apart', () => {
  const ok = scoreRun(rs(), fitOk(), { params: 135e6, info: null })
  const big = scoreRun(rs(), fitOk({ verdict: 'too-big', needBytes: 2e9 }), { params: 135e6, info: null })
  expect(part(big, 'headroom').score).toBe(50)
  expect(big.overall).toBe(ok.overall); expect(big.fit!.score).toBe(50); expect(big.fit!.value).toMatch(/too-big/)
  expect(part(scoreRun(rs(), fitOk({ verdict: 'tight', needBytes: 9e8 }), { params: 135e6, info: null }), 'headroom').score!).toBeLessThan(250)
})

test('scoreRun: overall is the weighted geometric mean of speed and response only; response is inverse-linear and capped', () => {
  const r = scoreRun(rs({ joules: 60 }), fitOk({ needBytes: 3e8 }), { params: 100e6, info: null })
  const W: Record<string, number> = { speed: 0.65, response: 0.35 }
  const g = Math.exp(r.parts.filter((p) => W[p.id]).reduce((s, p) => s + W[p.id] * Math.log(p.score!), 0))
  expect(Math.abs(r.overall - g)).toBeLessThanOrEqual(1)
  expect(part(scoreRun(rs({ firstMs: 600 }), null, { params: 1, info: null }), 'response').score).toBe(500)
  expect(part(scoreRun(rs({ firstMs: 1 }), null, { params: 1, info: null }), 'response').score).toBe(2000)
})
