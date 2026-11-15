import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { canRun, jumpLocked, jumpTo, useStore, type AppView } from './store'
import { BoardHost, BoardOptOut } from './board'
// Each view loads its own code on first use, so the first page needs only what it shows.
// the hint bubble lives in a lazy chunk so the first page does not pay for it
const HintLazy = lazy(() => import('./ui/charts').then((m) => ({ default: m.Hint })))
const Hint = (p: { label?: string; children: React.ReactNode }) => <Suspense fallback={null}><HintLazy {...p} /></Suspense>
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
const SUN = 'M12 7a5 5 0 100 10 5 5 0 000-10zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'
const MOON = 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z', SCREEN = 'M3 5h18v11H3zM8 20h8M12 16v4'
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

/** System / Light / Dark. Sets data-theme (System removes it), with a View Transition when the browser has one. */
function useThemeApply() {
  const theme = useStore((s) => s.theme)
  useEffect(() => {
    const el = document.documentElement
    const apply = () => { if (theme === 'system') delete el.dataset.theme; else el.dataset.theme = theme }
    const vt = (document as any).startViewTransition
    if (vt && !matchMedia('(prefers-reduced-motion: reduce)').matches && el.dataset.theme !== (theme === 'system' ? undefined : theme)) vt.call(document, apply); else apply()
  }, [theme])
}
function ThemeToggle() {
  const theme = useStore((s) => s.theme), set = useStore((s) => s.setTheme)
  const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const label = theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'
  return <button className="btn2 themebtn" data-theme-toggle onClick={() => set(next)} aria-label={`Theme: ${label}. Switch to ${next}.`} title={`Theme: ${label}`}><Ico d={theme === 'light' ? SUN : theme === 'dark' ? MOON : SCREEN} /><span className="themelbl">{label}</span></button>
}

/** Four small steps on the name card: what the page does, in plain words. Icons are inline SVG with the brand gradient. */
const HOW: { t: string; d: string; icon: string }[] = [
  { t: 'Get a model', d: 'It comes from Hugging Face and runs on your device.', icon: 'M4 5h16v10H4zM2 19h20M12 2v7M9 6l3 3 3-3' },
  { t: 'Watch it think', d: 'Your prompt flows through the 3D blocks.', icon: 'M3 8l5-3 5 3v6l-5 3-5-3zM11 10l5-3 5 3v6l-5 3-5-3z' },
  { t: 'See the power', d: 'Electricity moves through CPU, GPU and RAM.', icon: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  { t: 'Get your score', d: 'Test all gives you a score card.', icon: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4' },
]
function HowItWorks() {
  return (
    <ol className="howto" aria-label="How it works">
      <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}><defs><linearGradient id="ns-howg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9a82ff" /><stop offset=".55" stopColor="#3ddcf5" /><stop offset="1" stopColor="#ff8fc4" /></linearGradient></defs></svg>
      {HOW.map((h, i) => (
        <li key={h.t} style={{ animationDelay: `${120 + i * 90}ms` }}>
          <span className="howicon" aria-hidden><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="url(#ns-howg)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={h.icon} /></svg><b>{i + 1}</b></span>
          <span className="howtxt"><strong>{h.t}</strong><span>{h.d}</span></span>
        </li>
      ))}
    </ol>
  )
}

/** First visit: ask for a name. It goes on the score card and, after Test all, on the public leaderboard (unless the
 *  visitor ticks "Keep me off the leaderboard"). Enter continues; "Use Guest" skips. */
function NameCard() {
  const name = useStore((s) => s.name), setName = useStore((s) => s.setName)
  const [v, setV] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [name])
  if (name) return null
  return (
    <div className="namewall" data-namecard>
      <form className="namecard card" role="dialog" aria-modal="true" aria-labelledby="nm-t" onSubmit={(e) => { e.preventDefault(); if (v.trim()) setName(v) }}>
        <div className="namefields">
          <h3 id="nm-t">What is your name?<Hint label="About your name">It goes on your score card. After Test all, your name and score go on the public leaderboard.</Hint></h3>
          <input ref={ref} className="dockprompt" value={v} onChange={(e) => setV(e.target.value)} maxLength={24} autoComplete="given-name" aria-label="Your name" placeholder="Your name" />
          <p className="namenote" data-board-note>Your name and score go on a public leaderboard.</p>
          <BoardOptOut />
          <div className="namerow"><button className="btn primary" type="submit" disabled={!v.trim()}>Continue</button><button type="button" className="t5link" onClick={() => setName('Guest')}>Use Guest</button></div>
        </div>
        <HowItWorks />
      </form>
    </div>
  )
}
/** The name in the top bar, with a small menu to change it. */
function NameChip() {
  const name = useStore((s) => s.name), setName = useStore((s) => s.setName)
  const [open, setOpen] = useState(false)
  const [v, setV] = useState('')
  if (!name) return null
  return (
    <span className="namechip">
      <button className="btn2" aria-expanded={open} onClick={() => { setV(name); setOpen((o) => !o) }} title="Change your name"><span className="pickname">{name}</span></button>
      {open && <form className="pop namepop" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { setName(v); setOpen(false) } }}>
        <input className="dockprompt" value={v} onChange={(e) => setV(e.target.value)} maxLength={40} aria-label="Your name" autoFocus />
        <button className="btn" type="submit">Save</button></form>}
    </span>
  )
}

