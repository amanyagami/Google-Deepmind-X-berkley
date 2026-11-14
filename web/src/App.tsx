import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Hint } from './ui/charts'
import { canRun, jumpLocked, jumpTo, useStore, type AppView } from './store'
// Each view loads its own code on first use, so the first page needs only what it shows.
const MachineView = lazy(() => import('./hw/MachineUI').then((m) => ({ default: m.MachineView })))
const ZooView = lazy(() => import('./zoo/ZooUI').then((m) => ({ default: m.ZooView })))
const SECTIONS: { id: AppView; label: string; tip: string }[] = [
  { id: 'model', label: 'Model', tip: 'The model on your prompt, and five small networks beside it' },
  { id: 'power', label: 'Machine', tip: "This PC's hardware: live watts, and one prompt's journey through it" },
]
const Loading = () => <div className="skeleton" role="status" aria-label="Loading" />

/** Small stroke icons (1.75 px) for controls. */
const Ico = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg className="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)
const PLAY = 'M7 4.5v15l12-7.5z', SHIELD = 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z', CHEV = 'M6 9l6 6 6-6'

/** One prompt, one Run: the model runs it (Model section), then the Machine replays it on the hardware. */
const runAll = () => useStore.getState().run()

/** What this device offers, in one short phrase. Uses the capability probe when it exists, else a quick guess. */
function useDevice() {
  const [t, setT] = useState('This device')
  useEffect(() => {
    let live = true
    const mem = (c: number | null) => (c ? ` · ~${c} GB` : '')
    const guess = () => `This device · ${(navigator as any).gpu ? 'WebGPU' : 'WebAssembly (slower)'}${mem((navigator as any).deviceMemory ?? null)}`
    Promise.all([import('./hw/browserBench'), import('./hw/hwStore')]).then(([b, h]) => b.probe().then((c) => { h.useHW.getState().setCaps(c); return c })).then((c) => live && setT(`This device · ${c.gpu.available && !c.gpu.software ? 'WebGPU' : 'WebAssembly (slower)'}${mem(c.deviceMemoryGB)}`)).catch(() => live && setT(guess()))
    return () => { live = false }
  }, [])
  return t
}

