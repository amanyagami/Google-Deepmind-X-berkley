import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { ZooScene } from './ZooScene'
import { FLOPS, LAYER_LEGEND, VERDICT_WORD, VLM_MAX_WORDS, vlmWords, etaSecs, checkInput, crumbs, fmtBytes, fmtEta, groupByTask, readCheck, readDigit, smallerSuggestion, startLabel, consensus, inkTo8x8, LANGS, langPrompt, isMultilingual, type LangId } from './nets'
import { locateZ, NETS, STAGES, totalZ, useZoo, type CatRow, type DigitNet, type NetId } from './zooStore'
import * as engine from '../api'
import type { Task, TaskInput } from '../api'
import { useStore } from '../store'
import { CalcPanel, EditPanel, LayerPanel } from '../ui/panels'
import { ModelRunFacts } from '../hw/modelRun'
import { Explainer, Hint, Inspector, Peek, TopBars, showTok } from '../ui/charts'

const f = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v))

/* ------------------------------------------------------------------------------- drawing pad */
const PAD = 280, BRUSH = 8
type Pt = { x: number; y: number }
/** The pad's "try a digit", reachable from the dock (the pad lives in the rail and stays mounted on the net tabs). */
const PAD_API: { pick: ((d: number) => void) | null } = { pick: null }
let nextDigit = 1

/** The 8 by 8 picture the network sees, drawn straight from the store (no React render per stroke). */
function MiniInput() {
  const cv = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = cv.current?.getContext('2d')
    if (!c) return
    const data = c.createImageData(8, 8)   // reused for every redraw
    const draw = (img: number[]) => {
      const ink = getComputedStyle(cv.current!).color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [230, 235, 255]
      for (let i = 0; i < 64; i++) { data.data[i * 4] = ink[0]; data.data[i * 4 + 1] = ink[1]; data.data[i * 4 + 2] = ink[2]; data.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, img[i] ?? 0)) * 255) }
      c.putImageData(data, 0, 0)
    }
    draw(useZoo.getState().img)
    const off = useZoo.subscribe((s, p) => { if (s.img !== p.img) draw(s.img) })
    const mo = new MutationObserver(() => draw(useZoo.getState().img))   // theme switch changes the ink
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { off(); mo.disconnect() }
  }, [])
  return <canvas ref={cv} className="s6mini" width={8} height={8} data-mini-input aria-label="The 8 by 8 picture the network sees" role="img" />
}

/** One big square pad: thick smooth strokes (mouse, touch, pen), live guesses from all five networks, Clear, Undo, 0 to 9. */
function DrawPad() {
  const readsAll = useZoo((s) => s.reads)
  const cv = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Pt[][]>([])
  const live = useRef<Pt[] | null>(null)
  const sample = useRef<number[] | null>(useZoo.getState().label !== null ? useZoo.getState().base : null)
  const raf = useRef(0)
  const [inked, setInked] = useState(!!sample.current)
  const [nStrokes, setN] = useState(0)
  const ctx = () => cv.current!.getContext('2d', { willReadFrequently: true })!
  const line = (c: CanvasRenderingContext2D, pts: Pt[]) => {
    c.beginPath(); c.moveTo(pts[0].x, pts[0].y)
    if (pts.length === 1) c.lineTo(pts[0].x + 0.01, pts[0].y)
    for (let i = 1; i < pts.length; i++) c.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, (pts[i - 1].x + pts[i].x) / 2, (pts[i - 1].y + pts[i].y) / 2)
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y); c.stroke()
  }
  const redraw = () => {
    const c = ctx(), ink = getComputedStyle(cv.current!).color
    c.clearRect(0, 0, PAD, PAD); c.fillStyle = ink; c.strokeStyle = ink; c.lineWidth = BRUSH * 2; c.lineCap = 'round'; c.lineJoin = 'round'
    if (sample.current) { const k = PAD / 8; sample.current.forEach((v, i) => { c.globalAlpha = Math.min(1, v); c.fillRect((i % 8) * k, Math.floor(i / 8) * k, k + 0.5, k + 0.5) }); c.globalAlpha = 1 }
    for (const st of strokes.current) line(c, st)
    if (live.current) line(c, live.current)
  }
  /** Read the pad, centre it like MNIST, and hand the 8 by 8 picture to the networks: at most once per frame. */
  const commit = () => {
    raf.current = 0
    const d = ctx().getImageData(0, 0, PAD, PAD).data, ink = new Float32Array(PAD * PAD)
    for (let i = 0; i < ink.length; i++) ink[i] = d[i * 4 + 3] / 255
    useZoo.getState().setImg(inkTo8x8(ink, PAD), null)
    setInked(strokes.current.length > 0 || !!live.current || !!sample.current)
    setN(strokes.current.length)
  }
  const later = () => { redraw(); if (!raf.current) raf.current = requestAnimationFrame(commit) }
  useEffect(() => {
    redraw()
    PAD_API.pick = (d) => pick(d)
    // on a phone the rail is a bottom sheet: open it so the whole pad shows
    if (matchMedia('(max-width: 959px)').matches) document.querySelector<HTMLElement>('.inspector')?.style.setProperty('--sheet', '84dvh')
    return () => { cancelAnimationFrame(raf.current); PAD_API.pick = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const at = (e: { clientX: number; clientY: number }): Pt => { const r = cv.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * PAD, y: ((e.clientY - r.top) / r.height) * PAD } }
  const clear = () => { strokes.current = []; live.current = null; sample.current = null; later() }
  const undo = () => { if (strokes.current.length) { strokes.current.pop(); later() } }
  const pick = (d: number) => {
    const digits = useZoo.getState().digits
    const k = digits ? digits.labels.findIndex((l) => l === d) : -1
    if (k < 0 || !digits) return
    strokes.current = []; live.current = null; sample.current = digits.images[k]; later()
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest?.('input,textarea,select,[contenteditable]')) return
      if (e.key === 'c' || e.key === 'C') clear(); else if (e.key === 'z' || e.key === 'Z') undo()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const end = () => { if (live.current) { strokes.current.push(live.current); live.current = null; later() } }
  const reads = NETS.every((n) => readsAll[n.id]) ? NETS.map((n) => ({ id: n.id, r: readsAll[n.id]! })) : null
  const verdict = useMemo(() => (reads && inked ? consensus(reads.map((x) => x.r)) : null), [readsAll, inked]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="s6padwrap" data-pad-wrap>
      <div className="s6pad">
        <canvas ref={cv} data-pad width={PAD} height={PAD} aria-label="Draw a number here" role="img" style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return
            e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId)
            if (sample.current) { sample.current = null; strokes.current = [] }   // drawing over a sample digit starts fresh
            live.current = [at(e)]; later()
          }}
          onPointerMove={(e) => { if (!live.current) return; const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? []; for (const q of evs.length ? evs : [e.nativeEvent]) live.current.push(at(q)); later() }}
          onPointerUp={end} onPointerCancel={end} />
        {!inked && <div className="s6guide" aria-hidden><i /><span>Draw a number</span></div>}
      </div>
      <div className="s6row">
        <button className="btn2" data-pad-clear onClick={clear} title="Clear (C)">Clear</button>
        <button className="btn2" data-pad-undo onClick={undo} disabled={!nStrokes} title="Undo the last stroke (Z)">Undo</button>
        <span className="s6line">Try a digit</span>
      </div>
      <div className="s6chips" role="group" aria-label="Try a digit">{Array.from({ length: 10 }, (_, d) => <button key={d} className="btn2" onClick={() => pick(d)}>{d}</button>)}</div>
      <div className="s6see" aria-live="polite">
        {verdict ? (
          <>
            <p className="s6big" data-pad-result>I see a <b>{verdict.top}</b> · {pct(verdict.pct)}</p>
            {verdict.second !== null && verdict.pct2 >= 0.05 && <p className="s6line">or a {verdict.second} · {pct(verdict.pct2)}</p>}
          </>
        ) : <p className="s6line">Draw, or pick a digit. Five networks read it as you draw.</p>}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------------- outputs */
/** The real model that matches a tiny net, run in the page on the same picture. Always computed just now: no recording. */
function RealCard() {
  const r = useZoo(useShallow((s) => s.real))
  const net = useZoo((s) => s.net)
  if ((net !== 'vit' && net !== 'vlm') || r.net !== net) return null
  const kind = net === 'vit' ? 'picture model' : 'vision-language model'
  return (
    <div className="ccard" data-real-card data-real-state={r.state}>
      <h4>The real {kind} <small>{r.title}{r.size ? `, ${r.size}` : ''}</small></h4>
      {r.state === 'ask' && (
        <>
          <p className="s6line">The tiny model below is a teaching model. Real vision-language models start near 190 MB.</p>
          <button className="btn2" data-real-run onClick={() => useZoo.getState().runReal(true)}>Tap to run the real one</button>
        </>
      )}
      {r.state === 'idle' && <p className="s6line">Draw a number or pick a digit, and the real model looks at it too.</p>}
      {r.state === 'running' && <p className="s6line" role="status">{r.dl != null ? `Downloading the real model, ${Math.round(r.dl * 100)}%.` : 'The real model is looking at your picture.'}{net === 'vlm' && r.text ? ` “${r.text}”` : ''}</p>}
      {r.state === 'ok' && net === 'vit' && <TopBars items={r.items.slice(0, 3).map((x) => ({ token: x.token.split(',')[0], p: x.p }))} max={Math.max(1e-6, ...r.items.map((x) => x.p))} />}
      {r.state === 'ok' && net === 'vlm' && <p className="caption-out">“{r.text}”</p>}
      {r.state === 'ok' && <p className="s6line" data-real-live>Live, computed just now on {r.device === 'webgpu' ? 'your GPU' : 'your CPU'}{r.ms != null ? ` in ${Math.round(r.ms)} ms` : ''}. It was not trained on handwritten digits, so it may name an everyday object.</p>}
      {(r.state === 'err' || r.state === 'off') && <p className="s6line" role="alert">{r.err}</p>}
    </div>
  )
}

