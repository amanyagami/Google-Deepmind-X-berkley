// Kundali on Cloud Run: one small Node server, no framework.
//  - serves dist/ with the same headers, caching, types, gzip and single-page rules the old nginx config had
//  - the score leaderboard: POST /api/scores, GET /api/leaderboard, GET /api/leaderboard/me
// Storage: Firestore (collection "scores", one doc per device, id = sha256 of the device ID) or, for local runs and
// tests, memory (KUNDALI_STORE=memory, or no GOOGLE_CLOUD_PROJECT / K_SERVICE in the environment).
// Security headers come from dist/_headers (copied from public/_headers by the build), so there is one source.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ static files */

// nginx's stock mime.types for what the build contains, plus mjs and onnx (the two the old config added)
export const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'text/xml', txt: 'text/plain',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', wasm: 'application/wasm', onnx: 'application/octet-stream',
  svg: 'image/svg+xml', svgz: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
}
const DEFAULT_TYPE = 'application/octet-stream'
// gzip_types of the old config (text/html is always on in nginx); gzip_min_length 1024
const GZIP_TYPES = new Set(['text/html', 'text/css', 'text/javascript', 'application/javascript', 'application/json', 'application/wasm', 'application/octet-stream', 'image/svg+xml'])
const GZIP_MIN = 1024
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Cache-Control by final URI, as nginx's map did: hashed build files and the runtime forever, the page and the worker revalidate. */
export function cacheFor(uri) {
  if (uri.startsWith('/assets/') || uri.startsWith('/ort/')) return IMMUTABLE
  if (uri === '/' || uri === '/index.html' || uri === '/sw.js') return 'no-cache'
  return null
}

/** Security headers: the "/*" block of _headers. */
export function readSecurityHeaders(file) {
  const out = {}
  let inAll = false
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { inAll = line.trim() === '/*'; continue }
    const i = line.indexOf(':')
    if (inAll && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!out['Content-Security-Policy']) throw new Error(`${file}: no Content-Security-Policy in the /* block`)
  return out
}

const BOARD_META = '<meta name="kundali-board" content="on" />'
const httpDate = (ms) => new Date(Math.floor(ms / 1000) * 1000).toUTCString()
const etagOf = (st) => `"${Math.floor(st.mtimeMs / 1000).toString(16)}-${st.size.toString(16)}"`
const accepts = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')

function statFile(p) { try { const s = fs.statSync(p); return s.isFile() ? s : s.isDirectory() ? 'dir' : null } catch { return null } }

