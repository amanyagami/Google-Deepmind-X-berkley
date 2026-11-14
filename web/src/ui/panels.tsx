import { useEffect, useState } from 'react'
import { animate, motion } from 'framer-motion'
import { useStore, type Edit } from '../store'
import { DimBars, Heat, Hint, Spark, TopBars, showTok } from './charts'
import { RUNTIME_NAME, scoreRun } from '../hw/score'
import { useHW } from '../hw/hwStore'
import type { Fit, RunStats } from '../api'

const fmt = (n: number) => n.toLocaleString('en-US')
const bytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(1)} KB`)
const shortName = (n: string) => n.replace(/^(model\.|transformer\.)/, '')
const sci = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x === 0 ? '0' : x.toExponential(1))

/* ------------------------------------------------------------------ Model */
export function ModelPanel() {
  const { probe, probing, probeErr, mode } = useStore()
  if (probing) return <p className="hint">Reading the model header…<Hint>Only config.json and the safetensors header are fetched, not the weights.</Hint></p>
  if (probeErr) return <div className="err">{probeErr}</div>
  if (!probe) return <p className="hint">Paste a Hugging Face link above, or pick an example.</p>
  const g = probe.graph, d = g.dims, r = probe.read
  return (
    <div className="stack">
      <div>
        <h3 className="mono ttl">{g.repo}</h3>
        <div className="badges">
          <span className="badge on">{g.adapter}</span>
          <span className="badge">{g.class ?? g.model_type}</span>
          <span className={`badge ${g.runnable ? 'ok' : 'warn'}`}>{g.runnable ? 'live trace + edits' : 'structure + tensors only'}</span>
          {mode === 'replay' && <span className="badge warn">recorded run</span>}
        </div>
      </div>
      <dl className="kv">
        <div className="wide"><dt>Parameters</dt><dd className="big">{fmt(g.params)}</dd></div>
        {g.runnable && <>
          <div><dt>Layers</dt><dd>{d.L}</dd></div>
          <div><dt>Hidden size</dt><dd>{fmt(d.H)}</dd></div>
          <div><dt>Heads q / kv</dt><dd>{d.nh} / {d.nkv}</dd></div>
          <div><dt>MLP width</dt><dd>{fmt(d.I)}</dd></div>
          <div><dt>Vocabulary</dt><dd>{fmt(d.V)}</dd></div>
          <div><dt>Head size</dt><dd>{d.hd}</dd></div>
        </>}
        {g.stacks?.length > 1 && <div className="wide"><dt>Stacks</dt><dd>{g.stacks.map((s: any) => `${s.role} · ${s.count} blocks · ${fmt(s.params)}`).join('  |  ')}{g.connector ? `  |  connector · ${fmt(g.connector.params)}` : ''}</dd></div>}
        <div><dt>Tensors</dt><dd>{g.tensor_count}</dd></div>
        <div><dt>On disk</dt><dd>{bytes(g.bytes)}</dd></div>
      </dl>
      <div className="probe">
        <h4>What we read</h4>
        <p className="big2"><b>{r.requests}</b> requests · <b>{bytes(r.bytes)}</b> · <b>{r.weights_downloaded}</b> weights downloaded{r.seconds ? ` · ${r.seconds}s` : ''}</p>
        <ul className="log mono">
          {r.log.map((l: any, i: number) => <li key={i}><span>{l.what}</span><em>{bytes(l.bytes)}</em></li>)}
        </ul>
      </div>
      {g.notes.length > 0 && <p className="note">{g.notes[0]}{g.notes.length > 1 && <Hint label="More notes">{g.notes.slice(1).map((n: string, i: number) => <span key={i}>{n} </span>)}</Hint>}</p>}
    </div>
  )
}

/* -------------------------------------------------------------------- Run */
export function RunPanel() {
  const s = useStore()
  const { tokens, final, runErr, running, mode, edits, useEdits } = s
  const maxP = final ? Math.max(...final.topk.map((t: any) => t.p)) : 1
  return (
    <div className="stack">
      <label className="lbl" htmlFor="prompt">Prompt</label>
      <textarea id="prompt" rows={2} value={s.prompt} disabled={mode === 'replay'} onChange={(e) => s.setPrompt(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') s.run() }} />
      {mode === 'replay' && <p className="hint">Recorded run.<Hint>Start the backend to type your own prompt.</Hint></p>}
      <div className="row">
        <button className="btn" onClick={() => s.run()} disabled={running || !s.probe || !s.probe.graph.runnable}>{running ? 'Running…' : 'Run'}</button>
        {edits.length > 0 && (
          <label className="chk"><input type="checkbox" checked={useEdits} onChange={(e) => s.setUseEdits(e.target.checked)} /> apply {edits.length} edit{edits.length > 1 ? 's' : ''}</label>
        )}
      </div>
      {s.runStatus && <p className="hint">{s.runStatus}…{s.runStatus === 'Loading model' && <Hint>The first run downloads the weights.</Hint>}</p>}
      {runErr && <div className="err">{runErr}</div>}
      {tokens.length > 0 && (
        <div>
          <h4>Tokens <Hint>Click a token to choose the query position.</Hint></h4>
          <div className="toks">
            {tokens.map((t, i) => (
              <button key={i} className={`tok mono ${(s.qpos < 0 ? tokens.length - 1 : s.qpos) === i ? 'sel' : ''}`} onClick={() => s.setQpos(i)} title={`token ${i}`}>{showTok(t)}</button>
            ))}
          </div>
        </div>
      )}
      {final && (
        <div>
          <h4>Next token <small>· entropy {final.entropy} nats</small></h4>
          <TopBars items={final.topk} max={maxP} />
          <p className="verify">
            {final.verify?.attn_max_err !== null && final.verify?.attn_max_err !== undefined
              ? <>Attention rebuilt from q and k matches the model's own: max error <b>{sci(final.verify.attn_max_err)}</b> ✓</>
              : <>Recorded trace.</>}
            {' '}Forward pass {final.seconds}s.
          </p>
        </div>
      )}
      {!final && !running && !runErr && <p className="hint">Press Run.<Hint>Each layer streams in as the forward pass reaches it and lights up its block.</Hint></p>}
      {s.lastStats && !running && <RunScoreCard stats={s.lastStats} fit={s.fit} params={s.probe?.graph?.params ?? null} info={null} />}
    </div>
  )
}

/* ------------------------------------------------------------------ Layer */
export function LayerPanel() {
  const s = useStore()
  const { probe, selLayer: i, selHead, layers, tokens, scan } = s
  if (!probe) return null
  if (i === null) return <p className="hint">Click a block in the 3D view.<Hint>Heads are the small teeth on top of each attention plate.</Hint></p>
  const g = probe.graph, blk = g.blocks[i]
  const f = layers[i]
  const maxN = f ? Math.max(...f.resid_norm.map(Math.abs)) : 1
  const weights = [...blk.attn, ...blk.mlp, ...blk.norm].filter((t: any) => !t.buffer)
  return (
    <div className="stack">
      <h3 className="ttl">Block {i + 1} <small>of {g.blocks.length}</small></h3>
      {f ? (
        <div>
          <h4>Residual stream size per token <Hint>Measured after this block.</Hint></h4>
          <TopBars items={tokens.map((t, j) => ({ token: t, p: Math.abs(f.resid_norm[j]) }))} max={maxN} color="var(--pos)" />
          <p className="hint mono">attn +{f.attn_norm.at(-1).toFixed(2)} · MLP +{f.mlp_norm.at(-1).toFixed(2)}<Hint>What attention and the MLP add to the last token. Top MLP neuron: #{f.mlp.top[0][0]} ({f.mlp.top[0][1]}).</Hint></p>
        </div>
      ) : <p className="hint">Run a prompt to see this block's activations.</p>}

      {f && g.runnable && (
        <div>
          <h4>Attention heads <Hint>Rows are query tokens, columns are keys.</Hint></h4>
          <div className="heads">
            {f.attn.map((m: number[][], h: number) => {
              const imp = scan?.heads?.[i]?.[h]
              return (
                <button key={h} className={`head ${selHead === h ? 'sel' : ''}`} onClick={() => s.selectHead(h)} aria-pressed={selHead === h} aria-label={`Head ${h}`}>
                  <Heat data={m} size={64} mode="seq" max={1} />
                  <span className="mono">H{h}{imp !== undefined ? ` · ${imp >= 0 ? '−' : '+'}${Math.abs(imp * 100).toFixed(0)}pp` : ''}</span>
                </button>
              )
            })}
          </div>
          {selHead !== null && (
            <div className="row">
              <button className="btn" onClick={() => { s.setTab('calc'); s.fetchCalc() }}>Open the multiplication for head {selHead}</button>
              <button className="btn2" onClick={() => { s.addEdit({ type: 'ablate_head', layer: i, head: selHead }); s.setTab('edit') }}>Ablate it</button>
            </div>
          )}
        </div>
      )}

      <div>
        <h4>Tensors <Hint>Heatmaps read only the rows you ask for.</Hint></h4>
        <ul className="tensors">
          {weights.map((t: any) => {
            const loaded = s.tensors[t.name]
            return (
              <li key={t.name}>
                <div className="trow">
                  <span className="mono nm">{shortName(t.name).replace(/^(layers|h)\.\d+\./, '')}</span>
                  <span className="mono dim">{t.shape.join(' × ')} · {t.dtype}</span>
                  {t.shape.length === 2 && <button className="btn2 sm" onClick={() => s.openTensor(t.name)}>{loaded ? 'Reload' : 'Heatmap'}</button>}
                </div>
                {loaded && (
                  <div className="theat">
                    <Heat data={loaded.heat} size={200} />
                    <p className="hint mono">
                      read {loaded.rows_read}/{loaded.rows_total} rows · {bytes(loaded.fetched_bytes)} of {bytes(loaded.tensor_bytes)}<br />
                      mean {loaded.stats.mean} · std {loaded.stats.std} · range {loaded.stats.min}…{loaded.stats.max}
                    </p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {s.tensorErr && <div className="err">{s.tensorErr}</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- Calc */
export function CalcPanel() {
  const s = useStore()
  const c = s.calc
  const ready = s.selLayer !== null && s.selHead !== null
  return (
    <div className="stack">
      <p className="hint">
        {ready ? <>Layer <b>{s.selLayer! + 1}</b>, head <b>{s.selHead}</b>, query token <b className="mono">{showTok(s.tokens[(s.qpos < 0 ? s.tokens.length - 1 : s.qpos)] ?? '…')}</b>.</> : 'Pick a layer and a head in the Layer tab first.'}
        {s.edits.length > 0 && s.useEdits && ' Edits are applied.'}
      </p>
      <div className="row"><button className="btn" onClick={() => s.fetchCalc()} disabled={!ready || s.calcing}>{s.calcing ? 'Computing…' : 'Open the multiplication'}</button></div>
      {s.calcErr && <div className="err">{s.calcErr}</div>}
      {c && (() => {
        const sum = c.dim_products.reduce((a: number, b: number) => a + b, 0)
        const top = c.dim_products.map((v: number, d: number) => ({ v, d })).sort((a: any, b: any) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 4)
        return (
          <ol className="steps">
            <li>
              <h4>Query vector <small>q for “{c.query_token.trim()}”, {c.hd} dimensions</small></h4>
              <DimBars values={c.q} />
              <Hint>Projected from the residual stream by W<sub>q</sub>{s.probe?.graph.family === 'llama-like' ? ', then rotated by RoPE' : ''}.</Hint>
            </li>
            <li>
              <h4>Dot product with the key for “{c.top_key_token.trim()}” <small>each bar is q<sub>d</sub>·k<sub>d</sub> ÷ √{c.hd}</small></h4>
              <DimBars values={c.dim_products} />
              <p className="eq mono">
                {top.map((t: any, k: number) => <span key={k}>{k ? ' ' : ''}{t.v >= 0 ? '+' : '−'}{Math.abs(t.v).toFixed(2)}<sub>d{t.d}</sub></span>)} … Σ = <b>{sum.toFixed(3)}</b>
              </p>
            </li>
            <li>
              <h4>Scores → softmax <Hint>How much this token attends to each earlier token.</Hint></h4>
              <TopBars items={c.tokens.map((t: string, j: number) => ({ token: t, p: c.probs[j] }))} ghost={Object.fromEntries(c.tokens.map((t: string, j: number) => [t, c.model_probs[j]]))} max={Math.max(...c.probs, 0.01)} />
              <p className="hint mono">{c.scores.map((x: number) => x.toFixed(2)).join('  ')}<Hint>Raw scores. The white tick is the model's own attention weight.</Hint></p>
            </li>
            <li>
              <h4>Head output <small>Σ pⱼ · vⱼ, {c.hd} dimensions</small></h4>
              <DimBars values={c.out} />
              <Hint>This vector goes through W<sub>o</sub> and is added to the residual stream.</Hint>
            </li>
            <li className="ver">Rebuilt from q and k, the attention matches the model's own: max error <b>{sci(c.verify.max_abs_err)}</b> ✓</li>
          </ol>
        )
      })()}
    </div>
  )
}

/* ------------------------------------------------------------------- Edit */
function Diverge({ a, b }: { a: string; b: string }) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return <>{b.slice(0, n)}<mark>{b.slice(n)}</mark></>
}

const edLabel = (e: Edit) =>
  e.type === 'ablate_head' ? `ablate head L${e.layer! + 1}·H${e.head}` : e.type === 'ablate_mlp' ? `silence MLP L${e.layer! + 1}` :
  e.type === 'ablate_attn' ? `silence attention L${e.layer! + 1}` : e.type === 'zero_neuron' ? `zero neuron ${e.index} L${e.layer! + 1}` :
  e.type === 'scale_weight' ? `scale ${shortName(e.name!).replace(/^(layers|h)\./, 'L')} ×${e.factor}` : `set ${shortName(e.name!).replace(/^(layers|h)\./, 'L')}[${e.row},${e.col}] = ${e.value}`

export function EditPanel() {
  const s = useStore()
  const { probe, scan, compare: c, edits, mode } = s
  const [type, setType] = useState('ablate_head')
  const [layer, setLayer] = useState(0)
  const [head, setHead] = useState(0)
  const [idx, setIdx] = useState(0)
  const [factor, setFactor] = useState(2)
  const [tensor, setTensor] = useState('')
  const [row, setRow] = useState(0)
  const [col, setCol] = useState(0)
  const [val, setVal] = useState(1)
  if (!probe || !probe.graph.runnable) return <p className="hint">Edits need a model the backend can run.</p>
  const g = probe.graph, L = g.blocks.length
  const L0 = s.selLayer ?? layer
  const names = [...(g.blocks[Math.min(L0, L - 1)]?.attn ?? []), ...(g.blocks[Math.min(L0, L - 1)]?.mlp ?? [])].filter((t: any) => t.shape.length === 2 && !t.buffer).map((t: any) => t.name)
  const tname = names.includes(tensor) ? tensor : names[0]
  const add = () => {
    const l = Math.min(Math.max(0, L0), L - 1)
    const e: Edit = type === 'ablate_head' ? { type, layer: l, head: s.selHead ?? head } : type === 'zero_neuron' ? { type, layer: l, index: idx } :
      type === 'scale_weight' ? { type, name: tname, factor } : type === 'set_weight' ? { type, name: tname, row, col, value: val } : { type, layer: l }
    s.addEdit(e)
  }
  const maxP = c ? Math.max(...c.baseline.topk.map((t: any) => t.p), ...c.edited.topk.map((t: any) => t.p)) : 1
  const baseMap = c ? Object.fromEntries(c.baseline.topk.map((t: any) => [t.token, t.p])) : {}
  const top = scan ? scan.heads.flatMap((row: number[], l: number) => row.map((v, h) => ({ v, l, h }))).sort((a: any, b: any) => b.v - a.v).slice(0, 5) : []
  return (
    <div className="stack">
      <div>
        <h4>Which heads matter? <Hint>Ablate each head in turn and watch the answer change.</Hint></h4>
        <div className="row">
          <button className="btn2" onClick={() => s.runScan()} disabled={s.scanning}>{s.scanning ? 'Scanning every head…' : scan ? 'Re-scan' : 'Scan all heads'}</button>
          {scan && <label className="chk"><input type="checkbox" checked={s.showImportance} onChange={(e) => s.setShowImportance(e.target.checked)} /> show in 3D</label>}
        </div>
        {s.scanErr && <div className="err">{s.scanErr}</div>}
        {scan && (
          <>
            <p className="hint"><b className="mono">{showTok(scan.target)}</b> {(scan.p * 100).toFixed(1)}% · {scan.forward_passes} passes{scan.seconds ? ` · ${scan.seconds}s` : ''}<Hint>Brighter means ablating that head removes more of the answer.</Hint></p>
            <div className="hgrid" style={{ gridTemplateColumns: `repeat(${g.dims.nh}, 1fr)` }}>
              {scan.heads.map((row: number[], l: number) => row.map((v, h) => (
                <button key={`${l}-${h}`} className={`hc ${s.selLayer === l && s.selHead === h ? 'sel' : ''}`} title={`L${l + 1} H${h}: −${(Math.max(0, v) * 100).toFixed(1)} percentage points`}
                  style={{ background: `color-mix(in srgb, var(--pos) ${Math.round(Math.pow(Math.max(0, v) / s.scanMax, 0.6) * 100)}%, var(--surface))` }}
                  onClick={() => { s.selectLayer(l); s.selectHead(h); s.setTab('edit') }} aria-label={`Layer ${l + 1} head ${h}`} />
              )))}
            </div>
            <ul className="topheads">
              {top.map((t: any) => (
                <li key={`${t.l}-${t.h}`}><span className="mono">L{t.l + 1}·H{t.h}</span><span className="mono dim">−{(t.v * 100).toFixed(1)} pp</span>
                  <button className="btn2 sm" onClick={() => s.addEdit({ type: 'ablate_head', layer: t.l, head: t.h })}>Ablate</button></li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div>
        <h4>Edits <Hint>Applied to a copy; the original is restored after every call.</Hint></h4>
        {mode === 'live' ? (
          <div className="builder">
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Edit type">
              <option value="ablate_head">Ablate a head</option><option value="ablate_attn">Silence attention in a layer</option><option value="ablate_mlp">Silence the MLP in a layer</option>
              <option value="zero_neuron">Zero one MLP neuron</option><option value="scale_weight">Scale a weight tensor</option><option value="set_weight">Set one weight</option>
            </select>
            <label>layer <input type="number" min={1} max={L} value={L0 + 1} onChange={(e) => { setLayer(Math.max(0, +e.target.value - 1)); s.selectLayer(Math.max(0, Math.min(L - 1, +e.target.value - 1))); s.setTab('edit') }} /></label>
            {type === 'ablate_head' && <label>head <input type="number" min={0} max={g.dims.nh - 1} value={s.selHead ?? head} onChange={(e) => { setHead(+e.target.value); s.selectHead(+e.target.value) }} /></label>}
            {type === 'zero_neuron' && <label>neuron <input type="number" min={0} value={idx} onChange={(e) => setIdx(+e.target.value)} /></label>}
            {(type === 'scale_weight' || type === 'set_weight') && (
              <select value={tname} onChange={(e) => setTensor(e.target.value)} aria-label="Tensor">{names.map((n: string) => <option key={n} value={n}>{shortName(n)}</option>)}</select>
            )}
            {type === 'scale_weight' && <label>× <input type="number" step="0.1" value={factor} onChange={(e) => setFactor(+e.target.value)} /></label>}
            {type === 'set_weight' && <><label>row <input type="number" min={0} value={row} onChange={(e) => setRow(+e.target.value)} /></label><label>col <input type="number" min={0} value={col} onChange={(e) => setCol(+e.target.value)} /></label><label>value <input type="number" step="0.1" value={val} onChange={(e) => setVal(+e.target.value)} /></label></>}
            <button className="btn2" onClick={add}>Add edit</button>
          </div>
        ) : (
          <div className="chips2">
            {s.pack?.compares?.map((r: any, i: number) => <button key={i} className="btn2" onClick={() => s.showRecorded(i)}>{r.label}</button>)}
          </div>
        )}
        {edits.length > 0 && (
          <div className="chips2">
            {edits.map((e, i) => <span key={i} className="badge on">{edLabel(e)} <button aria-label="Remove edit" onClick={() => s.removeEdit(i)}>×</button></span>)}
            <button className="btn2 sm" onClick={() => s.clearEdits()}>Clear</button>
          </div>
        )}
        {mode === 'live' && <div className="row"><button className="btn" onClick={() => s.runCompare()} disabled={s.comparing || edits.length === 0}>{s.comparing ? 'Running both…' : 'Run A/B on the same prompt'}</button></div>}
        {mode === 'replay' && !c && <p className="hint">Recorded experiments.<Hint>Start the backend to build your own edits.</Hint></p>}
        {s.compareErr && <div className="err">{s.compareErr}</div>}
      </div>

      {c && (
        <div className="ab">
          <div className="abhead"><span className={`badge ${c.diff.top1_changed ? 'warn' : 'ok'}`}>{c.diff.top1_changed ? 'top answer changed' : 'top answer unchanged'}</span><span className="mono dim">KL {c.diff.kl}</span></div>
          <div className="abcols">
            <div><h4>Original</h4><TopBars items={c.baseline.topk} max={maxP} /><p className="gen mono">{c.baseline.generation}</p></div>
            <div><h4>Edited</h4><TopBars items={c.edited.topk} ghost={baseMap} max={maxP} color="var(--pos)" /><p className="gen mono"><Diverge a={c.baseline.generation} b={c.edited.generation} /></p></div>
          </div>
          <h4>Where the edit ripples <Hint>Relative change in the residual stream, layer by layer.</Hint></h4>
          <Spark values={c.diff.layer_drift} label="Relative change in the residual stream per layer" />
          <h4>Biggest movers</h4>
          <table className="movers mono"><tbody>{c.diff.movers.slice(0, 6).map((m: any) => (
            <tr key={m.id}><td>{showTok(m.token)}</td><td>{(m.p_base * 100).toFixed(1)}%</td><td>→</td><td>{(m.p_edit * 100).toFixed(1)}%</td><td className={m.delta >= 0 ? 'up' : 'down'}>{m.delta >= 0 ? '+' : '−'}{Math.abs(m.delta * 100).toFixed(1)}pp</td></tr>
          ))}</tbody></table>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- Run score */
function Count({ value }: { value: number }) {
  const [v, setV] = useState(0)
  useEffect(() => { const a = animate(0, value, { duration: 0.9, ease: 'easeOut', onUpdate: (x) => setV(Math.round(x)) }); return () => a.stop() }, [value])
  return <>{v}</>
}

/** How well this computer ran this model: hero number on an arc gauge, tier, four part bars. Reuses .gauge / .gnum. */
export function RunScoreCard({ stats, fit, params, info: infoIn }: { stats: RunStats | null | undefined; fit: Fit | null; params: number | null; info: any | null }) {
  const live = useHW((h) => h.info)
  const info = infoIn ?? live
  if (!stats) return <div className="stack"><p className="hint">Run a model to score this computer.<Hint>The score compares speed, response time, energy and memory room with a reference run.</Hint></p></div>
  const r = scoreRun(stats, fit, { params, info })
  const size = 150, rad = size / 2 - 12, c = size / 2
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2
  const pt = (a: number) => `${c + rad * Math.cos(a)} ${c + rad * Math.sin(a)}`
  const arc = `M ${pt(a0)} A ${rad} ${rad} 0 1 1 ${pt(a1)}`
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'center', gap: 14 }}>
        <div className="gauge" style={{ width: size, height: size * 0.9 }}>
          <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`Run score ${r.overall}, ${r.tier}`}>
            <path d={arc} fill="none" stroke="var(--line)" strokeWidth={9} strokeLinecap="round" />
            <motion.path d={arc} fill="none" stroke="var(--pos)" strokeWidth={9} strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: Math.min(1, r.overall / 2000) }}
              transition={{ type: 'spring', stiffness: 60, damping: 16 }} style={{ filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--pos) 60%, transparent))' }} />
          </svg>
          <div className="gnum"><b><Count value={r.overall} /></b><span>{r.tier}</span></div>
        </div>
        <div>
          <div className="mono ttl">{stats.repo.split('/').pop()}</div>
          <div className="badges"><span className="badge on">{RUNTIME_NAME[stats.where]}</span><span className="badge">{stats.task}</span></div>
        </div>
      </div>
      {[r.parts.filter((p) => p.id === 'speed' || p.id === 'response'), r.parts.filter((p) => p.id === 'efficiency' || p.id === 'headroom')].map((group, gi) => (
        <ul key={gi} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }} aria-label={gi ? 'Shown apart, not in the score' : 'In the score'}>
          {group.map((p) => (
            <li key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                <span>{gi ? '○ ' : '▲ '}{p.label}<Hint label={`How ${p.label} is scored`}><span className="mono">{p.detail}</span></Hint></span>
                <span className="mono dim">{p.id === 'efficiency' && stats.estimatedEnergy && p.score !== null ? '≈ ' : ''}{p.value}</span>
                <b className="mono">{p.score === null ? '—' : p.score}</b>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: 'var(--line)', overflow: 'hidden', marginTop: 3 }}>
                <motion.div initial={{ width: 0 }} animate={{ width: `${p.score === null ? 0 : Math.min(100, p.score / 20)}%` }} transition={{ type: 'spring', stiffness: 60, damping: 16 }}
                  style={{ height: '100%', background: gi ? 'repeating-linear-gradient(90deg, var(--neg) 0 6px, transparent 6px 9px)' : 'var(--pos)' }} />
              </div>
            </li>
          ))}
        </ul>
      ))}
      <p className="hint">{r.summary}<Hint label="Reference">{r.reference}. 1000 is the reference. A full bar is 2000. Speed counts 65 %, response 35 %. Memory fit and energy are shown apart.</Hint></p>
    </div>
  )
}
