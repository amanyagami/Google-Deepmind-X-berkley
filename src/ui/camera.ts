// Guided camera (decision D17, audit D1-D3), shared by the model scene and the machine scene.
// The scene decides the pose it wants (its home framing, or a focused block/part) and hands it to the guide with
// `set(pos, target, animate, focused)`. The guide clamps what the visitor can do around it and brings the camera back:
//  - orbit: azimuth within ±35° of the home view, polar within the scene's band (never below the floor), damped;
//  - zoom: toward the cursor, only within the scene's distance band (closer only while something is focused);
//  - pan (truck): only while focused, and the target stays inside the scene's box + 2;
//  - with nothing focused, drag / pinch / Ctrl+wheel is a peek: on release (wheel: 600 ms after the last tick) the
//    camera eases back home in about 600 ms; instant under reduced motion; grabbing again cancels the return.
//    A focused view stays where the visitor leaves it until Reset view, Esc or a click on empty space.
import CameraControlsImpl from 'camera-controls'
import type CameraControls from 'camera-controls'
import * as THREE from 'three'

const DEG = Math.PI / 180
export interface SceneLimits { polar: [number, number]; dist: [number, number]; focusedMin: number; azimuth: number }
/** Exact limits per scene (audit D2). Distances widen only if the fitted home pose itself lies outside them (narrow phones). */
export const LIMITS: Record<'model' | 'machine', SceneLimits> = {
  model: { polar: [32 * DEG, 68 * DEG], dist: [12.5, 30], focusedMin: 4, azimuth: 35 * DEG },
  machine: { polar: [32 * DEG, 70 * DEG], dist: [11, 27], focusedMin: 4, azimuth: 35 * DEG },
}
const RETURN_SMOOTH = 0.18 // camera-controls smoothTime: settles in about 600 ms
const WHEEL_IDLE = 600
const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export interface Pose { pos: [number, number, number]; target: [number, number, number] }
export interface Guide {
  /** the pose the scene wants now (home or focused); a peek returns here */
  pose: Pose | null
  /** the home pose (nothing focused) */
  homePose: Pose | null
  focused: boolean
  grabbing: boolean
  returning: boolean
  limits: { polar: [number, number]; azimuth: [number, number]; dist: [number, number] }
  /** where the camera is now */
  now(): Pose
  /** true when the camera sits at the home pose with nothing focused */
  atHome(eps?: number): boolean
  /** move to a pose the scene wants; `smooth` overrides the transition time (seconds) */
  set(pos: THREE.Vector3 | number[], target: THREE.Vector3 | number[], animate: boolean, focused?: boolean, smooth?: number): void
  /** go back to the wanted pose now */
  home(animate?: boolean): void
  dispose(): void
}

const arr = (v: THREE.Vector3 | number[]): [number, number, number] => (Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z])