function createStatic(dist, sec) {
  const SMALL = 1 << 20   // files up to 1 MB are kept in memory with their gzip
  const mem = new Map()
  let index = null
  const loadIndex = () => {
    const f = path.join(dist, 'index.html'), st = fs.statSync(f)
    if (index && index.mtimeMs === st.mtimeMs) return index
    // the page carries a marker so the app knows this host has the leaderboard (no probe request, no console noise elsewhere)
    const html = fs.readFileSync(f, 'utf8').replace('</head>', `  ${BOARD_META}\n  </head>`)
    const body = Buffer.from(html)
    return (index = { mtimeMs: st.mtimeMs, body, gz: zlib.gzipSync(body, { level: 9 }), etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`, mtime: st.mtimeMs })
  }

  /** Resolve a decoded, normalised path to {file, uri} the way try_files $uri $uri/ /index.html did. */
  const indexFile = path.join(dist, 'index.html')
  function resolve(p) {
    const hidden = p.split('/').some((s) => s.startsWith('.') || s === '_headers')
    if (!hidden) {
      const abs = path.join(dist, p)
      if (abs.startsWith(dist)) {
        const st = statFile(abs)
        if (st && st !== 'dir') return abs === indexFile ? { index: true, uri: '/index.html' } : { abs, st, uri: p }
        if (st === 'dir') {
          const ix = path.join(abs, 'index.html'), s2 = statFile(ix)
          if (ix === indexFile) return { index: true, uri: '/index.html' }
          if (s2 && s2 !== 'dir') return { abs: ix, st: s2, uri: path.posix.join(p, 'index.html') }
        }
      }
    }
    if (p.startsWith('/assets/') || p.startsWith('/ort/')) return null   // a missing build file is a real 404, never the page
    return { index: true, uri: '/index.html' }
  }

  return function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, sec, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
    let p
    try { p = decodeURIComponent(pathname) } catch { return plain(res, sec, 400, 'Bad request') }
    if (p.includes('\0') || p.includes('\\')) return plain(res, sec, 400, 'Bad request')
    p = path.posix.normalize(p.replace(/\/{2,}/g, '/'))
    if (!p.startsWith('/')) return plain(res, sec, 400, 'Bad request')
    const hit = resolve(p)
    if (!hit) return plain(res, sec, 404, 'Not found')
    const h = { ...sec }
    const cc = cacheFor(p === '/' ? '/' : hit.uri)
    if (cc) h['Cache-Control'] = cc

    if (hit.index) {
      let ix
      try { ix = loadIndex() } catch { return plain(res, sec, 404, 'Not found') }
      Object.assign(h, { 'Content-Type': 'text/html', 'Last-Modified': httpDate(ix.mtime), ETag: ix.etag, Vary: 'Accept-Encoding' })
      if (fresh(req, ix.etag, ix.mtime)) return end(res, 304, h)
      const gz = accepts(req)
      if (gz) h['Content-Encoding'] = 'gzip'
      return end(res, 200, h, gz ? ix.gz : ix.body, req.method === 'HEAD')
    }

    const type = MIME[path.extname(hit.abs).slice(1).toLowerCase()] ?? DEFAULT_TYPE
    h['Content-Type'] = type
    // gzip_static: a prebuilt .gz next to the file wins
    const gzSt = statFile(hit.abs + '.gz')
    const canGzip = (gzSt && gzSt !== 'dir') || (GZIP_TYPES.has(type) && hit.st.size >= GZIP_MIN)
    if (canGzip) h.Vary = 'Accept-Encoding'
    if (accepts(req) && gzSt && gzSt !== 'dir') {
      Object.assign(h, { 'Content-Encoding': 'gzip', 'Last-Modified': httpDate(gzSt.mtimeMs), ETag: etagOf(gzSt) })
      if (fresh(req, h.ETag, gzSt.mtimeMs)) return end(res, 304, h)
      return sendFile(req, res, h, hit.abs + '.gz', gzSt)
    }
    Object.assign(h, { 'Last-Modified': httpDate(hit.st.mtimeMs), ETag: etagOf(hit.st) })
    if (fresh(req, h.ETag, hit.st.mtimeMs)) return end(res, 304, h)
    if (accepts(req) && canGzip) {   // gzip on the fly (level 6), like `gzip on`; nginx drops the strong ETag then
      delete h.ETag; h['Content-Encoding'] = 'gzip'
      if (hit.st.size <= SMALL) {
        const key = hit.abs + ':' + hit.st.mtimeMs
        let z = mem.get(key)
        if (!z) { z = zlib.gzipSync(fs.readFileSync(hit.abs), { level: 6 }); if (mem.size > 500) mem.clear(); mem.set(key, z) }
        return end(res, 200, h, z, req.method === 'HEAD')
      }
      res.writeHead(200, h)
      if (req.method === 'HEAD') return res.end()
      return fs.createReadStream(hit.abs).pipe(zlib.createGzip({ level: 6 })).pipe(res)
    }
    h['Accept-Ranges'] = 'bytes'
    return sendFile(req, res, h, hit.abs, hit.st, true)
  }
}

function fresh(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match']
  if (inm) return etag ? inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag) || inm.trim() === '*' : false
  const ims = Date.parse(req.headers['if-modified-since'] ?? '')
  return Number.isFinite(ims) && Math.floor(mtimeMs / 1000) * 1000 <= ims
}

function sendFile(req, res, h, abs, st, ranges = false) {
  let start = 0, endB = st.size - 1, status = 200
  const m = ranges && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) endB = Math.min(+m[2], st.size - 1) } else { start = Math.max(0, st.size - +m[2]) }
    if (start > endB || start >= st.size) return end(res, 416, { ...h, 'Content-Range': `bytes */${st.size}` })
    status = 206; h['Content-Range'] = `bytes ${start}-${endB}/${st.size}`
  }
  h['Content-Length'] = endB - start + 1
  res.writeHead(status, h)
  if (req.method === 'HEAD' || h['Content-Length'] === 0) return res.end()
  fs.createReadStream(abs, { start, end: endB }).on('error', () => res.destroy()).pipe(res)
}

function end(res, status, h, body, headOnly = false) {
  if (body) h['Content-Length'] = body.length
  res.writeHead(status, h)
  res.end(headOnly ? undefined : body)
}
function plain(res, sec, status, text, extra = {}) {
  end(res, status, { ...sec, 'Content-Type': 'text/plain; charset=utf-8', ...extra }, Buffer.from(text + '\n'))
}

/* ------------------------------------------------------------------ validation */

export const PILLARS = ['compute', 'memory', 'gpu', 'storage', 'model']
// same weights and "untested counts as 50" rule as src/hw/score.ts finalScore
const PILLAR_WEIGHT = { compute: 0.35, memory: 0.25, gpu: 0.15, storage: 0.10, model: 0.15 }
export const MAX_SCORE = 20000
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

// Simple moderation. STEMS match anywhere (letters only, leetspeak undone); WORDS match a whole word only, so
// "Dickens", "Hancock" and "Nazir" still pass. Not a filter for everything: it stops the obvious.
const STEMS = ['fuck', 'fuk', 'nigger', 'nigga', 'faggot', 'retard', 'whore', 'bitch', 'motherf', 'hitler', 'porn', 'kkk', 'wanker']
const WORDS = new Set(['cunt', 'cunts', 'shit', 'dick', 'cock', 'pussy', 'ass', 'arse', 'asshole', 'slut', 'rape', 'rapist', 'nazi', 'nazis', 'sex', 'tits', 'fag', 'spic', 'chink',
  'kike', 'wank', 'twat', 'piss', 'cum', 'penis', 'vagina', 'dildo', 'bastard', 'admin', 'moderator', 'official', 'kundali'])
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' }
const URLISH = /(https?:|www\.|\.(com|net|org|io|ru|xyz|gg|me|co|ly|link|app|dev)\b|discord\.)/i

/** Trimmed, control and format characters removed, spaces collapsed, 1-24 characters. null when that leaves nothing valid. */
export function cleanName(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null
  const s = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, '').replace(/\s+/gu, ' ').trim()
  const n = [...s].length
  return n >= 1 && n <= 24 ? s : null
}
export function nameBlocked(name) {
  if (URLISH.test(name)) return true
  const de = name.toLowerCase().replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c)
  const squashed = de.replace(/[^\p{L}]/gu, '')
  const collapsed = squashed.replace(/(\p{L})\1+/gu, '$1')
  if (STEMS.some((s) => squashed.includes(s) || collapsed.includes(s))) return true
  return de.split(/[^\p{L}]+/u).filter(Boolean).some((w) => WORDS.has(w) || WORDS.has(w.replace(/(\p{L})\1+/gu, '$1')))
}

/** The overall score the five pillars imply (weighted geometric mean, untested = 50). */
export function impliedScore(pillars) {
  return Math.exp(PILLARS.reduce((a, k) => a + PILLAR_WEIGHT[k] * Math.log(Math.max(1, pillars[k] ?? 50)), 0))
}

/** Checks a POST /api/scores body. Returns { ok: true, value } or { ok: false, error, field }. */
export function validateScore(b) {
  const bad = (field, error = 'invalid') => ({ ok: false, error, field })
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('body')
  if (typeof b.deviceId !== 'string' || !UUID4.test(b.deviceId)) return bad('deviceId')
  const name = cleanName(b.name)
  if (!name) return bad('name')
  if (nameBlocked(name)) return bad('name', 'name_not_allowed')
  if (!num(b.score, 1, MAX_SCORE)) return bad('score')
  const p = b.pillars
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((k) => !PILLARS.includes(k))) return bad('pillars')
  const pillars = {}
  for (const k of PILLARS) {
    const v = p[k] ?? null
    if (v !== null && !num(v, 0, MAX_SCORE)) return bad('pillars')
    pillars[k] = v === null ? null : Math.round(v * 10) / 10
  }
  if (PILLARS.every((k) => pillars[k] === null)) return bad('pillars')
  const implied = impliedScore(pillars)
  if (Math.abs(b.score - implied) > Math.max(3, implied * 0.03)) return bad('score', 'score_mismatch')
  if (!num(b.tested, 0, 1)) return bad('tested')
  const backend = b.backend ?? b.gpu ?? ''
  if (typeof backend !== 'string' || !/^[\w .()+-]{0,24}$/.test(backend)) return bad('backend')
  const appVersion = b.appVersion ?? ''
  if (typeof appVersion !== 'string' || !/^[\w.+-]{0,20}$/.test(appVersion)) return bad('appVersion')
  return { ok: true, value: { id: deviceKey(b.deviceId), name, score: Math.round(b.score), pillars, tested: Math.round(b.tested * 100) / 100, backend, appVersion } }
}

/** The stored key: sha256 of the lower-cased device ID. The raw ID is never stored. */
export const deviceKey = (deviceId) => crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex')

/** One device's row after a new submission: best score kept, latest replaced, visits counted. */
export function mergeRow(prev, e, now) {
  const latest = { name: e.name, latest: e.score, latestPillars: e.pillars, tested: e.tested, backend: e.backend, appVersion: e.appVersion, updatedAt: now }
  if (!prev) return { ...latest, best: e.score, bestPillars: e.pillars, bestTested: e.tested, bestAt: now, createdAt: now, visits: 1 }
  const better = e.score > (prev.best ?? 0)
  return { ...prev, ...latest, visits: (prev.visits ?? 0) + 1, ...(better ? { best: e.score, bestPillars: e.pillars, bestTested: e.tested, bestAt: now } : {}) }
}

/** Competition ranks over rows sorted by best (1, 2, 2, 4). */
export function rankRows(rows) {
  let prev = null
  return rows.map((r, i) => { const rank = prev && prev.best === r.best ? prev.rank : i + 1; prev = { best: r.best, rank }; return { ...r, rank } })
}

/* ------------------------------------------------------------------ stores */

const byBest = (a, b) => b.best - a.best || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function memoryStore() {
  const docs = new Map()
  return {
    kind: 'memory',
    docs,
    async upsert(id, e, now) { const next = mergeRow(docs.get(id) ?? null, e, now); docs.set(id, next); return { ...next } },
    async get(id) { const d = docs.get(id); return d ? { ...d } : null },
    async top(limit) { return [...docs].map(([id, d]) => ({ id, ...d })).sort(byBest).slice(0, limit) },
    async countAbove(best) { let n = 0; for (const d of docs.values()) if (d.best > best) n++; return n },
    async count() { return docs.size },
  }
}

export function fileStore(filePath) {
  const docs = new Map()
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, d] of Object.entries(raw)) {
          if (d && typeof d === 'object' && typeof d.best === 'number') docs.set(id, d)
        }
      }
    }
  } catch { /* corrupt or missing file starts fresh */ }
  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(docs), null, 2))
      fs.renameSync(tmp, filePath)
    } catch { /* ignore transient write errors */ }
  }
  return {
    kind: 'file',
    filePath,
    docs,
    async upsert(id, e, now) { const next = mergeRow(docs.get(id) ?? null, e, now); docs.set(id, next); persist(); return { ...next } },
    async get(id) { const d = docs.get(id); return d ? { ...d } : null },
    async top(limit) { return [...docs].map(([id, d]) => ({ id, ...d })).sort(byBest).slice(0, limit) },
    async countAbove(best) { let n = 0; for (const d of docs.values()) if (d.best > best) n++; return n },
    async count() { return docs.size },
  }
}

export async function firestoreStore() {
  const { Firestore } = await import('@google-cloud/firestore')
  const db = new Firestore({
    ...(process.env.GOOGLE_CLOUD_PROJECT ? { projectId: process.env.GOOGLE_CLOUD_PROJECT } : {}),
    ...(process.env.KUNDALI_FIRESTORE_DB ? { databaseId: process.env.KUNDALI_FIRESTORE_DB } : {}),
    ignoreUndefinedProperties: true,
  })
  const col = db.collection(process.env.KUNDALI_COLLECTION || 'scores')
  return {
    kind: 'firestore',
    async upsert(id, e, now) {
      const ref = col.doc(id)
      return db.runTransaction(async (t) => { const s = await t.get(ref); const next = mergeRow(s.exists ? s.data() : null, e, now); t.set(ref, next); return next })
    },
    async get(id) { const s = await col.doc(id).get(); return s.exists ? s.data() : null },
    async top(limit) { return (await col.orderBy('best', 'desc').limit(limit).get()).docs.map((d) => ({ id: d.id, ...d.data() })) },
    async countAbove(best) { return (await col.where('best', '>', best).count().get()).data().count },
    async count() { return (await col.count().get()).data().count },
  }
}

export async function pickStore(env = process.env) {
  const want = (env.KUNDALI_STORE || '').toLowerCase()
  if (want === 'memory') return memoryStore()
  if (want === 'firestore') return firestoreStore()
  if (env.GOOGLE_CLOUD_PROJECT || env.K_SERVICE) {
    try { return await firestoreStore() }
    catch (err) {
      console.error('Firestore unavailable, falling back to memory store:', err?.message ?? err)
      return memoryStore()
    }
  }
  return fileStore(env.KUNDALI_DATA_FILE || path.join(HERE, '..', '.kundali-scores.json'))
}

/* ------------------------------------------------------------------ rate limits (per instance, in memory) */

export class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); this.n = 0 }
  /** Counts one hit for key. Returns 0 when allowed, else the seconds until the next one is. */
  hit(key, now = Date.now()) {
    if (++this.n % 1000 === 0 || this.hits.size > 50000) this.sweep(now)
    const from = now - this.windowMs
    const a = (this.hits.get(key) ?? []).filter((t) => t > from)
    if (a.length >= this.max) { this.hits.set(key, a); return Math.max(1, Math.ceil((a[0] + this.windowMs - now) / 1000)) }
    a.push(now); this.hits.set(key, a); return 0
  }
  sweep(now) { const from = now - this.windowMs; for (const [k, a] of this.hits) if (!a.length || a[a.length - 1] <= from) this.hits.delete(k) }
}

/* ------------------------------------------------------------------ API */

const BODY_MAX = 4096
const json = (res, sec, status, obj, req, extra = {}) => {
  const body = Buffer.from(JSON.stringify(obj))
  const h = { ...sec, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  if (body.length >= GZIP_MIN) { h.Vary = 'Accept-Encoding'; if (req && accepts(req)) { h['Content-Encoding'] = 'gzip'; return end(res, status, h, zlib.gzipSync(body), req.method === 'HEAD') } }
  end(res, status, h, body, req?.method === 'HEAD')
}

function readBody(req) {
  return new Promise((resolve) => {
    const len = +(req.headers['content-length'] ?? 0)
    if (len > BODY_MAX) { req.resume(); return resolve({ tooBig: true }) }
    const parts = []; let n = 0, done = false
    req.on('data', (c) => { if (done) return; n += c.length; if (n > BODY_MAX) { done = true; req.resume(); return resolve({ tooBig: true }) } parts.push(c) })
    req.on('end', () => { if (!done) { done = true; resolve({ text: Buffer.concat(parts).toString('utf8') }) } })
    req.on('error', () => { if (!done) { done = true; resolve({ error: true }) } })
  })
}

export function createApi({ store, trustProxy = false, proxyHops = 1, origins = [], limits = {}, cacheMs = 10000, clock = () => Date.now() }) {
  const L = { ip: new Limiter(limits.ipWrites ?? 30, 3600e3), device: new Limiter(limits.deviceWrites ?? 10, 3600e3), reads: new Limiter(limits.ipReads ?? 120, 60e3) }
  let topCache = null   // { at, rows, total }

  const clientIp = (req) => {
    const xff = trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').map((s) => s.trim()).filter(Boolean) : []
    return xff.length ? xff[Math.max(0, xff.length - proxyHops)] : req.socket.remoteAddress ?? '?'
  }
  const ownOrigin = (req) => {
    const proto = trustProxy ? String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() : req.socket.encrypted ? 'https' : 'http'
    return `${proto}://${req.headers.host ?? ''}`
  }
  const sameHost = (origin, req) => {
    if (!origin) return false
    if (origin === ownOrigin(req) || origins.includes(origin)) return true
    if (trustProxy && req.headers.host) {
      try { return new URL(origin).host === req.headers.host } catch { return false }
    }
    return false
  }
  /** Same origin (including reverse-proxied / iframe hosts when Origin matches Host). Browsers send Origin on every POST. */
  const allowed = (req) => {
    const site = req.headers['sec-fetch-site']
    const origin = req.headers.origin
    if (req.method === 'POST') return !!origin && sameHost(origin, req) && (!site || site === 'same-origin' || site === 'same-site' || (trustProxy && site === 'cross-site'))
    if (origin && !sameHost(origin, req)) return false
    if (site && site !== 'same-origin' && site !== 'none' && !(trustProxy && (site === 'same-site' || (origin && sameHost(origin, req))))) return false
    return true
  }

  async function top(limit) {
    const now = clock()
    if (!topCache || now - topCache.at > cacheMs) {
      const [rows, total] = await Promise.all([store.top(100), store.count()])
      topCache = { at: now, rows: rankRows(rows), total }
    }
    return { rows: topCache.rows.slice(0, limit), total: topCache.total }
  }
  const publicRow = (r) => ({ rank: r.rank, name: r.name, best: r.best, pillars: r.bestPillars, tested: r.bestTested ?? r.tested, backend: r.backend ?? '', updatedAt: r.updatedAt })

  return async function api(req, res, url, sec) {
    const route = url.pathname.replace(/\/+$/, '')
    if (!allowed(req)) return json(res, sec, 403, { error: 'forbidden' }, req)
    try {
      if (route === '/api/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, sec, 405, { error: 'method' }, req, { Allow: 'GET, HEAD' })
        // ok:false on purpose: the app treats {ok:true} here as "the companion serves this page"
        return json(res, sec, 200, { ok: false, app: 'kundali', board: true, store: store.kind }, req)
      }
      if (route === '/api/scores') {
        if (req.method !== 'POST') return json(res, sec, 405, { error: 'method' }, req, { Allow: 'POST' })
        const ipWait = L.ip.hit(clientIp(req), clock())
        if (ipWait) return json(res, sec, 429, { error: 'rate_limited', retryAfter: ipWait }, req, { 'Retry-After': String(ipWait) })
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, sec, 415, { error: 'json_only' }, req)
        const b = await readBody(req)
        if (b.tooBig) return json(res, sec, 413, { error: 'too_large' }, req, { Connection: 'close' })
        if (b.error) return json(res, sec, 400, { error: 'bad_body' }, req)
        let body
        try { body = JSON.parse(b.text) } catch { return json(res, sec, 400, { error: 'bad_json' }, req) }
        const v = validateScore(body)
        if (!v.ok) return json(res, sec, 422, { error: v.error, field: v.field }, req)
        const devWait = L.device.hit(v.value.id, clock())
        if (devWait) return json(res, sec, 429, { error: 'rate_limited', retryAfter: devWait }, req, { 'Retry-After': String(devWait) })
        const { id, ...entry } = v.value
        const row = await store.upsert(id, entry, new Date(clock()).toISOString())
        topCache = null
        const [above, total] = await Promise.all([store.countAbove(row.best), store.count()])
        return json(res, sec, 200, { ok: true, me: { rank: above + 1, total, name: row.name, best: row.best, latest: row.latest, pillars: row.bestPillars, visits: row.visits, updatedAt: row.updatedAt } }, req)
      }
      if (route === '/api/leaderboard' || route === '/api/leaderboard/me') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, sec, 405, { error: 'method' }, req, { Allow: 'GET, HEAD' })
        const wait = L.reads.hit(clientIp(req), clock())
        if (wait) return json(res, sec, 429, { error: 'rate_limited', retryAfter: wait }, req, { 'Retry-After': String(wait) })
        if (route === '/api/leaderboard') {
          const lim = Math.max(1, Math.min(100, Math.floor(+(url.searchParams.get('limit') ?? 50)) || 50))
          const t = await top(lim)
          return json(res, sec, 200, { rows: t.rows.map(publicRow), total: t.total }, req)
        }
        const did = url.searchParams.get('deviceId') ?? ''
        if (!UUID4.test(did)) return json(res, sec, 422, { error: 'invalid', field: 'deviceId' }, req)
        const row = await store.get(deviceKey(did))
        if (!row) return json(res, sec, 200, { me: null, total: await store.count() }, req)
        const [above, total] = await Promise.all([store.countAbove(row.best), store.count()])
        return json(res, sec, 200, { me: { rank: above + 1, total, name: row.name, best: row.best, latest: row.latest, pillars: row.bestPillars, visits: row.visits, updatedAt: row.updatedAt } }, req)
      }
      return json(res, sec, 404, { error: 'not_found' }, req)
    } catch (e) {
      console.error(JSON.stringify({ severity: 'ERROR', message: 'api error', route, error: String(e?.message ?? e) }))
      return json(res, sec, 503, { error: 'unavailable' }, req)
    }
  }
}

