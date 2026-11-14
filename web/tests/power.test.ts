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
