import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'

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
