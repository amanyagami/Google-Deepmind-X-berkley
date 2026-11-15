import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { useStore } from './store'

// Apply the saved theme before the first paint so there is no flash.
// index.html starts dark (the default); a saved choice replaces it before React renders.
try { const t = localStorage.getItem('ns.theme'); if (t === 'light') document.documentElement.dataset.theme = t; else if (t === 'system') delete document.documentElement.dataset.theme } catch { /* private mode */ }

// Exposed so browser tests and the devtools console can drive the app.
;(window as any).__studio = useStore
import('./hw/hwStore').then((m) => { ;(window as any).__hw = m.useHW })
import('./zoo/zooStore').then((m) => { ;(window as any).__zoo = m.useZoo })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

performance.mark('ns:shell')

// Offline shell: register the service worker in production. A waiting new version raises an event the page shows as a strip.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      ;(window as any).__sw = reg
      const waiting = () => reg.waiting && navigator.serviceWorker.controller && dispatchEvent(new CustomEvent('ns-sw-update', { detail: reg }))
      waiting(); reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', waiting))
    }).catch(() => { /* no service worker: the app still works */ })
  })
}
