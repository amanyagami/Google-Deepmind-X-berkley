// The browser's networks must compute exactly what PyTorch computed. Run: npm test
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cnn, mlp, rnn, vit, vlm, type Pack } from '../src/zoo/nets'

const load = (n: string): Pack => JSON.parse(readFileSync(new URL(`../public/zoo/${n}.json`, import.meta.url), 'utf8'))
const digits = JSON.parse(readFileSync(new URL('../public/zoo/digits.json', import.meta.url), 'utf8'))
const flat = (x: any): number[] => (Array.isArray(x) ? x.flat(Infinity as 1) : [x]) as number[]

function close(name: string, got: any, want: number[], tol = 2e-3) {
  const g = flat(got)
  assert.equal(g.length, want.length, `${name}: length ${g.length} vs ${want.length}`)
  let worst = 0
  for (let i = 0; i < g.length; i++) worst = Math.max(worst, Math.abs(g[i] - want[i]))
  assert.ok(worst < tol, `${name}: max difference ${worst}`)
  return worst
}

for (const [name, fn, keys] of [
  ['mlp', mlp, ['h1', 'h2', 'logits']],
  ['cnn', cnn, ['conv1', 'pool1', 'conv2', 'pool2', 'logits']],
  ['rnn', rnn, ['hidden', 'logits']],
  ['vit', vit, ['patches', 'tokens', 'attn', 'out', 'logits']],
] as const) {
  test(`${name} matches PyTorch on its reference images`, () => {
    const p = load(name)
    for (const r of p.reference) {
      const out: any = (fn as any)(p.weights, r.input)
      for (const k of keys) close(`${name}.${k}`, out[k], r[k])
    }
  })
}

test('vlm matches PyTorch (vision tower, connector, text attention, logits)', () => {
  const p = load('vlm')
  for (const r of p.reference) {
    const out = vlm(p.weights, r.input, p.vocab!, r.ids)
    close('vlm.v_attn', out.v_attn, r.v_attn)
    close('vlm.img', out.img, r.img)
    close('vlm.t_attn', out.t_attn, r.t_attn)
    close('vlm.logits', out.logits, r.logits)
  }
})

test('classifiers agree with the labels on most held-out digits', () => {
  for (const [name, fn] of [['mlp', mlp], ['cnn', cnn], ['rnn', rnn], ['vit', vit]] as const) {
    const p = load(name)
    let ok = 0
    digits.images.forEach((img: number[], i: number) => { const o: any = (fn as any)(p.weights, img); if (o.probs.indexOf(Math.max(...o.probs)) === digits.labels[i]) ok++ })
    assert.ok(ok / digits.images.length > 0.9, `${name}: ${ok}/${digits.images.length}`)
  }
})

test('vlm writes a grammatical caption with the right digit and parity', () => {
  const p = load('vlm')
  const names = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  let ok = 0
  digits.images.forEach((img: number[], i: number) => {
    const words = vlm(p.weights, img, p.vocab!).ids.map((id) => p.vocab![id])
    const d = digits.labels[i]
    const want = ['<bos>', 'this', 'is', names[d] === 'eight' ? 'an' : 'a', names[d], ',', 'it', 'is', d % 2 ? 'odd' : 'even', '<eos>']
    if (words.join(' ') === want.join(' ')) ok++
  })
  assert.ok(ok / digits.images.length > 0.85, `exact captions ${ok}/${digits.images.length}`)
})

// ---- S6 model UI helpers (plain functions; the screens are checked in the browser) ----
import { checkInput, consentFor, crumbs, fmtBytes, fmtEta, groupByTask, readCheck, smallerSuggestion, startLabel } from '../src/zoo/nets'

test('S6 picker groups follow the fixed order and drop empty groups', () => {
  const g = groupByTask([{ task: 'fill-mask' }, { task: 'text-generation' }, { task: 'text-generation' }, { task: 'automatic-speech-recognition' }])
  assert.deepEqual(g.map((x) => [x.label, x.rows.length]), [['Text', 2], ['Fill-mask', 1], ['Speech', 1]])
})
test('S6 start label shows size or cached; consent follows section 0.3', () => {
  assert.equal(startLabel({ bytes: 82 * 1048576, cached: false }), '▶ Start (download 82 MB)')
  assert.equal(startLabel({ bytes: 82 * 1048576, cached: true }), '▶ Start (cached)')
  assert.equal(consentFor(10 * 1048576), 'none'); assert.equal(consentFor(80 * 1048576), 'size'); assert.equal(consentFor(200 * 1048576), 'warn'); assert.equal(consentFor(10, true), 'warn')
  assert.equal(fmtBytes(2 * 1024 ** 3), '2.0 GB'); assert.equal(fmtEta(20), 'about 20 s'); assert.equal(fmtEta(300), 'about 5 min')
})
test('S6 input checks: caps, mask, empty, size', () => {
  assert.match(checkInput('fill-mask', { kind: 'text', text: 'Paris is the capital' })!, /\[MASK\]/)
  assert.equal(checkInput('fill-mask', { kind: 'text', text: 'Paris is the [MASK] of France.' }), null)
  assert.match(checkInput('text-generation', { kind: 'text', text: 'a'.repeat(3000) })!, /512/)
  assert.match(checkInput('text-generation', { kind: 'text', text: 'a'.repeat(1000) }, { deviceMemoryGB: 2 })!, /128/)
  assert.match(checkInput('text-generation', { kind: 'text', text: '  ' })!, /Type/)
  assert.match(checkInput('image-classification', { kind: 'image', url: 'x' }, null, { bytes: 11 * 1048576 })!, /10 MB/)
  assert.match(checkInput('automatic-speech-recognition', { kind: 'audio', url: 'x' }, null, { seconds: 31 })!, /30 s/)
  assert.equal(readCheck({ ok: true }), null); assert.equal(readCheck('bad'), 'bad'); assert.equal(readCheck({ ok: false, message: 'no' }), 'no')
})
test('S6 breadcrumb and smaller-model suggestion', () => {
  assert.deepEqual(crumbs({ kind: 'block', layer: 11, part: 'attn' }), ['Model', 'Block 12', 'Attention']); assert.deepEqual(crumbs(null), [])
  const rows = [{ id: 'a', task: 'text-generation', bytes: 900, verdict: 'too-big' }, { id: 'b', task: 'text-generation', bytes: 80, verdict: 'fits' }, { id: 'c', task: 'text-generation', bytes: 300, verdict: 'fits' }]
  assert.equal(smallerSuggestion(rows[0], rows)!.id, 'c')
})
