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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
