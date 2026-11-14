import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { jumpLocked, jumpTo, useStore, type AppView, type Tab } from './store'
import { CalcPanel, EditPanel, LayerPanel, ModelPanel, RunPanel } from './ui/panels'
// Each view loads its own code on first use, so the first page needs only what it shows.
const ModelScene = lazy(() => import('./scene/ModelScene').then((m) => ({ default: m.ModelScene })))
const JourneyView = lazy(() => import('./hw/MachineUI').then((m) => ({ default: m.JourneyView })))
const PowerView = lazy(() => import('./hw/MachineUI').then((m) => ({ default: m.PowerView })))
const ZooView = lazy(() => import('./zoo/ZooUI').then((m) => ({ default: m.ZooView })))
const SECTIONS: { id: AppView; label: string; tip: string }[] = [
  { id: 'model', label: 'Model', tip: "The model's structure, run live" },
  { id: 'journey', label: 'Journey', tip: "Follow one prompt through this PC's hardware" },
  { id: 'power', label: 'Electricity', tip: 'The electricity in this PC, live' },
  { id: 'zoo', label: 'Network zoo', tip: 'Five kinds of neural network, side by side' },
]
const Loading = () => <div className="scene empty"><p className="hint">Loading…</p></div>

const TABS: { id: Tab; label: string }[] = [
  { id: 'model', label: 'Model' }, { id: 'run', label: 'Run' }, { id: 'layer', label: 'Layer' }, { id: 'calc', label: 'Calculate' }, { id: 'edit', label: 'Edit & compare' },
]

function Header({ view }: { view: AppView }) {
  const s = useStore()
  const [text, setText] = useState('')
  useEffect(() => { if (s.repo) setText(s.repo) }, [s.repo])
  return (
    <header className="top">
      <div className="brand"><span className="logo" aria-hidden />Neural Studio</div>
      <nav className="seg" aria-label="Sections">
        {SECTIONS.map((x) => (
          <button key={x.id} className={view === x.id ? 'on' : ''} aria-current={view === x.id ? 'true' : undefined} onClick={() => jumpTo(x.id)} title={x.tip}>
            {x.label}{x.id === 'power' && <span className="livedot" aria-hidden />}
          </button>
        ))}
      </nav>
      <form className="urlform" onSubmit={(e) => { e.preventDefault(); s.loadModel(text) }}>
        <label className="sr" htmlFor="repo">Hugging Face model URL</label>
        <span className="host">huggingface.co/</span>
        <input id="repo" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="org/model" />
        <button className="btn" type="submit" disabled={s.probing}>{s.probing ? 'Reading…' : 'Load'}</button>
      </form>
      <div className="chips" role="group" aria-label="Examples">
        {s.examples.map((e) => (
          <button key={e.id} className="chip" aria-pressed={s.repo.toLowerCase() === e.repo.toLowerCase()} onClick={() => s.loadExample(e.id)}>{e.title}</button>
        ))}
      </div>
      <span className={`status ${s.backend}`} title={s.backend === 'online' ? 'Backend connected: live probe, runs and edits' : 'Backend not reachable: playing recorded runs'}>
        <i />{s.backend === 'online' ? 'live backend' : s.backend === 'offline' ? 'replay mode' : 'connecting'}
      </span>
    </header>
  )
}

/** Watches the four sections: which ones are on screen (only those draw their 3D), which one the page is at, and which
 *  are close enough to load their code. */
function useSections(flow: React.RefObject<HTMLDivElement | null>) {
  const [seen, setSeen] = useState<Record<AppView, boolean>>({ model: true, journey: false, power: false, zoo: false })
  useEffect(() => {
    const root = flow.current
    if (!root) return
    // on a phone the page itself scrolls, not the column
    const scroller = getComputedStyle(root).overflowY === 'auto' ? root : null
    const els = [...root.querySelectorAll<HTMLElement>('[data-sec]')]
    const ratio: Record<string, number> = {}
    const near = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { const id = (e.target as HTMLElement).dataset.sec as AppView; setSeen((s) => (s[id] ? s : { ...s, [id]: true })) }
    }, { root: scroller, rootMargin: '100% 0px' })
    const on = new IntersectionObserver((es) => {
      for (const e of es) ratio[(e.target as HTMLElement).dataset.sec!] = e.intersectionRatio
      useStore.getState().setVisible(Object.fromEntries(els.map((el) => [el.dataset.sec!, (ratio[el.dataset.sec!] ?? 0) > 0.04])))
      if (jumpLocked()) return
      const best = els.map((el) => el.dataset.sec as AppView).reduce((a, b) => ((ratio[b] ?? 0) > (ratio[a] ?? 0) ? b : a))
      if ((ratio[best] ?? 0) > 0 && useStore.getState().appView !== best) useStore.getState().setAppView(best)
    }, { root: scroller, threshold: [0, 0.04, 0.2, 0.4, 0.6, 0.8, 1] })
    els.forEach((el) => { near.observe(el); on.observe(el) })
    return () => { near.disconnect(); on.disconnect() }
  }, [flow])
  return seen
}

const Sect = ({ id, label, children }: { id: AppView; label: string; children: React.ReactNode }) => (
  <div id={`sec-${id}`} data-sec={id} className="sect" role="region" aria-label={label}>{children}</div>
)

export default function App() {
  const init = useStore((s) => s.init)
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const probe = useStore((s) => s.probe)
  const view = useStore((s) => s.appView)
  const flow = useRef<HTMLDivElement>(null)
  const seen = useSections(flow)
  const [hadProbe, setHadProbe] = useState(false)
  useEffect(() => { if (probe) setHadProbe(true) }, [probe])
  useEffect(() => { init() }, [init])
  // a link such as /#power opens at that section
  useEffect(() => { const first = useStore.getState().appView; if (first !== 'model') requestAnimationFrame(() => jumpTo(first, false)) }, [])
  useEffect(() => { try { history.replaceState(null, '', view === 'model' ? location.pathname + location.search : `${location.search}#${view}`) } catch { /* ignore */ } }, [view])
  return (
    <div className="app">
      <Header view={view} />
      <div className="flow" ref={flow}>
        <Sect id="model" label="Model">
          <main className="main">
            <section className="stage" aria-label="3D model">
              {probe || hadProbe ? <Suspense fallback={<Loading />}><ModelScene /></Suspense> : <div className="scene empty"><p className="hint">Paste a model link to build its 3D structure.</p></div>}
            </section>
            <aside className="inspector" aria-label="Inspector">
              <div className="tabs" role="tablist">
                {TABS.map((t) => (
                  <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
                ))}
              </div>
              <div className="pane" role="tabpanel">
                {tab === 'model' && <ModelPanel />}
                {tab === 'run' && <RunPanel />}
                {tab === 'layer' && <LayerPanel />}
                {tab === 'calc' && <CalcPanel />}
                {tab === 'edit' && <EditPanel />}
              </div>
            </aside>
          </main>
        </Sect>
        <Sect id="journey" label="Journey of a prompt through the hardware">{seen.journey ? <Suspense fallback={<Loading />}><JourneyView /></Suspense> : <Loading />}</Sect>
        <Sect id="power" label="Electricity, live">{seen.power ? <Suspense fallback={<Loading />}><PowerView /></Suspense> : <Loading />}</Sect>
        <Sect id="zoo" label="Network zoo">{seen.zoo ? <Suspense fallback={<Loading />}><ZooView /></Suspense> : <Loading />}</Sect>
      </div>
    </div>
  )
}
