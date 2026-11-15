import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// The FastAPI backend serves /api and /ws on :8000. In dev, Vite proxies to it.
// base './': the build is a static web app that works from any host and any sub-path.

// Cross-origin isolation (threads, precise timers) and a strict content policy. Keep in step with public/_headers.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://huggingface.co https://*.hf.co",
  "media-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' data: blob: https://huggingface.co https://*.huggingface.co https://*.hf.co http://127.0.0.1:8000 ws://127.0.0.1:8000",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ')
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' }

// Serves leaderboard API endpoints and meta marker during Vite dev so the leaderboard works without building first.
const devLeaderboard = (): Plugin => ({
  name: 'dev-leaderboard',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.includes('kundali-board') ? html : html.replace('</head>', '    <meta name="kundali-board" content="on" />\n  </head>')
  },
  async configureServer(s) {
    // loaded only by the dev server, so a build never depends on server-web/ (it may be absent or uninstalled)
    // @ts-ignore pure ESM module in server-web
    const { createApi, fileStore } = await import('./server-web/server.mjs').catch(() => ({ createApi: null, fileStore: null })) as any
    if (!createApi) return
    const store = fileStore(resolve(__dirname, '.kundali-scores.json'))
    const api = createApi({ store, trustProxy: true })
    s.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '')
      if (path !== '/api/scores' && path !== '/api/leaderboard' && path !== '/api/leaderboard/me') return next()
      try {
        const url = new URL(req.url ?? '/', 'http://localhost:3000')
        await api(req, res, url, { 'X-Content-Type-Options': 'nosniff' })
      } catch (err) {
        next(err as Error)
      }
    })
  },
})

// The ONNX runtime's WebAssembly files, served from our own origin at /ort/ (no third-party CDN).
const ORT = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']
const ortDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const selfHostOrt = (): Plugin => ({
  name: 'self-host-ort',
  configureServer(s) {
    s.middlewares.use((req, res, next) => {
      const f = ORT.find((n) => req.url?.split('?')[0].endsWith('/ort/' + n))
      if (!f) return next()
      res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
      res.end(readFileSync(resolve(ortDir, f)))
    })
  },
  enforce: 'post',
  generateBundle(_o, bundle) {
    // the runtime also gets bundled as a hashed 26 MB asset nobody loads (wasmPaths points at /ort/): drop that copy
    for (const k of Object.keys(bundle)) if (/^assets\/ort-wasm[^/]*\.wasm$/.test(k)) delete bundle[k]
    for (const n of ORT) this.emitFile({ type: 'asset', fileName: 'ort/' + n, source: readFileSync(resolve(ortDir, n)) })
  },
})

// Stamps public/sw.js in dist with a build hash and the list of files to keep for offline use.
const stampSw = (): Plugin => ({
  name: 'stamp-sw',
  apply: 'build',
  writeBundle(opts, bundle) {
    const out = opts.dir ?? resolve(__dirname, 'dist'), f = resolve(out, 'sw.js')
    // Vite also emits its own copy of the engine's wasm (unused: we point the engine at /ort/). Drop it.
    for (const n of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(n)) { try { unlinkSync(resolve(out, n)) } catch { /* already gone */ } delete bundle[n] }
    const names = Object.keys(bundle).filter((n) => !n.endsWith('.map'))
    const hash = createHash('sha1').update(names.join('|')).digest('hex').slice(0, 10)
    writeFileSync(f, readFileSync(f, 'utf8').replace('__BUILD__', hash).replace('__PRECACHE__', names.join(',')))
  },
})

export default defineConfig({
  base: './',
  // the app version, sent with a leaderboard score
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version) },
  plugins: [react(), devLeaderboard(), selfHostOrt(), stampSw()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    // dev keeps inline scripts and a live-reload socket, so only isolation is applied here; preview gets the full policy
    headers: { ...ISOLATION },
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  preview: { headers: { ...ISOLATION, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } },
  build: {
    outDir: 'dist', chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks(id) {
      // shared vendor chunks: three.js once, its React wrapper once, React once (not duplicated into each view)
      if (!id.includes('node_modules')) return
      if (/node_modules[\/]three[\/]/.test(id)) return 'three'
      if (/node_modules[\/](@react-three|postprocessing|three-stdlib|troika|@monogrid|meshline|camera-controls|maath|its-fine)/.test(id)) return 'r3f'
      if (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return 'react'
    } } },
  },
  worker: { format: 'es' },
})