/** Attach a guide to a CameraControls instance. `bounds` is the scene's content box (the target may pan within it + 2). */
export function createGuide(c: CameraControls, scene: 'model' | 'machine', bounds: () => THREE.Box3): Guide {
  const S = LIMITS[scene]
  const ACT = CameraControlsImpl.ACTION
  let wheelT = 0
  const sph = new THREE.Spherical(), off = new THREE.Vector3(), p0 = new THREE.Vector3(), t0 = new THREE.Vector3()
  c.dollyToCursor = true; c.dollySpeed = 0.5; c.smoothTime = 0.25; c.draggingSmoothTime = 0.1
  const g: Guide = {
    pose: null, homePose: null, focused: false, grabbing: false, returning: false,
    limits: { polar: S.polar, azimuth: [-Infinity, Infinity], dist: S.dist },
    now() { c.getPosition(p0, false); c.getTarget(t0, false); return { pos: arr(p0), target: arr(t0) } },
    atHome(eps = 0.25) {
      const H = g.homePose; if (!H || g.focused) return false
      c.getPosition(p0, false); c.getTarget(t0, false)
      return p0.distanceTo(new THREE.Vector3(...H.pos)) < eps && t0.distanceTo(new THREE.Vector3(...H.target)) < eps
    },
    set(pos, target, animate, focused = false, smooth) {
      const p = arr(pos), t = arr(target)
      g.pose = { pos: p, target: t }; g.focused = focused
      if (!focused) g.homePose = g.pose
      // widen the limits for the move itself, then apply the ones around the new pose
      c.minAzimuthAngle = -Infinity; c.maxAzimuthAngle = Infinity; c.minPolarAngle = 0; c.maxPolarAngle = Math.PI
      c.minDistance = 0; c.maxDistance = Infinity
      c.smoothTime = smooth ?? 0.25
      g.returning = false
      const now = !animate || reduceMotion()
      const pose = g.pose
      // limits apply at once, widened to include where the camera is now so the move is never bent; tightened at rest
      apply(!now); c.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], !now)
      if (!now) wide = true
    },
    home(animate = true) { back(animate) },
    dispose() { c.removeEventListener('controlstart', onStart); c.removeEventListener('controlend', onEnd); c.removeEventListener('rest', onRest); window.clearTimeout(wheelT); dom?.removeEventListener('wheel', onWheel) },
  }
  let wide = false
  function apply(includeNow = false) {
    const H = g.homePose ?? g.pose, P = g.pose; if (!H || !P) return
    off.set(H.pos[0] - H.target[0], H.pos[1] - H.target[1], H.pos[2] - H.target[2]); sph.setFromVector3(off)
    const theta = sph.theta, dHome = sph.radius
    off.set(P.pos[0] - P.target[0], P.pos[1] - P.target[1], P.pos[2] - P.target[2]); const dNow = off.length()
    const pp = Math.acos(Math.min(1, off.y / Math.max(1e-6, dNow)))
    let lo = Math.min(g.focused ? S.focusedMin : S.dist[0], dNow), hi = Math.max(S.dist[1], dHome * 1.1, dNow)
    let pLo = Math.min(S.polar[0], pp), pHi = Math.max(S.polar[1], pp), aLo = theta - S.azimuth, aHi = theta + S.azimuth
    if (includeNow) { // the camera's current spot, so the transition to the new pose is not clamped
      c.getPosition(p0, false); c.getTarget(t0, false); off.copy(p0).sub(t0); sph.setFromVector3(off)
      lo = Math.min(lo, sph.radius); hi = Math.max(hi, sph.radius); pLo = Math.min(pLo, sph.phi); pHi = Math.max(pHi, sph.phi)
      let a = sph.theta; while (a < aLo - Math.PI) a += 2 * Math.PI; while (a > aHi + Math.PI) a -= 2 * Math.PI
      aLo = Math.min(aLo, a); aHi = Math.max(aHi, a)
    }
    c.minAzimuthAngle = aLo; c.maxAzimuthAngle = aHi
    c.minPolarAngle = pLo; c.maxPolarAngle = pHi
    c.minDistance = lo; c.maxDistance = hi
    g.limits = { polar: [pLo, pHi], azimuth: [aLo, aHi], dist: [lo, hi] }
    c.setBoundary(bounds().clone().expandByScalar(2)); c.boundaryEnclosesCamera = false; c.boundaryFriction = 0
    // truck (pan) only while focused
    c.mouseButtons.right = g.focused ? ACT.TRUCK : ACT.NONE
    c.mouseButtons.middle = g.focused ? ACT.TRUCK : ACT.DOLLY
    c.touches.two = g.focused ? ACT.TOUCH_DOLLY_TRUCK : ACT.TOUCH_DOLLY
    c.touches.three = g.focused ? ACT.TOUCH_TRUCK : ACT.NONE
  }
  function back(animate: boolean) {
    const P = g.pose; if (!P) return
    g.returning = true
    c.smoothTime = RETURN_SMOOTH
    c.setLookAt(P.pos[0], P.pos[1], P.pos[2], P.target[0], P.target[1], P.target[2], animate && !reduceMotion())
  }
  const onStart = () => { g.grabbing = true; g.returning = false; window.clearTimeout(wheelT) }
  const onEnd = () => { g.grabbing = false; if (!g.focused) back(true) }
  const onRest = () => { if (g.returning) { g.returning = false; c.smoothTime = 0.25 } if (wide && !g.grabbing) { wide = false; apply() } }
  // Ctrl+wheel / trackpad pinch: no start/end events, so return a moment after the last tick
  const onWheel = (e: WheelEvent) => { if (!(e.ctrlKey || e.metaKey)) return; window.clearTimeout(wheelT); g.returning = false; if (!g.focused) wheelT = window.setTimeout(() => { if (!g.grabbing) back(true) }, WHEEL_IDLE) }
  const dom = (c as any)._domElement as HTMLElement | undefined
  c.addEventListener('controlstart', onStart); c.addEventListener('controlend', onEnd); c.addEventListener('rest', onRest)
  dom?.addEventListener('wheel', onWheel, { passive: true })
  return g
}
