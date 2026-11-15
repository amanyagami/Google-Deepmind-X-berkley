// Forward passes of the five zoo networks, in plain TypeScript, returning every intermediate value.
// The math mirrors PyTorch exactly (server/train_zoo.py); zoo.test.ts checks it against PyTorch's own activations.

import type { DigitNet as NetId } from './zooStore'

export type W = Record<string, { shape: number[]; data: number[] }>
export interface Pack { name: string; title: string; blurb: string; accuracy: number; params: number; weights: W; vocab?: string[]; reference: any[]; accuracy_note?: string }

const relu = (v: number) => (v > 0 ? v : 0)
const sigmoid = (v: number) => 1 / (1 + Math.exp(-v))
const gelu = (x: number) => 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x ** 3)))

/** y = W x + b for a PyTorch Linear (weight shape [out, in]). */
export function linear(w: W, name: string, x: ArrayLike<number>): number[] {
  const { shape: [o, i], data } = w[`${name}.weight`]
  const b = w[`${name}.bias`]?.data
  const y = new Array(o)
  for (let r = 0; r < o; r++) { let s = b ? b[r] : 0; const off = r * i; for (let c = 0; c < i; c++) s += data[off + c] * x[c]; y[r] = s }
  return y
}

function layerNorm(w: W, name: string, x: number[]): number[] {
  const n = x.length, m = x.reduce((a, b) => a + b, 0) / n
  const v = x.reduce((a, b) => a + (b - m) ** 2, 0) / n
  const g = w[`${name}.weight`].data, b = w[`${name}.bias`].data
  return x.map((t, k) => ((t - m) / Math.sqrt(v + 1e-5)) * g[k] + b[k])
}

export function softmax(x: number[]): number[] {
  const m = Math.max(...x); const e = x.map((t) => Math.exp(t - m)); const s = e.reduce((a, b) => a + b, 0)
  return e.map((t) => t / s)
}

/* ---------------------------------------------------------------------------------------- MLP */
export function mlp(w: W, img: number[]) {
  const input = img.slice(0, 64)
  const z1 = linear(w, 'fc1', input), h1 = z1.map(relu)
  const z2 = linear(w, 'fc2', h1), h2 = z2.map(relu)
  const logits = linear(w, 'fc3', h2)
  return { input, z1, h1, z2, h2, logits, probs: softmax(logits) }
}

/* ---------------------------------------------------------------------------------------- CNN */
function conv3(w: W, name: string, x: number[], cin: number, n: number) {
  const { shape: [cout], data } = w[`${name}.weight`], b = w[`${name}.bias`].data
  const out = new Array(cout * n * n).fill(0)
  for (let o = 0; o < cout; o++) for (let y = 0; y < n; y++) for (let xx = 0; xx < n; xx++) {
    let s = b[o]
    for (let c = 0; c < cin; c++) for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) {
      const iy = y + ky - 1, ix = xx + kx - 1
      if (iy < 0 || ix < 0 || iy >= n || ix >= n) continue
      s += data[((o * cin + c) * 3 + ky) * 3 + kx] * x[(c * n + iy) * n + ix]
    }
    out[(o * n + y) * n + xx] = relu(s)
  }
  return out
}
function pool2(x: number[], ch: number, n: number) {
  const m = n / 2, out = new Array(ch * m * m)
  for (let c = 0; c < ch; c++) for (let y = 0; y < m; y++) for (let xx = 0; xx < m; xx++) {
    const at = (yy: number, xq: number) => x[(c * n + yy) * n + xq]
    out[(c * m + y) * m + xx] = Math.max(at(2 * y, 2 * xx), at(2 * y, 2 * xx + 1), at(2 * y + 1, 2 * xx), at(2 * y + 1, 2 * xx + 1))
  }
  return out
}
export function cnn(w: W, img: number[]) {
  const input = img.slice(0, 64)
  const conv1 = conv3(w, 'c1', input, 1, 8), pool1 = pool2(conv1, 8, 8)
  const conv2 = conv3(w, 'c2', pool1, 8, 4), pool2_ = pool2(conv2, 16, 4)
  const logits = linear(w, 'fc', pool2_)
  return { input, conv1, pool1, conv2, pool2: pool2_, logits, probs: softmax(logits) }
}