const TINY = <p className="s6line" data-tiny-note>A tiny teaching net trained on digits. It computes live in this page from its real weights, with no recorded data.</p>
function Output() {
  const { net, out, label, pack } = useZoo(useShallow((s) => ({ net: s.net, out: s.out, label: s.label, pack: s.packs[s.net] })))
  if (!out || !pack) return null
  if (net === 'vlm') {
    const words: string[] = out.ids.slice(1).map((i: number) => pack.vocab![i]).filter((w: string) => w !== '<eos>')
    const given = out.given ?? 0
    const add = (w: string) => { const z = useZoo.getState(); z.setWords(`${z.words.trim()} ${w}`.trim()) }
    return (
      <>
      <RealCard />
      <div className="ccard">
        <h4>Answer <small>your words, then the model's</small></h4>
        {TINY}
        <p className="caption-out">“{words.map((w, i) => <span key={i}>{i && w !== ',' ? ' ' : ''}{i < given ? <b className="s6mine">{w}</b> : w}</span>)}”</p>
        <p className="s6line">Words it knows. Tap to add one (up to {VLM_MAX_WORDS}).</p>
        <div className="s6chips s6vocab" role="group" aria-label="Words it knows">
          {pack.vocab!.slice(2).map((w) => <button key={w} className="btn2" onClick={() => add(w)}>{w}</button>)}
          <button className="btn2" onClick={() => useZoo.getState().setWords('')}>Clear</button>
        </div>
        <p className="small mono">{label !== null ? `the test image is a ${label}` : 'your drawing'}<Hint>Each word is chosen from {pack.vocab!.length} possible words, given the image tokens and the words written so far.</Hint></p>
      </div>
      </>
    )
  }
  const best = out.probs.indexOf(Math.max(...out.probs))
  return (
    <>
    <RealCard />
    <div className="ccard">
      <h4>Prediction <small>{label !== null ? `the test image is a ${label}` : 'your drawing'}</small></h4>
      <div className="probs">{out.probs.map((p: number, i: number) => <div key={i} className={i === best ? 'on' : ''}><i style={{ height: `${Math.max(2, p * 100)}%` }} /><span>{i}</span></div>)}</div>
      <p className="small mono">{best} · {pct(out.probs[best])} sure</p>
      {TINY}
    </div>
    </>
  )
}

/* ------------------------------------------------------------------------- calculation card */
function terms(W: { shape: number[]; data: number[] }, row: number, x: number[], k = 6) {
  const n = W.shape[1]
  const t = x.map((v, i) => ({ i, w: W.data[row * n + i], x: v, p: W.data[row * n + i] * v })).filter((q) => q.x !== 0)
  t.sort((a, b) => Math.abs(b.p) - Math.abs(a.p))
  return { top: t.slice(0, k), rest: t.slice(k).reduce((a, q) => a + q.p, 0), nRest: Math.max(0, t.length - k), zeros: n - t.length }
}

