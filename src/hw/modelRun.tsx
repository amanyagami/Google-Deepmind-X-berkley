// B7, machine side: one device score. A finished model run is written into the results as `model:<repo>`, so the
// Model pillar of the device score fills; the Model drawer shows plain facts and a link to that score (no gauge).
import { useStore } from '../store'
import type { Fit, RunStats } from '../api'
import { useHW } from './hwStore'
import { modelResult } from './score'
export { modelResult }

let seen: RunStats | null = null
/** Copies the newest finished run into the device results once. Never mixes scales with the tests already there. */
export function syncModelRun(): void {
  const st = useStore.getState()
  const stats = st.lastStats
  if (!stats || stats === seen || st.running) return
  seen = stats
  const r = modelResult(stats, { params: st.spec?.params ?? null, fit: st.fit, ok: !st.runErr })
  if (!r) return
  useHW.getState().addResult(r)
  useHW.getState().snapshot()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ns-model-scored'))
}
let installed = false
/** Starts following finished runs (idempotent). Called when the machine section or the facts below load. */
export function followModelRuns(): void {
  if (installed) return
  installed = true
  syncModelRun()
  useStore.subscribe((s, p) => { if (s.lastStats !== p.lastStats || s.running !== p.running) syncModelRun() })
}

/** Opens the machine drawer on the score, with the Model row open. */
export function openYourScore(): void {
  useStore.getState().setRail('machine', true)
  window.dispatchEvent(new CustomEvent('ns-open-score', { detail: { pillar: 'model' } }))
  if (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 999px)').matches) import('../store').then((m) => m.jumpTo('power')).catch(() => { /* no section */ })
}

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`)
const FIT_WORD: Record<string, string> = { fits: 'fits', tight: 'tight fit', 'too-big': 'too big' }

/**
 * For the Model drawer (zoo/ZooUI.tsx renders it): plain facts of the last run and a link to the one device score.
 * "12 words/s · first word 0.4 s · fits" · Your score
 */
export function ModelRunFacts({ stats: s0, fit: f0 }: { stats?: RunStats | null; fit?: Fit | null }) {
  followModelRuns()
  const last = useStore((s) => s.lastStats), fitNow = useStore((s) => s.fit)
  const stats = s0 === undefined ? last : s0, fit = f0 === undefined ? fitNow : f0
  const pillar = useHW((h) => (stats ? h.results[`model:${stats.repo}`]?.score ?? null : null))
  if (!stats) return null
  const gen = stats.unit === 'tokens'
  const facts = [
    stats.perSec > 0 ? `${stats.perSec >= 10 ? Math.round(stats.perSec) : stats.perSec.toFixed(1)} ${gen ? 'words/s' : 'answers/s'}` : null,
    stats.firstMs > 0 ? `${gen ? 'first word' : 'answer'} ${secs(stats.firstMs)}` : null,
    fit ? FIT_WORD[fit.verdict] ?? fit.verdict : null,
  ].filter(Boolean)
  return (
    <p className="s6line" data-model-facts>
      <span className="mono">{facts.join(' · ')}</span>
      {' · '}<button type="button" className="t5-link" data-your-score onClick={openYourScore}>Your score</button>
      {pillar == null && <span className="sr-only"> (this run has no speed score yet)</span>}
    </p>
  )
}