/* ---------------------------------------------------------------------------------------- RNN */
export function rnn(w: W, img: number[]) {
  const H = 24, input = img.slice(0, 64)
  const Wi = w['gru.weight_ih'].data, Wh = w['gru.weight_hh'].data, bi = w['gru.bias_ih'].data, bh = w['gru.bias_hh'].data
  let h = new Array(H).fill(0)
  const hidden: number[][] = [], gates: { r: number[]; z: number[]; n: number[] }[] = []
  for (let t = 0; t < 8; t++) {
    const x = input.slice(t * 8, t * 8 + 8)
    const gi = (row: number) => { let s = bi[row]; for (let c = 0; c < 8; c++) s += Wi[row * 8 + c] * x[c]; return s }
    const gh = (row: number) => { let s = bh[row]; for (let c = 0; c < H; c++) s += Wh[row * H + c] * h[c]; return s }
    const r: number[] = [], z: number[] = [], n: number[] = []
    for (let k = 0; k < H; k++) { r.push(sigmoid(gi(k) + gh(k))); z.push(sigmoid(gi(H + k) + gh(H + k))) }
    for (let k = 0; k < H; k++) n.push(Math.tanh(gi(2 * H + k) + r[k] * gh(2 * H + k)))
    h = h.map((hp, k) => (1 - z[k]) * n[k] + z[k] * hp)
    hidden.push(h); gates.push({ r, z, n })
  }
  const logits = linear(w, 'fc', h)
  return { input, hidden, gates, logits, probs: softmax(logits) }
}

/* -------------------------------------------------------------------------------- transformers */
function patches(img: number[]) {
  const out: number[][] = []
  for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) out.push([img[(2 * py) * 8 + 2 * px], img[(2 * py) * 8 + 2 * px + 1], img[(2 * py + 1) * 8 + 2 * px], img[(2 * py + 1) * 8 + 2 * px + 1]])
  return out
}

/** One pre-norm block. allowed(i, j): may position i attend to position j. */
function block(w: W, p: string, x: number[][], heads: number, allowed: (i: number, j: number) => boolean) {
  const T = x.length, D = x[0].length, hd = D / heads
  const qkv = x.map((t) => linear(w, `${p}.qkv`, layerNorm(w, `${p}.ln1`, t)))
  const attn: number[][][] = []
  const mixed = x.map(() => new Array(D).fill(0))
  for (let h = 0; h < heads; h++) {
    const A: number[][] = []
    for (let i = 0; i < T; i++) {
      const s: number[] = []
      for (let j = 0; j < T; j++) {
        if (!allowed(i, j)) { s.push(-Infinity); continue }
        let d = 0; for (let k = 0; k < hd; k++) d += qkv[i][h * hd + k] * qkv[j][D + h * hd + k]
        s.push(d / Math.sqrt(hd))
      }
      const a = softmax(s); A.push(a)
      for (let j = 0; j < T; j++) if (a[j]) for (let k = 0; k < hd; k++) mixed[i][h * hd + k] += a[j] * qkv[j][2 * D + h * hd + k]
    }
    attn.push(A)
  }
  const afterAttn = x.map((t, i) => { const o = linear(w, `${p}.proj`, mixed[i]); return t.map((v, k) => v + o[k]) })
  const out = afterAttn.map((t) => { const m = linear(w, `${p}.fc2`, linear(w, `${p}.fc1`, layerNorm(w, `${p}.ln2`, t)).map(gelu)); return t.map((v, k) => v + m[k]) })
  return { qkv, attn, afterAttn, out }
}

