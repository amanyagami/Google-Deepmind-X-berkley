// node --test server.test.mjs   (memory store; no network, no Firestore)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { cleanName, nameBlocked, validateScore, mergeRow, rankRows, memoryStore, impliedScore, createHandler, deviceKey, Limiter, cacheFor } from './server.mjs'

const ID = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const P = { compute: 1200, memory: 900, gpu: 1500, storage: 600, model: null }
const body = (o = {}) => ({ deviceId: ID(1), name: 'Ada', score: Math.round(impliedScore(o.pillars ?? P)), pillars: P, tested: 0.8, backend: 'webgpu', appVersion: '0.1.0', ...o })

test('names: trimmed, control and format characters removed, 1-24 characters', () => {
  assert.equal(cleanName('  Ada  Lovelace \n'), 'Ada Lovelace')
  assert.equal(cleanName('A\u0000d‮a​'), 'Ada')
  assert.equal(cleanName('   '), null)
  assert.equal(cleanName('x'.repeat(25)), null)
  assert.equal(cleanName('é'.repeat(24)), 'é'.repeat(24))
  assert.equal(cleanName(42), null)
})

test('names: blocklist stops the obvious, keeps real names', () => {
  for (const n of ['fuck you', 'F u C k', 'sh1t', 'b1tch', 'www.spam.com', 'go to http://x', 'Admin', 'n1gg3r']) assert.ok(nameBlocked(n), n)
  for (const n of ['Ada', 'Dickens', 'Hancock', 'Nazir', 'Scunthorpe', 'Assam', 'Grape', 'Zoë', '李雷', 'Guest']) assert.ok(!nameBlocked(n), n)
})

test('validation: a good body passes and keeps no raw device ID', () => {
  const v = validateScore(body())
  assert.ok(v.ok, JSON.stringify(v))
  assert.equal(v.value.id, deviceKey(ID(1)))
  assert.ok(!JSON.stringify(v.value).includes(ID(1)))
})

test('validation: impossible values are rejected', () => {
  const cases = {
    deviceId: [{ deviceId: 'abc' }, { deviceId: '00000000-1111-1111-8111-111111111111' }],
    name: [{ name: '' }, { name: 'x'.repeat(30) }, { name: null }],
    score: [{ score: NaN }, { score: -5 }, { score: 20001 }, { score: '900' }, { score: Infinity }, { score: 5000 }],
    pillars: [{ pillars: { ...P, gpu: 20001 } }, { pillars: { ...P, gpu: 'NaN' }, score: 1000 }, { pillars: { ...P, extra: 1 } }, { pillars: [1, 2] }, { pillars: { compute: null, memory: null, gpu: null, storage: null, model: null } }],
    tested: [{ tested: 1.5 }, { tested: -0.1 }, { tested: 'all' }],
    backend: [{ backend: '<script>' }],
    appVersion: [{ appVersion: 'x'.repeat(30) }],
  }
  for (const [field, list] of Object.entries(cases)) for (const o of list) {
    const v = validateScore(body(o))
    assert.ok(!v.ok, `${field} ${JSON.stringify(o)} should fail`)
    assert.equal(v.field, field, JSON.stringify(o))
  }
  assert.equal(validateScore(body({ name: 'fuck' })).error, 'name_not_allowed')
  assert.equal(validateScore(body({ score: 5000 })).error, 'score_mismatch')
})

test('upsert: best kept, latest replaced, visits counted', () => {
  const a = mergeRow(null, { name: 'Ada', score: 1000, pillars: P, tested: 1, backend: 'w', appVersion: '1' }, 't1')
  assert.deepEqual([a.best, a.latest, a.visits, a.createdAt], [1000, 1000, 1, 't1'])
  const b = mergeRow(a, { name: 'Ada L', score: 800, pillars: P, tested: 1, backend: 'w', appVersion: '1' }, 't2')
  assert.deepEqual([b.best, b.latest, b.visits, b.name, b.createdAt, b.updatedAt, b.bestAt], [1000, 800, 2, 'Ada L', 't1', 't2', 't1'])
  const c = mergeRow(b, { name: 'Ada L', score: 1300, pillars: P, tested: 1, backend: 'w', appVersion: '1' }, 't3')
  assert.deepEqual([c.best, c.latest, c.visits, c.bestAt], [1300, 1300, 3, 't3'])
})

test('ranking: competition ranks, ties share a rank', () => {
  assert.deepEqual(rankRows([{ best: 9 }, { best: 7 }, { best: 7 }, { best: 3 }]).map((r) => r.rank), [1, 2, 2, 4])
})

test('memory store: top, count above, get', async () => {
  const s = memoryStore()
  for (const [i, sc] of [[1, 500], [2, 900], [3, 700]]) await s.upsert(deviceKey(ID(i)), { name: 'n' + i, score: sc, pillars: P, tested: 1, backend: '', appVersion: '' }, 't')
  assert.deepEqual((await s.top(2)).map((r) => r.best), [900, 700])
  assert.equal(await s.countAbove(700), 1)
  assert.equal(await s.count(), 3)
  assert.equal((await s.get(deviceKey(ID(1)))).best, 500)
})

test('limiter: N per window, then a wait', () => {
  const l = new Limiter(2, 1000)
  assert.equal(l.hit('a', 0), 0); assert.equal(l.hit('a', 10), 0); assert.ok(l.hit('a', 20) > 0); assert.equal(l.hit('b', 20), 0); assert.equal(l.hit('a', 1011), 0)
})

