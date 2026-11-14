import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { jumpLocked, jumpTo, useStore, type AppView, type Tab } from './store'
// Each view loads its own code on first use, so the first page needs only what it shows.
const JourneyView = lazy(() => import('./hw/MachineUI').then((m) => ({ default: m.JourneyView })))
const PowerView = lazy(() => import('./hw/MachineUI').then((m) => ({ default: m.PowerView })))
const ZooView = lazy(() => import('./zoo/ZooUI').then((m) => ({ default: m.ZooView })))
const SECTIONS: { id: AppView; label: string; tip: string }[] = [
  { id: 'model', label: 'Model', tip: 'The model on your prompt, and five small networks beside it' },
  { id: 'journey', label: 'Journey', tip: "Follow one prompt through this PC's hardware" },
  { id: 'power', label: 'Electricity', tip: 'The electricity in this PC, live' },
]
const Loading = () => <div className="scene empty"><p className="hint">Loading…</p></div>


/** One prompt, one Run: the model runs it (Model section), then the Journey replays it on the hardware. */
const runAll = () => useStore.getState().run()

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
      <form className="urlform promptform" onSubmit={(e) => { e.preventDefault(); runAll() }}>
        <label className="sr" htmlFor="sharedprompt">Prompt</label>
        <span className="host">prompt</span>
        <input id="sharedprompt" value={s.prompt} onChange={(e) => s.setPrompt(e.target.value)} spellCheck={false} disabled={s.mode === 'replay'} title={s.mode === 'replay' ? 'Recorded run: start the companion to type your own prompt' : 'The same prompt drives the model and the machine'} />
        <button className="btn" type="submit" disabled={s.running || !s.probe?.graph?.runnable}>{s.running ? 'Running…' : 'Run'}</button>
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
  const probe = useStore((s) => s.probe)
  const layers = useStore((s) => s.layers.length)
  const view = useStore((s) => s.appView)
  const flow = useRef<HTMLDivElement>(null)
  const seen = useSections(flow)
  // every model opens already run on the shared prompt, so the animations have something real to show
  const autoRan = useRef('')
  useEffect(() => { const s = useStore.getState(); if (probe?.graph?.runnable && !layers && !s.running && autoRan.current !== s.repo) { autoRan.current = s.repo; s.run() } }, [probe, layers])
  useEffect(() => { init() }, [init])
  // a link such as /#power opens at that section
  useEffect(() => { const first = useStore.getState().appView; if (first !== 'model') requestAnimationFrame(() => jumpTo(first, false)) }, [])
  useEffect(() => { try { history.replaceState(null, '', view === 'model' ? location.pathname + location.search : `${location.search}#${view}`) } catch { /* ignore */ } }, [view])
  return (
    <div className="app">
      <Header view={view} />
      <div className="flow" ref={flow}>
        <Sect id="model" label="The model on your prompt">{seen.model ? <Suspense fallback={<Loading />}><ZooView /></Suspense> : <Loading />}</Sect>
        <Sect id="journey" label="Journey of a prompt through the hardware">{seen.journey ? <Suspense fallback={<Loading />}><JourneyView /></Suspense> : <Loading />}</Sect>
        <Sect id="power" label="Electricity, live">{seen.power ? <Suspense fallback={<Loading />}><PowerView /></Suspense> : <Loading />}</Sect>
      </div>
    </div>
  )
}
