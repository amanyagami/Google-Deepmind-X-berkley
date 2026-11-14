import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ZooScene } from './ZooScene'
import { FLOPS, isNeutral, readDigit } from './nets'
import { locateZ, NETS, STAGES, totalZ, useZoo, type DigitNet, type NetId } from './zooStore'
import { useStore } from '../store'
import { CalcPanel, EditPanel, LayerPanel, ModelPanel, RunPanel } from '../ui/panels'

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
        <p className="hint small">Draw a digit with the mouse. Every network recomputes as you draw.</p>
        {stressed && <div className="seen"><canvas ref={seen} width={96} height={96} aria-label="What the networks see after the stress test" /><span className="hint small">what the networks see</span></div>}
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
        <p className="hint small">Each word is chosen from {pack.vocab!.length} possible words, given the image tokens and the words written so far. {label !== null ? `This test image is a ${label}.` : ''}</p>
      </div>
    )
  }
  const best = out.probs.indexOf(Math.max(...out.probs))
  return (
    <div className="ccard">
      <h4>Prediction <small>{label !== null ? `the test image is a ${label}` : 'your drawing'}</small></h4>
      <div className="probs">{out.probs.map((p: number, i: number) => <div key={i} className={i === best ? 'on' : ''}><i style={{ height: `${Math.max(2, p * 100)}%` }} /><span>{i}</span></div>)}</div>
      <p className="hint small">{best} with {(out.probs[best] * 100).toFixed(1)}% confidence.</p>
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
      {T.zeros > 0 && <p className="hint small">{T.zeros} inputs were exactly 0 and add nothing.</p>}
      {note && <p className="hint small">{note}</p>}
    </>
  )
}