/** "Saved on this device: 82 MB · Clear", shown when the privacy hint is open. */
function SavedLine() {
  const [i, setI] = useState<{ bytes: number; persisted: boolean | null } | null>(null)
  const load = () => useStore.getState().savedInfo().then(setI).catch(() => setI({ bytes: 0, persisted: null }))
  useEffect(() => { void load() }, [])
  if (!i) return null
  const mb = i.bytes / 1048576
  return <span className="savedline">{i.bytes ? <>Saved on this device: {mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB · <button type="button" className="t5link" onClick={() => void useStore.getState().clear().then(load)}>Clear</button></> : 'Nothing saved on this device yet.'}</span>
}

function TopBar({ view }: { view: AppView }) {
  const device = useDevice()
  return (
    <header className="topbar">
      <div className="brand"><span className="logo" aria-hidden /><span className="brandname">Kundali</span></div>
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
      <ThemeToggle />
      <NameChip />
      <span className="tag privchip"><Ico d={SHIELD} /><span className="privtxt">Runs on your device</span>
        <Hint label="About privacy">Your prompts and files stay in this tab. Only model files are downloaded. After Test all, your name and score go on the public leaderboard, unless you chose to stay off it. <SavedLine /></Hint></span>
    </header>
  )
}

/** Narrow only: the Details bar sits right above the dock. It comes early in the DOM (so its toggle is the first one reached)
 *  and is placed last on screen by CSS order. It opens the drawer of the section in view. */
function DetailsBar() {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 999px)').matches)
  useEffect(() => { const m = matchMedia('(max-width: 999px)'), f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  const which = useStore((x) => (x.appView === 'power' ? 'machine' : 'model'))
  const open = useStore((x) => x.railOpen[which])
  const setRail = useStore((x) => x.setRail)
  if (!narrow) return null
  return <button className="drawer-tab dock-details" data-drawer-toggle aria-expanded={open} onClick={() => setRail(which, !open)}>{open ? 'Close' : 'Details'}</button>
}

/** Default dock: the prompt and Run. S5 and S6 fill #dock-slot with Test all, progress and Cancel. */
function Dock() {
  const s = useStore()
  const ref = useRef<HTMLElement>(null)
  // measure the dock (it grows with strips; narrow, the 44 px Details bar sits right above it) and share the height with the layout
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // only when narrow: wide, the dock keeps its fixed height and strips float above it, so nothing shifts
    const narrow = matchMedia('(max-width: 999px)')
    const ro = new ResizeObserver(() => { if (narrow.matches) { const h = Math.ceil(el.getBoundingClientRect().height), st = document.documentElement.style; st.setProperty('--dock-core', `${h}px`); st.setProperty('--dock-h', `${h + 44}px`) } else { const st = document.documentElement.style; st.removeProperty('--dock-core'); st.removeProperty('--dock-h') } })
    narrow.addEventListener('change', () => { ro.disconnect(); ro.observe(el) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <footer className="dock" data-dock ref={ref}>
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
  return <div className="errbox" role="alert" data-error><p>{message}</p><button className="btn" onClick={onAction}>{action}</button></div>
}
class Guard extends Component<{ children: React.ReactNode }, { err: boolean }> {
  state = { err: false }
  static getDerivedStateFromError() { return { err: true } }
  render() { return this.state.err ? <ErrorBox message="This part did not load. Check your connection, then try again." onAction={() => this.setState({ err: false })} /> : this.props.children }
}

/** "New version · Reload": shown when a new service worker is waiting. */
function UpdateStrip() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null)
  useEffect(() => { const f = (e: Event) => setReg((e as CustomEvent).detail); addEventListener('ns-sw-update', f); return () => removeEventListener('ns-sw-update', f) }, [])
  if (!reg) return null
  return <div className="offline-strip update-strip" role="status">New version <button className="t5link" onClick={() => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload()); reg.waiting?.postMessage('skip') }}>Reload</button></div>
}

