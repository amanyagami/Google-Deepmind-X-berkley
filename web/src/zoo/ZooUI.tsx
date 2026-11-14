import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { ZooScene } from './ZooScene'
import { FLOPS, LAYER_LEGEND, VERDICT_WORD, checkInput, crumbs, fmtBytes, fmtEta, groupByTask, isNeutral, readCheck, readDigit, smallerSuggestion, startLabel } from './nets'
import { locateZ, NETS, STAGES, totalZ, useZoo, type CatRow, type DigitNet, type NetId } from './zooStore'
import * as engine from '../api'
import type { Task, TaskInput } from '../api'
import { useStore } from '../store'
import { CalcPanel, EditPanel, LayerPanel, RunScoreCard } from '../ui/panels'
import { Hint, Inspector, TopBars, inspectCrumb, inspectParent } from '../ui/charts'

const f = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v))

/* ------------------------------------------------------------------------------- drawing pad */
const paintPx = (c: CanvasRenderingContext2D, img: number[], s: number) => {
  for (let i = 0; i < 64; i++) { const v = img[i]; c.fillStyle = `rgb(${Math.round(20 + 235 * v)},${Math.round(26 + 143 * v)},${Math.round(50 + 27 * v)})`; c.fillRect((i % 8) * s, Math.floor(i / 8) * s, s - 1, s - 1) }
}

function DrawPad() {
  const base = useZoo((s) => s.base)
  const img = useZoo((s) => s.img)
  const stressed = useZoo((s) => !isNeutral(s.fx))
  const ref = useRef<HTMLCanvasElement>(null)
  const seen = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  useEffect(() => { paintPx(ref.current!.getContext('2d')!, base, 24) }, [base])
  useEffect(() => { if (seen.current) paintPx(seen.current.getContext('2d')!, img, 12) }, [img, stressed])
  const paint = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * 8, y = ((e.clientY - r.top) / r.height) * 8
    const next = [...useZoo.getState().base]
    for (let i = 0; i < 64; i++) {
      const dx = (i % 8) + 0.5 - x, dy = Math.floor(i / 8) + 0.5 - y, d2 = dx * dx + dy * dy
      if (d2 < 1.6) next[i] = Math.min(1, next[i] + (d2 < 0.35 ? 0.55 : 0.18))
    }
    useZoo.getState().setImg(next, null)
  }
  return (
    <div className="drawpad">
      <canvas ref={ref} width={192} height={192} aria-label="Draw a digit: 8 by 8 pixels"
        onPointerDown={(e) => { drawing.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); paint(e) }}
        onPointerMove={(e) => { if (drawing.current) paint(e) }} onPointerUp={() => { drawing.current = false }} />
      <div className="col">
        <p className="small">Draw a digit<Hint>Every network recomputes as you draw. Pick a test digit below, or draw your own with the mouse.</Hint></p>
        {stressed && <div className="seen"><canvas ref={seen} width={96} height={96} aria-label="What the networks see after the stress test" /><span className="small">they see this</span></div>}
        <button className="btn2 sm" onClick={() => useZoo.getState().setImg(new Array(64).fill(0), null)}>Clear</button>
      </div>
    </div>
  )
}