function DotCard({ title, T, bias, z, act, note }: { title: string; T: ReturnType<typeof terms>; bias: number; z: number; act?: [string, number]; note?: string }) {
  return (
    <>
      <h4>{title}</h4>
      <table className="optab mono"><thead><tr><th>input</th><th>value</th><th>× weight</th><th>=</th></tr></thead>
        <tbody>{T.top.map((q) => <tr key={q.i}><td>#{q.i}</td><td>{f(q.x)}</td><td>{f(q.w)}</td><td className={q.p < 0 ? 'neg' : 'pos'}>{f(q.p)}</td></tr>)}
          {T.nRest > 0 && <tr><td colSpan={3}>{T.nRest} smaller terms</td><td>{f(T.rest)}</td></tr>}
          <tr><td colSpan={3}>bias</td><td>{f(bias)}</td></tr></tbody></table>
      <p className="mono res">sum = <b>{f(z)}</b>{act ? <> → {act[0]} → <b>{f(act[1])}</b></> : null}</p>
      {(T.zeros > 0 || note) && <Hint>{T.zeros > 0 ? `${T.zeros} inputs were exactly 0 and add nothing. ` : ''}{note}</Hint>}
    </>
  )
}

function CalcCard() {
  const { net, out, pack, sel } = useZoo(useShallow((s) => ({ net: s.net, out: s.out, pack: s.packs[s.net], sel: s.sel })))
  if (!out || !pack) return null
  if (!sel) return <div className="ccard"><h4>How is a number computed?<Hint>Double-click any neuron, cell or token in the 3D view to see the arithmetic behind it, with the real numbers.</Hint></h4></div>
  const w = pack.weights
  let body: any = <p className="mono small">input pixel = {f(out.input?.[sel.index] ?? 0)}<Hint>The brightness of that pixel, 0 to 1.</Hint></p>
  if (net === 'mlp' && (sel.layer === 'h1' || sel.layer === 'h2')) {
    const L = sel.layer === 'h1' ? 'fc1' : 'fc2', x = sel.layer === 'h1' ? out.input : out.h1, z = (sel.layer === 'h1' ? out.z1 : out.z2)[sel.index]
    body = <DotCard title={`Neuron ${sel.index} of ${sel.layer === 'h1' ? 'hidden layer 1' : 'hidden layer 2'}`} T={terms(w[`${L}.weight`], sel.index, x)} bias={w[`${L}.bias`].data[sel.index]} z={z} act={['ReLU (negative becomes 0)', Math.max(0, z)]} />
  } else if (net === 'cnn' && (sel.layer === 'conv1' || sel.layer === 'conv2')) {
    const n = sel.layer === 'conv1' ? 8 : 4, cin = sel.layer === 'conv1' ? 1 : 8, src = sel.layer === 'conv1' ? out.input : out.pool1
    const m = Math.floor(sel.index / (n * n)), y = Math.floor((sel.index % (n * n)) / n), x = sel.index % n
    const K = w[`${sel.layer === 'conv1' ? 'c1' : 'c2'}.weight`].data, b = w[`${sel.layer === 'conv1' ? 'c1' : 'c2'}.bias`].data[m]
    const per: number[] = []
    for (let c = 0; c < cin; c++) { let s = 0; for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) { const iy = y + ky - 1, ix = x + kx - 1; if (iy >= 0 && ix >= 0 && iy < n && ix < n) s += K[((m * cin + c) * 3 + ky) * 3 + kx] * src[(c * n + iy) * n + ix] } per.push(s) }
    const z = per.reduce((a, v) => a + v, 0) + b
    body = (
      <>
        <h4>Filter {m}, position ({x}, {y})</h4>
        {cin === 1 ? (
          <div className="kgrid mono">{Array.from({ length: 9 }, (_, k) => { const iy = y + Math.floor(k / 3) - 1, ix = x + (k % 3) - 1; const v = iy >= 0 && ix >= 0 && iy < 8 && ix < 8 ? src[iy * 8 + ix] : 0; const kw = K[(m * 9) + k]; return <div key={k}><span>{f(v, 2)}</span><b className={kw < 0 ? 'neg' : 'pos'}>×{f(kw, 2)}</b></div> })}</div>
        ) : <p className="mono small">{per.map((v, c) => `map ${c}: ${f(v)}`).join(' · ')}</p>}
        <p className="mono res">sum {cin > 1 ? 'over 8 maps × 9 weights' : 'of 9 products'} + bias {f(b)} = <b>{f(z)}</b> → ReLU → <b>{f(Math.max(0, z))}</b></p>
        <Hint>The same 3×3 filter slides over every position: this map is that one filter's answer everywhere.</Hint>
      </>
    )
  } else if (net === 'rnn' && sel.layer?.startsWith('h')) {
    const t = +sel.layer.slice(1), j = sel.index, g = out.gates[t], hp = t ? out.hidden[t - 1][j] : 0
    body = (
      <>
        <h4>Memory unit {j} after row {t + 1}</h4>
        <ul className="facts mono">
          <li><span>reset gate r</span><b>{f(g.r[j])}</b><Hint>How much of the old memory to use when forming the new candidate.</Hint></li>
          <li><span>update gate z</span><b>{f(g.z[j])}</b><Hint>How much of the old memory to keep.</Hint></li>
          <li><span>candidate n</span><b>{f(g.n[j])}</b><Hint>tanh(new row · weights + r × old memory · weights)</Hint></li>
          <li><span>old memory</span><b>{f(hp)}</b></li>
        </ul>
        <p className="mono res">new = (1 − {f(g.z[j], 2)}) × {f(g.n[j], 2)} + {f(g.z[j], 2)} × {f(hp, 2)} = <b>{f(out.hidden[t][j])}</b></p>
      </>
    )
  } else if (net === 'vit' && (sel.layer === 'tokens' || sel.layer === 'out')) {
    const tok = Math.floor(sel.index / 16)
    const rows = [0, 1].map((h) => out.attn[h][tok].map((a: number, j: number) => ({ j, a })).sort((x: any, y: any) => y.a - x.a).slice(0, 4))
    body = (
      <>
        <h4>{tok === 0 ? 'The summary token' : `Token ${tok} (patch ${tok - 1})`}</h4>
        <Hint>It compares its query with every token's key (dot product ÷ √8), turns the scores into weights with softmax, and takes the weighted average of their values. The arcs show this token's attention; double-click another token to switch.</Hint>
        {rows.map((r: any[], h: number) => <p key={h} className="mono small">head {h + 1}: {r.map((q) => `${q.j === 0 ? 'summary' : 'patch ' + (q.j - 1)} ${(q.a * 100).toFixed(0)}%`).join(' · ')}</p>)}
              </>
    )
  } else if (net === 'vlm') {
    body = <VlmStepCard />
  }
  return <div className="ccard calc">{body}<button className="btn2 sm" onClick={() => useZoo.getState().select(null)}>Close</button></div>
}

function VlmStepCard() {
  const { out, pack, t } = useZoo(useShallow((s) => ({ out: s.out, pack: s.packs.vlm, t: s.t })))
  const st = locateZ('vlm', t)
  const k = st.id === 'write' ? Math.max(0, Math.min(out.steps.length - 1, Math.floor(st.p * out.ids.length) - 1)) : 0
  const step = out.steps[k]
  const top = step.probs.map((p: number, i: number) => ({ p, w: pack!.vocab![i] })).sort((a: any, b: any) => b.p - a.p).slice(0, 5)
  const row = 16 + k
  const img = [0, 1].map((h) => step.attn[h][row].slice(0, 16).reduce((a: number, b: number) => a + b, 0))
  return (
    <>
      <h4>Choosing word {k + 1}: “{pack!.vocab![step.chosen]}”</h4>
      <div className="probs h">{top.map((q: any) => <div key={q.w}><span className="mono">{q.w}</span><i style={{ width: `${q.p * 100}%` }} /><b className="mono">{(q.p * 100).toFixed(1)}%</b></div>)}</div>
      <Hint>While choosing it, head 1 put {(img[0] * 100).toFixed(0)}% and head 2 {(img[1] * 100).toFixed(0)}% of their attention on the image tokens; the rest went to the words already written. Scrub the timeline to watch each word being chosen.</Hint>
    </>
  )
}

/* -------------------------------------------------------------------------------- timeline */
function ZooTimeline() {
  const { net, t, playing, speed } = useZoo(useShallow((s) => ({ net: s.net, t: s.t, playing: s.playing, speed: s.speed })))
  const z = useZoo.getState()
  const track = useRef<HTMLDivElement>(null)
  const T = totalZ(net), cur = locateZ(net, t)
  const seek = (x: number) => { const r = track.current!.getBoundingClientRect(); z.setT(((x - r.left) / r.width) * T) }
  return (
    <div className="tlbar">
      <div className="tlctl">
        <button className="ib big" aria-label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? z.pause() : z.play())}>{playing ? '❚❚' : '▶'}</button>
        <span className="mono tm">{t.toFixed(1)} / {T.toFixed(1)} s</span>
        <select aria-label="Playback speed" value={speed} onChange={(e) => z.setSpeed(+e.target.value)}>{[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
        <span className="hint small">{STAGES[net][cur.i].label}</span>
      </div>
      <div className="tltrack" ref={track} onPointerDown={(e) => { z.pause(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seek(e.clientX) }} onPointerMove={(e) => { if (e.buttons) seek(e.clientX) }}>
        {STAGES[net].map((s, i) => (
          <div key={s.id} className={`tlseg ${i === cur.i ? 'on' : ''} ${i < cur.i ? 'done' : ''}`} style={{ width: `${(s.dur / T) * 100}%` }} title={s.label}>
            <i style={{ width: i < cur.i ? '100%' : i === cur.i ? `${cur.p * 100}%` : '0%' }} /><span>{s.label}</span>
          </div>
        ))}
        <div className="tlrail" style={{ transform: `translateX(${Math.max(0, Math.min(100, (t / T) * 100))}%)` }}><div className="tlhead" /></div>
      </div>
    </div>
  )
}

/** One fixed colour per network (validated categorical palette, dark surface), used everywhere a network is identified. */
export const NET_COLOR: Record<DigitNet, string> = { mlp: '#3987e5', cnn: '#d95926', rnn: '#199e70', vit: '#c98500', vlm: '#d55181' }
const NAME: Record<DigitNet, string> = { mlp: 'MLP', cnn: 'CNN', rnn: 'RNN', vit: 'ViT', vlm: 'VLM' }
/** One percent format everywhere: whole numbers, no space. */
const pct = (p: number) => `${Math.round(p * 100)}%`
const fmtUs = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(1)} ms` : `${Math.round(us)} µs`)

/* ------------------------------------------------------------------- all five, side by side */
export function CompareCard() {
  const { reads, net, label, timing } = useZoo(useShallow((s) => ({ reads: s.reads, net: s.net, label: s.label, timing: s.timing })))
  // the same forward-pass results the 3D scene draws: nothing is recomputed here
  const rows = NETS.map((n) => ({ id: n.id, r: reads[n.id] ?? null }))
  const digits = rows.map((x) => x.r?.digit).filter((d) => d !== undefined && d !== null)
  const agree = digits.length === 5 && digits.every((d) => d === digits[0])
  const maxUs = Math.max(1, ...NETS.map((n) => timing[n.id]?.us ?? 0))
  return (
    <div className="ccard">
      <h4>All five networks <small>{digits.length < 5 ? 'loading…' : agree ? `all read a ${digits[0]}` : 'they disagree'}</small><Hint>Computed live in this page as you draw, from the same pass the 3D view shows. For the VLM, “reads” is the digit its own caption names (– when it names none). Times are measured here, averaged over {timing.mlp?.n ?? '…'}+ runs; the VLM's time is for writing its whole caption. Click a row to see that network in 3D.</Hint></h4>
      <div className="cmp" role="table" aria-label="What each network reads, how sure it is, and how long it takes here">
        <div className="cmph" role="row"><span role="columnheader">network</span><span role="columnheader">reads</span><span role="columnheader">sure</span><span role="columnheader">time per image, this device</span></div>
        {rows.map(({ id, r }) => (
          <button key={id} role="row" className={`cmpr ${id === net ? 'on' : ''}`} onClick={() => useZoo.getState().setNet(id)} data-net-row={id} data-read-hash={r?.hash} title={r?.caption ? `caption: “${r.caption}”${r.digit === null ? ' (names no digit)' : ''}` : `show the ${NAME[id]} in 3D`}>
            <span role="cell"><i className="sw" style={{ background: NET_COLOR[id] }} />{NAME[id]}</span>
            <b role="cell" data-read-digit={r?.digit ?? '-'} className={`mono dig ${label !== null && r?.digit !== null && r && r.digit !== label ? 'wrong' : ''}`}>{r ? (r.digit ?? '–') : '…'}</b>
            <span role="cell" className="conf" data-read-conf={r ? Math.round(r.conf * 100) : ''}><i style={{ width: `${(r?.conf ?? 0) * 100}%` }} /><em className="mono">{r ? (r.digit === null ? '–' : pct(r.conf)) : ''}</em></span>
            <span role="cell" className="spd"><i style={{ width: `${((timing[id]?.us ?? 0) / maxUs) * 100}%` }} /><em className="mono">{timing[id] ? fmtUs(timing[id]!.us) : '…'}</em></span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ================================================================================ S6 model UI */
const CSS = `
.s6strip{position:absolute;left:12px;right:12px;top:56px;z-index:12;display:flex;flex-direction:column;gap:6px;padding:8px 12px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
@media (max-width:900px){.s6strip{top:56px}}
.s6lang{min-height:44px;max-width:130px;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:4px 8px;font-size:13px}
.s6note2{justify-content:space-between}
.s6tok{display:inline-block;padding:2px 7px;margin:2px;border:1px solid var(--line);border-radius:7px;font:13px var(--mono),'Noto Sans','Noto Sans Devanagari','Noto Sans SC','Noto Sans Arabic','Segoe UI',system-ui,sans-serif;white-space:pre}
.s6padwrap{display:flex;flex-direction:column;gap:10px}
.s6pad{position:relative;width:100%;max-width:420px;aspect-ratio:1;min-width:280px;margin:0 auto;border-radius:16px;background:var(--surface);border:1px solid var(--line);overflow:hidden}
.s6pad canvas{position:absolute;inset:0;width:100%;height:100%;color:var(--fg);cursor:crosshair;touch-action:none}
.s6guide{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;color:var(--muted)}
.s6guide i{position:absolute;inset:18%;border:2px dashed color-mix(in srgb,var(--muted) 45%,transparent);border-radius:14px}
.s6guide span{position:relative;font-size:18px}
.s6chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(40px,1fr));gap:6px}
.s6chips button,.s6padwrap .btn2{min-height:44px}
.s6see{display:flex;flex-direction:column;gap:4px}
.s6big{margin:0;font-size:24px} .s6big b{font-size:30px}
.s6pills{display:flex;flex-wrap:wrap;gap:6px}
.s6pill{display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border:1.5px solid;border-radius:999px;font-size:12.5px}
#dock-slot:has([data-s6dock])>:not([data-s6dock]){display:none}
#model-picker-slot:has([data-picker])>:not([data-picker]){display:none}
.s6card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:12;width:min(440px,calc(100% - 28px));display:flex;flex-direction:column;gap:10px;padding:18px 20px;background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:16px;backdrop-filter:blur(10px);box-shadow:0 12px 40px #0008}
.s6card h2{margin:0;font-size:20px;line-height:1.2}
.s6card p{margin:0}
.s6line{font-size:13px;color:var(--muted)} .s6line b{color:var(--fg);font-weight:600}
.s6go{font-size:15px;font-weight:600;padding:11px 16px;min-height:44px;border-radius:12px;border:0;cursor:pointer;background:var(--pos);color:#06101c}
.s6go:disabled{background:var(--surface2);color:var(--fg);cursor:default;border:1px solid var(--line)}
.s6link{background:none;border:0;color:var(--pos-ink);cursor:pointer;font-size:13px;padding:6px 0;text-align:left;text-decoration:underline}
.s6bar{height:8px;border-radius:5px;background:var(--line);overflow:hidden} .s6bar i{display:block;height:100%;background:var(--pos);transition:width .3s}
.s6bar.ind i{width:35%;animation:s6slide 1.2s ease-in-out infinite alternate} @keyframes s6slide{from{margin-left:0}to{margin-left:65%}}
.s6row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.s6pick{position:relative;display:inline-block}
.s6pick.fallback{position:absolute;left:14px;top:12px;z-index:14}
.s6pickbtn{display:flex;align-items:center;gap:8px;min-height:40px;max-width:100%;padding:6px 12px;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:12px;cursor:pointer;font-size:13.5px}
.s6pickbtn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46vw}
.s6pop{position:absolute;left:0;top:calc(100% + 6px);z-index:70;width:min(420px,92vw);max-height:70vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:8px;box-shadow:0 14px 40px #000a}
.s6grp{margin:8px 6px 4px;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.s6rowb{display:grid;grid-template-columns:1fr auto;gap:2px 10px;width:100%;text-align:left;background:none;color:var(--fg);border:1px solid transparent;border-radius:10px;padding:8px 10px;min-height:44px;cursor:pointer}
.s6rowb:hover{background:var(--surface)} .s6rowb[aria-current=true]{border-color:var(--pos)}
.s6rowb small{color:var(--muted);font-size:12px;grid-column:1} .s6rowb em{font-style:normal;font-size:12px;grid-column:2;grid-row:1;align-self:center}
.s6v-fits{color:var(--pos-ink)} .s6v-tight{color:#e0b341} .s6v-too-big{color:var(--bad)}
.s6dock{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:14px}
.s6dock.fallback{margin:10px 12px 0}
.s6dock.compact{position:relative;flex-direction:row;padding:0;border:0;background:none;width:100%}
.s6dock.compact .s6go{align-self:flex-start;white-space:nowrap}
.s6dock.compact>div:first-child{width:100%}
.s6float{position:absolute;left:0;right:0;bottom:calc(100% + 8px);z-index:30;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 10px}
/* wide: the bulbs sit at the bottom-left corner of each stage; the floating notes keep clear of them (left of the machine stage's bulb, right of the model stage's) */
@media (min-width:1000px){.s6float{left:56px;right:auto;width:min(calc(100% - 56px),calc(50vw - 100px))}}
.s6float:empty{display:none}.s6small{font-size:12px;padding:5px 10px}
.s6dock .s6go{min-height:44px}
.s6dock textarea,.s6dock input[type=text],.s6dock input[type=url]{width:100%;box-sizing:border-box;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:13px var(--mono)}
.s6dock .s6go{align-self:flex-start}
.s6drop{border:1px dashed var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:8px} .s6drop.over{border-color:var(--pos);background:color-mix(in srgb,var(--pos) 8%,transparent)}
.s6drop img{max-height:90px;max-width:100%;align-self:flex-start;border-radius:8px}
.s6dock button.btn2{min-height:40px}
.s6crumb{position:absolute;left:14px;bottom:96px;z-index:9;display:flex;gap:6px;align-items:center;font-size:13px;padding:4px 10px;border-radius:999px;background:color-mix(in srgb,var(--bg) 80%,transparent);border:1px solid var(--line)}
.s6crumb b{font-weight:600} .s6crumb span{color:var(--muted)}
.s6legend{position:absolute;right:14px;bottom:96px;z-index:9}
.s6legend .hintpop{top:auto;bottom:calc(100% + 8px);left:auto;right:0;transform:translateX(var(--shift));text-align:left}
.s6legend ul{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:12.5px} .s6legend li{display:flex;gap:8px;align-items:center}
.s6legend li i{width:18px;text-align:center;font-style:normal}
.s6legend li s{width:10px;height:10px;border-radius:3px;text-decoration:none;display:inline-block}
.s6acts{display:flex;gap:8px;flex-wrap:wrap}
.s6fit{font-size:12.5px;color:var(--muted)} .s6fit b{color:var(--fg)}
.s6resp{font:14px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:900px){.tlctl .ib,.tlctl select{min-height:40px!important;min-width:40px!important}}
.s6inrow{flex-wrap:nowrap}
@media (max-width:600px){.s6inrow{flex-wrap:wrap}.s6in{flex:1 1 100%!important}.s6dock.compact .s6go{white-space:normal;max-width:122px;line-height:1.15;padding:6px 10px;font-size:14px}}
.s6link{min-height:44px;display:inline-flex;align-items:center;margin:6px 0 10px;width:auto!important;max-width:max-content;align-self:flex-start}
.s6dock button,.s6dock input,.s6dock select{min-height:44px}
.s6dock .btn2.sm,.s6err .btn2{min-height:44px}
.s6err{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.zoonets{display:flex;flex-wrap:nowrap;max-width:calc(100% - 28px);overflow-x:auto;scrollbar-width:none}
.zoonets button{white-space:nowrap;flex:none}
@media (max-width:600px){.zoonets .sfx{display:none}.zoonets button{padding-inline:9px}}
.zoo .tlseg span{font:500 12px var(--body);opacity:0;transition:opacity .15s}
.zoo .tlseg.on span,.zoo .tlseg:hover span{opacity:1}
@media (prefers-reduced-motion:reduce){.zoo .tlseg span{transition:none}}
.zoohud .eyebrow,.zoo .cmph span,.s6grp{text-transform:none;letter-spacing:0;font-family:var(--body)}
.zoo .cmph span{font-size:12px}
.s6grp{font-size:12.5px;font-weight:600}
.s6tok .gap{display:inline-block;width:.6em;margin-right:2px;border-bottom:1px solid var(--faint)}
.s6netin{flex-wrap:nowrap;width:100%;min-width:0}
.s6mini{width:44px;height:44px;flex:none;image-rendering:pixelated;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:8px}
.s6what{white-space:nowrap;flex:none}
.s6netin .s6words{flex:1 1 auto;min-width:0}
.s6netin>.btn2{flex:none;white-space:nowrap}
.s6netin>.btn2[data-primary]{margin-left:auto}
.s6netin .s6words~.btn2[data-primary]{margin-left:0}
.s6mine{color:var(--pos-ink)}
.s6vocab{grid-template-columns:repeat(auto-fill,minmax(64px,1fr))}
@media (max-width:600px){.s6netin{flex-wrap:wrap}.s6netin .s6words{flex:1 1 calc(100% - 140px)}.s6what{font-size:12.5px}}
.s6note{position:absolute;left:14px;right:14px;top:64px;text-align:center;z-index:3}
@media (max-width:900px){.s6crumb,.s6legend{bottom:140px}}
`

function usePortal(id: string): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(() => (typeof document === 'undefined' ? null : document.getElementById(id)))
  useEffect(() => {
    if (el && el.isConnected) return
    let n = 0
    const t = setInterval(() => { const f = document.getElementById(id); if (f) { setEl(f); clearInterval(t) } else if (++n > 20) clearInterval(t) }, 250)
    return () => clearInterval(t)
  }, [id, el])
  return el
}

const kindOf = (t: Task | null): TaskInput['kind'] => (t === 'image-classification' ? 'image' : t === 'automatic-speech-recognition' ? 'audio' : 'text')

/** What the models engine says about one input (async); the local rules answer first so the message never lags. */
function useProblem(task: Task | null, input: TaskInput, caps: { deviceMemoryGB?: number | null } | null, extra?: { bytes?: number; seconds?: number }): string | null {
  const local = checkInput(task, input as any, caps, extra)
  const [remote, setRemote] = useState<string | null>(null)
  const key = JSON.stringify([task, input, caps?.deviceMemoryGB])
  useEffect(() => {
    let live = true
    setRemote(null)
    if (!task || local) return
    Promise.resolve(engine.validateInput(task, input, { ...(caps ?? {}), prepare: false })).then((r) => { if (live) setRemote(readCheck(r)) }, () => {})
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return local ?? remote
}

/** One sentence and one button. Every failure the visitor can hit ends here. */
function ErrorBox({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return <div className="err s6err" role="alert" data-error><span>{text}</span><button className="btn2 sm" onClick={onAction}>{action}</button></div>
}

/* ---------------------------------------------------------------- download / run status */
/** Consent, download progress and run status. The numbers come from the main store (plan, download, running). */
function Status() {
  const { pending, download, running, runStatus, runErr, runErrCode, confirm, decline, cancel } = useStore(useShallow((s) => ({ runErrCode: s.runErrCode, pending: s.pendingDownload, download: s.download, running: s.running, runStatus: s.runStatus, runErr: s.runErr, confirm: s.confirmDownload, decline: s.declineDownload, cancel: s.cancelDownload })))
  if (runErr && !download) {
    const retry = runErrCode === 'offline' || runErrCode === 'aborted' || runErrCode === 'unknown'
    return <ErrorBox text={runErr} action={retry ? 'Try again' : 'Pick another model'} onAction={() => (retry ? void runNow() : window.dispatchEvent(new Event('ns-open-picker')))} />
  }
  const auto = typeof (useStore.getState() as any).autoStart === 'function'   // the strip over the scene shows progress
  if (auto && (pending || download || running)) return null
  if (pending) {
    return (
      <div role="alert" className="s6row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <p className="s6line"><b>{pending.consent === 'warn' ? 'Big download' : 'Download'}: {fmtBytes(pending.bytes)}{pending.etaSeconds ? `, ${fmtEta(pending.etaSeconds)}` : ''}.</b>{pending.consent === 'warn' ? ' It may use mobile data.' : ''}</p>
        <div className="s6row"><button className="btn2" data-start onClick={() => confirm()}>Download {fmtBytes(pending.bytes)}</button><button className="btn2" onClick={() => { decline(); window.dispatchEvent(new Event('ns-open-picker')) }}>Use a smaller model</button></div>
      </div>
    )
  }
  if (download) {
    const pct = download.total ? Math.min(100, (download.done / download.total) * 100) : 0
    return (
      <div className="stack" style={{ gap: 6 }}>
        <div className="s6bar" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><i style={{ width: `${pct}%` }} /></div>
        <div className="s6row"><span className="s6line mono" aria-live="polite">{fmtBytes(download.done)} of {fmtBytes(download.total)}{download.bytesPerSec ? ` · ${(download.bytesPerSec / 1048576).toFixed(1)} MB/s` : ''}{download.etaSeconds != null ? ` · ${fmtEta(download.etaSeconds)} left` : ''}</span><button className="btn2 sm" onClick={() => cancel()}>Cancel</button></div>
      </div>
    )
  }
  if (running) return <div className="stack" style={{ gap: 6 }}><div className="s6bar ind" aria-hidden><i /></div><p className="s6line" aria-live="polite">{runStatus ? `${runStatus}…` : 'Running…'}</p></div>
  if (!runErr) return null
  const retry = runErrCode === 'offline' || runErrCode === 'aborted' || runErrCode === 'unknown'
  return <ErrorBox text={runErr} action={retry ? 'Try again' : 'Pick another model'} onAction={() => (retry ? void runNow() : window.dispatchEvent(new Event('ns-open-picker')))} />
}

/** The plan for the model that is loaded now (size, time, cached). */
function useCurrentPlan() {
  const { spec, fit } = useStore(useShallow((s) => ({ spec: s.spec, fit: s.fit })))
  const [plan, setPlan] = useState<engine.DownloadPlan | null>(null)
  const live = useStore((s) => s.plan)   // the run keeps this one current (cached after the download), so the button stops offering a download that is done
  useEffect(() => { setPlan(null); if (spec) useZoo.getState().planFor(spec, fit).then(setPlan, () => {}) }, [spec, fit])
  return live && spec && live.repo === (spec.onnx?.repo ?? spec.repo) ? live : plan
}

const isBrowserFit = (fit: engine.Fit | null) => !!fit && (fit.where === 'webgpu' || fit.where === 'wasm')

/* --------------------------------------------------------------------------- first visit card */
function FirstVisit() {
  const { examples, running, lastStats, mode, spec, fit } = useStore(useShallow((s) => ({ examples: s.examples, running: s.running, lastStats: s.lastStats, mode: s.mode, spec: s.spec, fit: s.fit })))
  const { cardOff, caps, catalog } = useZoo(useShallow((s) => ({ cardOff: s.cardOff, caps: s.caps, catalog: s.catalog })))
  const { pending, download } = useStore(useShallow((s) => ({ pending: s.pendingDownload, download: s.download })))
  useEffect(() => { useZoo.getState().loadCaps() }, [])
  useEffect(() => { if (examples.length) useZoo.getState().loadCatalog() }, [examples.length])
  const cur = useCurrentPlan()
  // the first model to offer: a browser model small enough to need no warning, text first, else the smallest
  const live = examples.filter((e) => !e.file)
  const ok = live.filter((e) => isBrowserFit(catalog[e.id]?.fit ?? null) && catalog[e.id]?.plan && catalog[e.id]!.plan!.consent !== 'warn')
  const def = ok.find((e) => (e.task ?? 'text-generation') === 'text-generation') ?? [...ok].sort((a, b) => (catalog[a.id]!.bytes ?? 0) - (catalog[b.id]!.bytes ?? 0))[0] ?? live[0]
  const row: CatRow | undefined = def ? catalog[def.id] : undefined
  const usingCurrent = !!spec && mode === 'live' && isBrowserFit(fit)
  const title = usingCurrent ? (examples.find((e) => e.repo.toLowerCase() === spec!.repo.toLowerCase())?.title ?? spec!.repo.split('/').pop()) : def?.title
  const rawPlan = usingCurrent ? cur : row?.plan ?? null
  const sb = (usingCurrent ? spec : row?.spec)?.bytes ?? null
  const plan = rawPlan && rawPlan.bytes == null && sb && !(usingCurrent ? fit : row?.fit)?.where?.startsWith('comp') ? { ...rawPlan, bytes: sb } : rawPlan
  const forced = !!pending || !!download
  if (!def || (!forced && (cardOff || (lastStats && lastStats.where !== 'companion')))) return null
  const watch = async () => {
    const z = useZoo.getState(); z.setCardOff(true)
    const st = useStore.getState(), rec = st.examples.find((e) => e.file)
    if (!rec) return
    if (st.repo.toLowerCase() !== rec.repo.toLowerCase()) await st.loadExample(rec.id)
    if (!useStore.getState().running) await useStore.getState().run()
  }
  const busy = forced
  return (
    <div className="s6card" data-card role="region" aria-label="Start here">
      <h2>See an AI run on your device</h2>
      <p className="s6line" data-detail>{caps ? <>Your device: <b>{caps.line}</b></> : 'Reading your device…'}</p>
      <p className="s6line" data-detail>The model: <b>{title}</b>{plan ? <> · {fmtBytes(plan.bytes)}{plan.cached ? '' : plan.etaSeconds ? ` · ${fmtEta(plan.etaSeconds)}` : ''}{plan.cached && <b className="s6v-fits" data-cached> · cached ✓</b>}</> : ''}</p>
      {!busy && <button className="s6go" data-start data-primary onClick={() => useZoo.getState().startLive(usingCurrent ? undefined : def.id)}>{startLabel(plan)}</button>}
      <Status />
            {!busy && <button className="s6link" onClick={watch}>Watch a recorded run</button>}
    </div>
  )
}

/* ------------------------------------------------------------------------------ explainers (R2-3) */
/** Two or three short lines per animation (plain words, TODO section 6.4). */
const EXPLAIN: Record<NetId | 'pad', string[]> = {
  llm: ['Each dot is a word. Lines show what it listens to.', 'The bars at the end are its guesses for the next word.'],
  mlp: ['Pixels go in on the left. Each layer mixes them.', 'Ten bars come out, one for each digit.'],
  cnn: ['Small filters slide over the picture. They find edges and curves.', 'Then the net picks a digit.'],
  rnn: ['It reads the digit one row at a time.', 'It keeps a memory of the rows it saw.'],
  vit: ['It cuts the picture into patches. Each patch is a token.', 'Attention lets the patches talk to each other.'],
  vlm: ['It looks at the picture first.', 'Then it writes a caption, one word at a time.'],
  pad: ['Draw a number. Five networks read it as you draw.', 'Each pill shows what one network guessed.'],
}
const Say = ({ id }: { id: NetId | 'pad' }) => <>{EXPLAIN[id].map((l, i) => <p key={i} style={{ margin: '0 0 4px' }}>{l}</p>)}</>

/* --------------------------------------------------------------------- progress strip (R2-2) */
/** With automatic downloads the first-visit card is gone: one slim line says what is coming, how big it is and how far along. */
function AutoStrip() {
  const { spec, repo, examples, running, lastStats, download, pending, runErr, cancel } = useStore(useShallow((s) => ({ spec: s.spec, repo: s.repo, examples: s.examples, running: s.running, lastStats: s.lastStats, download: s.download, pending: s.pendingDownload, runErr: s.runErr, cancel: s.cancelDownload })))
  const plan = useCurrentPlan()
  // the engine starts the default model by itself; ask once, after the catalog is known
  const asked = useRef(false)
  useEffect(() => {
    const st: any = useStore.getState()
    if (asked.current || !examples.length || typeof st.autoStart !== 'function') return
    asked.current = true
    void st.autoStart()
  }, [examples.length])
  const title = examples.find((e) => e.repo.toLowerCase() === repo.toLowerCase())?.title ?? (repo.split('/').pop() || 'the model')
  const total = download?.total ?? pending?.bytes ?? plan?.bytes ?? null
  const pct = download && download.total ? Math.min(100, Math.round((download.done / download.total) * 100)) : null
  const conn: any = (navigator as any).connection
  const mobile = !!conn && (conn.saveData || conn.type === 'cellular')
  const busy = !!download || !!pending || (running && !lastStats && !!spec && isBrowserFit(useStore.getState().fit))
  if (!busy || runErr) return null
  return (
    <div className="s6strip" role="status" data-strip>
      <div className="s6row" style={{ flexWrap: 'nowrap' }}>
        <span className="s6line" style={{ flex: 1, minWidth: 0 }} aria-live="polite">Getting <b>{title}</b>{total ? ` · ${fmtBytes(total)}` : ''}{pct !== null ? ` · ${pct} %` : ''}</span>
        <button className="btn2 sm" onClick={() => cancel()}>Cancel</button>
      </div>
      <div className="s6bar" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}><i style={{ width: `${pct ?? 0}%` }} /></div>
      {mobile && <span className="s6line">You are on mobile data. Cancel any time.</span>}
    </div>
  )
}

/* ------------------------------------------------------------------------------ model picker */
function Picker() {
  const { examples, repo, backend, loadExample, loadModel, probing, probeErr } = useStore(useShallow((s) => ({ examples: s.examples, repo: s.repo, backend: s.backend, loadExample: s.loadExample, loadModel: s.loadModel, probing: s.probing, probeErr: s.probeErr })))
  const catalog = useZoo((s) => s.catalog)
  const [open, setOpen] = useState(false)
  const [other, setOther] = useState(false)
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const slot = usePortal('model-picker-slot')
  useEffect(() => { const f = (e: Event) => { setOpen(true); if ((e as CustomEvent).detail?.link) setOther(true) }; window.addEventListener('ns-open-picker', f); return () => window.removeEventListener('ns-open-picker', f) }, [])
  useEffect(() => { if (open && examples.length) useZoo.getState().loadCatalog() }, [open, examples.length])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const rows = useMemo(() => examples.map((e): CatRow => catalog[e.id] ?? { id: e.id, title: e.title, repo: e.repo, task: e.task ?? 'text-generation', recorded: !!e.file, bytes: null, plan: null, fit: null, spec: null }), [examples, catalog])
  const current = examples.find((e) => e.repo.toLowerCase() === repo.toLowerCase())
  const node = (
    <div className={`s6pick ${slot ? '' : 'fallback'}`} ref={box} data-picker>
      <button className="s6pickbtn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)} title="Choose a model"><span>Model: <b>{current?.title ?? (repo.split('/').pop() || 'none')}</b></span><i aria-hidden>▾</i></button>
      {open && (
        <div className="s6pop" role="menu" aria-label="Models">
          {[...groupByTask(rows.filter((r) => !(r.recorded && backend !== 'online'))), ...(backend !== 'online' && rows.some((r) => r.recorded) ? [{ task: 'recorded', label: 'Recorded runs', rows: rows.filter((r) => r.recorded) }] : [])].map((g) => (
            <div key={g.task} role="group" aria-label={g.label}>
              <div className="s6grp">{g.label}</div>
              {g.rows.map((r) => {
                const sug = r.verdict === 'too-big' ? smallerSuggestion(r as any, rows as any) : null
                const note = r.recorded && backend !== 'online' ? 'no download' : r.plan ? r.bytes == null ? (r.fit?.where === 'companion' ? 'runs on the companion' : 'size unknown') : `${fmtBytes(r.bytes)}${r.plan.cached ? '' : ` · ${fmtEta(etaSecs(r.bytes))}`}` : '…'
                return (
                  <button key={r.id} role="menuitem" className="s6rowb" aria-current={!!current && current.id === r.id} onClick={() => { setOpen(false); void useZoo.getState().setNet('llm'); loadExample(r.id) }}>
                    <span>{r.title}{r.plan?.cached && <b className="s6v-fits" data-cached> cached ✓</b>}</span>
                    {r.verdict && r.verdict !== 'fits' && <em className={`s6v-${r.verdict}`}>{VERDICT_WORD[r.verdict]}</em>}
                    <small>{note}{sug ? ` · try ${sug.title}` : ''}</small>
                  </button>
                )
              })}
            </div>
          ))}
          <div className="s6grp">More</div>
          <button className="s6rowb" onClick={() => setOther(!other)} aria-expanded={other}><span>Use another model…</span></button>
          {other && (
            <form className="s6dock" style={{ border: 0, margin: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void useZoo.getState().setNet('llm'); loadModel(text); setOpen(false) } }}>
              <label className="s6line" htmlFor="s6hf">A Hugging Face link or name</label>
              <input id="s6hf" type="text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="org/model" />
              <button className="btn2" type="submit" disabled={probing}>{probing ? 'Reading…' : 'Load'}</button>
            </form>
          )}
        </div>
      )}
      {probeErr && !open && <span className="sr" role="alert">{probeErr}</span>}
    </div>
  )
  return slot ? createPortal(node, slot) : node
}

function LangSelect({ value, onChange, label = 'Language', disabled = false }: { value: LangId; onChange: (l: LangId) => void; label?: string; disabled?: boolean }) {
  return (
    <>
      <label className="sr" htmlFor="s6lang">{label}</label>
      <select id="s6lang" data-lang-picker className="s6lang" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as LangId)} title={label}>
        {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </>
  )
}

/* ---------------------------------------------------------------------------- task input */
function InputBox({ compact = false }: { compact?: boolean }) {
  const { spec, input, setInput, mode } = useStore(useShallow((s) => ({ spec: s.spec, input: s.input, setInput: s.setInput, mode: s.mode })))
  const { custom, remember, caps, lang, setLang } = useZoo(useShallow((s) => ({ custom: s.custom, remember: s.remember, caps: s.caps, lang: s.lang, setLang: s.setLang })))
  const examplesAll = useStore((s) => s.examples)
  const task: Task = spec?.task ?? 'text-generation'
  const kind = kindOf(task)
  const [msg, setMsg] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ bytes?: number; seconds?: number }>({})
  const [urlText, setUrlText] = useState('')
  const [over, setOver] = useState(false)
  const [rec, setRec] = useState<MediaRecorder | null>(null)
  const [more, setMore] = useState(false)
  const busyRun = useStore((s) => s.running)
  useEffect(() => { if (busyRun) setMore(false) }, [busyRun])
  const file = useRef<HTMLInputElement>(null)
  const dflt = spec?.defaultInput ?? engine.defaultInputFor(task)
  // a model of another task opens with that task's remembered custom input, else its default
  const seen = useRef('')
  useEffect(() => {
    if (!spec || seen.current === `${spec.repo}|${task}`) return
    seen.current = `${spec.repo}|${task}`
    setMsg(null); setMeta({})
    const c = custom[task] ?? engine.loadSavedInput(task)
    if (c && c.kind === kind && JSON.stringify(c) !== JSON.stringify(input)) setInput(c)
  }, [spec, task]) // eslint-disable-line react-hooks/exhaustive-deps
  const cur: TaskInput = input.kind === kind ? input : dflt
  const set = (i: TaskInput, m: { bytes?: number; seconds?: number } = {}) => { setMsg(null); setMeta(m); setInput(i); remember(task, i); engine.saveInput(task, i) }
  const check = useProblem(task, cur, caps, meta)
  const problem = msg ?? check
  const replay = mode === 'replay'
  const pickFile = (f: File | undefined) => {
    if (!f) return
    if (kind === 'image' && !f.type.startsWith('image/')) return setMsg('That is not an image. Pick a JPG or PNG.')
    if (kind === 'audio' && !f.type.startsWith('audio/') && !f.type.startsWith('video/')) return setMsg('That is not a sound file. Pick a WAV or MP3.')
    if (kind === 'image' && f.size > 10 * 1048576) return setMsg('That image is over 10 MB. Pick a smaller one.')
    const url = URL.createObjectURL(f)
    if (kind === 'audio') {
      const a = new Audio(url)
      a.onloadedmetadata = () => set({ kind: 'audio', url }, { seconds: a.duration })
      a.onerror = () => setMsg('That sound file could not be read. Try a WAV or MP3.')
    } else set({ kind: 'image', url }, { bytes: f.size })
  }
  const record = async () => {
    if (rec) { rec.stop(); return }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return setMsg('This browser cannot record. Upload a file instead.')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch (e: any) {
      return setMsg(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'The microphone is blocked. Allow it in the address bar, or upload a file.' : 'No microphone found. Upload a file instead.')
    }
    const r = new MediaRecorder(stream), parts: Blob[] = []
    const stop = setTimeout(() => r.state !== 'inactive' && r.stop(), 30000)
    r.ondataavailable = (e) => parts.push(e.data)
    r.onstop = () => { clearTimeout(stop); stream.getTracks().forEach((t) => t.stop()); setRec(null); const b = new Blob(parts, { type: r.mimeType || 'audio/webm' }); set({ kind: 'audio', url: URL.createObjectURL(b) }) }
    r.start(); setRec(r)
  }
  const drop = (e: React.DragEvent) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files?.[0]) }
  const insertMask = () => { const t = cur.kind === 'text' ? cur.text : ''; set({ kind: 'text', text: /\[MASK\]/.test(t) ? t : `${t.trimEnd()} [MASK]`.trim() }) }
  const langOk = task === 'text-generation' || task === 'text-classification'
  const multi = isMultilingual(spec)
  const spoken = kind === 'audio' && multi
  const canSwap = !!(engine as any).multilingualFor?.(task)
  /** A language fills the prompt; a model that only knows English is swapped for the smallest multilingual one, which then downloads by itself. */
  const pickLang = async (id: LangId) => {
    setLang(id); (useStore.getState() as any).setLanguage?.(id)
    set({ kind: 'text', text: langPrompt(id, task) })
    if (id !== 'en' && !isMultilingual(useStore.getState().spec) && canSwap) {
      useStore.getState().cancelDownload()
      await (useStore.getState() as any).switchToMultilingual?.()
      set({ kind: 'text', text: langPrompt(id, task) })
    }
  }
  const needsMulti = langOk && lang !== 'en' && !multi && !canSwap
  return (
    <div className="stack" style={{ gap: 8 }}>
      {needsMulti && <div className={`s6row s6note2 ${compact ? 's6float' : ''}`} data-note><span className="s6line">This model knows English best.</span></div>}
      {spoken && <div className="s6row"><LangSelect value={lang} onChange={setLang} label="Spoken language" /></div>}
      <input ref={file} type="file" accept={kind === 'image' ? 'image/*' : 'audio/*'} hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
      {kind === 'text' && cur.kind === 'text' && (
        <>
          <label className={compact ? 'sr' : 'lbl'} htmlFor="s6text">{task === 'fill-mask' ? 'Sentence with a gap' : task === 'text-classification' ? 'Text to judge' : 'Start of a sentence'}</label>
          <div className="s6row s6inrow">
            {langOk && <LangSelect value={lang} onChange={(id) => pickLang(id)} />}
            {compact
              ? <input id="s6text" data-prompt className="s6in" type="text" style={{ flex: 1, minWidth: 0 }} value={cur.text} disabled={replay} aria-invalid={!!problem} onChange={(e) => set({ kind: 'text', text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void runNow() }} placeholder={task === 'fill-mask' ? 'Use [MASK] for the gap' : 'Type here'} />
              : <textarea id="s6text" data-prompt rows={2} style={{ flex: 1 }} value={cur.text} disabled={replay} aria-invalid={!!problem} onChange={(e) => set({ kind: 'text', text: e.target.value })} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void runNow() }} />}
            {task === 'fill-mask' && <button className="btn2 sm" disabled={replay} onClick={insertMask}>[MASK]</button>}
            <button className="btn2 sm s6ex" disabled={replay} onClick={() => set(dflt)} title="Put the example text back">Example</button>
          </div>
          {replay && !compact && <p className="s6line">Recorded run. Pick a browser model to type your own.</p>}
        </>
      )}
      {compact && kind !== 'text' && <div className="s6row" style={{ flexWrap: 'nowrap' }}><span className="s6line" style={{ flex: 1 }}>{kind === 'image' ? 'Picture' : 'Sound'}: <b>{JSON.stringify(cur) === JSON.stringify(dflt) ? 'sample' : 'yours'}</b></span>{kind === 'audio' && <button className="btn2 sm" data-test="mic" onClick={record} aria-pressed={!!rec}>{rec ? '■ Stop' : '● Record'}</button>}<button className="btn2 sm" aria-expanded={more} onClick={() => setMore(!more)}>Change</button></div>}
      {kind === 'image' && cur.kind === 'image' && (!compact || more) && (
        <div className={`s6drop ${compact ? 's6float' : ''} ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <img src={cur.url} alt="The picture the model will look at" />
          <div className="s6row">
            <button className="btn2 sm" onClick={() => set(dflt)}>Use the sample</button>
            <button className="btn2 sm" onClick={() => file.current?.click()}>Upload a picture</button>
          </div>
          <form className="s6row" onSubmit={(e) => { e.preventDefault(); if (urlText.trim()) set({ kind: 'image', url: urlText.trim() }) }}>
            <label className="sr" htmlFor="s6imgurl">Picture link</label>
            <input id="s6imgurl" type="url" style={{ flex: 1, minWidth: 120 }} value={urlText} onChange={(e) => setUrlText(e.target.value)} placeholder="or paste a picture link" />
            <button className="btn2 sm" type="submit">Use link</button>
          </form>
          <span className="s6line">You can also drop a picture here.</span>
        </div>
      )}
      {kind === 'audio' && cur.kind === 'audio' && (!compact || more) && (
        <div className={`s6drop ${compact ? 's6float' : ''}`}>
          <audio controls src={cur.url} style={{ width: '100%' }} />
          <div className="s6row">
            <button className="btn2 sm" onClick={() => set(dflt)}>Use the sample clip</button>
            <button className="btn2 sm" onClick={() => file.current?.click()}>Upload a sound</button>
            {!compact && <button className="btn2 sm" data-test="mic" onClick={record} aria-pressed={!!rec}>{rec ? '■ Stop' : '● Record'}</button>}
          </div>
        </div>
      )}
      {msg ? <div className={compact ? 's6float' : ''}><ErrorBox text={msg} action={kind === 'text' ? 'Use the example' : 'Upload a file'} onAction={() => { if (kind === 'text') set(dflt); else file.current?.click() }} /></div> : problem && <p className={`err ${compact ? 's6float s6small' : ''}`} role="alert" data-error>{problem}</p>}
    </div>
  )
}

