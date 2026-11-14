import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The FastAPI backend serves /api and /ws on :8000. In dev, Vite proxies to it.
// base './': the build is a static web app that works from any host and any sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
})