/* ------------------------------------------------------------------ server */

export function createHandler({ dist, store, ...opts }) {
  dist = path.resolve(dist)
  const headersPath = fs.existsSync(path.join(dist, '_headers')) ? path.join(dist, '_headers') : path.join(HERE, '..', 'public', '_headers')
  const sec = readSecurityHeaders(headersPath)
  const serve = createStatic(dist, sec)
  const getStore = typeof store?.then === 'function' ? () => store : () => Promise.resolve(store)
  let apiReady = null
  const getApi = () => (apiReady ??= getStore().then((s) => createApi({ store: s, ...opts })))
  return async (req, res) => {
    let url
    try { url = new URL(req.url ?? '/', 'http://x') } catch { return plain(res, sec, 400, 'Bad request') }
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await (await getApi())(req, res, url, sec)
      return serve(req, res, url.pathname)
    } catch (e) {
      console.error(JSON.stringify({ severity: 'ERROR', message: 'request failed', path: url.pathname, error: String(e?.message ?? e) }))
      if (!res.headersSent) plain(res, sec, 500, 'Server error'); else res.destroy()
    }
  }
}

async function main() {
  const dist = path.resolve(process.env.KUNDALI_DIST || path.join(HERE, '..', 'dist'))
  const onCloudRun = !!process.env.K_SERVICE
  const storePromise = pickStore()
  const handler = createHandler({
    dist, store: storePromise,
    trustProxy: onCloudRun || process.env.KUNDALI_TRUST_PROXY === '1',
    proxyHops: +(process.env.KUNDALI_PROXY_HOPS || 1),
    origins: (process.env.KUNDALI_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    limits: { deviceWrites: +(process.env.KUNDALI_RATE_DEVICE || 10), ipWrites: +(process.env.KUNDALI_RATE_IP || 30), ipReads: +(process.env.KUNDALI_RATE_READS || 120) },
  })
  const srv = http.createServer(handler)
  srv.requestTimeout = 30000; srv.headersTimeout = 15000; srv.keepAliveTimeout = 65000
  srv.on('error', (err) => { console.error(err); process.exit(1) })
  const port = Number(process.env.PORT) || 8080
  const host = onCloudRun ? '0.0.0.0' : (process.env.HOST || '0.0.0.0')
  srv.listen(port, host, () => {
    console.log(`kundali listening on http://${host}:${port} (dist=${dist})`)
    storePromise.then((store) => {
      console.log(JSON.stringify({ severity: 'INFO', message: `kundali on :${port}`, store: store.kind, dist }))
      if (store.kind === 'memory' && onCloudRun) console.warn(JSON.stringify({ severity: 'WARNING', message: 'memory store on Cloud Run: scores are lost on restart' }))
    }).catch((err) => console.error(err))
  })
  const stop = () => srv.close(() => process.exit(0))
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1) })