function CalcCard() {
  const { net, out, pack, sel } = useZoo(useShallow((s) => ({ net: s.net, out: s.out, pack: s.packs[s.net], sel: s.sel })))
  if (!out || !pack) return null
  if (!sel) return <div className="ccard"><h4>How is a number computed?</h4><p className="hint">Double-click any neuron, cell or token in the 3D view to see the arithmetic behind it, with the real numbers.</p></div>
  const w = pack.weights
  let body: any = <p className="hint">This is an input value: {f(out.input?.[sel.index] ?? 0)} (the brightness of that pixel, 0 to 1).</p>
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
        <p className="hint small">The same 3×3 filter slides over every position: this map is that one filter's answer everywhere.</p>
      </>
    )
  } else if (net === 'rnn' && sel.layer?.startsWith('h')) {
    const t = +sel.layer.slice(1), j = sel.index, g = out.gates[t], hp = t ? out.hidden[t - 1][j] : 0
    body = (
      <>
        <h4>Memory unit {j} after row {t + 1}</h4>
        <ul className="facts mono">
          <li><span>reset gate r</span><b>{f(g.r[j])}</b><em className="hint small">how much of the old memory to use when forming the new candidate</em></li>
          <li><span>update gate z</span><b>{f(g.z[j])}</b><em className="hint small">how much of the old memory to keep</em></li>
          <li><span>candidate n</span><b>{f(g.n[j])}</b><em className="hint small">tanh(new row · weights + r × old memory · weights)</em></li>
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
        <p className="hint small">It compares its query with every token's key (dot product ÷ √8), turns the scores into weights with softmax, and takes the weighted average of their values.</p>
        {rows.map((r: any[], h: number) => <p key={h} className="mono small">head {h + 1}: {r.map((q) => `${q.j === 0 ? 'summary' : 'patch ' + (q.j - 1)} ${(q.a * 100).toFixed(0)}%`).join(' · ')}</p>)}
        <p className="hint small">The arcs show this token's attention. Double-click another token to switch.</p>
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
      <p className="hint small">While choosing it, head 1 put {(img[0] * 100).toFixed(0)}% and head 2 {(img[1] * 100).toFixed(0)}% of their attention on the image tokens; the rest went to the words already written. Scrub the timeline to watch each word being chosen.</p>
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
      <h4>All five networks <small>{digits.length < 5 ? 'loading…' : agree ? `all read a ${digits[0]}` : 'they disagree'}</small></h4>
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
      <p className="hint small">Computed live in this page as you draw. Times are measured here, averaged over {timing.mlp?.n ?? '…'}+ runs; the VLM's time is for writing its whole caption. Click a row to see that network in 3D.</p>
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
      <h4>Stress test <small>{off ? 'the clean image' : 'every network sees the changed image'}</small></h4>
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
      <p className="hint small">A CNN's filters slide, so it often survives a shift that breaks the MLP, which ties each weight to one fixed pixel.</p>
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
      <h4>Which network is most robust? <small>accuracy on {sweep?.n ?? 48} test digits as noise rises</small></h4>
      {!sweep ? (
        <>
          <p className="hint small">Runs all five networks on every test digit at six noise levels (three noise draws each), in this page.</p>
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
          <p className="hint small">The VLM counts as right when the number word in its caption is the right digit.</p>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------------------- view */
export function ZooView() {
  const { net, packs, err } = useZoo(useShallow((s) => ({ net: s.net, packs: s.packs, err: s.err })))
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { useZoo.getState().init().then(() => setLoaded(true)) }, [])
  const p = net === 'llm' ? undefined : packs[net]
  const repo = useStore((s) => s.repo)
  const short = repo ? repo.split('/').pop()! : 'This model'
  return (
    <main className="main machine zoo">
      <section className="stage" aria-label={`3D view of a ${p?.title ?? 'network'}`}>
        <ZooScene />
        <div className="vswitch seg zoonets" role="group" aria-label="Network">
          <button className={`real ${net === 'llm' ? 'on' : ''}`} onClick={() => useZoo.getState().setNet('llm')} title="The model loaded at the top, on your prompt">{short}</button>
          {NETS.map((n) => <button key={n.id} className={net === n.id ? 'on' : ''} onClick={() => useZoo.getState().setNet(n.id as NetId)} title="A tiny network that reads 8×8 handwritten digits">{n.short}</button>)}
        </div>
        {p && (
          <div className="phud zoohud">
            <p className="eyebrow">{p.title}</p>
            <p className="small">{p.blurb}</p>
            <div className="prow mono"><div><span>parameters</span><b>{p.params.toLocaleString()}</b></div><div><span>{p.accuracy_note ?? 'test accuracy'}</span><b>{(p.accuracy * 100).toFixed(1)}%</b></div></div>
            <p className="hint small">Work per image: {FLOPS[net as DigitNet]}. Computed in this page, on this device.</p>
          </div>
        )}
        <div className="stagebottom"><ZooTimeline /></div>
        {err && <div className="err">{err}</div>}
      </section>
      <aside className="inspector" aria-label="Network input and output">
        {net === 'llm' ? <ModelTools /> : <div className="pane">
          <div className="stack">
            {!loaded && <p className="hint">Loading the networks…</p>}
            <DrawPad />
            <Gallery />
            <CompareCard />
            <StressCard />
            <Output />
            <CalcCard />
            <RobustCard />
            <p className="hint small">All five were trained on the same 1,500 handwritten digits (scikit-learn's 8×8 set) by server/train_zoo.py, so you can compare how each kind of network solves the same problem. The browser's arithmetic is checked against PyTorch's by tests/zoo.test.ts.</p>
          </div>
        </div>}
      </aside>
    </main>
  )
}


const TOOLS = [['model', 'Model'], ['run', 'Run'], ['layer', 'Layer'], ['calc', 'Calculate'], ['edit', 'Edit & compare']] as const
/** The real model's tools: its structure, the run on the shared prompt, one layer, one calculation, and edits. */
function ModelTools() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  return (
    <>
      <div className="tabs" role="tablist">{TOOLS.map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
      <div className="pane" role="tabpanel">
        {tab === 'model' && <ModelPanel />}{tab === 'run' && <RunPanel />}{tab === 'layer' && <LayerPanel />}{tab === 'calc' && <CalcPanel />}{tab === 'edit' && <EditPanel />}
      </div>
    </>
  )
}