/** Run from the keyboard: the same path as the button. */
function startFromInput() { return runNow() }
function runNow() {
  const { fit, mode } = useStore.getState()
  return mode === 'live' && isBrowserFit(fit) ? useZoo.getState().startLive() : useStore.getState().run()
}

/* ------------------------------------------------------------------------------ dock (Run) */
function RunDock() {
  const { spec, fit, running, mode, probe, lastStats, input, backend } = useStore(useShallow((s) => ({ spec: s.spec, fit: s.fit, running: s.running, mode: s.mode, probe: s.probe, lastStats: s.lastStats, input: s.input, backend: s.backend })))
  const caps = useZoo((s) => s.caps)
  const busy = useStore((s) => !!s.pendingDownload || !!s.download)
  const plan = useCurrentPlan()
  const slot = usePortal('dock-slot')
  const viaBrowser = mode === 'live' && isBrowserFit(fit)
  const task = spec?.task ?? 'text-generation'
  const bad = useProblem(task, input.kind === kindOf(task) ? input : spec?.defaultInput ?? input, caps)
  const first = viaBrowser && !!plan && !plan.cached && lastStats?.repo?.toLowerCase() !== spec?.repo?.toLowerCase()
  const can = !!(spec || probe) && !running && !busy && !(bad && mode !== 'replay')
  const net = useZoo((s) => s.net)
  // the dock follows the tab: the prompt only for the language model, the digit (and the VLM's words) for the small nets
  if (net !== 'llm') { const n = <NetDock net={net} compact={!!slot} />; return slot ? createPortal(n, slot) : n }
  const node = (
    <div className={`s6dock ${slot ? 'compact' : 'fallback'}`} aria-label="Run" data-s6dock>
      <div className="s6row" style={{ flexWrap: 'nowrap', width: '100%', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}><InputBox compact={!!slot} /></div>
        <button className="s6go" data-start data-primary disabled={!can} onClick={() => void runNow()}>{running ? 'Running…' : first ? startLabel(plan, '▶ Run') : '▶ Run'}</button>
      </div>
      <div className={slot ? 's6float' : ''}><Status /></div>
    </div>
  )
  return slot ? createPortal(node, slot) : node
}

/** Open the rail where the pad lives and bring the pad into view. */
function openPad() {
  useStore.getState().setRail('model', true)
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-pad]')?.scrollIntoView({ block: 'nearest', behavior: 'auto' }))
}
function newDigit() {
  const d = nextDigit; nextDigit = (nextDigit + 3) % 10
  if (PAD_API.pick) PAD_API.pick(d)
  else { const z = useZoo.getState(), k = z.digits?.labels.indexOf(d) ?? -1; if (k >= 0) z.setImg(z.digits!.images[k], d) }
}

