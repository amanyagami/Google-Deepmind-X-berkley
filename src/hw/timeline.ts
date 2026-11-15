// The whole journey is a pure function of one number: the playhead (visual seconds).
// Scrubbing, rewinding and pausing therefore always show a consistent picture.
// Visual durations are a storytelling choice; every number shown comes from a real measurement.

export type StageId = 'input' | 'send' | 'tokenize' | 'embed' | 'blocks' | 'logits' | 'pick' | 'output' | 'decode'
export interface Seg { id: StageId; label: string; short: string; v0: number; v1: number }
export interface Timeline { segs: Seg[]; total: number }

const DUR: Record<string, number> = { input: 2.6, send: 1.6, tokenize: 2.4, embed: 2.4, logits: 2.8, pick: 1.8, output: 2.4, decode: 4.2 }
/** Long and short name of each journey stage. */
export const LABEL: Record<StageId, [string, string]> = {
  input: ['You type', 'Type'], send: ['Hand to the program', 'Send'], tokenize: ['Cut into tokens', 'Tokenize'], embed: ['Look up meanings', 'Embed'],
  blocks: ['Think, block by block', 'Blocks'], logits: ['Score every word', 'Score'], pick: ['Pick the next word', 'Pick'], output: ['Back to your screen', 'Show'],
  decode: ['Repeat for more words', 'Repeat'],
}

export function buildTimeline(L: number, expanded: boolean): Timeline {
  const order: StageId[] = ['input', 'send', 'tokenize', 'embed', 'blocks', 'logits', 'pick', 'output', 'decode']
  let t = 0
  const segs: Seg[] = order.map((id) => {
    const d = id === 'blocks' ? (expanded ? Math.max(6, L * 1.1) : 5.0) : DUR[id]
    const s = { id, label: LABEL[id][0], short: LABEL[id][1], v0: t, v1: t + d }
    t += d
    return s
  })
  return { segs, total: t }
}

export function locate(tl: Timeline, t: number) {
  const i = Math.max(0, tl.segs.findIndex((s) => t < s.v1))
  const seg = tl.segs[i === -1 ? tl.segs.length - 1 : i]
  return { i, seg, p: Math.min(1, Math.max(0, (t - seg.v0) / (seg.v1 - seg.v0))) }
}

const cache = new WeakMap<object, Map<number, any[]>>()
export function layerOps(j: any, layer: number, phase: 'prefill' | 'decode' = 'prefill'): any[] {
  const key = j[phase]
  let m = cache.get(key)
  if (!m) {
    m = new Map()
    for (const o of j[phase].ops) { if (!m.has(o.layer)) m.set(o.layer, []); m.get(o.layer)!.push(o) }
    cache.set(key, m)
  }
  return m.get(layer) ?? []
}

/** Which layer and which operation are running at progress p through the "blocks" stage. */
export function blockAt(j: any, p: number) {
  const L = j.L
  const layer = Math.min(L - 1, Math.floor(p * L))
  const q = p * L - layer
  const ops = layerOps(j, layer)
  const w = ops.map((o) => Math.pow(Math.max(o.ms, 0.02), 0.6))
  const tot = w.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  for (let k = 0; k < ops.length; k++) {
    acc += w[k] / tot
    if (q <= acc || k === ops.length - 1) return { layer, op: ops[k], opP: Math.min(1, Math.max(0, 1 - (acc - q) / (w[k] / tot))), ops }
  }
  return { layer, op: null, opP: 0, ops }
}

export interface Peaks { gflops: number; gbps: number }
export interface Activity {
  stage: StageId
  p: number
  flow: Record<string, number> // 0..1 per link
  cores: number[] // 0..1 per physical core
  l3: number
  ram: number
  gpu: number
  typed: number // characters of the prompt typed so far
  shown: number // generated tokens shown on the display
  hud: string
  op?: any
  layer?: number
}

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const NCORE = 8