/** Model picker fallback: the old link box and example chips, until the picker fills the slot. */
function PickerFallback() {
  const s = useStore()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  useEffect(() => { if (s.repo) setText(s.repo) }, [s.repo])
  return (
    <div className="pickfb">
      <button className="btn2 pickbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Pick a model"><span className="pickname">{s.repo.split('/').pop() || 'Pick a model'}</span><Ico d={CHEV} /></button>
      {open && (
        <div className="pop" role="group" aria-label="Pick a model">
          <form className="urlform" onSubmit={(e) => { e.preventDefault(); s.loadModel(text); setOpen(false) }}>
            <label className="sr" htmlFor="repo">Hugging Face model URL</label>
            <span className="host">huggingface.co/</span>
            <input id="repo" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="org/model" />
            <button className="btn" type="submit" disabled={s.probing}>{s.probing ? 'Reading…' : 'Load'}</button>
          </form>
          <div className="chips" role="group" aria-label="Examples">
            {s.examples.map((e) => (
              <button key={e.id} className="chip" aria-pressed={s.repo.toLowerCase() === e.repo.toLowerCase()} onClick={() => { s.loadExample(e.id); setOpen(false) }}>{e.title}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TopBar({ view }: { view: AppView }) {
  const device = useDevice()
  return (
    <header className="topbar">
      <div className="brand"><span className="logo" aria-hidden /><span className="brandname">Neural Studio</span></div>
      <div id="model-picker-slot"><PickerFallback /></div>
      <nav className="seg" aria-label="Sections">
        {SECTIONS.map((x) => (
          <button key={x.id} className={view === x.id ? 'on' : ''} aria-current={view === x.id ? 'true' : undefined} onClick={() => jumpTo(x.id)} title={x.tip}>
            {x.label}{x.id === 'power' && <span className="livedot" aria-hidden />}
          </button>
        ))}
      </nav>
      <span className="grow" />
      <span className="tag devchip">{device}</span>
      <span className="tag privchip"><Ico d={SHIELD} /><span className="privtxt">Runs on your device · nothing uploaded</span>
        <Hint label="About privacy">Your prompts and files stay in this tab. Only model files are downloaded.</Hint></span>
    </header>
  )
}

/** Default dock: the prompt and Run. S5 and S6 fill #dock-slot with Test all, progress and Cancel. */
function Dock() {
  const s = useStore()
  return (
    <footer className="dock">
      <div id="dock-slot">
        <form className="dockform" onSubmit={(e) => { e.preventDefault(); runAll() }}>
          <label className="sr" htmlFor="sharedprompt">Prompt</label>
          <input id="sharedprompt" className="dockprompt" value={s.prompt} onChange={(e) => s.setPrompt(e.target.value)} spellCheck={false} disabled={s.mode === 'replay'} title={s.mode === 'replay' ? 'Recorded run. Start the companion to type your own prompt.' : 'The same prompt drives the model and the machine'} />
          <button className="btn primary" type="submit" disabled={!canRun(s)}>{s.running ? <><span className="spin" aria-hidden />Running</> : <><Ico d={PLAY} fill />Run</>}</button>
        </form>
        {s.runStatus && <span className="dockstat mono" role="status">{s.runStatus}</span>}
      </div>
    </footer>
  )
}

/** One sentence and one button. Used when a part fails to load. */
export function ErrorBox({ message, action = 'Try again', onAction }: { message: string; action?: string; onAction: () => void }) {
  return <div className="errbox" role="alert"><p>{message}</p><button className="btn" onClick={onAction}>{action}</button></div>
}
class Guard extends Component<{ children: React.ReactNode }, { err: boolean }> {
  state = { err: false }
  static getDerivedStateFromError() { return { err: true } }
  render() { return this.state.err ? <ErrorBox message="This part did not load. Check your connection, then try again." onAction={() => this.setState({ err: false })} /> : this.props.children }
}

function OfflineStrip() {
  const [on, setOn] = useState(typeof navigator === 'undefined' || navigator.onLine)
  useEffect(() => { const f = () => setOn(navigator.onLine); addEventListener('online', f); addEventListener('offline', f); return () => { removeEventListener('online', f); removeEventListener('offline', f) } }, [])
  return on ? null : <div className="offline-strip" role="status">You are offline. Models you already loaded still run.</div>
}

/** Bottom sheet: below 960 px the rail is a sheet. Drag its handle, or tap it, to snap between peek, half and full. */
function useSheet() {
  useEffect(() => {
    const snaps = [25, 55, 82]
    let drag: { el: HTMLElement; y0: number; h0: number; moved: boolean } | null = null
    const down = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest?.('.rail, .inspector') as HTMLElement | null
      if (!el || getComputedStyle(el).position !== 'sticky' || e.clientY - el.getBoundingClientRect().top > 30) return
      drag = { el, y0: e.clientY, h0: el.offsetHeight, moved: false }
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag) return
      if (Math.abs(e.clientY - drag.y0) > 4) drag.moved = true
      if (drag.moved) drag.el.style.setProperty('--sheet', `${Math.max(120, Math.min(innerHeight * 0.85, drag.h0 + drag.y0 - e.clientY))}px`)
    }
    const up = () => {
      if (!drag) return
      const { el, moved } = drag; drag = null
      const cur = el.offsetHeight
      const px = snaps.map((v) => (v * innerHeight) / 100)
      let i = px.reduce((b, v, k) => (Math.abs(v - cur) < Math.abs(px[b] - cur) ? k : b), 0)
      if (!moved) i = (i + 1) % snaps.length
      const apply = () => el.style.setProperty('--sheet', `${snaps[i]}dvh`)
      const vt = (document as any).startViewTransition
      if (vt && !matchMedia('(prefers-reduced-motion: reduce)').matches) vt.call(document, apply); else apply()
    }
    document.addEventListener('pointerdown', down); document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up) }
  }, [])
}

/** Watches the sections: which ones are on screen (only those draw their 3D), which one the page is at, and which
 *  are close enough to load their code. */
function useSections(flow: React.RefObject<HTMLDivElement | null>) {
  const [seen, setSeen] = useState<Record<AppView, boolean>>({ model: true, journey: false, power: false, zoo: false })
  useEffect(() => {
    const root = flow.current
    if (!root) return
    // the page itself scrolls (the top bar and dock are sticky)
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
  const probeRes = useStore((s) => s.probe)
  const layers = useStore((s) => s.layers.length)
  const view = useStore((s) => s.appView)
  const flow = useRef<HTMLDivElement>(null)
  const seen = useSections(flow)
  useSheet()
  // every model opens already run on the shared prompt, so the animations have something real to show
  const autoRan = useRef('')
  useEffect(() => { const s = useStore.getState(); if (canRun(s) && !layers && !s.running && autoRan.current !== s.repo) { autoRan.current = s.repo; s.run({ auto: true }) } }, [probeRes, layers])
  useEffect(() => { init() }, [init])
  // a link such as /#power opens at that section (the old #journey link opens the merged Machine section)
  useEffect(() => { const first = useStore.getState().appView; if (first !== 'model') requestAnimationFrame(() => jumpTo(first === 'journey' ? 'power' : first, false)) }, [])
  useEffect(() => { try { history.replaceState(null, '', view === 'model' ? location.pathname + location.search : `${location.search}#${view}`) } catch { /* ignore */ } }, [view])
  return (
    <div className="app">
      <TopBar view={view} />
      <OfflineStrip />
      <div className="flow" ref={flow}>
        <Guard>
          <Sect id="model" label="The model on your prompt">{seen.model ? <Suspense fallback={<Loading />}><ZooView /></Suspense> : <Loading />}</Sect>
          <Sect id="power" label="The machine: live electricity and the journey of a prompt">{seen.power ? <Suspense fallback={<Loading />}><MachineView /></Suspense> : <Loading />}</Sect>
        </Guard>
      </div>
      <Dock />
    </div>
  )
}