/** The dock on a small-network tab: no prompt and no language. The picture the net sees, Draw, New digit; the VLM also
 *  takes a few words, which it finishes. Same height as the prompt dock, so switching tabs does not move the page. */
function NetDock({ net, compact }: { net: NetId; compact: boolean }) {
  const { words, setWords, label, vocab } = useZoo(useShallow((s) => ({ words: s.words, setWords: s.setWords, label: s.label, vocab: s.packs.vlm?.vocab ?? null })))
  const unknown = net === 'vlm' && vocab ? vlmWords(words, vocab).unknown : []
  return (
    <div className={`s6dock ${compact ? 'compact' : 'fallback'}`} aria-label="Input" data-s6dock data-net-dock={net}>
      <div className="s6row s6netin">
        <MiniInput />
        <span className="s6line s6what">{net === 'vlm' ? 'Picture' : 'Digit'}<b>{label !== null ? ` · sample ${label}` : ' · yours'}</b></span>
        {net === 'vlm' && (
          <>
            <label className="sr" htmlFor="s6words">Your words. The model finishes the sentence about the picture.</label>
            <input id="s6words" data-question className="s6in s6words" type="text" value={words} maxLength={60} spellCheck={false} autoComplete="off"
              placeholder="e.g. it is" onChange={(e) => setWords(e.target.value)} title="Your first words. It finishes the sentence about the picture." />
          </>
        )}
        <button className="btn2" data-primary onClick={openPad}>Draw</button>
        <button className="btn2" onClick={newDigit}>New digit</button>
      </div>
      {unknown.length > 0 && <p className={`s6line ${compact ? 's6float s6small' : ''}`} role="status">It knows 20 words. Skipped: {unknown.slice(0, 4).join(', ')}</p>}
    </div>
  )
}