function OfflineStrip() {
  const [on, setOn] = useState(typeof navigator === 'undefined' || navigator.onLine)
  useEffect(() => { const f = () => setOn(navigator.onLine); addEventListener('online', f); addEventListener('offline', f); return () => { removeEventListener('online', f); removeEventListener('offline', f) } }, [])
  return on ? null : <div className="offline-strip" role="status" data-error>You are offline. Saved models still run. <button className="t5link" onClick={() => { void useStore.getState().autoStart() }}>Try again</button></div>
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

const RAIL = { model: 'model', power: 'machine' } as const
const Sect = ({ id, label, children }: { id: 'model' | 'power'; label: string; children: React.ReactNode }) => {
  const open = useStore((s) => s.railOpen[RAIL[id]])
  const setRail = useStore((s) => s.setRail)
  return (
    <div id={`sec-${id}`} data-sec={id} data-rail={open ? 'open' : 'closed'} className="sect" role="region" aria-label={label}>
      {children}
      <button className="drawer-tab" data-drawer-toggle aria-expanded={open} onClick={() => setRail(RAIL[id], !open)}>{open ? 'Close' : 'Details'}</button>
    </div>
  )
}

/** Esc, or a click outside the drawer, closes the open drawers. Machine details follow the drawer. */
function useDrawers() {
  useEffect(() => { try { if (localStorage.getItem('ns.machine.details') === null) useStore.getState().setDetails(false) } catch { /* private mode */ } }, [])
  useEffect(() => {
    const close = () => { const s = useStore.getState(); (['model', 'machine'] as const).forEach((k) => s.railOpen[k] && s.setRail(k, false)) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.rail, .inspector, .drawer-tab, .hintpop, .pop')) close() }
    addEventListener('keydown', key); document.addEventListener('pointerdown', down)
    return () => { removeEventListener('keydown', key); document.removeEventListener('pointerdown', down) }
  }, [])
  // the inspector opens the Model drawer by itself when something is selected, and closes it when cleared
  useEffect(() => {
    let off = () => {}
    import('./zoo/zooStore').then((m) => { off = m.useZoo.subscribe((z, p) => { if (!!z.inspect !== !!p.inspect) useStore.getState().setRail('model', !!z.inspect) }) })
    return () => off()
  }, [])
  // the Machine view has its own details switch: keep it and the drawer in step
  const open = useStore((s) => s.railOpen.machine), details = useStore((s) => s.details)
  useEffect(() => { if (useStore.getState().details !== open) useStore.getState().setDetails(open) }, [open])
  useEffect(() => { if (useStore.getState().railOpen.machine !== details) useStore.getState().setRail('machine', details) }, [details])
}

export default function App() {
  const init = useStore((s) => s.init)
  const probeRes = useStore((s) => s.probe)
  const layers = useStore((s) => s.layers.length)
  const view = useStore((s) => s.appView)
  const flow = useRef<HTMLDivElement>(null)
  const seen = useSections(flow)
  useSheet()
  useThemeApply()
  useDrawers()
  // stage and rail are the side-by-side panels: mark them so tests and styles can find them
  useEffect(() => {
    const mark = () => document.querySelectorAll('.main > .stage, .main > .rail, .main > .inspector').forEach((e) => { e.setAttribute('data-panel', ''); if (!e.matches('.stage')) e.setAttribute('data-drawer', '') })
    mark()
    const mo = new MutationObserver(mark)
    mo.observe(flow.current!, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])
  // the default model downloads by itself and runs when ready (no click); the recorded run plays meanwhile
  useEffect(() => { init(); void useStore.getState().autoStart() }, [init])
  // a link such as /#power opens at that section (the old #journey link opens the merged Machine section)
  useEffect(() => { const first = useStore.getState().appView; if (first !== 'model') requestAnimationFrame(() => jumpTo(first === 'journey' ? 'power' : first, false)) }, [])
  useEffect(() => { try { history.replaceState(null, '', view === 'model' ? location.pathname + location.search : `${location.search}#${view}`) } catch { /* ignore */ } }, [view])
  return (
    <div className="app">
      <TopBar view={view} />
      <OfflineStrip />
      <UpdateStrip />
      <DetailsBar />
      <div className="flow" ref={flow}>
        <div id="score-strip-slot" data-score-strip />
        <Guard><div className="pair">
          <Sect id="model" label="The model on your prompt">{seen.model ? <Suspense fallback={<Loading />}><ZooView /></Suspense> : <Loading />}</Sect>
          <Sect id="power" label="The machine: live electricity and the journey of a prompt">{seen.power ? <Suspense fallback={<Loading />}><MachineView /></Suspense> : <Loading />}</Sect>
        </div></Guard>
      </div>
      <Dock />
      <NameCard />
      <BoardHost />
    </div>
  )
}