export function vit(w: W, img: number[]) {
  const input = img.slice(0, 64), p = patches(input)
  const pos = w['pos'].data, D = 16
  const cls = w['cls'].data
  const tokens = [cls.map((v, k) => v + pos[k]), ...p.map((pp, i) => linear(w, 'embed', pp).map((v, k) => v + pos[(i + 1) * D + k]))]
  const b = block(w, 'block', tokens, 2, () => true)
  const logits = linear(w, 'head', layerNorm(w, 'ln', b.out[0]))
  return { input, patches: p, tokens, attn: b.attn, out: b.out, logits, probs: softmax(logits) }
}

/** The toy VLM. With `ids` it scores that text (teacher forcing); without, it writes a caption greedily. */
export function vlm(w: W, img: number[], vocab: string[], ids?: number[], prefix: number[] = []) {
  const input = img.slice(0, 64), p = patches(input)
  const vpos = w['v_pos'].data, tpos = w['t_pos'].data
  const vtok = p.map((pp, i) => linear(w, 'v_embed', pp).map((v, k) => v + vpos[i * 16 + k]))
  const vb = block(w, 'v_block', vtok, 2, () => true)
  const img_ = vb.out.map((t) => linear(w, 'connector', t))
  const temb = w['t_embed.weight'].data, Dt = 24
  const run = (text: number[]) => {
    const seq = [...img_, ...text.map((id) => temb.slice(id * Dt, id * Dt + Dt))].map((t, i) => t.map((v, k) => v + tpos[i * Dt + k]))
    const tb = block(w, 't_block', seq, 2, (i, j) => (i < 16 && j < 16) || j <= i)
    const logits = tb.out.slice(16).map((t) => linear(w, 'lm_head', layerNorm(w, 'ln', t)))
    return { tb, logits }
  }
  if (ids) { const r = run(ids); return { input, patches: p, v_attn: vb.attn, img: img_, t_attn: r.tb.attn, logits: r.logits, ids, steps: [] as any[] } }
  // greedy generation: keep every step so the UI can replay how each word was chosen. The user's own words (`prefix`)
  // go in first, as if the model had written them; then it carries on by itself. 16 image + 10 text positions in all.
  const pre = prefix.slice(0, VLM_MAX_WORDS)
  const text = [vocab.indexOf('<bos>')]
  const steps: { probs: number[]; chosen: number; attn: number[][][] }[] = []
  let last: ReturnType<typeof run> | null = null
  for (let s = 0; s < 9; s++) {
    last = run(text)
    const probs = softmax(last.logits[last.logits.length - 1])
    const chosen = s < pre.length ? pre[s] : probs.indexOf(Math.max(...probs))
    steps.push({ probs, chosen, attn: last.tb.attn })
    text.push(chosen)
    if (s >= pre.length && vocab[chosen] === '<eos>') break
  }
  return { input, patches: p, v_attn: vb.attn, img: img_, t_attn: last!.tb.attn, logits: last!.logits, ids: text, steps, given: pre.length }
}

/** The VLM's text input: at most this many of the user's words go in before the model writes. */
export const VLM_MAX_WORDS = 5
/** Split typed text into the toy VLM's words (it knows 20). Unknown words are skipped and reported. */
export function vlmWords(text: string, vocab: string[]): { ids: number[]; unknown: string[] } {
  const ids: number[] = [], unknown: string[] = []
  for (const wd of text.toLowerCase().replace(/,/g, ' , ').split(/\s+/).filter(Boolean)) {
    const k = vocab.indexOf(wd)
    if (k > 1) { if (ids.length < VLM_MAX_WORDS) ids.push(k) } else unknown.push(wd)
  }
  return { ids, unknown }
}