/* ---------------------------------------------------------------------------- result card */
function Result() {
  const lang = useZoo((s) => s.lang)
  const typed = useStore((s) => (s.input.kind === 'text' ? s.input.text : ''))
  const preview = useMemo(() => {
    try { const seg = new (Intl as any).Segmenter(lang, { granularity: 'word' }); return [...seg.segment(typed)].filter((x: any) => x.isWordLike).map((x: any) => x.segment as string).slice(0, 40) } catch { return typed.split(/\s+/).filter(Boolean).slice(0, 40) }
  }, [typed, lang])
  const tokens = useStore((s) => s.tokens)
  const { lastStats, fit, spec, final, runErr, running, examples, loadExample } = useStore(useShallow((s) => ({ lastStats: s.lastStats, fit: s.fit, spec: s.spec, final: s.final, runErr: s.runErr, running: s.running, examples: s.examples, loadExample: s.loadExample })))
  const alt = runErr && /smaller|too big/i.test(runErr) ? examples.find((e) => e.repo.toLowerCase() !== spec?.repo.toLowerCase() && (e.task ?? 'text-generation') === spec?.task) : null
  const items = final?.topk ?? final?.labels?.map((l: any) => ({ token: l.label, p: l.score }))
  const text: string | undefined = final?.text
  return (
    <div className="stack">
      {tokens.length === 0 && preview.length > 0 && (
        <div className="ccard"><h4>Your text <small>before the model cuts it up</small></h4><div dir="auto" lang={lang} style={{ lineHeight: 1.9 }}>{preview.map((t, i) => <span key={i} className="s6tok" data-token>{t}</span>)}</div></div>
      )}
      {tokens.length > 0 && (
        <div className="ccard"><h4>Tokens <small>the pieces the model reads</small></h4><div dir="auto" lang={lang} style={{ lineHeight: 1.9 }}>{tokens.slice(0, 60).map((t, i) => { const sp = /^[ Ġ▁]/.test(t); return <span key={i} className="s6tok" data-token>{sp && <i className="gap" aria-label="space" />}{showTok(sp ? t.slice(1) : t)}</span> })}</div><p className="s6line">A line before a piece means it starts a new word.</p></div>
      )}
      {final && !running && (
        <div className="ccard">
          <h4>Response <small>from the model</small></h4>
          {text && <p className="s6resp">{text}</p>}
          {items && <TopBars items={items.slice(0, 5)} max={Math.max(...items.map((x: any) => x.p), 1e-6)} />}
        </div>
      )}
      {lastStats && !running && (
        <>
          <p className="s6line" data-runscore>Ran on <b>{lastStats.where === 'webgpu' ? 'the GPU, in your browser' : lastStats.where === 'wasm' ? 'the CPU, in your browser' : 'the companion'}</b>{fit?.reason ? `. ${fit.reason}` : '.'}<Hint>The page picks the GPU when it can. It falls back to the CPU if the GPU cannot hold the model.</Hint></p>
          <ModelRunFacts stats={lastStats} fit={fit} />
        </>
      )}
      {!final && !running && !lastStats && <p className="hint">Press Run. The result shows here.</p>}
    </div>
  )
}