export function activityAt(j: any, tl: Timeline, t: number, peaks: Peaks, ncores = NCORE): Activity {
  const { seg, p } = locate(tl, t)
  const a: Activity = { stage: seg.id, p, flow: {}, cores: new Array(ncores).fill(0), l3: 0, ram: 0, gpu: 0, typed: 0, shown: 0, hud: seg.label }
  if (!j) return a
  const chars = j.input.text.length
  const sq = (v: number) => Math.sqrt(clamp(v))
  switch (seg.id) {
    case 'input': a.typed = Math.ceil(clamp(p / 0.85) * chars); a.flow.usb = 0.25 + 0.2 * Math.sin(p * 40); a.hud = `typing · ${a.typed}/${chars} characters`; break
    case 'send': a.typed = chars; a.flow.usb = 1; a.hud = `${j.input.utf8_bytes} bytes travel to the program`; break
    case 'tokenize': a.typed = chars; a.cores[0] = 0.9; a.l3 = 0.2; a.ram = 0.1; a.hud = `tokenizer · ${j.tokenize.tokens.length} tokens · ${j.tokenize.us} µs`; break
    case 'embed': a.typed = chars; a.flow.ddr = 0.55 + 0.4 * Math.sin(p * 18) ** 2; a.cores[0] = 0.5; a.cores[1] = 0.3; a.ram = 0.6; a.hud = `embedding lookup · ${j.tokenize.tokens.length} rows from RAM`; break
    case 'blocks': {
      const b = blockAt(j, p)
      a.layer = b.layer; a.op = b.op
      if (b.op) {
        const memory = clamp(b.op.gbps / Math.max(1, peaks.gbps))
        const comp = clamp(b.op.gflops / Math.max(1, peaks.gflops))
        a.flow.ddr = b.op.wbytes > 0 ? 0.35 + 0.65 * sq(memory * 1.4) : 0.08
        a.ram = a.flow.ddr
        a.l3 = 0.3 + 0.5 * sq(memory)
        const act = b.op.kind === 'matmul' ? 0.35 + 0.65 * sq(comp * 2.2) : 0.18
        for (let k = 0; k < ncores; k++) a.cores[k] = act * (0.85 + 0.15 * Math.sin(t * 9 + k))
        a.hud = `block ${b.layer + 1}/${j.L} · ${b.op.name} · ${b.op.ms.toFixed(2)} ms`
      }
      a.typed = chars
      break
    }
    case 'logits': {
      const op = layerOps(j, j.L, 'decode').find((o) => o.name === 'lm_head') ?? null
      a.op = op; a.flow.ddr = 0.95; a.ram = 0.95; a.l3 = 0.7
      for (let k = 0; k < ncores; k++) a.cores[k] = 0.7 + 0.2 * Math.sin(t * 7 + k)
      a.hud = op ? `lm_head · ${(op.wbytes / 1e6).toFixed(0)} MB read · ${op.ms.toFixed(2)} ms` : 'scoring the vocabulary'
      a.typed = chars
      break
    }
    case 'pick': a.cores[0] = 0.8; a.l3 = 0.1; a.hud = `softmax · picked “${j.sample.chosen.trim()}” · ${j.sample.us} µs`; a.typed = chars; break
    case 'output': a.flow.vid = 1; a.typed = chars; a.shown = 1; a.hud = `text goes back to the screen · ${j.detok.us} µs`; break
    case 'decode': {
      const n = j.decode.tokens.length
      a.shown = 1 + Math.floor(clamp(p) * (n - 1)); a.typed = chars
      const pulse = 0.5 + 0.5 * Math.sin(p * 90)
      a.flow.ddr = 0.55 + 0.45 * pulse; a.ram = a.flow.ddr; a.l3 = 0.6
      for (let k = 0; k < ncores; k++) a.cores[k] = 0.5 + 0.4 * pulse
      a.flow.vid = 0.4 + 0.4 * (1 - pulse)
      a.hud = `${j.decode.tps} tokens/s · ${j.decode.effective_gbps} GB/s from RAM`
      break
    }
  }
  return a
}

