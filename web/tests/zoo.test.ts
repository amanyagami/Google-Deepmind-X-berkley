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

/* ===================================================================================== S4 models engine (fenced block) */
import { describe as s4describe, it as s4it, expect as s4expect, vi as s4vi, beforeEach as s4beforeEach, afterEach as s4afterEach } from 'vitest'
import * as S4 from '../src/api'

s4describe('S4 models engine', () => {
  const enc = new TextEncoder()
  const DT: Record<string, number> = { F64: 8, F32: 4, F16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, I32: 4, I8: 1, U8: 1 }
  /** Build a safetensors file: tensors are laid out one after another from raw byte arrays. */
  function build(ts: Record<string, { dtype: string; shape: number[]; bytes: Uint8Array }>, extra: Record<string, unknown> = {}) {
    const hdr: any = { __metadata__: { format: 'pt' }, ...extra }
    let off = 0
    const parts: Uint8Array[] = []
    for (const [n, t] of Object.entries(ts)) { hdr[n] = { dtype: t.dtype, shape: t.shape, data_offsets: [off, off + t.bytes.length] }; off += t.bytes.length; parts.push(t.bytes) }
    const h = enc.encode(JSON.stringify(hdr))
    const out = new Uint8Array(8 + h.length + off)
    new DataView(out.buffer).setBigUint64(0, BigInt(h.length), true)
    out.set(h, 8)
    let p = 8 + h.length
    for (const b of parts) { out.set(b, p); p += b.length }
    return out
  }
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer)
  const u16 = (a: number[]) => new Uint8Array(new Uint16Array(a).buffer)
  /** header-only file with raw JSON text, for the fuzz cases */
  function raw(json: string | Uint8Array, lenOverride?: bigint, size?: number) {
    const h = typeof json === 'string' ? enc.encode(json) : json
    const out = new Uint8Array(8 + h.length + (size ?? 64))
    new DataView(out.buffer).setBigUint64(0, lenOverride ?? BigInt(h.length), true)
    out.set(h, 8)
    return out
  }
  const code = (fn: () => unknown) => { try { fn() } catch (e: any) { return e instanceof S4.TensorError ? e.code : `other:${e?.message}` } return 'none' }
  const ph = (json: string, size = 64) => code(() => S4.parseHeader(raw(json, undefined, size), 8 + enc.encode(json).length + size))

  s4describe('parseHeader', () => {
    s4it('accepts a valid header', () => {
      const f = build({ a: { dtype: 'F32', shape: [2, 2], bytes: f32([1, 2, 3, 4]) }, b: { dtype: 'F16', shape: [3], bytes: u16([0, 0, 0]) } })
      const h = S4.parseHeader(f, f.length)
      s4expect(Object.keys(h.tensors)).toEqual(['a', 'b'])
      s4expect(h.tensors.a).toEqual({ dtype: 'F32', shape: [2, 2], start: 0, end: 16 })
      s4expect(h.base).toBe(8 + h.headerLen)
      s4expect(h.metadata).toEqual({ format: 'pt' })
    })
    s4it('rejects header length 0, 2^63, > 16 MiB, truncated', () => {
      s4expect(code(() => S4.parseHeader(raw('{}', 0n), 100))).toBe('length')
      s4expect(code(() => S4.parseHeader(raw('{}', 2n ** 63n), 100))).toBe('length')
      s4expect(code(() => S4.parseHeader(raw('{}', 2n ** 64n - 1n), 100))).toBe('length')
      s4expect(code(() => S4.parseHeader(raw('{}', BigInt(16 * 1024 * 1024 + 1)), 1e9))).toBe('length')
      s4expect(code(() => S4.parseHeader(raw('{}', 50n), 40))).toBe('truncated')   // longer than the file
      s4expect(code(() => S4.parseHeader(new Uint8Array(4), 4))).toBe('truncated')
    })
    s4it('rejects non-UTF8 and bad JSON and non-object roots', () => {
      s4expect(code(() => S4.parseHeader(raw(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), 200))).toBe('json')
      s4expect(ph('{not json')).toBe('json')
      s4expect(ph('[]')).toBe('json')
      s4expect(ph('null')).toBe('json')
      s4expect(ph('3')).toBe('json')
    })
    s4it('rejects non-dict entries and missing fields', () => {
      s4expect(ph('{"a": 3}')).toBe('entry')
      s4expect(ph('{"a": [1]}')).toBe('entry')
      s4expect(ph('{"a": null}')).toBe('entry')
      s4expect(ph('{"__metadata__": 5}')).toBe('entry')
      s4expect(ph('{"a": {"shape":[1],"data_offsets":[0,4]}}')).toBe('field')
      s4expect(ph('{"a": {"dtype":"F32","data_offsets":[0,4]}}')).toBe('field')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1]}}')).toBe('field')
    })
    s4it('rejects unknown dtype, bad dims, > 8 dims', () => {
      s4expect(ph('{"a": {"dtype":"F33","shape":[1],"data_offsets":[0,4]}}')).toBe('dtype')
      s4expect(ph('{"a": {"dtype":5,"shape":[1],"data_offsets":[0,4]}}')).toBe('field')
      s4expect(ph('{"a": {"dtype":"F32","shape":[-1],"data_offsets":[0,4]}}')).toBe('dims')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1.5],"data_offsets":[0,4]}}')).toBe('dims')
      s4expect(ph('{"a": {"dtype":"F32","shape":["1"],"data_offsets":[0,4]}}')).toBe('dims')
      s4expect(ph('{"a": {"dtype":"F32","shape":"1","data_offsets":[0,4]}}')).toBe('dims')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1,1,1,1,1,1,1,1,1],"data_offsets":[0,4]}}')).toBe('dims')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1,1,1,1,1,1,1,1],"data_offsets":[0,4]}}')).toBe('none')   // exactly 8 is fine
    })
    s4it('rejects huge shapes and overflow with BigInt products', () => {
      s4expect(ph('{"a": {"dtype":"F32","shape":[1,1099511627776],"data_offsets":[0,4]}}')).toBe('size')   // [1, 2**40]
      s4expect(ph('{"a": {"dtype":"F32","shape":[2147483648,2147483648,2147483648],"data_offsets":[0,4]}}')).toBe('size')   // 2**93 elements
      s4expect(ph('{"a": {"dtype":"F32","shape":[9007199254740993],"data_offsets":[0,4]}}')).toBe('dims')   // beyond 2**53
      s4expect(ph('{"a": {"dtype":"F32","shape":[4294967296,4294967296],"data_offsets":[0,9007199254740991]}}')).toBe('size')
    })
    s4it('rejects bad offsets: a>b, negative, past EOF, non-integers', () => {
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[8,4]}}')).toBe('offsets')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[-4,0]}}')).toBe('offsets')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[0.5,4.5]}}')).toBe('offsets')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[0]}}')).toBe('offsets')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[0,4,8]}}')).toBe('offsets')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[100,104]}}', 64)).toBe('offsets')   // past the end of a 64 byte body
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[0,4]}}', 64)).toBe('none')
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[60,64]}}', 64)).toBe('none')   // exactly to the end
      s4expect(ph('{"a": {"dtype":"F32","shape":[1],"data_offsets":[61,65]}}', 64)).toBe('offsets')   // one byte past
    })
    s4it('rejects overlap and size mismatch', () => {
      s4expect(ph('{"a": {"dtype":"F32","shape":[2],"data_offsets":[0,8]},"b": {"dtype":"F32","shape":[2],"data_offsets":[4,12]}}')).toBe('overlap')
      s4expect(ph('{"a": {"dtype":"F32","shape":[2],"data_offsets":[0,8]},"b": {"dtype":"F32","shape":[2],"data_offsets":[8,16]}}')).toBe('none')
      s4expect(ph('{"a": {"dtype":"F32","shape":[2],"data_offsets":[0,7]}}')).toBe('size')
      s4expect(ph('{"a": {"dtype":"F16","shape":[2],"data_offsets":[0,8]}}')).toBe('size')
      s4expect(ph('{"a": {"dtype":"F32","shape":[],"data_offsets":[0,4]}}')).toBe('none')   // a scalar
      s4expect(ph('{"a": {"dtype":"F32","shape":[0,5],"data_offsets":[0,0]}}')).toBe('none')   // empty tensor
    })
    s4it('does not mix up another file: offsets are checked against the real file size', () => {
      const f = build({ a: { dtype: 'F32', shape: [4], bytes: f32([1, 2, 3, 4]) } })
      s4expect(code(() => S4.parseHeader(f, f.length - 1))).toBe('offsets')
    })
  })

  s4describe('decoding', () => {
    s4it('F32 / F64 / F16 / BF16 / F8 fixtures decode exactly', () => {
      s4expect(Array.from(S4.decodeBytes(f32([1.5, -2.25, 0, 1e-3]), 'F32', 4))).toEqual(Array.from(new Float32Array([1.5, -2.25, 0, 1e-3])))
      s4expect(Array.from(S4.decodeBytes(new Uint8Array(new Float64Array([3.5, -1]).buffer), 'F64', 2))).toEqual([3.5, -1])
      s4expect(Array.from(S4.decodeBytes(u16([0x3c00, 0xc000, 0x3800, 0x0000, 0x7bff]), 'F16', 5))).toEqual([1, -2, 0.5, 0, 65504])
      s4expect(Array.from(S4.decodeBytes(u16([0x3f80, 0xc000, 0x4040]), 'BF16', 3))).toEqual([1, -2, 3])
      s4expect(Array.from(S4.decodeBytes(new Uint8Array([0x38, 0x40, 0xb8, 0x00]), 'F8_E4M3', 4))).toEqual([1, 2, -1, 0])
      s4expect(S4.decodeBytes(new Uint8Array([0x7f]), 'F8_E4M3', 1)[0]).toBeNaN()
      s4expect(Array.from(S4.decodeBytes(new Uint8Array([0x3c, 0x40, 0xbc, 0x7c]), 'F8_E5M2', 4))).toEqual([1, 2, -1, Infinity])
      s4expect(() => S4.decodeBytes(new Uint8Array(4), 'I32', 1)).toThrow()
    })
  })

  s4describe('tensorWindow (mocked Hub)', () => {
    const SHA = 'a'.repeat(40)
    const big = new Float32Array(1000 * 8).map((_, i) => i)
    const w46 = Array.from({ length: 24 }, (_, i) => i)
    const files: Record<string, Uint8Array> = {
      'm.safetensors': build({
        w: { dtype: 'F32', shape: [4, 6], bytes: f32(w46) },
        h: { dtype: 'F16', shape: [2, 3], bytes: u16([0x3c00, 0xc000, 0x3800, 0, 0x3c00, 0x3c00]) },
        b: { dtype: 'BF16', shape: [2, 2], bytes: u16([0x3f80, 0xc000, 0x4040, 0x3f80]) },
        e: { dtype: 'F8_E4M3', shape: [4], bytes: new Uint8Array([0x38, 0x40, 0xb8, 0x00]) },
        q: { dtype: 'I8', shape: [2, 2], bytes: new Uint8Array([1, 2, 3, 4]) },
        qw: { dtype: 'I32', shape: [2, 2], bytes: new Uint8Array(16) },
        c: { dtype: 'F32', shape: [2, 3, 4], bytes: f32(Array.from({ length: 24 }, (_, i) => 100 + i)) },
        big: { dtype: 'F32', shape: [1000, 8], bytes: new Uint8Array(big.buffer) },
        wide: { dtype: 'F32', shape: [2, 64], bytes: f32(Array.from({ length: 128 }, (_, i) => i)) },
        long: { dtype: 'F32', shape: [1, 2000], bytes: f32(Array.from({ length: 2000 }, (_, i) => i)) },
      }),
    }
    let log: { url: string; range: string | null }[] = []
    let inFlight = 0, peak = 0
    const realFetch = globalThis.fetch
    s4beforeEach(() => {
      log = []; inFlight = 0; peak = 0
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input)
        log.push({ url, range: init?.headers?.Range ?? null })
        if (url.includes('/api/models/gated/')) return new Response('{}', { status: 403 })
        if (url.includes('/api/models/')) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
        const m = /\/resolve\/([^/]+)\/(.+)$/.exec(url)
        if (!m) return new Response('no', { status: 404 })
        s4expect(m[1]).toBe(SHA)   // always pinned to the commit
        const file = files[m[2]]
        if (!file) return new Response('no', { status: 404 })
        const r = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? '')
        if (!r) return new Response(file, { status: 200 })
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise((res) => setTimeout(res, 3))
        inFlight--
        const a = +r[1], b = Math.min(+r[2], file.length - 1)
        return new Response(file.slice(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${file.length}` } })
      }) as any
    })
    s4afterEach(() => { globalThis.fetch = realFetch })
    const win = (repo: string, name: string, o: Partial<S4.TensorReq> = {}) => S4.tensorWindow({ repo, file: 'm.safetensors', name, r0: 0, c0: 0, rows: 4, cols: 6, stride: 1, ...o })

    s4it('reads a whole F32 matrix and a sub-window byte-exact, with one data request', async () => {
      const a = await win('t/one', 'w')
      s4expect(Array.from(a.data)).toEqual(w46)
      s4expect(a).toMatchObject({ rows: 4, cols: 6, stride: 1, decoded: true, truncated: false, dtype: 'F32', shape: [4, 6] })
      const dataReqs = log.filter((l) => l.range && !l.range.startsWith('bytes=0-65535'))
      s4expect(dataReqs.length).toBe(1)
      const b = await win('t/one', 'w', { r0: 1, c0: 2, rows: 2, cols: 3 })
      s4expect(Array.from(b.data)).toEqual([8, 9, 10, 14, 15, 16])
    })
    s4it('decodes F16, BF16 and F8 tensors from the file', async () => {
      s4expect(Array.from((await win('t/dt', 'h', { rows: 2, cols: 3 })).data)).toEqual([1, -2, 0.5, 0, 1, 1])
      s4expect(Array.from((await win('t/dt', 'b', { rows: 2, cols: 2 })).data)).toEqual([1, -2, 3, 1])
      s4expect(Array.from((await win('t/dt', 'e', { rows: 1, cols: 4 })).data)).toEqual([1, 2, -1, 0])
    })
    s4it('quantized storage is reported as not decoded, and nothing is read for it', async () => {
      const before = log.length
      const q = await win('t/q', 'qw', { rows: 2, cols: 2 })
      s4expect(q.decoded).toBe(false)
      s4expect(q.dtype).toBe('I32')
      s4expect(q.requests).toBe(0)
      s4expect(log.slice(before).some((l) => l.range && !l.range.startsWith('bytes=0-65535'))).toBe(false)
      s4expect((await win('t/q', 'q', { rows: 2, cols: 2 })).decoded).toBe(false)
    })
    s4it('3-D tensors need i0 and then read that slice', async () => {
      await s4expect(win('t/c', 'c', { rows: 3, cols: 4 })).rejects.toMatchObject({ code: 'needs-i0' })
      const s = await win('t/c', 'c', { i0: 1, rows: 3, cols: 4 })
      s4expect(Array.from(s.data)).toEqual(Array.from({ length: 12 }, (_, i) => 112 + i))
      await s4expect(win('t/c', 'c', { i0: 2, rows: 3, cols: 4 })).rejects.toMatchObject({ code: 'range' })
    })
    s4it('window bounds: outside the tensor, fractions and clamping', async () => {
      await s4expect(win('t/b', 'w', { r0: 4 })).rejects.toMatchObject({ code: 'range' })
      await s4expect(win('t/b', 'w', { c0: 6 })).rejects.toMatchObject({ code: 'range' })
      await s4expect(win('t/b', 'w', { r0: -1 })).rejects.toMatchObject({ code: 'range' })
      await s4expect(win('t/b', 'w', { rows: 1.5 })).rejects.toMatchObject({ code: 'range' })
      await s4expect(win('t/b', 'nope')).rejects.toMatchObject({ code: 'notfound' })
      const edge = await win('t/b', 'w', { r0: 3, c0: 4, rows: 10, cols: 10 })   // clipped to what exists
      s4expect(Array.from(edge.data)).toEqual([22, 23])
      s4expect([edge.rows, edge.cols]).toEqual([1, 2])
    })
    s4it('an overview samples rows evenly across the tensor, never the first N', async () => {
      const o = await win('t/o', 'big', { rows: 16, cols: 8, stride: undefined })
      s4expect(o.rows).toBeLessThanOrEqual(16)
      const firstCol = Array.from({ length: o.rows }, (_, i) => o.data[i * o.cols])
      const srcRows = firstCol.map((v) => v / 8)
      s4expect(srcRows[0]).toBe(0)
      s4expect(srcRows[o.rows - 1]).toBeGreaterThan(900)   // reaches the end of a 1000-row tensor
      const gaps = srcRows.slice(1).map((v, i) => v - srcRows[i])
      s4expect(new Set(gaps).size).toBe(1)                  // evenly spaced
      s4expect(o.stride).toBeGreaterThan(1)
      s4expect(o.requests).toBeLessThanOrEqual(1 + 1 + 64)
    })
    s4it('an overview never reads more than 64 rows', async () => {
      const o = await win('t/o64', 'big', { rows: 500, cols: 8, stride: undefined })
      s4expect(o.rows).toBeLessThanOrEqual(64)
      const o2 = await win('t/o64', 'big', { rows: 200, cols: 8, stride: 3 })
      s4expect(o2.rows).toBe(64); s4expect(o2.truncated).toBe(true)
    })
    s4it('caps: 16 MiB read cap at, below and above the limit', async () => {
      const caps = S4.WINDOW_CAPS, saved = caps.readBytes
      caps.readBytes = 100   // 25 floats
      try {
        const below = await win('t/cap', 'wide', { rows: 1, cols: 24 })
        const at = await win('t/cap', 'wide', { rows: 1, cols: 25 })
        const above = await win('t/cap', 'wide', { rows: 1, cols: 26 })
        s4expect([below.cols, below.truncated]).toEqual([24, false])
        s4expect([at.cols, at.truncated]).toEqual([25, false])
        s4expect([above.cols, above.truncated]).toEqual([25, true])
        s4expect(above.fetchedBytes).toBeLessThanOrEqual(100)
        s4expect(Array.from(above.data)).toEqual(Array.from({ length: 25 }, (_, i) => i))
      } finally { caps.readBytes = saved }
    })
    s4it('caps: output at most 1024 x 1024, 8 requests in flight', async () => {
      const l = await win('t/side', 'long', { rows: 1, cols: 5000 })
      s4expect(l.cols).toBeLessThanOrEqual(1024)
      s4expect(l.truncated || l.cols === 1024 || l.stride > 1).toBe(true)
      const o = await win('t/par', 'big', { rows: 40, cols: 8, stride: 20 })   // 40 separate row reads
      s4expect(o.requests).toBeGreaterThan(8)
      s4expect(peak).toBeLessThanOrEqual(8)
    })
    s4it('caps: 15 s timeout stops a stuck read', async () => {
      const caps = S4.WINDOW_CAPS, saved = caps.ms
      caps.ms = 30
      const f = globalThis.fetch
      globalThis.fetch = ((u: any, i: any) => (String(u).includes('/resolve/') ? new Promise((_, rej) => i?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) : f(u, i))) as any
      try { await s4expect(win('t/slow', 'w')).rejects.toMatchObject({ code: 'timeout' }) } finally { caps.ms = saved; globalThis.fetch = f }
    })
    s4it('an identical window is served from the LRU without a request', async () => {
      await win('t/lru', 'w')
      const n = log.length
      const again = await win('t/lru', 'w')
      s4expect(log.length).toBe(n)
      s4expect([again.requests, again.fetchedBytes]).toEqual([0, 0])
      s4expect(S4.windowCacheBytes()).toBeGreaterThan(0)
      s4expect(S4.windowCacheBytes()).toBeLessThanOrEqual(S4.WINDOW_CAPS.lruBytes)
    })
    s4it('a gated repo gives a clear error', async () => {
      await s4expect(S4.tensorWindow({ repo: 'gated/x', file: 'm.safetensors', name: 'w', r0: 0, c0: 0, rows: 1, cols: 1 })).rejects.toMatchObject({ code: 'gated' })
    })
    s4it('a server that ignores Range is refused (never reads a whole file)', async () => {
      const f = globalThis.fetch
      globalThis.fetch = ((u: any, i: any) => f(u, String(u).includes('/resolve/') ? { ...i, headers: {} } : i)) as any
      try { await s4expect(win('t/norange', 'w')).rejects.toMatchObject({ code: 'http' }) } finally { globalThis.fetch = f }
    })
  })

  s4describe('consent thresholds', () => {
    const MiB = 1024 * 1024
    s4it('none under 25 MB, size to 150 MB, warn above or on cellular / saveData', () => {
      s4expect(S4.consentFor(1)).toBe('none')
      s4expect(S4.consentFor(25 * MiB - 1)).toBe('none')
      s4expect(S4.consentFor(25 * MiB)).toBe('size')
      s4expect(S4.consentFor(150 * MiB)).toBe('size')
      s4expect(S4.consentFor(150 * MiB + 1)).toBe('warn')
      s4expect(S4.consentFor(null)).toBe('size')
      s4expect(S4.consentFor(1, { cellular: true })).toBe('warn')
      s4expect(S4.consentFor(1, { saveData: true })).toBe('warn')
    })
    s4it('planDownload reports size, eta and consent from the spec without any request', async () => {
      const spy = s4vi.fn(async () => { throw new Error('no network expected') })
      const f = globalThis.fetch
      globalThis.fetch = spy as any
      try {
        const spec: any = { repo: 'x/y', task: 'fill-mask', onnx: { repo: 'x/y', dtypes: ['q8', 'fp32'], sizes: { q8: 80 * MiB, fp32: 300 * MiB } } }
        const p = await S4.planDownload(spec, { device: 'wasm' })
        s4expect(p).toMatchObject({ repo: 'x/y', bytes: 80 * MiB, cached: false, consent: 'size' })
        const big = await S4.planDownload(spec, { device: 'wasm', dtype: 'fp32' })
        s4expect(big.consent).toBe('warn')
        s4expect(spy).not.toHaveBeenCalled()
      } finally { globalThis.fetch = f }
    })
  })

  s4describe('validateInput', () => {
    s4it('text: 512 tokens, 128 under 4 GB, empty and wrong kind', async () => {
      const t = (n: number) => ({ kind: 'text' as const, text: 'a'.repeat(n * 4) })
      s4expect((await S4.validateInput('text-generation', t(512), { deviceMemoryGB: 8 })).ok).toBe(true)
      const over = await S4.validateInput('text-generation', t(513), { deviceMemoryGB: 8 })
      s4expect(over.ok).toBe(false)
      s4expect(!over.ok && over.error).toMatch(/512/)
      s4expect((await S4.validateInput('fill-mask', t(128), { deviceMemoryGB: 2 })).ok).toBe(true)
      const low = await S4.validateInput('fill-mask', t(129), { deviceMemoryGB: 2 })
      s4expect(!low.ok && low.error).toMatch(/128/)
      s4expect((await S4.validateInput('text-classification', t(129), { deviceMemoryGB: 4 })).ok).toBe(true)
      s4expect((await S4.validateInput('text-classification', { kind: 'text', text: '   ' })).ok).toBe(false)
      s4expect((await S4.validateInput('text-classification', { kind: 'image', url: 'x' })).ok).toBe(false)
    })
    s4it('image: 10 MB cap at / above, wrong kind, unreadable', async () => {
      const f = globalThis.fetch
      const serve = (n: number) => { globalThis.fetch = (async () => new Response(new Uint8Array(n))) as any }
      try {
        const MB = 1024 * 1024
        serve(10 * MB)
        s4expect((await S4.validateInput('image-classification', { kind: 'image', url: 'https://x/a.jpg' }, { prepare: false })).ok).toBe(true)
        serve(10 * MB + 1)
        const r = await S4.validateInput('image-classification', { kind: 'image', url: 'https://x/a.jpg' }, { prepare: false })
        s4expect(!r.ok && r.error).toMatch(/10 MB/)
        globalThis.fetch = (async () => { throw new TypeError('x') }) as any
        s4expect((await S4.validateInput('image-classification', { kind: 'image', url: 'https://x/a.jpg' }, { prepare: false })).ok).toBe(false)
        s4expect((await S4.validateInput('image-classification', { kind: 'audio', url: 'x' })).ok).toBe(false)
      } finally { globalThis.fetch = f }
    })
    s4it('audio: 30 s cap and mono 16 kHz target', () => {
      s4expect(S4.checkAudioSeconds(30)).toBeNull()
      s4expect(S4.checkAudioSeconds(30.5)).toMatch(/30 s/)
      s4expect(S4.checkAudioSeconds(45, { maxAudioSeconds: 60 })).toBeNull()
      s4expect(S4.INPUT_LIMITS.audioRate).toBe(16000)
    })
    s4it('remembers a custom input per task in localStorage and survives it being unavailable', () => {
      const store: Record<string, string> = {}
      ;(globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } }
      try {
        S4.saveInput('fill-mask', { kind: 'text', text: 'Hello [MASK]' })
        s4expect(store['ns.input.fill-mask']).toBeTruthy()
        s4expect(S4.loadSavedInput('fill-mask')).toEqual({ kind: 'text', text: 'Hello [MASK]' })
        s4expect(S4.loadSavedInput('text-generation')).toBeNull()
        S4.saveInput('image-classification', { kind: 'image', url: 'blob:abc' })   // object URLs die with the page
        s4expect(store['ns.input.image-classification']).toBeUndefined()
        S4.saveInput('image-classification', { kind: 'image', url: 'https://x/y.png' })
        s4expect(S4.loadSavedInput('image-classification')).toMatchObject({ url: 'https://x/y.png' })
        ;(globalThis as any).localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
        s4expect(() => S4.saveInput('fill-mask', { kind: 'text', text: 'x' })).not.toThrow()
        s4expect(S4.loadSavedInput('fill-mask')).toBeNull()
      } finally { delete (globalThis as any).localStorage }
    })
  })

  s4describe('degenerate output', () => {
    s4it('flags zero variance, NaN and empty, not real scores', () => {
      s4expect(S4.isDegenerate(new Float32Array(10))).toBe(true)
      s4expect(S4.isDegenerate([0.2, 0.2, 0.2])).toBe(true)
      s4expect(S4.isDegenerate([0.2, NaN, 0.3])).toBe(true)
      s4expect(S4.isDegenerate([])).toBe(true)
      s4expect(S4.isDegenerate([0.9, 0.1])).toBe(false)
      s4expect(S4.isDegenerate([1])).toBe(false)
    })
    s4it('errors carry a code and a friendly message', () => {
      s4expect(S4.classifyError(new Error('Array buffer allocation failed')).code).toBe('oom')
      s4expect(S4.classifyError(new Error('Failed to fetch')).code).toBe('offline')
      s4expect(S4.classifyError(new Error('HTTP 403')).code).toBe('gated')
      s4expect(S4.classifyError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })).code).toBe('quota')
      s4expect(S4.classifyError(new Error('Could not locate file onnx/model.onnx')).code).toBe('unsupported')
      s4expect(S4.classifyError(new S4.BrowserRunError('degenerate', 'x')).code).toBe('degenerate')
    })
  })

  s4describe('one pipeline alive', () => {
    s4it('switching models 10 times keeps one pipeline in memory', async () => {
      s4vi.resetModules()
      let live = 0, peak = 0, created = 0, disposed = 0
      s4vi.doMock('@huggingface/transformers', () => ({
        env: { backends: { onnx: {} } },
        pipeline: async () => {
          s4expect(live).toBe(0)   // the previous one is gone before the next loads
          live++; created++; peak = Math.max(peak, live)
          await new Promise((r) => setTimeout(r, 1))
          return { dispose: async () => { live--; disposed++ } }
        },
      }))
      const A: typeof S4 = await import('../src/api')
      for (let i = 0; i < 10; i++) await A.loadPipeline('fill-mask', i % 2 ? 'r/a' : 'r/b', 'wasm', 'q8')
      s4expect(live).toBe(1); s4expect(peak).toBe(1); s4expect(created).toBe(10); s4expect(disposed).toBe(9)
      // the same model again reuses it
      const again = await A.loadPipeline('fill-mask', 'r/a', 'wasm', 'q8')
      s4expect(again.cached).toBe(true); s4expect(created).toBe(10)
      // rapid concurrent switches still never overlap
      await Promise.all(['x', 'y', 'z', 'w'].map((r) => A.loadPipeline('fill-mask', `r/${r}`, 'wasm', 'q8').catch(() => null)))
      s4expect(peak).toBe(1)
      await A.disposeAll()
      s4expect(live).toBe(0)
      s4vi.doUnmock('@huggingface/transformers')
    })
  })

  s4describe('ensureModel and the cache', () => {
    const MiB = 1024 * 1024
    class FakeCache {
      m = new Map<string, { buf: Uint8Array; headers: Headers }>()
      async match(k: any) { const e = this.m.get(typeof k === 'string' ? k : k.url); return e ? new Response(e.buf, { headers: e.headers }) : undefined }
      async put(k: any, r: Response) { this.m.set(typeof k === 'string' ? k : k.url, { buf: new Uint8Array(await r.arrayBuffer()), headers: new Headers(r.headers) }) }
      async keys() { return [...this.m.keys()].map((url) => ({ url })) }
    }
    const store = new Map<string, FakeCache>()
    const realFetch = globalThis.fetch
    let fileHits: string[] = []
    s4beforeEach(() => {
      store.clear(); fileHits = []
      ;(globalThis as any).caches = {
        open: async (n: string) => { if (!store.has(n)) store.set(n, new FakeCache()); return store.get(n) },
        delete: async (n: string) => store.delete(n),
      }
      globalThis.fetch = (async (u: any) => {
        const url = String(u)
        if (url.includes('/api/models/')) return new Response(JSON.stringify({ siblings: [
          { rfilename: 'config.json', size: 5 }, { rfilename: 'tokenizer.json', size: 7 },
          { rfilename: 'onnx/model_quantized.onnx', size: 20 }, { rfilename: 'onnx/model.onnx', size: 90 }, { rfilename: 'model.safetensors', size: 1000 },
        ] }))
        fileHits.push(url)
        return new Response(new Uint8Array(url.includes('onnx') ? 20 : url.includes('tokenizer') ? 7 : 5), { headers: { 'content-length': '20' } })
      }) as any
    })
    s4afterEach(() => { globalThis.fetch = realFetch; delete (globalThis as any).caches })
    const spec: any = { repo: 'o/m', task: 'fill-mask', onnx: { repo: 'o/m', dtypes: ['q8', 'fp32'], sizes: { q8: 32 } } }

    s4it('downloads only the chosen precision, then reports cached with zero model requests', async () => {
      const prog: number[] = []
      const r1 = await S4.ensureModel(spec, { device: 'wasm', onProgress: (d) => prog.push(d) }).done
      s4expect(r1.cached).toBe(false)
      s4expect(fileHits.sort()).toEqual(['https://huggingface.co/o/m/resolve/main/config.json', 'https://huggingface.co/o/m/resolve/main/onnx/model_quantized.onnx', 'https://huggingface.co/o/m/resolve/main/tokenizer.json'])
      s4expect(prog.at(-1)).toBeGreaterThan(0)
      s4expect(prog).toEqual([...prog].sort((a, b) => a - b))   // never goes backwards
      fileHits = []
      const r2 = await S4.ensureModel(spec, { device: 'wasm', onProgress: () => {} }).done
      s4expect(r2.cached).toBe(true)
      s4expect(fileHits).toEqual([])
      s4expect((await S4.planDownload(spec, { device: 'wasm' })).cached).toBe(true)
      const info = await S4.modelCacheInfo()
      s4expect(info.models).toEqual([{ repo: 'o/m', dtype: 'q8', bytes: 32 }])
      await S4.clearModels()
      s4expect((await S4.planDownload(spec, { device: 'wasm' })).cached).toBe(false)
    })
    s4it('cancel aborts and nothing is marked complete', async () => {
      const ac = new AbortController()
      const g = globalThis.fetch
      globalThis.fetch = ((u: any, i: any) => String(u).includes('/api/models/') ? g(u, i) : new Promise((_, rej) => i?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as any
      const h = S4.ensureModel(spec, { device: 'wasm', onProgress: () => {}, signal: ac.signal })
      setTimeout(() => ac.abort(), 20)
      await s4expect(h.done).rejects.toMatchObject({ code: 'aborted' })
      s4expect((await S4.planDownload(spec, { device: 'wasm' })).cached).toBe(false)
    })
    s4it('a full disk becomes a readable quota error', async () => {
      ;(globalThis as any).caches = { open: async () => ({ match: async () => undefined, put: async () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }) }, keys: async () => [] }), delete: async () => true }
      await s4expect(S4.ensureModel(spec, { device: 'wasm', onProgress: () => {} }).done).rejects.toMatchObject({ code: 'quota' })
    })
  })
})
