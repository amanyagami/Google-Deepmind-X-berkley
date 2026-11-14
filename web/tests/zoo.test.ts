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
