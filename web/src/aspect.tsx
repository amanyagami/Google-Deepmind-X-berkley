import { useEffect } from 'react'
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