function Gallery() {
  const digits = useZoo((s) => s.digits)
  if (!digits) return null
  return (
    <div className="gallery" role="group" aria-label="Test digits">
      {digits.images.slice(0, 24).map((im, k) => (
        <button key={k} title={`a ${digits.labels[k]} from the test set`} onClick={() => useZoo.getState().setImg(im, digits.labels[k])}>
          <svg viewBox="0 0 8 8" width="30" height="30">{im.map((v, i) => <rect key={i} x={i % 8} y={Math.floor(i / 8)} width="1" height="1" fill={`rgba(255,169,77,${v})`} />)}</svg>
        </button>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------------------------- outputs */
function Output() {
  const { net, out, label, pack } = useZoo(useShallow((s) => ({ net: s.net, out: s.out, label: s.label, pack: s.packs[s.net] })))
  if (!out || !pack) return null
  if (net === 'vlm') {
    const words = out.ids.slice(1).map((i: number) => pack.vocab![i]).filter((w: string) => w !== '<eos>')
    return (
      <div className="ccard">
        <h4>Caption written by the model</h4>
        <p className="caption-out">“{words.join(' ').replace(' ,', ',')}”</p>
        <p className="small mono">{label !== null ? `the test image is a ${label}` : 'your drawing'}<Hint>Each word is chosen from {pack.vocab!.length} possible words, given the image tokens and the words written so far.</Hint></p>
      </div>
    )
  }
  const best = out.probs.indexOf(Math.max(...out.probs))
  return (
    <div className="ccard">
      <h4>Prediction <small>{label !== null ? `the test image is a ${label}` : 'your drawing'}</small></h4>
      <div className="probs">{out.probs.map((p: number, i: number) => <div key={i} className={i === best ? 'on' : ''}><i style={{ height: `${Math.max(2, p * 100)}%` }} /><span>{i}</span></div>)}</div>
      <p className="small mono">{best} · {(out.probs[best] * 100).toFixed(1)}% sure</p>
    </div>
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
        <div className="tlhead" style={{ left: `${(t / T) * 100}%` }} />
      </div>
    </div>
  )
}

/** One fixed colour per network (validated categorical palette, dark surface), used everywhere a network is identified. */
export const NET_COLOR: Record<DigitNet, string> = { mlp: '#3987e5', cnn: '#d95926', rnn: '#199e70', vit: '#c98500', vlm: '#d55181' }
const NAME: Record<DigitNet, string> = { mlp: 'MLP', cnn: 'CNN', rnn: 'RNN (GRU)', vit: 'ViT', vlm: 'VLM' }
const fmtUs = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(1)} ms` : `${Math.round(us)} µs`)

/* ------------------------------------------------------------------- all five, side by side */
export function CompareCard() {
  const { img, packs, net, label, timing } = useZoo(useShallow((s) => ({ img: s.img, packs: s.packs, net: s.net, label: s.label, timing: s.timing })))
  const rows = useMemo(() => NETS.map((n) => ({ id: n.id, r: packs[n.id] ? readDigit(n.id, packs[n.id]!, img) : null })), [img, packs])
  const digits = rows.map((x) => x.r?.digit).filter((d) => d !== undefined && d !== null)
  const agree = digits.length === 5 && digits.every((d) => d === digits[0])
  const maxUs = Math.max(1, ...NETS.map((n) => timing[n.id]?.us ?? 0))
  return (
    <div className="ccard">
      <h4>All five networks <small>{digits.length < 5 ? 'loading…' : agree ? `all read a ${digits[0]}` : 'they disagree'}</small><Hint>Computed live in this page as you draw. Times are measured here, averaged over {timing.mlp?.n ?? '…'}+ runs; the VLM's time is for writing its whole caption. Click a row to see that network in 3D.</Hint></h4>
      <div className="cmp" role="table" aria-label="What each network reads, how sure it is, and how long it takes here">
        <div className="cmph" role="row"><span role="columnheader">network</span><span role="columnheader">reads</span><span role="columnheader">sure</span><span role="columnheader">time per image, this device</span></div>
        {rows.map(({ id, r }) => (
          <button key={id} role="row" className={`cmpr ${id === net ? 'on' : ''}`} onClick={() => useZoo.getState().setNet(id)} title={r?.caption ? `caption: “${r.caption}”` : `show the ${NAME[id]} in 3D`}>
            <span role="cell"><i className="sw" style={{ background: NET_COLOR[id] }} />{NAME[id]}</span>
            <b role="cell" className={`mono dig ${label !== null && r?.digit !== null && r && r.digit !== label ? 'wrong' : ''}`}>{r ? (r.digit ?? '?') : '…'}</b>
            <span role="cell" className="conf"><i style={{ width: `${(r?.conf ?? 0) * 100}%` }} /><em className="mono">{r ? `${Math.round(r.conf * 100)}%` : ''}</em></span>
            <span role="cell" className="spd"><i style={{ width: `${((timing[id]?.us ?? 0) / maxUs) * 100}%` }} /><em className="mono">{timing[id] ? fmtUs(timing[id]!.us) : '…'}</em></span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------- stress test */
export function StressCard() {
  const fx = useZoo((s) => s.fx)
  const set = useZoo((s) => s.setFx)
  const off = isNeutral(fx)
  return (
    <div className="ccard">
      <h4>Stress test <small>{off ? 'the clean image' : 'every network sees the changed image'}</small><Hint>A CNN's filters slide, so it often survives a shift that breaks the MLP, which ties each weight to one fixed pixel.</Hint></h4>
      <div className="fxgrid">
        <label>Noise <input type="range" min={0} max={0.9} step={0.05} value={fx.noise} onChange={(e) => set({ noise: +e.target.value })} /><em className="mono">{Math.round(fx.noise * 100)}%</em></label>
        <label>Shift → <input type="range" min={-2} max={2} step={1} value={fx.dx} onChange={(e) => set({ dx: +e.target.value })} /><em className="mono">{fx.dx > 0 ? '+' : ''}{fx.dx} px</em></label>
        <label>Shift ↓ <input type="range" min={-2} max={2} step={1} value={fx.dy} onChange={(e) => set({ dy: +e.target.value })} /><em className="mono">{fx.dy > 0 ? '+' : ''}{fx.dy} px</em></label>
        <label>Stroke <input type="range" min={-1} max={1} step={1} value={fx.thick} onChange={(e) => set({ thick: +e.target.value })} /><em className="mono">{fx.thick < 0 ? 'thinner' : fx.thick > 0 ? 'thicker' : 'as drawn'}</em></label>
      </div>
      <div className="row">
        <button className="btn2 sm" disabled={!fx.noise} onClick={() => set({ seed: fx.seed + 1 })}>New noise</button>
        <button className="btn2 sm" disabled={off} onClick={() => set({ noise: 0, dx: 0, dy: 0, thick: 0 })}>Reset</button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- robustness chart */
export function RobustCard() {
  const { sweep, busy, run } = useZoo(useShallow((s) => ({ sweep: s.sweep, busy: s.sweepBusy, run: s.runSweep })))
  const [hx, setHx] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const W = 320, H = 170, L = 34, R = 18, T = 10, B = 26
  const lv = sweep?.levels ?? []
  const x = (i: number) => L + (i / Math.max(1, lv.length - 1)) * (W - L - R)
  const y = (a: number) => T + (1 - a) * (H - T - B)
  const done = NETS.filter((n) => (sweep?.acc[n.id]?.length ?? 0) > 0)
  return (
    <div className="ccard">
      <h4>Which network is most robust? <small>accuracy on {sweep?.n ?? 48} test digits as noise rises</small><Hint>Runs all five networks on every test digit at six noise levels (three noise draws each), in this page. The VLM counts as right when the number word in its caption is the right digit.</Hint></h4>
      {!sweep ? (
        <>
          <button className="btn2 sm" onClick={() => run()}>Run the robustness test</button>
        </>
      ) : (
        <>
          <div className="legend">{NETS.map((n) => <span key={n.id}><i style={{ background: NET_COLOR[n.id] }} />{NAME[n.id]}</span>)}</div>
          <div className="rchart">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Accuracy of each network as noise rises"
              onPointerMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHx(Math.max(0, Math.min(lv.length - 1, Math.round(((px - L) / (W - L - R)) * (lv.length - 1))))) }}
              onPointerLeave={() => setHx(null)}>
              {[0, 0.25, 0.5, 0.75, 1].map((a) => <g key={a}><line x1={L} x2={W - R} y1={y(a)} y2={y(a)} className="grid" /><text x={L - 6} y={y(a) + 3} textAnchor="end">{a * 100}%</text></g>)}
              {lv.map((l, i) => <text key={i} x={x(i)} y={H - 8} textAnchor="middle">{Math.round(l * 100)}%</text>)}
              {hx !== null && <line x1={x(hx)} x2={x(hx)} y1={T} y2={H - B} className="cross" />}
              {done.map((n) => {
                const a = sweep.acc[n.id]!
                return (
                  <g key={n.id}>
                    <path d={a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={NET_COLOR[n.id]} strokeWidth="2" strokeLinejoin="round" />
                    {a.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={hx === i ? 5 : 4} fill={NET_COLOR[n.id]} stroke="var(--surface)" strokeWidth="2" />)}
                  </g>
                )
              })}
              <text x={W - 2} y={H - 8} textAnchor="end" className="axl">noise →</text>
            </svg>
            {hx !== null && done.length > 0 && (
              <div className="rtip" style={{ left: `${(x(hx) / W) * 100}%` }}>
                <b>{Math.round(lv[hx] * 100)}% noise</b>
                {[...done].sort((a, b) => (sweep.acc[b.id]![hx] ?? 0) - (sweep.acc[a.id]![hx] ?? 0)).map((n) => sweep.acc[n.id]![hx] !== undefined && (
                  <span key={n.id}><i style={{ background: NET_COLOR[n.id] }} />{NAME[n.id]}<em className="mono">{Math.round(sweep.acc[n.id]![hx] * 100)}%</em></span>
                ))}
              </div>
            )}
          </div>
          {busy ? <p className="hint small busy"><span className="pulse" /> testing {busy}…</p> : (
            <div className="row">
              <button className="btn2 sm" onClick={() => setTable(!table)}>{table ? 'Hide table' : 'Show as table'}</button>
              <button className="btn2 sm" onClick={() => run()}>Run again</button>
            </div>
          )}
          {table && (
            <table className="optab mono"><thead><tr><th>noise</th>{done.map((n) => <th key={n.id}>{n.short}</th>)}</tr></thead>
              <tbody>{lv.map((l, i) => <tr key={i}><td>{Math.round(l * 100)}%</td>{done.map((n) => <td key={n.id}>{sweep.acc[n.id]![i] !== undefined ? `${Math.round(sweep.acc[n.id]![i] * 100)}%` : ''}</td>)}</tr>)}</tbody></table>
          )}
        </>
      )}
    </div>
  )
}

/* ================================================================================ S6 model UI */
const CSS = `
#dock-slot:has([data-s6dock])>:not([data-s6dock]){display:none}
#model-picker-slot:has([data-picker])>:not([data-picker]){display:none}
.s6card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:12;width:min(440px,calc(100% - 28px));display:flex;flex-direction:column;gap:10px;padding:18px 20px;background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:16px;backdrop-filter:blur(10px);box-shadow:0 12px 40px #0008}
.s6card h2{margin:0;font-size:20px;line-height:1.2}
.s6card p{margin:0}
.s6line{font-size:13px;color:var(--muted)} .s6line b{color:var(--fg);font-weight:600}
.s6go{font-size:15px;font-weight:600;padding:11px 16px;min-height:44px;border-radius:12px;border:0;cursor:pointer;background:var(--pos);color:#06101c}
.s6go:disabled{opacity:.5;cursor:default}
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

/* ---------------------------------------------------------------- download / run status */
/** Consent, download progress and run status. The numbers come from the main store (plan, download, running). */
function Status() {
  const { pending, download, running, runStatus, runErr, confirm, decline, cancel } = useStore(useShallow((s) => ({ pending: s.pendingDownload, download: s.download, running: s.running, runStatus: s.runStatus, runErr: s.runErr, confirm: s.confirmDownload, decline: s.declineDownload, cancel: s.cancelDownload })))
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
  return runErr ? <div className="err" role="alert" data-error>{runErr}</div> : null
}

/** The plan for the model that is loaded now (size, time, cached). */
function useCurrentPlan() {
  const { spec, fit } = useStore(useShallow((s) => ({ spec: s.spec, fit: s.fit })))
  const [plan, setPlan] = useState<engine.DownloadPlan | null>(null)
  useEffect(() => { setPlan(null); if (spec) useZoo.getState().planFor(spec, fit).then(setPlan, () => {}) }, [spec, fit])
  return plan
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
  const def = examples.find((e) => !e.file && isBrowserFit(catalog[e.id]?.fit ?? null)) ?? examples.find((e) => !e.file)
  const row: CatRow | undefined = def ? catalog[def.id] : undefined
  const usingCurrent = !!spec && mode === 'live' && isBrowserFit(fit)
  const title = usingCurrent ? (examples.find((e) => e.repo.toLowerCase() === spec!.repo.toLowerCase())?.title ?? spec!.repo.split('/').pop()) : def?.title
  const rawPlan = usingCurrent ? cur : row?.plan ?? null
  const sb = (usingCurrent ? spec : row?.spec)?.bytes ?? null
  const plan = rawPlan && rawPlan.bytes == null && sb && !(usingCurrent ? fit : row?.fit)?.where?.startsWith('comp') ? { ...rawPlan, bytes: sb } : rawPlan
  const blocked = (usingCurrent ? fit : row?.fit)?.verdict === 'too-big'
  const forced = !!pending || !!download
  if (!def || (!forced && (cardOff || (lastStats && lastStats.where !== 'companion') || running))) return null
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
      {!busy && <button className="s6go" data-start data-primary disabled={blocked} onClick={() => useZoo.getState().startLive(usingCurrent ? undefined : def.id)}>{startLabel(plan)}</button>}
      <Status />
      {blocked && <p className="s6line">This device cannot hold that model. Pick a smaller one at the top.</p>}
      {!busy && <button className="s6link" onClick={watch}>Watch a recorded run</button>}
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
  useEffect(() => { const f = () => setOpen(true); window.addEventListener('ns-open-picker', f); return () => window.removeEventListener('ns-open-picker', f) }, [])
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
          {groupByTask(rows).map((g) => (
            <div key={g.task} role="group" aria-label={g.label}>
              <div className="s6grp">{g.label}</div>
              {g.rows.map((r) => {
                const sug = r.verdict === 'too-big' ? smallerSuggestion(r as any, rows as any) : null
                const note = r.recorded && backend !== 'online' ? 'recorded run, no download' : r.plan ? r.bytes == null ? (r.fit?.where === 'companion' ? 'runs on the companion' : 'size unknown') : `${fmtBytes(r.bytes)}${r.plan.cached ? '' : r.plan.etaSeconds ? ` · ${fmtEta(r.plan.etaSeconds)}` : ''}` : 'reading size…'
                return (
                  <button key={r.id} role="menuitem" className="s6rowb" aria-current={!!current && current.id === r.id} onClick={() => { setOpen(false); loadExample(r.id) }}>
                    <span>{r.title}{r.plan?.cached && <b className="s6v-fits" data-cached> cached ✓</b>}</span>
                    {r.verdict && <em className={`s6v-${r.verdict}`}>{VERDICT_WORD[r.verdict]}</em>}
                    <small>{note}{sug ? ` · try ${sug.title}` : ''}</small>
                  </button>
                )
              })}
            </div>
          ))}
          <div className="s6grp">More</div>
          <button className="s6rowb" onClick={() => setOther(!other)} aria-expanded={other}><span>Use another model…</span></button>
          {other && (
            <form className="s6dock" style={{ border: 0, margin: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { loadModel(text); setOpen(false) } }}>
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

/* ---------------------------------------------------------------------------- task input */
function InputBox({ compact = false }: { compact?: boolean }) {
  const { spec, input, setInput, mode } = useStore(useShallow((s) => ({ spec: s.spec, input: s.input, setInput: s.setInput, mode: s.mode })))
  const { custom, remember, caps } = useZoo(useShallow((s) => ({ custom: s.custom, remember: s.remember, caps: s.caps })))
  const task: Task = spec?.task ?? 'text-generation'
  const kind = kindOf(task)
  const [msg, setMsg] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ bytes?: number; seconds?: number }>({})
  const [urlText, setUrlText] = useState('')
  const [over, setOver] = useState(false)
  const [rec, setRec] = useState<MediaRecorder | null>(null)
  const [more, setMore] = useState(false)
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
  return (
    <div className="stack" style={{ gap: 8 }}>
      {kind === 'text' && cur.kind === 'text' && (
        <>
          <label className={compact ? 'sr' : 'lbl'} htmlFor="s6text">{task === 'fill-mask' ? 'Sentence with a gap' : task === 'text-classification' ? 'Text to judge' : 'Start of a sentence'}</label>
          <div className="s6row" style={{ flexWrap: 'nowrap' }}>
            {compact
              ? <input id="s6text" type="text" style={{ flex: 1, minWidth: 0 }} value={cur.text} disabled={replay} aria-invalid={!!problem} onChange={(e) => set({ kind: 'text', text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void runNow() }} placeholder={task === 'fill-mask' ? 'Use [MASK] for the gap' : 'Type here'} />
              : <textarea id="s6text" rows={2} style={{ flex: 1 }} value={cur.text} disabled={replay} aria-invalid={!!problem} onChange={(e) => set({ kind: 'text', text: e.target.value })} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void runNow() }} />}
            {task === 'fill-mask' && <button className="btn2 sm" disabled={replay} onClick={insertMask}>[MASK]</button>}
            <button className="btn2 sm" disabled={replay} onClick={() => set(dflt)} title="Put the example text back">Example</button>
          </div>
          {replay && !compact && <p className="s6line">Recorded run. Pick a browser model to type your own.</p>}
        </>
      )}
      {compact && kind !== 'text' && <div className="s6row" style={{ flexWrap: 'nowrap' }}><span className="s6line" style={{ flex: 1 }}>{kind === 'image' ? 'Picture' : 'Sound'}: <b>{JSON.stringify(cur) === JSON.stringify(dflt) ? 'sample' : 'yours'}</b></span><button className="btn2 sm" aria-expanded={more} onClick={() => setMore(!more)}>Change</button></div>}
      {kind === 'image' && cur.kind === 'image' && (!compact || more) && (
        <div className={`s6drop ${compact ? 's6float' : ''} ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <img src={cur.url} alt="The picture the model will look at" />
          <div className="s6row">
            <button className="btn2 sm" onClick={() => set(dflt)}>Use the sample</button>
            <button className="btn2 sm" onClick={() => file.current?.click()}>Upload a picture</button>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
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
            <input ref={file} type="file" accept="audio/*" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
            <button className="btn2 sm" onClick={record} aria-pressed={!!rec}>{rec ? '■ Stop' : '● Record'}</button>
          </div>
        </div>
      )}
      {problem && <p className={`err ${compact ? 's6float s6small' : ''}`} role="alert" data-error>{problem}</p>}
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

/* ---------------------------------------------------------------------------- result card */
function Result() {
  const { lastStats, fit, spec, final, runErr, running, examples, loadExample } = useStore(useShallow((s) => ({ lastStats: s.lastStats, fit: s.fit, spec: s.spec, final: s.final, runErr: s.runErr, running: s.running, examples: s.examples, loadExample: s.loadExample })))
  const alt = runErr && /smaller|too big/i.test(runErr) ? examples.find((e) => e.repo.toLowerCase() !== spec?.repo.toLowerCase() && (e.task ?? 'text-generation') === spec?.task) : null
  const items = final?.topk ?? final?.labels?.map((l: any) => ({ token: l.label, p: l.score }))
  const text: string | undefined = final?.text
  return (
    <div className="stack">
      {runErr && <div className="err" role="alert" data-error>{runErr}{alt && <> <button className="btn2 sm" onClick={() => loadExample(alt.id)}>Use {alt.title}</button></>}</div>}
      {final && !running && (
        <div className="ccard">
          <h4>Response <small>from the model</small></h4>
          {text && <p className="s6resp">{text}</p>}
          {items && <TopBars items={items.slice(0, 5)} max={Math.max(...items.map((x: any) => x.p), 1e-6)} />}
        </div>
      )}
      {lastStats && !running && (
        <>
          <p className="s6line" data-score>Ran on <b>{lastStats.where === 'webgpu' ? 'the GPU, in your browser' : lastStats.where === 'wasm' ? 'the CPU, in your browser' : 'the companion'}</b>{fit?.reason ? `. ${fit.reason}` : '.'}<Hint>The page picks the GPU when it can. It falls back to the CPU if the GPU cannot hold the model.</Hint></p>
          <RunScoreCard stats={lastStats} fit={fit} params={spec?.params ?? null} info={null} />
          <p className="s6line">Speed and energy here are <b>estimated</b>. The score uses speed, wait and memory.{lastStats.joules != null && <> Energy: about <b className="mono">{lastStats.joules.toFixed(1)} J</b> (estimated).</>}</p>
          {fit && <p className="s6fit">Fit: <b className={`s6v-${fit.verdict}`}>{VERDICT_WORD[fit.verdict]}</b>. Needs about {fmtBytes(fit.needBytes)}{fit.haveBytes ? `, this device has ${fmtBytes(fit.haveBytes)}` : ''}.</p>}
        </>
      )}
      {!final && !runErr && !running && !lastStats && <p className="hint">Press Run. The result shows here.</p>}
    </div>
  )
}

/* ------------------------------------------------------------------------------------- view */
function Crumb() {
  const inspect = useZoo((s) => s.inspect)
  if (!inspect) return null
  const parts = inspectCrumb(inspect).split(' › ')
  return (
    <nav className="s6crumb" aria-label="Where you are">
      {parts.map((p, i) => <span key={i}>{i > 0 && ' › '}{i === parts.length - 1 ? <b aria-current="location">{p}</b> : <span>{p}</span>}</span>)}
      <button className="btn2 sm" aria-label="Go up one level (Esc)" onClick={() => useZoo.getState().setInspect(inspectParent(inspect))}>Esc</button>
    </nav>
  )
}

function Empty() {
  const { net } = useZoo(useShallow((s) => ({ net: s.net })))
  const { layers, running, mode, lastStats } = useStore(useShallow((s) => ({ layers: s.layers.length, running: s.running, mode: s.mode, lastStats: s.lastStats })))
  if (net !== 'llm' || layers || running || !lastStats || mode === 'replay') return null
  return <p className="s6line" style={{ position: 'absolute', left: 14, right: 14, top: '40%', textAlign: 'center', zIndex: 3 }}>This model has no inside view in the browser. The result is on the right.<Hint>Try the small networks above to see inside one.</Hint></p>
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
  return (
    <main className="main machine zoo">
      <style>{CSS}</style>
      <section className="stage" aria-label={`3D view of a ${p?.title ?? 'network'}`}>
        <ZooScene />
        <Picker />
        <div className="vswitch seg zoonets" role="group" aria-label="Network">
          <button className={`real ${net === 'llm' ? 'on' : ''}`} onClick={() => useZoo.getState().setNet('llm')} title="The model loaded at the top, on your prompt">{short}</button>
          {NETS.map((n) => <button key={n.id} className={net === n.id ? 'on' : ''} onClick={() => useZoo.getState().setNet(n.id as NetId)} title="A tiny network that reads 8×8 handwritten digits">{n.short}</button>)}
        </div>
        {p && (
          <div className="phud zoohud">
            <p className="eyebrow">{p.title}<Hint>{p.blurb}</Hint></p>
            <div className="prow mono"><div><span>parameters</span><b>{p.params.toLocaleString()}</b></div><div><span>{p.accuracy_note ?? 'test accuracy'}</span><b>{(p.accuracy * 100).toFixed(1)}%</b></div></div>
            <p className="small mono">{FLOPS[net as DigitNet].split('≈').pop()?.trim()}<Hint>Work per image: {FLOPS[net as DigitNet]}. Computed in this page, on this device.</Hint></p>
          </div>
        )}
        <Empty />
        <Crumb />
        <Legend />
        <div className="stagebottom"><ZooTimeline /></div>
        <FirstVisit />
        {err && <div className="err">{err}</div>}
      </section>
      <aside className="inspector" aria-label="Network input and output">
        {net === 'llm' ? <ModelTools inspecting={!!inspect} /> : <div className="pane">
          <div className="stack">
            {!loaded && <p className="hint">Loading the networks…</p>}
            <DrawPad />
            <Gallery />
            <CompareCard />
            <StressCard />
            <Output />
            <CalcCard />
            <RobustCard />
            <p className="small">About these networks<Hint>All five learned from the same 1,500 digits. Compare how each one solves it.</Hint></p>
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
      <RunDock />
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
