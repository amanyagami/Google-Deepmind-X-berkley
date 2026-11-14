import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
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
  generateBundle() { for (const n of ORT) this.emitFile({ type: 'asset', fileName: 'ort/' + n, source: readFileSync(resolve(ortDir, n)) }) },
})

export default defineConfig({
  base: './',
  plugins: [react(), selfHostOrt()],
  server: {
    port: 5173,
    // dev keeps inline scripts and a live-reload socket, so only isolation is applied here; preview gets the full policy
    headers: { ...ISOLATION },
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  preview: { headers: { ...ISOLATION, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
})