test('cache rules match the old nginx map', () => {
  assert.match(cacheFor('/assets/x.js'), /immutable/); assert.match(cacheFor('/ort/a.wasm'), /immutable/)
  for (const u of ['/', '/index.html', '/sw.js']) assert.equal(cacheFor(u), 'no-cache')
  assert.equal(cacheFor('/examples/index.json'), null)
})

/* ---- over HTTP ---- */
async function serve(opts = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'kdist-'))
  fs.mkdirSync(path.join(dist, 'assets')); fs.mkdirSync(path.join(dist, 'ort'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>K</title></head><body></body></html>')
  fs.writeFileSync(path.join(dist, '_headers'), "/*\n  Content-Security-Policy: default-src 'self'\n  X-Content-Type-Options: nosniff\n\n/assets/*\n  Cache-Control: x\n")
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1);'.repeat(200))
  fs.writeFileSync(path.join(dist, 'ort', 'r.wasm'), Buffer.alloc(3000, 1))
  fs.writeFileSync(path.join(dist, 'ort', 'r.wasm.gz'), zlib.gzipSync(Buffer.alloc(3000, 1)))
  const srv = http.createServer(createHandler({ dist, store: memoryStore(), limits: { deviceWrites: 3, ipWrites: 5, ...opts.limits } }))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  return { base, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}
const post = (base, b, h = {}) => fetch(base + '/api/scores', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) })

test('http: static headers, SPA fallback, 404 for missing build files, board marker in the page', async () => {
  const s = await serve()
  try {
    const r = await fetch(s.base + '/some/route')
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-cache'); assert.equal(r.headers.get('content-security-policy'), "default-src 'self'")
    assert.match(await r.text(), /<meta name="kundali-board"/)
    const a = await fetch(s.base + '/assets/a.js')
    assert.match(a.headers.get('cache-control'), /immutable/); assert.equal(a.headers.get('content-type'), 'text/javascript')
    const w = await fetch(s.base + '/ort/r.wasm')
    assert.equal(w.headers.get('content-type'), 'application/wasm'); assert.equal((await w.arrayBuffer()).byteLength, 3000)
    assert.equal((await fetch(s.base + '/assets/nope.js')).status, 404)
    assert.equal((await fetch(s.base + '/_headers')).headers.get('content-type'), 'text/html')
    assert.equal((await fetch(s.base + '/%2e%2e/%2e%2e/etc/passwd')).headers.get('content-type'), 'text/html')
    const h = await (await fetch(s.base + '/api/health')).json()
    assert.equal(h.ok, false); assert.equal(h.board, true)
  } finally { await s.close() }
})

test('http: submit, update the same row, leaderboard and own rank', async () => {
  const s = await serve()
  try {
    let r = await post(s.base, body())
    assert.equal(r.status, 200, await r.clone().text())
    r = await post(s.base, body({ deviceId: ID(2), name: 'Bob', pillars: { ...P, compute: 3000 }, score: Math.round(impliedScore({ ...P, compute: 3000 })) }))
    assert.equal(r.status, 200)
    const low = { ...P, compute: 300 }
    r = await post(s.base, body({ pillars: low, score: Math.round(impliedScore(low)), name: 'Ada 2' }))
    const me = (await r.json()).me
    assert.equal(me.visits, 2); assert.equal(me.best, Math.round(impliedScore(P))); assert.equal(me.rank, 2); assert.equal(me.name, 'Ada 2')
    const b = await (await fetch(s.base + '/api/leaderboard?limit=50')).json()
    assert.deepEqual(b.rows.map((x) => [x.rank, x.name]), [[1, 'Bob'], [2, 'Ada 2']]); assert.equal(b.total, 2)
    assert.ok(!JSON.stringify(b).includes(ID(1)))
    const m = await (await fetch(s.base + '/api/leaderboard/me?deviceId=' + ID(1))).json()
    assert.equal(m.me.rank, 2); assert.equal(m.me.visits, 2)
    assert.equal((await (await fetch(s.base + '/api/leaderboard/me?deviceId=' + ID(9))).json()).me, null)
  } finally { await s.close() }
})

test('http: other origins, wrong type, big bodies, bad JSON and floods are refused', async () => {
  const s = await serve()
  try {
    assert.equal((await post(s.base, body(), { origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(s.base + '/api/scores', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)
    assert.equal((await fetch(s.base + '/api/leaderboard', { headers: { origin: 'https://evil.example' } })).status, 403)
    const cors = await fetch(s.base + '/api/leaderboard', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    assert.equal(cors.headers.get('access-control-allow-origin'), null)
    assert.equal((await post(s.base, 'x', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post(s.base, JSON.stringify({ ...body(), pad: 'x'.repeat(5000) }))).status, 413)
    assert.equal((await post(s.base, '{nope')).status, 400)
    // ipWrites 5: the 415, 413 and 400 above counted (the 403s did not); two more pass, the next is refused
    assert.equal((await post(s.base, body({ deviceId: ID(5) }))).status, 200)
    assert.equal((await post(s.base, body({ deviceId: ID(6) }))).status, 200)
    const r = await post(s.base, body({ deviceId: ID(7) }))
    assert.equal(r.status, 429); assert.ok(+r.headers.get('retry-after') > 0)
  } finally { await s.close() }
  const s2 = await serve({ limits: { ipWrites: 100 } })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(s2.base, body())).status, 200)
    assert.equal((await post(s2.base, body())).status, 429)   // deviceWrites 3
    assert.equal((await post(s2.base, body({ deviceId: ID(2) }))).status, 200)
  } finally { await s2.close() }
})
