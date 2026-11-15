import { useEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'

/** How much farther the camera must sit on a narrow (portrait) screen to keep the scene's width in frame. */
export const aspectK = (aspect: number) => Math.min(3, Math.max(1, 1.45 / Math.max(0.2, aspect)))

/** Move the camera back along its view line by aspectK. */
export function aspectFit(p: number[], t: number[], aspect: number): number[] {
  const k = aspectK(aspect)
  return [t[0] + (p[0] - t[0]) * k, t[1] + (p[1] - t[1]) * k, t[2] + (p[2] - t[2]) * k]
}

/** Scene fog whose range stretches with the camera distance, so a pulled-back camera does not see only fog. */
export function FitFog({ color, near, far }: { color: string; near: number; far: number }) {
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height))
  const k = aspectK(aspect)
  return <fog attach="fog" args={[color, near * k, far * k]} />
}

/** The page scrolls through several 3D scenes, so a plain mouse wheel over a scene must scroll the page, not zoom it.
 *  Ctrl + wheel (and a trackpad pinch, which arrives as Ctrl + wheel) still zooms. */
export function WheelScrollsPage() {
  const el = useThree((s) => s.gl.domElement)
  useEffect(() => {
    const h = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation() }
    el.addEventListener('wheel', h, { capture: true })
    return () => el.removeEventListener('wheel', h, { capture: true })
  }, [el])
  return null
}

/** Draws a canvas with frameloop="demand" at a fixed rate. Used while a test measures the machine: the scene stays
 *  live, but at 30 frames a second instead of the display's full rate, so it takes less from the chip being tested. */
export function FpsCap({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const id = setInterval(() => invalidate(), 1000 / fps)
    return () => clearInterval(id)
  }, [fps, invalidate])
  return null
}

/* ROUND 2 CONTRACT (owner S1): the resolved theme for 3D scenes. S1 makes it follow data-theme / the OS setting. */
export type ThemeName = 'light' | 'dark'
const resolveTheme = (): ThemeName => {
  const t = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined
  return t === 'light' || t === 'dark' ? t : typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
/** The theme now in effect: the data-theme the toggle sets, else the OS setting. Updates when either changes. */
export function useTheme(): ThemeName {
  const [t, setT] = useState<ThemeName>(resolveTheme)
  useEffect(() => {
    const f = () => setT(resolveTheme())
    const mq = matchMedia('(prefers-color-scheme: light)'), mo = new MutationObserver(f)
    mq.addEventListener('change', f); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); f()
    return () => { mq.removeEventListener('change', f); mo.disconnect() }
  }, [])
  return t
}

/** The Kundali mark on a 2D canvas (share card): chamfered square, diagonals, inner diamond, vertex dots & central bindu star. */
export function drawKundali(g: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const gr = g.createLinearGradient(x, y, x + size, y + size)
  gr.addColorStop(0, '#f6dfae'); gr.addColorStop(0.55, '#ffb454'); gr.addColorStop(1, '#ff7d5a')
  const h = size / 2
  const r = size * 0.14
  g.save()
  const aura = g.createRadialGradient(x + h, y + h, 0, x + h, y + h, size * 0.65)
  aura.addColorStop(0, 'rgba(255, 192, 113, 0.20)'); aura.addColorStop(0.6, 'rgba(255, 180, 84, 0.07)'); aura.addColorStop(1, 'rgba(255, 125, 90, 0)')
  g.fillStyle = aura
  g.beginPath(); g.roundRect(x, y, size, size, r); g.fill()

  g.strokeStyle = gr; g.lineWidth = Math.max(1.8, size / 13); g.lineJoin = 'round'; g.lineCap = 'round'
  g.beginPath(); g.roundRect(x, y, size, size, r); g.stroke()

  g.save(); g.globalAlpha = 0.82; g.lineWidth = Math.max(1.4, size / 16)
  g.beginPath(); g.moveTo(x + r * 0.4, y + r * 0.4); g.lineTo(x + size - r * 0.4, y + size - r * 0.4)
  g.moveTo(x + size - r * 0.4, y + r * 0.4); g.lineTo(x + r * 0.4, y + size - r * 0.4); g.stroke(); g.restore()

  g.beginPath()
  g.moveTo(x + h, y); g.lineTo(x + size, y + h); g.lineTo(x + h, y + size); g.lineTo(x, y + h); g.closePath()
  g.stroke()

  const dotR = Math.max(1.6, size / 18)
  for (const [dx, dy, col] of [[h, 0, '#f6dfae'], [size, h, '#ffb454'], [h, size, '#ff7d5a'], [0, h, '#ffb454']] as const) {
    g.fillStyle = col; g.beginPath(); g.arc(x + dx, y + dy, dotR, 0, Math.PI * 2); g.fill()
  }

  const s = size * 0.15, si = s * 0.32
  const sg = g.createLinearGradient(x + h - s, y + h - s, x + h + s, y + h + s)
  sg.addColorStop(0, '#fff6e2'); sg.addColorStop(0.5, '#ffc071'); sg.addColorStop(1, '#ff7d5a')
  g.fillStyle = sg
  g.beginPath()
  g.moveTo(x + h, y + h - s); g.lineTo(x + h + si, y + h - si); g.lineTo(x + h + s, y + h); g.lineTo(x + h + si, y + h + si)
  g.lineTo(x + h, y + h + s); g.lineTo(x + h - si, y + h + si); g.lineTo(x + h - s, y + h); g.lineTo(x + h - si, y + h - si)
  g.closePath(); g.fill()
  g.restore()
}