/* ------------------------------------------------------------------------------------- view */

function Empty() {
  const { net } = useZoo(useShallow((s) => ({ net: s.net })))
  const { layers, running, mode, lastStats } = useStore(useShallow((s) => ({ layers: s.layers.length, running: s.running, mode: s.mode, lastStats: s.lastStats })))
  const blank = lastStats != null && !layers && !running && mode !== 'replay'
  // a run with no inside view leaves the model scene empty: show a small network instead, once per run, and say so
  if (!blank || net !== 'llm') return null
  return <p className="s6line s6note">This model has no inside view in the browser.<Hint>The result is on the right. The small networks above show how a network works inside.</Hint></p>
}

function Legend() {
  return (
    <div className="s6legend">
      <Hint label="What the shapes mean">
        <ul>{LAYER_LEGEND.map((l) => <li key={l.name}><i>{l.icon}</i><s style={{ background: l.tint }} /><span><b>{l.name}</b> · {l.shape}</span></li>)}</ul>
      </Hint>
    </div>
  )
}

export function ZooView() {
  const { net, packs, err, inspect } = useZoo(useShallow((s) => ({ net: s.net, packs: s.packs, err: s.err, inspect: s.inspect })))
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { useZoo.getState().init().then(() => setLoaded(true)) }, [])
  const p = net === 'llm' ? undefined : packs[net]
  const repo = useStore((s) => s.repo)
  const short = repo ? repo.split('/').pop()! : 'This model'
  const stageRef = useRef<HTMLElement>(null), tabsRef = useRef<HTMLDivElement>(null)
  // the net card sits under the tab row: measure the row (it can wrap) instead of guessing its height
  useEffect(() => {
    const st = stageRef.current, tb = tabsRef.current
    if (!st || !tb) return
    const f = () => st.style.setProperty('--zoo-tabs-b', `${Math.ceil(tb.getBoundingClientRect().bottom - st.getBoundingClientRect().top)}px`)
    f(); const ro = new ResizeObserver(f); ro.observe(tb); ro.observe(st)
    return () => ro.disconnect()
  }, [])
  return (
    <main className="main machine zoo">
      <style>{CSS}</style>
      <section ref={stageRef} className="stage" aria-label={`3D view of a ${p?.title ?? 'network'}`}>
        <ZooScene />
        <Picker />
        <div ref={tabsRef} className="vswitch seg zoonets" data-zoo-tabs role="group" aria-label="Network">
          <button className={`real ${net === 'llm' ? 'on' : ''}`} onClick={() => useZoo.getState().setNet('llm')} title={`${short}: a real language model, on your prompt`}>{short.replace(/[-_](\d+(\.\d+)?[MBK]|instruct).*$/i, '')}<span className="sfx">{short.match(/[-_](\d+(\.\d+)?[MBK]|instruct).*$/i)?.[0] ?? ''}</span></button>
          {/* the pad stays one tap away (Draw in the dock): an open drawer would cover this tab row and half the scene */}
          {NETS.map((n) => <button key={n.id} className={net === n.id ? 'on' : ''} data-net-tab={n.id} onClick={() => void useZoo.getState().setNet(n.id as NetId)} title={n.id === 'vlm' ? 'A tiny network that looks at a digit and finishes your words about it' : 'A tiny network that reads 8×8 handwritten digits'}>{n.short}</button>)}
          <button className="more" data-more-models onClick={() => window.dispatchEvent(new CustomEvent('ns-open-picker', { detail: { link: true } }))} title="Load another model from a Hugging Face link">More…</button>
        </div>
        {p && (
          <Peek className="phud zoohud" data-hud="net" label={`More about the ${p.title}`}
            summary={<p className="zoohud-sum"><b>{NETS.find((n) => n.id === net)?.short ?? p.title}</b> · <span className="mono">{Math.round(p.accuracy * 100)}%</span> right</p>}
            details={<>
              <p className="zoohud-title">{p.title}</p>
              <div className="prow mono"><div><span>Parameters</span><b>{p.params.toLocaleString()}</b></div><div><span>{p.accuracy_note ? p.accuracy_note[0].toUpperCase() + p.accuracy_note.slice(1) : 'Test accuracy'}</span><b>{(p.accuracy * 100).toFixed(1)}%</b></div></div>
              <p className="small">{((w) => <><span className="mono">{w}</span>{/per /.test(w) ? '' : ' per image'}. Computed on this device.</>)(FLOPS[net as DigitNet].split('≈').pop()?.trim() ?? '')}</p>
              <p className="zoohud-blurb">{p.blurb}</p>
            </>} />
        )}
        <Explainer key={net} id={net === 'llm' ? 'model' : `net-${net}`} placement="bottom-left"><Say id={net} /></Explainer>
        <Empty />
        <Legend />
        <div className="stagebottom"><ZooTimeline /></div>
        {typeof (useStore.getState() as any).autoStart === 'function' ? <AutoStrip /> : <FirstVisit />}
        {err && <div className="err">{err}</div>}
      </section>
      <RunDock />
      <aside className="inspector" aria-label="Network input and output">
        {net === 'llm' ? <ModelTools inspecting={!!inspect} /> : <div className="pane">
          <div className="stack">
            {!loaded && <p className="hint">Loading the networks…</p>}
            <DrawPad />
            <CompareCard />
            <Output />
            <CalcCard />
            <p className="s6line">All five learned from the same 1,500 digits.</p>
          </div>
        </div>}
      </aside>
    </main>
  )
}

/** The real model's rail: Run, and nothing else until something is picked in the scene. */
function ModelTools({ inspecting }: { inspecting: boolean }) {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const act = tab === 'calc' || tab === 'edit' ? tab : null
  return (
    <>
      <div className="pane" style={{ flex: 'none' }}><Inspector /></div>
      <div className="pane" role="region" aria-label="Run">
        {!inspecting && <Result />}
        {inspecting && (
          <div className="stack">
                        <div className="s6acts">
              <button className={`btn2 ${tab === 'calc' ? 'on' : ''}`} aria-pressed={tab === 'calc'} onClick={() => setTab(tab === 'calc' ? 'layer' : 'calc')}>See the maths</button>
              <button className={`btn2 ${tab === 'edit' ? 'on' : ''}`} aria-pressed={tab === 'edit'} onClick={() => setTab(tab === 'edit' ? 'layer' : 'edit')}>Change weights</button>
            </div>
            {act === 'calc' ? <CalcPanel /> : act === 'edit' ? <EditPanel /> : <LayerPanel />}
          </div>
        )}
      </div>
    </>
  )
}