export const FLOPS: Record<string, string> = {
  mlp: '2×(64·32 + 32·16 + 16·10) ≈ 5.4 k multiply-adds',
  cnn: '8·64·9 + 16·16·72 + 64·10 ≈ 23 k multiply-adds',
  rnn: '8 steps × 3 gates × (8 + 24)·24 ≈ 18 k multiply-adds',
  vit: '17 tokens × (qkv 768 + proj 256 + MLP 1024) + attention ≈ 36 k multiply-adds',
  vlm: 'vision 16 tokens ≈ 33 k · text ≈ 26 tokens × 3.5 k per word written',
}

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Which digit a network reads, and how sure it is. The VLM writes a caption: its digit is the number word in it. */
/** First maximum wins on a tie: the one rule every view uses. */
export const argmax = (a: ArrayLike<number>): number => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k }
/** A short fingerprint of the picture (and the VLM's typed words), so two views can prove they looked at the same input. */
export function inputHash(img: ArrayLike<number>, extra = ''): string {
  let h = 2166136261
  for (let i = 0; i < img.length; i++) h = Math.imul(h ^ Math.round(Math.max(0, Math.min(1, img[i])) * 255), 16777619)
  for (let i = 0; i < extra.length; i++) h = Math.imul(h ^ extra.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0')
}
/** One forward pass of a tiny net. The result is the single source for its table row and its 3D scene. */
export function runNet(net: NetId, p: Pack, img: number[], words = ''): any {
  if (net === 'vlm') return vlm(p.weights, img, p.vocab!, undefined, vlmWords(words, p.vocab!).ids)
  return ({ mlp, cnn, rnn, vit } as const)[net](p.weights, img)
}
export interface Read { digit: number | null; conf: number; caption?: string; probs?: number[] }
/** What a finished forward pass says. For the four classifiers: the most likely digit and its softmax probability.
 *  For the VLM: the digit named by a word the model wrote itself (not the words the user typed), with the chance it gave that word; '–' (null) when its caption names no digit. */
export function readFrom(net: NetId, p: Pack, o: any): Read {
  if (net === 'vlm') {
    const words = o.ids.slice(1).map((i: number) => p.vocab![i]).filter((w: string) => w !== '<eos>')
    for (let k = o.given ?? 0; k < o.steps.length; k++) {
      const d = NUM.indexOf(p.vocab![o.steps[k].chosen])
      if (d >= 0) return { digit: d, conf: o.steps[k].probs[o.steps[k].chosen], caption: words.join(' ') }
    }
    return { digit: null, conf: 0, caption: words.join(' ') }
  }
  const probs: number[] = o.probs
  const d = argmax(probs)
  return { digit: d, conf: probs[d], probs }
}
export function readDigit(net: NetId, p: Pack, img: number[]): Read {
  return readFrom(net, p, runNet(net, p, img))
}

export interface Speed { us: number; n: number }

/** Time per image on this device, in microseconds: the full forward pass (for the VLM, writing the whole caption). */
export function timeNet(net: NetId, p: Pack, images: number[][]): Speed {
  readDigit(net, p, images[0]) // warm up the JIT once
  const t0 = performance.now()
  let n = 0
  while (n < images.length || (performance.now() - t0 < 60 && n < images.length * 20)) { readDigit(net, p, images[n % images.length]); n++ }
  return { us: ((performance.now() - t0) * 1000) / n, n }
}

/* ======================================================================================= S6 model UI helpers (pure) */
export type UiTask = 'text-generation' | 'fill-mask' | 'text-classification' | 'image-classification' | 'automatic-speech-recognition'

/** The five groups of the model picker, in order. */
export const TASK_GROUPS: { task: UiTask; label: string }[] = [
  { task: 'text-generation', label: 'Text' }, { task: 'fill-mask', label: 'Fill-mask' }, { task: 'text-classification', label: 'Sentiment' },
  { task: 'image-classification', label: 'Image' }, { task: 'automatic-speech-recognition', label: 'Speech' },
]

/** The layer-type legend (TODO §6.3). S8 draws the shapes; this only names them. */
export const LAYER_LEGEND: { name: string; shape: string; icon: string; tint: string }[] = [
  { name: 'Embedding / input', shape: 'flat tiles', icon: '▦', tint: '#7d8bb0' },
  { name: 'Attention', shape: 'head teeth and arcs', icon: '◎', tint: '#7b86e0' },
  { name: 'MLP / dense', shape: 'spheres', icon: '●', tint: '#c9a46a' },
  { name: 'Convolution', shape: 'cell grid and kernel frame', icon: '▣', tint: '#3fb3a6' },
  { name: 'Pooling', shape: 'flatter cells', icon: '▫', tint: '#8fd1c8' },
  { name: 'Recurrent', shape: 'spheres and a loop ring', icon: '↻', tint: '#a68bd8' },
  { name: 'Norm', shape: 'thin outline ring', icon: '○', tint: '#7d8bb0' },
  { name: 'Output', shape: 'bars', icon: '▮', tint: '#7d8bb0' },
]

export const MB = 1024 * 1024
export const fmtBytes = (b: number | null | undefined) => (b == null || !isFinite(b) ? 'size unknown' : b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(1)} GB` : `${Math.max(1, Math.round(b / MB))} MB`)
/** Seconds to download `bytes` at `mbps` megabits per second. */
export const etaSecs = (bytes: number | null | undefined, mbps = 20) => (bytes == null ? null : Math.max(1, Math.round((bytes * 8) / (mbps * 1e6))))
export const fmtEta = (s: number | null | undefined) => (s == null ? '' : s < 90 ? `about ${Math.max(1, Math.round(s))} s` : `about ${Math.round(s / 60)} min`)
/** Rule from TODO section 0.3: under 25 MB one click, 25-150 MB show size, above that warn. */
export const consentFor = (bytes: number | null | undefined, saveData = false): 'none' | 'size' | 'warn' => (saveData || (bytes ?? 0) > 150 * MB ? 'warn' : (bytes ?? 0) >= 25 * MB ? 'size' : 'none')
/** The button text of the one primary action. */
export const startLabel = (p: { bytes: number | null; cached: boolean } | null | undefined, verb = '▶ Start') => (!p || (!p.cached && p.bytes == null) ? verb : p.cached ? `${verb} (cached)` : `${verb} (download ${fmtBytes(p.bytes)})`)

export const VERDICT_WORD = { fits: 'runs', tight: 'slow', 'too-big': 'too big' } as const

/** Group catalog rows by task, keeping the picker's order and dropping empty groups. */
export function groupByTask<T extends { task?: string | null }>(rows: T[]): { task: UiTask; label: string; rows: T[] }[] {
  return TASK_GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => (r.task ?? 'text-generation') === g.task) })).filter((g) => g.rows.length)
}

/** The nearest smaller model of the same task that is not too big: the suggestion shown beside a "too big" verdict. */
export function smallerSuggestion<T extends { id: string; task?: string | null; bytes: number | null; verdict?: string }>(row: T, rows: T[]): T | null {
  const t = row.task ?? 'text-generation'
  const c = rows.filter((r) => r.id !== row.id && (r.task ?? 'text-generation') === t && r.verdict !== 'too-big' && (r.bytes ?? Infinity) < (row.bytes ?? Infinity))
  return c.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))[0] ?? null
}

/** `inspect` as the path shown above the scene: Model > Block 12 > Attention. Layers count from 0 inside, from 1 on screen. */
export function crumbs(i: { kind: string; layer?: number; part?: string; name?: string; index?: number } | null): string[] {
  if (!i) return []
  const out = ['Model']
  if (i.kind === 'block' || i.layer !== undefined) out.push(`Block ${(i.layer ?? 0) + 1}`)
  if (i.part) out.push({ attn: 'Attention', mlp: 'MLP', norm: 'Norm', embed: 'Embedding' }[i.part] ?? i.part)
  if (i.kind === 'tensor' && i.name) out.push(i.name.split('.').slice(-2).join('.'))
  if (i.kind === 'token') out.push(`Token ${i.index ?? 0}`)
  if (i.kind === 'output') out.push('Output')
  return out
}

export interface InputCaps { deviceMemoryGB?: number | null }
export const TEXT_CAP_TOKENS = 512, TEXT_CAP_LOW = 128, IMAGE_CAP_MB = 10, AUDIO_CAP_S = 30
/** Fallback check, used until the models engine's own validateInput is present. Returns a message, or null when fine. */
export function checkInput(task: UiTask | null, input: { kind: string; text?: string; url?: string }, caps?: InputCaps | null, extra?: { bytes?: number; seconds?: number }): string | null {
  if (input.kind === 'text') {
    const text = (input.text ?? '').trim()
    if (!text) return 'Type some text first.'
    const cap = (caps?.deviceMemoryGB ?? 8) < 4 ? TEXT_CAP_LOW : TEXT_CAP_TOKENS
    const est = Math.ceil(text.length / 4)
    if (est > cap) return `That is too long. This device takes up to ${cap} tokens (about ${cap * 4} letters).`
    if (task === 'fill-mask' && !/\[MASK\]/.test(text)) return 'Add [MASK] where the word goes.'
    return null
  }
  if (!input.url) return input.kind === 'image' ? 'Pick an image first.' : 'Pick a sound first.'
  if (input.kind === 'image' && extra?.bytes && extra.bytes > IMAGE_CAP_MB * MB) return `That image is over ${IMAGE_CAP_MB} MB. Pick a smaller one.`
  if (input.kind === 'audio' && extra?.seconds && extra.seconds > AUDIO_CAP_S) return `That clip is over ${AUDIO_CAP_S} s. Pick a shorter one.`
  return null
}
/** The models engine may return a string, null, or {ok,message}: read all of them the same way. */
export function readCheck(r: any): string | null {
  if (!r || r === true) return null
  if (typeof r === 'string') return r
  if (r.ok === true || r.valid === true) return null
  return String(r.message ?? r.error ?? r.reason ?? 'That input does not work.')
}

/* ================================================================================ draw pad (R2-12) */
/**
 * What the networks see of a drawing. `ink` is an n by n grid of ink amounts (0 to 1). Like MNIST, the digit is cropped
 * to its ink box, scaled so its longer side is 7 pixels, centred in the 8 by 8 frame, and averaged down (antialiased).
 * The strongest pixel is 1, as in the training digits. A blank pad gives all zeros.
 */
export function inkTo8x8(ink: ArrayLike<number>, n: number): number[] {
  let x0 = n, y0 = n, x1 = -1, y1 = -1
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (ink[y * n + x] > 0.08) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const out = new Array(64).fill(0)
  if (x1 < 0) return out
  const w = x1 - x0 + 1, h = y1 - y0 + 1, side = Math.max(w, h), k = side / 7   // source pixels per output pixel
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2
  const S = 4                                                                    // samples per output pixel, each way
  let mx = 0
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    let a = 0
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = Math.floor(cx + (i + (sx + 0.5) / S - 4) * k), y = Math.floor(cy + (j + (sy + 0.5) / S - 4) * k)
      if (x >= 0 && y >= 0 && x < n && y < n) a += ink[y * n + x]
    }
    out[j * 8 + i] = a / (S * S)
    if (out[j * 8 + i] > mx) mx = out[j * 8 + i]
  }
  return mx > 0 ? out.map((v) => Math.min(1, v / mx)) : out
}

/** Several networks, one answer: the average of their class probabilities (the VLM counts as its digit). */
export function consensus(reads: { digit: number | null; conf: number; probs?: number[] }[]): { top: number; pct: number; second: number | null; pct2: number } {
  const agg = new Array(10).fill(0)
  let n = 0
  for (const r of reads) {
    if (r.digit === null) continue
    n++
    for (let d = 0; d < 10; d++) agg[d] += r.probs ? r.probs[d] : d === r.digit ? r.conf : (1 - r.conf) / 9
  }
  if (!n) return { top: 0, pct: 0, second: null, pct2: 0 }
  const m = agg.map((v) => v / n), order = [...m.keys()].sort((a, b) => m[b] - m[a])
  return { top: order[0], pct: m[order[0]], second: order[1], pct2: m[order[1]] }
}

/* ================================================================================ languages (R2-1) */
export type LangId = 'en' | 'es' | 'fr' | 'de' | 'hi' | 'zh' | 'ar' | 'pt'
export const LANGS: { id: LangId; name: string; dir: 'ltr' | 'rtl'; prompt: string; review: string }[] = [
  { id: 'en', name: 'English', dir: 'ltr', prompt: 'The capital of France is', review: 'I really enjoyed this film, it was wonderful.' },
  { id: 'es', name: 'Español', dir: 'ltr', prompt: 'La capital de Francia es', review: 'Disfruté mucho esta película, fue maravillosa.' },
  { id: 'fr', name: 'Français', dir: 'ltr', prompt: 'La capitale de la France est', review: "J'ai vraiment aimé ce film, il était magnifique." },
  { id: 'de', name: 'Deutsch', dir: 'ltr', prompt: 'Die Hauptstadt von Frankreich ist', review: 'Ich habe diesen Film sehr genossen, er war wunderbar.' },
  { id: 'hi', name: 'हिन्दी', dir: 'ltr', prompt: 'फ्रांस की राजधानी है', review: 'मुझे यह फिल्म बहुत पसंद आई, यह शानदार थी।' },
  { id: 'zh', name: '中文', dir: 'ltr', prompt: '法国的首都是', review: '我真的很喜欢这部电影，太精彩了。' },
  { id: 'ar', name: 'العربية', dir: 'rtl', prompt: 'عاصمة فرنسا هي', review: 'لقد استمتعت حقًا بهذا الفيلم، كان رائعًا.' },
  { id: 'pt', name: 'Português', dir: 'ltr', prompt: 'A capital da França é', review: 'Gostei muito deste filme, foi maravilhoso.' },
]
export const langPrompt = (id: LangId, task: string | null) => { const l = LANGS.find((x) => x.id === id) ?? LANGS[0]; return task === 'text-classification' ? l.review : l.prompt }
/** Does this model know more than English? A name and architecture check, until the catalog says it outright. */
export function isMultilingual(m: { repo?: string; arch?: string } | null | undefined): boolean {
  if (!m) return false
  const r = `${m.repo ?? ''} ${m.arch ?? ''}`.toLowerCase()
  if (/\.en\b|-en\b|english/.test(r)) return false
  return /multiling|xlm|mbert|bloom|qwen|gemma|llama-3|llama3|mt5|mbart|smollm3|aya|whisper|mistral|labse|e5/.test(r)
}
/** The language of a text, by script and a few common words: enough to say which picker entry it matches. */
export function guessLang(text: string): LangId {
  if (/[ऀ-ॿ]/.test(text)) return 'hi'
  if (/[一-鿿]/.test(text)) return 'zh'
  if (/[؀-ۿ]/.test(text)) return 'ar'
  const t = ` ${text.toLowerCase()} `
  if (/ (la|el|es|de|los|las|una|capital)\b/.test(t) && /(ñ|ó|í| es | del )/.test(t)) return 'es'
  if (/ (la|le|les|est|de|des|une)\b/.test(t) && /(é|è|ç|capitale| est )/.test(t)) return 'fr'
  if (/ (die|der|das|ist|von|und)\b/.test(t)) return 'de'
  if (/ (da|do|os|as|uma|é)\b/.test(t) && /(ã|ç|õ| é )/.test(t)) return 'pt'
  return 'en'
}
