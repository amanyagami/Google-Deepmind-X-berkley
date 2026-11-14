import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { useStore } from './store'
import { useHW } from './hw/hwStore'
import { useZoo } from './zoo/zooStore'

// Exposed so browser tests and the devtools console can drive the app.
;(window as any).__studio = useStore
;(window as any).__hw = useHW
;(window as any).__zoo = useZoo

// Run the ONNX engine from our own files (/ort/), not a CDN. Set before the first model loads.
import('@huggingface/transformers').then((tf: any) => {
  const root = new URL('ort/', document.baseURI).href
  tf.env.backends.onnx.wasm.wasmPaths = { mjs: root + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: root + 'ort-wasm-simd-threaded.asyncify.wasm' }
}).catch(() => { /* the engine then uses its default location */ })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