const fmtB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`)
const fmtF = (f: number) => (f >= 1e9 ? `${(f / 1e9).toFixed(2)} GFLOP` : `${(f / 1e6).toFixed(1)} MFLOP`)

/** While a benchmark runs, the machine lights up the part being measured. */
export function benchActivity(stage: string, ncores: number, live: number): Activity {
  const a: Activity = { stage: 'blocks', p: 0, flow: {}, cores: new Array(ncores).fill(0), l3: 0, ram: 0, gpu: 0, typed: 0, shown: 0, hud: '' }
  const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 90)
  if (stage === 'matmul_1') { a.cores[0] = pulse; a.l3 = 0.2 }
  else if (stage === 'matmul_n') a.cores.fill(pulse)
  else if (stage === 'dram') { a.flow.ddr = pulse; a.ram = pulse; a.l3 = 0.5; a.cores.fill(0.35) }
  else if (stage === 'cache') { a.cores[0] = pulse; a.l3 = pulse }
  else if (stage === 'disk') { a.flow.ssd = pulse; a.ram = 0.3 }
  else if (stage === 'net') { a.flow.nic = pulse; a.flow.wan = pulse }
  else if (stage === 'gpu') { a.gpu = pulse; a.ram = 0.3 + 0.3 * live }
  else if (stage === 'ai_load') { a.flow.ssd = pulse; a.ram = 0.5 }
  else if (stage === 'ai') { a.cores.fill(0.7 * pulse); a.flow.ddr = pulse; a.ram = pulse; a.l3 = 0.6 }
  return a
}

export interface Caption { title: string; text: string; nums: { k: string; v: string }[]; dive?: { path: string[]; label: string } }

export function captionFor(j: any, a: Activity, peaks: Peaks, info: any): Caption {
  const d = j.dims
  const tokens = j.tokenize.tokens.length
  const dec = j.decode, pre = j.prefill
  switch (a.stage) {
    case 'input':
      return { title: 'You type', text: 'Every key press is a tiny electrical signal. The keyboard sends it to the computer, and the operating system turns it into letters.',
        nums: [{ k: 'characters', v: String(j.input.chars) }, { k: 'bytes (UTF-8)', v: String(j.input.utf8_bytes) }] }
    case 'send':
      return { title: 'Text handed to the model program', text: 'The browser passes your text to the program running the model on this same PC. It never leaves the machine; it is just memory handed from one program to another.',
        nums: [{ k: 'bytes sent', v: String(j.input.utf8_bytes) }, { k: 'network used', v: 'none (localhost)' }] }
    case 'tokenize':
      return { title: 'CPU cuts the text into tokens', text: 'A model cannot read letters. A tokenizer cuts the text into pieces it knows, called tokens, and swaps each for an ID number. One CPU core does this in microseconds.',
        nums: [{ k: 'tokens', v: String(tokens) }, { k: 'vocabulary', v: j.tokenize.vocab.toLocaleString() }, { k: 'time (measured)', v: `${j.tokenize.us} µs` }], dive: { path: ['cpu'], label: 'Look inside the CPU' } }
    case 'embed': {
      const e = pre.ops.find((o: any) => o.name === 'embed')
      return { title: 'Each token picks a row from a table', text: `The table has ${d.V.toLocaleString()} rows and ${d.H} columns and lives in RAM. The chosen row is the token's meaning as ${d.H} numbers.`,
        nums: [{ k: 'rows read', v: String(tokens) }, { k: 'bytes read', v: fmtB(tokens * d.H * 4) }, { k: 'time (measured)', v: e ? `${e.ms.toFixed(3)} ms` : 'n/a' }], dive: { path: ['ram'], label: 'Look inside the RAM' } }
    }
    case 'blocks': {
      const op = a.op
      return { title: `Thinking: block ${(a.layer ?? 0) + 1} of ${j.L}`, text: 'Each block first lets the words look at each other (attention), then thinks about each word on its own (MLP). Every step is a matrix multiplication whose weights must be streamed in from RAM.',
        nums: [{ k: 'now', v: op ? op.name : '…' }, { k: 'this op', v: op ? `${op.ms.toFixed(2)} ms · ${op.gbps} GB/s` : '…' }, { k: 'all blocks', v: `${fmtF(pre.flops)} · ${pre.total_ms.toFixed(0)} ms` }, { k: 'weights streamed', v: fmtB(pre.wbytes) }],
        dive: { path: ['cpu', 'core0'], label: 'Zoom into one multiplication' } }
    }
    case 'logits': {
      const op = a.op
      return { title: 'Score every word', text: `The final vector is compared with all ${d.V.toLocaleString()} words at once. It is the biggest single matrix in the model, so it is the biggest single read from RAM.`,
        nums: [{ k: 'matrix', v: `${d.V.toLocaleString()} × ${d.H}` }, { k: 'read from RAM', v: op ? fmtB(op.wbytes) : 'n/a' }, { k: 'time (measured)', v: op ? `${op.ms.toFixed(2)} ms` : 'n/a' }], dive: { path: ['ram'], label: 'Look inside the RAM' } }
    }
    case 'pick':
      return { title: 'Pick the likeliest word', text: 'Softmax turns the scores into probabilities that add up to 100%. The model takes the most likely word.',
        nums: [...j.sample.top.slice(0, 3).map((t: any) => ({ k: t.token.trim() || '·', v: `${(t.p * 100).toFixed(1)}%` })), { k: 'time (measured)', v: `${j.sample.us} µs` }] }
    case 'output':
      return { title: 'The word goes back to your screen', text: 'The token ID becomes text again, goes back to the browser, and the graphics hardware draws it as pixels.',
        nums: [{ k: 'text', v: j.sample.chosen.trim() }, { k: 'time (measured)', v: `${j.detok.us} µs` }] }
    case 'decode': {
      const pctPeak = peaks.gbps ? Math.round((100 * dec.effective_gbps) / peaks.gbps) : null
      return { title: 'Repeat for every new word', text: 'The model reuses what it already computed (the KV cache), but each new word still needs every weight again. That makes writing speed a question of how fast RAM can deliver data.',
        nums: [{ k: 'speed', v: `${dec.tps} tokens/s` }, { k: 'weights per token', v: fmtB(dec.weight_bytes) }, { k: 'RAM throughput', v: `${dec.effective_gbps} GB/s${pctPeak !== null ? ` (${pctPeak}% of measured peak)` : ''}` }],
        dive: { path: ['ram'], label: 'Why RAM is the limit' } }
    }
  }
}
