// The machine: where the watts go while it works, and where a prompt goes while the model answers.
// Package and per-core power come from the CPU's own energy counters (RAPL, read by the companion) or, in a
// browser without the companion, from a labelled estimate. Everything that moves is driven by those numbers:
// particle speed and density on the copper follow package watts, each core's colour, height and sparks follow
// that core's watts, and the regulator phases fire in turn at a rate that follows the load.
// When a prompt's journey exists, its timeline (activityAt) drives the same scene: cores, RAM and the data rails
// (blue) light as the prompt goes keyboard -> CPU <-> RAM -> screen, while the copper rails (amber) carry the power.
import { useContext, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { aspectFit, FpsCap, useTheme, WheelScrollsPage } from '../aspect'
import { CameraControls, Environment, Lightformer, RoundedBox } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { peaksOf, powerNow, useHW, useHWThrottled, type PowerMode, type PowerSample } from './hwStore'
import { activityAt, locate } from './timeline'
import { Chip, FirstFrame, fitBox, KitProvider, LiteCtx, markTween, reduceMotion, setText, SlowWatch, useStage, useStageKeys, Word } from '../zoo/ZooScene'

// ---- live readout under a label: the newest OS sample, 10 times a second -------------------------------------
/** What a 3D label can show live, straight from the OS sample that arrives 10 times a second. */
export type LiveKey = 'cpu' | 'ram' | 'ssd' | 'nic' | `core${number}`

const rate = (bps: number) => (bps >= 1e9 ? `${(bps / 1e9).toFixed(1)} GB/s` : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`)

export function liveText(k: LiveKey, l: any): string {
  if (!l) return ''
  if (k === 'cpu') {
    const ghz = l.power?.eff_mhz ? l.power.eff_mhz / 1000 : l.mhz ? l.mhz / 1000 : 0
    return [`${Math.round(l.cpu_avg ?? 0)}% busy`, ghz ? `${ghz.toFixed(2)} GHz` : '', l.power?.pkg_w != null ? `${l.power.pkg_w.toFixed(1)} W` : ''].filter(Boolean).join(' · ')
  }
  if (k === 'ram') return l.ram_total ? `${(l.ram_used / 2 ** 30).toFixed(1)} of ${(l.ram_total / 2 ** 30).toFixed(0)} GB in use` : ''
  if (k === 'ssd') return `read ${rate(l.disk_read_bps ?? 0)} · write ${rate(l.disk_write_bps ?? 0)}`
  if (k === 'nic') return `↓ ${rate(l.net_recv_bps ?? 0)}${l.net_sent_bps != null ? ` · ↑ ${rate(l.net_sent_bps)}` : ''}`
  const c = +k.slice(4)
  const u = l.cpu ?? []
  const load = ((u[c * 2] ?? 0) + (u[c * 2 + 1] ?? 0)) / 2
  const w = l.power?.core_w?.[c]
  return `${Math.round(load)}%${w != null ? ` · ${w.toFixed(1)} W` : ''}`
}

/** One live line under a 3D label. It re-renders only when its text changes. */
export function LiveLine({ k }: { k: LiveKey }) {
  const t = useHW((s) => liveText(k, s.latest))
  if (!t) return null
  return <i className="lv"><span className="livedot" aria-hidden />{t}</i>
}

/** The same live readout without its own wrapper, for use inside a label chip. */
function LiveBare({ k }: { k: LiveKey }) {
  const t = useHWThrottled((s) => liveText(k, s.latest), 250)
  return t ? <><span className="livedot" aria-hidden />{t}</> : null
}

const AMBER = new THREE.Color('#ffa94d')
const BLUE = new THREE.Color('#55a8ff')
const WHITE = new THREE.Color('#fff4e0')
const INK = new THREE.Color('#1a2342')
const COPPER = new THREE.Color('#c77b3a')
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** The sample to draw now: the test being recorded, the live sensors, or a replay. Computed once per store change. */
let memoState: unknown = null
let memo: { s: PowerSample | null; mode: PowerMode } = { s: null, mode: 'none' }
export function currentSample(): { s: PowerSample | null; mode: PowerMode } {
  const h = useHW.getState()
  if (h !== memoState) { memoState = h; memo = powerNow(h) }
  return memo
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0)
export interface Flows { ram: number; ssd: number; nic: number; ddr: number; usb: number; vid: number; typed: number; shown: number; stage?: string }
const FLAT: Flows = { ram: 0.08, ssd: 0.05, nic: 0.05, ddr: 0, usb: 0, vid: 0, typed: 0, shown: 0 }
let memoAState: unknown = null
let memoA: Flows = FLAT
/** How busy each part is (0..1). RAM, SSD and network supplies are not metered, so they glow with activity: from the
 *  prompt's journey while it plays, from the test that is running, or from the OS disk and network counters when live. */
export function activity(): Flows {
  const h = useHW.getState()
  if (h === memoAState) return memoA
  memoAState = h
  if (!h.benchRunning && h.pMode === 'journey' && h.journey) {
    const nc = h.info?.cpu?.cores ?? 8
    const a = activityAt(h.journey, h.tl, h.playhead, peaksOf(h), nc)
    return (memoA = { ram: Math.max(0.08, a.ram), ssd: 0.05, nic: 0.05, ddr: a.flow.ddr ?? 0, usb: a.flow.usb ?? 0, vid: a.flow.vid ?? 0, typed: a.typed, shown: a.shown, stage: a.stage })
  }
  const { s, mode } = currentSample()
  if (mode === 'live') {
    const t = h.latest
    const ram = 0.08
    return (memoA = { ...FLAT, ram, ddr: ram, ssd: 0.05 + 0.95 * clamp01(Math.sqrt(((t?.disk_read_bps ?? 0) + (t?.disk_write_bps ?? 0)) / 1e9)), nic: 0.05 + 0.95 * clamp01(Math.sqrt((t?.net_recv_bps ?? 0) / 1.25e7)) })
  }
  const st = s?.stage
  const ram = st === 'dram' ? 1 : st === 'ai' ? 0.8 : st === 'cache' ? 0.3 : 0.08
  return (memoA = { ...FLAT, ram, ddr: ram > 0.1 ? ram : 0, ssd: st === 'disk' || st === 'ai_load' ? 1 : 0.05, nic: st === 'net' ? 1 : 0.05 })
}

/** Colour of a core at w watts: dark, then blue, amber and white-hot. */
function heat(w: number, out: THREE.Color) {
  const x = Math.min(1, w / 9)
  if (x < 0.25) return out.copy(INK).lerp(BLUE, x / 0.25)
  if (x < 0.65) return out.copy(BLUE).lerp(AMBER, (x - 0.25) / 0.4)
  return out.copy(AMBER).lerp(WHITE, (x - 0.65) / 0.35)
}

// ---- layout ---------------------------------------------------------------------------------------
const CPU = V(1.2, 0, -0.2)
const DCIN = V(-8.6, 0, 3.6)
const RAMP = V(7.4, 0, -0.2)
const SSDP = V(1.2, 0, 5.0)
const NICP = V(-6.4, 0, -3.8)
const KEYP = V(8.0, 0, 5.6)
const SCRP = V(8.2, 0, -4.6)
const PHASES = 8
const phasePos = (k: number) => (k < 5 ? V(-3.4, 0, -3.0 + k * 1.15) : V(-1.8 + (k - 5) * 1.5, 0, -3.9))
const Y = 0.16

function curve(pts: THREE.Vector3[]) { return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.08) }

const RAILS = {
  input: curve([V(-8.0, Y, 3.6), V(-6.2, Y, 3.6), V(-5.0, Y, 2.0), V(-4.6, Y, -1.0), V(-4.6, Y, -3.9), V(1.6, Y, -4.7)]),
  phases: Array.from({ length: PHASES }, (_, k) => {
    const p = phasePos(k)
    return k < 5 ? curve([V(p.x + 0.45, Y, p.z), V(-1.4, Y, p.z * 0.8), V(-0.9, Y, CPU.z + (p.z - CPU.z) * 0.35)])
      : curve([V(p.x, Y, p.z + 0.45), V(p.x * 0.7 + CPU.x * 0.3, Y, -2.9), V(p.x * 0.4 + CPU.x * 0.6, Y, -2.35)])
  }),
  ram: curve([V(-6.2, Y, 4.4), V(4.4, Y, 4.4), V(6.2, Y, 3.0), V(7.2, Y, 2.1)]),
  ssd: curve([V(-6.2, Y, 4.0), V(-1.0, Y, 4.0), V(0.0, Y, 5.0)]),
  nic: curve([V(-6.8, Y, 3.0), V(-6.8, Y, 0.0), V(-6.4, Y, -3.0)]),
}
// data rails (blue): where the prompt and its numbers travel
const DY = 0.21
const DATA = {
  usb: curve([V(6.4, DY, 5.6), V(5.2, DY, 5.2), V(3.9, DY, 3.6), V(3.4, DY, 2.3)]),
  vid: curve([V(3.7, DY, -1.6), V(5.0, DY, -3.1), V(6.4, DY, -4.4)]),
  ddrA: curve([V(7.0, DY, -0.8), V(3.8, DY, -0.8)]),
  ddrB: curve([V(7.0, DY, 0.6), V(3.8, DY, 0.6)]),
  ssd: curve([V(1.2, DY, 4.6), V(1.2, DY, 2.3)]),
  nic: curve([V(-6.4, DY, -4.4), V(-6.4, DY, -5.5), V(2.8, DY, -5.5), V(2.8, DY, -2.7)]),
}

// ---- pieces -----------------------------------------------------------------------------------------
function Slab({ size, pos = [0, 0, 0], color = '#131b33', radius = 0.05, metal = 0.55, rough = 0.32, matRef }: any) {
  return (
    <RoundedBox args={size} radius={radius} smoothness={3} position={pos}>
      <meshPhysicalMaterial ref={matRef} color={color} metalness={metal} roughness={rough} clearcoat={0.7} clearcoatRoughness={0.25} />
    </RoundedBox>
  )
}

/** Which test results belong to which part of the machine (first one with a score wins). */
const CID: Record<string, string[]> = { cpu: ['cpun', 'cpu1'], cache: ['cache'], ram: ['ram'], ssd: ['storage'], nic: ['net'] }
const open = (id: string) => useHW.getState().dive([id])

/** A label chip: name + live value + the part's latest score; sub-line on hover or selection. Always mounted. Click selects. */
function Tag({ pos, name, sub, show = true, live, group, cid, prio = 1 }: { pos: [number, number, number]; name: string; sub?: string; show?: boolean; live?: LiveKey; group?: string; cid?: string; prio?: number }) {
  const path = useHW((s) => s.path)
  const hov = useHW((s) => s.hover === group)
  const score = useHW((s) => {
    const r = (s as any).results as Record<string, { score?: number | null }> | undefined
    for (const id of CID[cid ?? group ?? ''] ?? []) { const v = r?.[id]?.score; if (typeof v === 'number') return `score ${Math.round(v)}` }
    return undefined
  })
  const vis = show && !(path.length > 0 && group && path[0] !== group)
  return <Chip pos={pos} name={name} sub={sub} live={live ? <LiveBare k={live} /> : undefined} score={score} hidden={!vis} selected={!!group && path[0] === group} hovered={hov} prio={prio}
    onClick={group ? () => open(group) : undefined} onHover={group ? (h) => useHW.getState().setHover(h ? group : null) : undefined} />
}

/** Double-click a part to look inside it; the pointer shows which parts can be opened. */
function Hot({ pos, id, children }: { pos: THREE.Vector3; id: string; children: any }) {
  return (
    <group position={pos.toArray()}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; useHW.getState().setHover(id) }}
      onPointerOut={() => { document.body.style.cursor = ''; useHW.getState().setHover(null) }}
      onClick={(e) => { e.stopPropagation(); open(id) }}
      onDoubleClick={(e) => { e.stopPropagation(); open(id) }}>
      {children}
    </group>
  )
}

const PT = { light: false }
function Pcb() {
  const geo = useMemo(() => {
    const pts: number[] = []
    for (let x = -10; x <= 10; x += 0.5) pts.push(x, 0.011, -6, x, 0.011, 6.5)
    for (let z = -6; z <= 6.5; z += 0.5) pts.push(-10, 0.011, z, 10, 0.011, z)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return g
  }, [])
  return (
    <group>
      <RoundedBox args={[20.5, 0.3, 13]} radius={0.2} smoothness={4} position={[0, -0.15, 0.25]}>
        <meshPhysicalMaterial color={PT.light ? '#cfd6ee' : '#08101f'} metalness={PT.light ? 0.1 : 0.4} roughness={0.65} clearcoat={0.4} />
      </RoundedBox>
      <lineSegments geometry={geo}><lineBasicMaterial color={PT.light ? '#aab4d6' : '#17223f'} transparent opacity={0.5} /></lineSegments>
    </group>
  )
}

/** A copper rail with current flowing along it. `level` returns 0..1 for how much power it carries now. */
function Rail({ c, level, color = AMBER, count: count0 = 26, width = 0.045, speed = 1 }: { c: THREE.CatmullRomCurve3; level: () => number; color?: THREE.Color; count?: number; width?: number; speed?: number }) {
  const lite = useContext(LiteCtx), count = lite ? Math.max(4, Math.ceil(count0 / 2)) : count0
  const tube = useMemo(() => new THREE.TubeGeometry(c, 64, width, 8, false), [c, width])
  const mat = useRef<THREE.MeshPhysicalMaterial>(null!)
  const glow = useRef<THREE.MeshBasicMaterial>(null!)
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const p = useMemo(() => new THREE.Vector3(), [])
  const phase = useRef(Math.random())
  useFrame((_, dt) => {
    const lv = level()
    const f = Number.isFinite(lv) ? Math.max(0, Math.min(1, lv)) : 0
    mat.current.emissive.copy(color); mat.current.emissiveIntensity = 0.05 + 0.6 * f
    glow.current.opacity = 0.05 + 0.35 * f
    phase.current = (phase.current + (reduceMotion ? 0 : dt * speed * (0.08 + 0.9 * f))) % 1
    const on = Math.round(count * (0.15 + 0.85 * f))
    for (let i = 0; i < count; i++) {
      const u = Number.isFinite(phase.current) ? (phase.current + i / count) % 1 : 0
      c.getPointAt(u, p)
      d.position.copy(p)
      d.scale.setScalar(i < on && f > 0.02 ? 0.045 + 0.05 * f : 0.0001)
      d.updateMatrix(); mesh.current.setMatrixAt(i, d.matrix)
    }
    mesh.current.instanceMatrix.needsUpdate = true
  })
  return (
    <group>
      <mesh geometry={tube}><meshPhysicalMaterial ref={mat} color={COPPER} metalness={0.9} roughness={0.3} emissive={color} emissiveIntensity={0.1} /></mesh>
      <mesh geometry={useMemo(() => new THREE.TubeGeometry(c, 64, width * 3.2, 8, false), [c, width])}><meshBasicMaterial ref={glow} color={color} transparent opacity={0.1} depthWrite={false} toneMapped={false} /></mesh>
      <instancedMesh ref={mesh} args={[undefined as any, undefined as any, count]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 10]} /><meshBasicMaterial color={color.clone().multiplyScalar(3)} toneMapped={false} />
      </instancedMesh>
    </group>
  )
}

/** Power comes in here: the adapter's DC jack. */
function DcIn() {
  const ring = useRef<THREE.MeshBasicMaterial>(null!)
  useFrame(() => { const s = currentSample().s; const f = s ? Math.min(1, s.pkg_w / 70) : 0; ring.current.color.copy(AMBER).multiplyScalar(0.5 + 2.5 * f) })
  return (
    <group position={DCIN.toArray()}>
      <Slab size={[1.4, 0.8, 1.2]} pos={[0, 0.4, 0]} color="#151c33" />
      <mesh position={[-0.71, 0.45, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.28, 0.28, 0.06, 32]} /><meshStandardMaterial color="#0a0f1e" metalness={0.9} roughness={0.2} /></mesh>
      <mesh position={[-0.75, 0.45, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[0.2, 0.035, 12, 40]} /><meshBasicMaterial ref={ring} toneMapped={false} /></mesh>
      <Tag pos={[0, 1.4, 0]} name="Power in" sub="DC from the adapter" group="vrm" />
    </group>
  )
}

/** The voltage regulator: several phases take turns converting the input down to about 1 V for the cores. */
function Vrm() {
  const chokes = useRef<THREE.MeshPhysicalMaterial[]>([])
  const fets = useRef<THREE.MeshBasicMaterial[]>([])
  const t = useRef(0)
  useFrame((_, dt) => {
    const s = currentSample().s
    const f = s ? Math.min(1, s.pkg_w / 65) : 0
    t.current += reduceMotion ? 0 : dt * (0.6 + 5 * f)  // a visual rate: real phases switch ~500 000 times a second
    for (let k = 0; k < PHASES; k++) {
      const on = ((t.current + k / PHASES) % 1) < (0.22 + 0.5 * f) ? 1 : 0.15
      const m = chokes.current[k]; if (m) { m.emissive.copy(AMBER); m.emissiveIntensity = 0.03 + f * 1.4 * on }
      const g = fets.current[k]; if (g) g.color.copy(AMBER).multiplyScalar(0.25 + 3 * f * on)
    }
  })
  return (
    <group onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; useHW.getState().setHover('vrm') }} onPointerOut={() => { document.body.style.cursor = ''; useHW.getState().setHover(null) }}
      onClick={(e) => { e.stopPropagation(); open('vrm') }} onDoubleClick={(e) => { e.stopPropagation(); open('vrm') }}>
      {Array.from({ length: PHASES }, (_, k) => {
        const p = phasePos(k)
        return (
          <group key={k} position={p.toArray()}>
            <Slab size={[0.55, 0.12, 0.55]} pos={[-0.35, 0.08, 0]} color="#0c1222" />
            <mesh position={[-0.35, 0.16, 0]}><boxGeometry args={[0.32, 0.03, 0.32]} /><meshBasicMaterial ref={(m) => { if (m) fets.current[k] = m }} toneMapped={false} /></mesh>
            <RoundedBox args={[0.62, 0.42, 0.62]} radius={0.06} smoothness={3} position={[0.32, 0.22, 0]}>
              <meshPhysicalMaterial ref={(m) => { if (m) chokes.current[k] = m }} color="#2b2f3a" metalness={0.7} roughness={0.4} clearcoat={0.3} />
            </RoundedBox>
            {[-0.2, 0.2].map((z) => <mesh key={z} position={[0.0, 0.2, z * 1.6]}><cylinderGeometry args={[0.09, 0.09, 0.36, 16]} /><meshStandardMaterial color="#3d4660" metalness={0.8} roughness={0.25} /></mesh>)}
          </group>
        )
      })}
      <Tag pos={[-3.4, 1.1, -3.6]} name="Voltage regulator" sub="8 phases · ~1 V out" group="vrm" />
    </group>
  )
}

/** The CPU: package, a power grid ring, and one tile per core whose colour, height and sparks follow its watts. */
function CpuChip() {
  const n = useHW((s) => s.info?.cpu?.cores ?? 8)
  const logical = useHW((s) => !!s.info?.cpu?.logical_only)
  const nCores = logical ? Math.max(1, Math.round(n / 2)) : n
  const cols = Math.ceil(nCores / 2)
  const sp = Math.min(1.05, 3.6 / cols)
  const cores = useMemo(() => Array.from({ length: nCores }, (_, k) => ({ k, x: (k % cols - (cols - 1) / 2) * sp, z: (Math.floor(k / cols) - 0.5) * sp * 1.05 - 0.3 })), [nCores, cols, sp])
  const tiles = useRef<THREE.InstancedMesh>(null!)
  const heatM = useRef<THREE.InstancedMesh>(null!)
  const ring = useRef<THREE.MeshBasicMaterial>(null!)
  const soc = useRef<THREE.MeshPhysicalMaterial>(null!)
  const arcs = useRef<THREE.LineSegments>(null!)
  const labels = useRef<(HTMLDivElement | null)[]>([])
  const path = useHW((s) => s.path)
  const away = path.length > 0 && path[0] !== 'cpu'
  const deepCore = path[0] === 'cpu' && path[1]?.startsWith('core') ? +path[1].slice(4) : -1
  const d = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])
  const HEAT = 14
  const arcGeo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(nCores * 2 * 6 * 2 * 3), 3)); return g }, [nCores])
  const lastArc = useRef(0), lastTxt = useRef(0), hot = useRef(-1)
  useFrame(({ clock }) => {
    const s = currentSample().s
    const time = clock.elapsedTime
    const cw = s?.core_w ?? []
    const doText = time - lastTxt.current > 0.25 // label text at 4 Hz
    if (doText) { lastTxt.current = time; let mx = 0.5; hot.current = -1; for (let i = 0; i < cw.length; i++) if ((cw[i] ?? 0) > mx) { mx = cw[i]; hot.current = i } }
    const pulse = reduceMotion ? 1 : 1 + 0.18 * Math.sin(time * 5)
    const coreSum = cw.reduce((a, b) => a + (b ?? 0), 0)
    ring.current.color.copy(AMBER).multiplyScalar(0.3 + 2.4 * Math.min(1, (s?.pkg_w ?? 0) / 65))
    soc.current.emissiveIntensity = 0.05 + 1.2 * Math.min(1, Math.max(0, ((s?.pkg_w ?? 0) - coreSum) / 25))
    for (const c of cores) {
      const w = cw[c.k] ?? 0
      const h = 0.1 + Math.min(1.4, w * 0.15)
      d.position.set(c.x, 0.3 + h / 2, c.z); d.scale.set(1, h, 1); d.updateMatrix(); tiles.current.setMatrixAt(c.k, d.matrix)
      heat(w, col); tiles.current.setColorAt(c.k, col.multiplyScalar((1 + Math.min(2.2, w / 3)) * (c.k === hot.current ? pulse : 1)))
      for (let i = 0; i < HEAT; i++) {
        const life = ((time * (0.25 + w * 0.06) + i / HEAT + c.k * 0.37) % 1)
        const on = i < Math.round(HEAT * Math.min(1, w / 8))
        d.position.set(c.x + Math.sin(i * 7.1 + c.k) * sp * 0.28, 0.4 + h + life * 2.2, c.z + Math.cos(i * 3.7 + c.k) * sp * 0.28)
        d.scale.setScalar(on && !reduceMotion ? 0.05 * (1 - life) + 0.01 : 0.0001); d.updateMatrix(); heatM.current.setMatrixAt(c.k * HEAT + i, d.matrix)
      }
      const el = labels.current[c.k]
      if (el && doText) { setText(el, `${w.toFixed(1)} W`); el.style.outline = c.k === deepCore ? '1px solid #ffa94d' : '' }
    }
    tiles.current.instanceMatrix.needsUpdate = true; tiles.current.instanceColor!.needsUpdate = true; heatM.current.instanceMatrix.needsUpdate = true
    // sparks: short jagged arcs from the power ring into each busy core, redrawn ~15 times a second
    if (time - lastArc.current > 0.066 && !reduceMotion) {
      lastArc.current = time
      const pos = arcGeo.getAttribute('position') as THREE.BufferAttribute
      const a = pos.array as Float32Array
      a.fill(0)
      let o = 0
      for (const c of cores) {
        const w = cw[c.k] ?? 0
        const nArc = w > 6 ? 2 : w > 3 ? 1 : 0
        for (let j = 0; j < nArc; j++) {
          const ang = Math.random() * Math.PI * 2
          const sx = Math.cos(ang) * 2.15, sz = Math.sin(ang) * 2.0 - 0.2
          let px = sx, py = 0.32, pz = sz
          for (let seg = 0; seg < 6; seg++) {
            const u = (seg + 1) / 6
            const nx = sx + (c.x - sx) * u + (seg < 5 ? (Math.random() - 0.5) * 0.35 : 0)
            const nz = sz + (c.z - sz) * u + (seg < 5 ? (Math.random() - 0.5) * 0.35 : 0)
            const ny = 0.32 + Math.sin(u * Math.PI) * 0.35 + 0.15 * u
            a.set([px, py, pz, nx, ny, nz], o); o += 6
            px = nx; py = ny; pz = nz
          }
        }
      }
      pos.needsUpdate = true
    }
  })
  return (
    <group position={CPU.toArray()}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; useHW.getState().setHover('cpu') }} onPointerOut={() => { document.body.style.cursor = ''; useHW.getState().setHover(null) }}
      onClick={(e) => { e.stopPropagation(); useHW.getState().dive(e.object === tiles.current && e.instanceId != null ? ['cpu', `core${e.instanceId}`] : ['cpu']) }}
      onDoubleClick={(e) => { e.stopPropagation(); useHW.getState().dive(e.object === tiles.current && e.instanceId != null ? ['cpu', `core${e.instanceId}`] : ['cpu']) }}>
      <Slab size={[5.0, 0.22, 4.8]} color="#141c36" radius={0.14} />
      <Slab size={[4.4, 0.1, 4.2]} pos={[0, 0.15, 0]} color="#0c1330" radius={0.08} />
      <mesh position={[0, 0.22, -0.2]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[2.0, 2.08, 96]} /><meshBasicMaterial ref={ring} toneMapped={false} side={THREE.DoubleSide} /></mesh>
      <instancedMesh ref={tiles} args={[undefined as any, undefined as any, nCores]}>
        <boxGeometry args={[sp * 0.78, 1, sp * 0.78]} /><meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={heatM} args={[undefined as any, undefined as any, nCores * HEAT]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 8]} /><meshBasicMaterial color={AMBER.clone().multiplyScalar(1.6)} transparent opacity={0.55} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <lineSegments ref={arcs} geometry={arcGeo}><lineBasicMaterial color={new THREE.Color('#bfe3ff').multiplyScalar(2.6)} toneMapped={false} transparent opacity={0.9} /></lineSegments>
      <RoundedBox args={[3.6, 0.1, 0.7]} radius={0.04} smoothness={2} position={[0, 0.26, 1.65]}>
        <meshPhysicalMaterial ref={soc} color="#15203f" emissive={BLUE} emissiveIntensity={0.1} metalness={0.5} roughness={0.35} />
      </RoundedBox>
      {/* a fixed number of labels, so the core count changing never unmounts one (drei <Html> must stay mounted) */}
      {Array.from({ length: 64 }, (_, k) => { const c = cores[k]; return <Word key={k} pos={c ? [c.x, 0.2, c.z + sp * 0.5] : [0, 0.2, 0]} hidden={away || !c} elRef={(el) => { labels.current[k] = el }}>—</Word> })}
      <Tag pos={[0, 1.9, -2.7]} name={deepCore >= 0 ? `Core ${deepCore}` : 'CPU'} sub={deepCore >= 0 ? undefined : `${nCores} cores${logical ? ' (2 threads each, assumed)' : ''}`} live={deepCore >= 0 ? `core${deepCore}` : 'cpu'} group="cpu" prio={2} />
      <Tag pos={[0, 0.8, 2.25]} name="Cache" sub="graphics, caches, memory controller: package minus cores" group="cpu" cid="cache" show={deepCore < 0} prio={0.5} />
    </group>
  )
}

function Ram() {
  const sticks = useHW((s) => Math.max(1, s.info?.ram?.sticks?.length || 2))
  const mats = useRef<THREE.MeshPhysicalMaterial[]>([])
  useFrame(() => {
    const f = activity().ram
    mats.current.forEach((m) => { if (m) m.emissiveIntensity = 0.05 + f * 0.9 })
  })
  return (
    <Hot pos={RAMP} id="ram">
      {Array.from({ length: sticks }, (_, i) => (
        <RoundedBox key={i} args={[0.16, 1.4, 4.2]} radius={0.03} smoothness={2} position={[i * 0.6 - (sticks - 1) * 0.3, 0.7, 0]}>
          <meshPhysicalMaterial ref={(m) => { if (m) mats.current[i] = m }} color="#16204a" emissive={BLUE} emissiveIntensity={0.05} metalness={0.5} roughness={0.35} />
        </RoundedBox>
      ))}
      <Tag pos={[0, 1.9, 0]} name="RAM" sub="power not metered" live="ram" group="ram" />
    </Hot>
  )
}

function Small({ pos, id, name, sub, act, size, live }: { pos: THREE.Vector3; id: string; name: string; sub?: string; act: () => number; size: [number, number, number]; live?: LiveKey }) {
  const m = useRef<THREE.MeshPhysicalMaterial>(null!)
  useFrame(() => { m.current.emissiveIntensity = 0.04 + act() * 0.9 })
  return (
    <Hot pos={pos} id={id}>
      <RoundedBox args={size} radius={0.05} smoothness={2} position={[0, size[1] / 2, 0]}>
        <meshPhysicalMaterial ref={m} color="#14203f" emissive={BLUE} emissiveIntensity={0.05} metalness={0.5} roughness={0.35} />
      </RoundedBox>
      <Tag pos={[0, 0.9, 0]} name={name} sub={sub} live={live} group={id} />
    </Hot>
  )
}

function Rails() {
  const lvl = (fn: (s: PowerSample) => number) => () => { const s = currentSample().s; return s ? fn(s) : 0 }
  const coreSum = (s: PowerSample) => s.core_w.reduce((a, b) => a + (b ?? 0), 0)
  return (
    <group>
      {/* power: copper rails, amber */}
      <Rail c={RAILS.input} level={lvl((s) => s.pkg_w / 65)} width={0.07} count={34} speed={0.9} />
      {RAILS.phases.map((c, k) => <Rail key={k} c={c} level={lvl((s) => coreSum(s) / 50)} width={0.04} count={14} speed={1.3 + (k % 3) * 0.1} />)}
      <Rail c={RAILS.ram} level={() => activity().ram} width={0.03} count={16} />
      <Rail c={RAILS.ssd} level={() => activity().ssd} width={0.026} count={10} />
      <Rail c={RAILS.nic} level={() => activity().nic} width={0.026} count={10} />
      {/* data: thin blue rails */}
      <Rail c={DATA.usb} level={() => activity().usb} color={BLUE} width={0.035} count={14} speed={0.8} />
      <Rail c={DATA.vid} level={() => activity().vid} color={BLUE} width={0.035} count={14} speed={0.8} />
      <Rail c={DATA.ddrA} level={() => activity().ddr} color={BLUE} width={0.035} count={12} speed={1.2} />
      <Rail c={DATA.ddrB} level={() => activity().ddr} color={BLUE} width={0.035} count={12} speed={1.2} />
      <Rail c={DATA.ssd} level={() => activity().ssd} color={BLUE} width={0.03} count={10} speed={0.8} />
      <Rail c={DATA.nic} level={() => activity().nic} color={BLUE} width={0.03} count={16} speed={0.8} />
    </group>
  )
}

/** The keyboard: a key lights while the prompt is typed. */
function Keyboard() {
  const keys = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])
  useEffect(() => {
    let i = 0
    for (let r = 0; r < 4; r++) for (let c = 0; c < 14; c++) { d.position.set(-1.35 + c * 0.208, 0.1, -0.42 + r * 0.26); d.updateMatrix(); keys.current.setMatrixAt(i++, d.matrix) }
    keys.current.instanceMatrix.needsUpdate = true
  }, [d])
  useFrame(() => {
    const a = activity()
    const lit = a.stage === 'input' ? (a.typed * 11) % 56 : -1
    for (let i = 0; i < 56; i++) { col.set('#202a4a'); if (i === lit) col.copy(AMBER).multiplyScalar(3); keys.current.setColorAt(i, col) }
    keys.current.instanceColor!.needsUpdate = true
  })
  return (
    <Hot pos={KEYP} id="keyboard">
      <Slab size={[3.2, 0.14, 1.5]} color="#182041" />
      <instancedMesh ref={keys} args={[undefined as any, undefined as any, 56]}><boxGeometry args={[0.17, 0.07, 0.19]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      <Tag pos={[0, 0.9, 0.2]} name="Keyboard" sub="you type" group="keyboard" />
    </Hot>
  )
}

/** The screen: it brightens while the answer travels to it. */
function Screen() {
  const mat = useRef<THREE.MeshBasicMaterial>(null!)
  useFrame(() => { const f = activity().vid; mat.current.color.copy(INK).lerp(BLUE, 0.25 + 0.5 * f).multiplyScalar(0.6 + 1.4 * f) })
  return (
    <Hot pos={SCRP} id="display">
      <Slab size={[3.4, 2.0, 0.12]} pos={[0, 1.05, 0]} color="#10172e" radius={0.08} />
      <mesh position={[0, 1.05, 0.07]}><planeGeometry args={[3.15, 1.78]} /><meshBasicMaterial ref={mat} toneMapped={false} /></mesh>
      <Slab size={[0.3, 0.7, 0.2]} pos={[0, 0.35, -0.05]} color="#10172e" />
      <Tag pos={[0, 2.5, 0]} name="Screen" sub="the answer" group="display" />
    </Hot>
  )
}

/** One core opened: a real dot product, 16 numbers at a time, with the real numbers from this model. */
const LANES = V(CPU.x, 0.12, 2.75)
function LanesHost() { return <Lanes active={useHW((s) => s.path[0] === 'cpu' && !!s.path[1]?.startsWith('core'))} /> }
function Lanes({ active }: { active: boolean }) {
  const micro = useHW((s) => s.micro)
  const rows = useRef<THREE.InstancedMesh[]>([])
  const d = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])
  const sum = useRef<THREE.Mesh>(null!)
  useFrame(({ clock }) => {
    if (!micro || !active || rows.current.length < 3) return
    const T = reduceMotion ? 0.85 : (clock.elapsedTime % 9) / 9
    const ease = (a: number, b: number) => Math.min(1, Math.max(0, (T - a) / (b - a)))
    const data = [micro.x, micro.w, micro.products]
    const phase = [ease(0.0, 0.2), ease(0.1, 0.3), ease(0.35, 0.6)]
    data.forEach((arr: number[], r: number) => {
      const mx = Math.max(...arr.map(Math.abs), 1e-6)
      arr.forEach((v, i) => {
        const h = Math.max(0.02, (Math.abs(v) / mx) * 0.9) * phase[r]
        d.position.set((i - 7.5) * 0.19, h / 2, r * 0.75); d.scale.set(1, Math.max(0.001, h), 1); d.updateMatrix()
        rows.current[r].setMatrixAt(i, d.matrix)
        col.copy(v >= 0 ? AMBER : BLUE).multiplyScalar(2.2); rows.current[r].setColorAt(i, col)
      })
      rows.current[r].instanceMatrix.needsUpdate = true; rows.current[r].instanceColor!.needsUpdate = true
    })
    const total = micro.chunk_sums[0]
    sum.current.scale.x = Math.max(0.01, Math.abs(total) * 14 * ease(0.65, 0.95)); sum.current.position.x = (total >= 0 ? 1 : -1) * sum.current.scale.x * 0.5
  })
  const on = active && !!micro
  return (
    <group position={LANES.toArray()} scale={0.62} visible={on}>
      {[0, 1, 2].map((r) => (
        <instancedMesh key={r} ref={(m) => { if (m) rows.current[r] = m }} args={[undefined as any, undefined as any, 16]} frustumCulled={false}>
          <boxGeometry args={[0.14, 1, 0.3]} /><meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      ))}
      <mesh ref={sum} position={[0, 0.05, 2.35]}><boxGeometry args={[1, 0.12, 0.3]} /><meshBasicMaterial color={AMBER.clone().multiplyScalar(2.4)} toneMapped={false} /></mesh>
      <Tag pos={[-2.4, 0.45, 0]} name="x" sub="16 inputs" show={on} group="cpu" />
      <Tag pos={[-2.4, 0.45, 0.75]} name="w" sub="16 weights" show={on} group="cpu" />
      <Tag pos={[-2.4, 0.45, 1.5]} name="x × w" sub="16 at once" show={on} group="cpu" />
      <Tag pos={[-2.4, 0.3, 2.35]} name="Σ" sub={`round 1 of ${micro?.fma_instructions ?? ''}`} show={on} group="cpu" />
    </group>
  )
}

// ---- camera -------------------------------------------------------------------------------------------------
type Cam = [number[], number[]]
const OVERVIEW: Cam = [[0.2, 13.6, 15.8], [0.2, 0, 0.5]]
// the cards cover the lower part of the view, so each dive aims a little in front of its subject to lift it up
const DIVE: Record<string, Cam> = {
  cpu: [[1.2, 7.0, 6.4], [1.2, 0.3, 0.6]], vrm: [[-3.0, 5.6, 5.0], [-2.6, 0.2, -1.4]],
  ram: [[7.4, 8.4, 9.4], [7.4, 0.8, 1.4]], ssd: [[1.2, 6.0, 11.0], [1.2, 0.1, 5.8]], nic: [[-6.4, 6.2, 4.2], [-6.4, 0.1, -2.2]],
  keyboard: [[8.0, 7.5, 11.6], [8.0, 0.1, 6.2]], display: [[8.2, 6.5, 4.6], [8.2, 1.0, -2.6]],
}
const STAGE_CAM: Record<string, Cam> = {
  input: [[6.0, 10, 14], [5.6, 0, 3.0]], send: [[5.6, 10, 14], [5.0, 0, 2.8]], tokenize: [[1.2, 8.5, 9.4], [1.4, 0.2, -0.4]],
  embed: [[3.6, 10.5, 12.6], [3.6, 0, 0.2]], blocks: [[3.6, 11.5, 13.4], [3.6, 0, 0.2]], logits: [[3.6, 10.5, 12.6], [3.6, 0, 0.2]],
  pick: [[1.2, 8.5, 9.4], [1.4, 0.2, -0.4]], output: [[6.6, 9, 7.2], [6.2, 0.4, -2.4]], decode: [[3.6, 11.5, 13.4], [3.6, 0, 0.2]],
}

const MACHINE_BOX = new THREE.Box3(V(-10.3, 0, -6.3), V(10.3, 2.6, 6.7))
const _p = new THREE.Vector3(), _t = new THREE.Vector3()
/** The camera: the whole machine fitted from its bounding box (keeping the user's orbit angle on a resize), the dives and
 *  follow-the-prompt views as before, applied on the next frame. */
function Rig() {
  const ctl = useRef<CameraControls>(null!)
  const stage = useHW((s) => locate(s.tl, s.playhead).seg.id)
  const path = useHW((s) => s.path)
  // before a journey plays there is nothing to follow: show the whole machine
  const follow = useHW((s) => s.follow && !!s.journey && s.pMode === 'journey')
  const size = useThree((s) => s.size)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const scene = useThree((s) => s.scene)
  const last = useRef({ w: 0, h: 0, key: '' })
  useEffect(() => {
    const c = ctl.current, L = last.current; if (!c) return
    const key = `${path.join('/')}|${follow}|${stage}`
    const resize = key === L.key
    if (resize && Math.abs(size.width - L.w) < 1 && Math.abs(size.height - L.h) < 1) return
    L.w = size.width; L.h = size.height; L.key = key
    const id = requestAnimationFrame(() => {
      const aspect = size.width / Math.max(1, size.height)
      const isCore = path[0] === 'cpu' && path[1]?.startsWith('core')
      const overview = !isCore && !path.length && !follow
      const [q0, q] = isCore ? ([[1.2, 6.8, 9.2], [1.2, 0.3, 2.2]] as Cam) : path.length ? (DIVE[path[0]] ?? OVERVIEW) : follow ? (STAGE_CAM[stage] ?? OVERVIEW) : OVERVIEW
      // the card column on the left and the cards at the bottom cover part of the view: aim to the left of and in front of
      // the subject so it sits in the free part (not on a phone, where the cards stack above and below)
      const wide = aspect > 1.2
      const dx = !wide ? 0 : isCore ? 3.4 : path.length ? 2.4 : 2.0
      const dz = path.length ? 0 : 2.0
      let pos: number[], tgt: number[]
      if (overview) {
        const dir = new THREE.Vector3()
        if (resize && c.distance > 1e-3) { c.getPosition(_p); c.getTarget(_t); dir.copy(_p).sub(_t) } else dir.set(OVERVIEW[0][0] - OVERVIEW[1][0], OVERVIEW[0][1] - OVERVIEW[1][1], OVERVIEW[0][2] - OVERVIEW[1][2])
        if (dir.lengthSq() < 1e-6) dir.set(0, 0.65, 0.76)
        const b = MACHINE_BOX.clone(); b.min.x -= 2 * dx; b.max.z += 2 * dz // widening the box shifts the view target left/forward, clear of the cards
        const f = fitBox(b, dir, camera.fov, size.width, size.height, 56)
        pos = f.pos.toArray(); tgt = f.target.toArray()
      } else {
        const p0 = [q0[0] - dx, q0[1], q0[2] + dz], t = [q[0] - dx, q[1], q[2] + dz]
        pos = aspectFit(p0, t, aspect); tgt = t
      }
      const animate = !reduceMotion && !resize
      if (animate) markTween(1200)
      c.setLookAt(pos[0], pos[1], pos[2], tgt[0], tgt[1], tgt[2], animate)
    })
    return () => cancelAnimationFrame(id)
  }, [path, follow, stage, size.width, size.height, camera])
  useFrame(() => {
    const f = scene.fog as THREE.Fog | null; if (!f || !ctl.current) return
    ctl.current.getTarget(_t); const d = camera.position.distanceTo(_t)
    f.near = d * 0.97 + 8; f.far = d * 2.0 + 24
  })
  return <CameraControls ref={ctl} makeDefault smoothTime={0.8} minDistance={1.5} maxDistance={102} maxPolarAngle={Math.PI * 0.49}
    onStart={() => { const h = useHW.getState(); if (h.follow && !h.path.length) h.setFollow(false) }} />
}

export function PowerScene({ active = true }: { active?: boolean }) {
  // Live while tests run too. Drawing has a small cost of its own; it is the same in every stage, so it sits
  // inside the idle baseline the other stages are compared with.
  const recording = useHW((s) => s.benchRunning)
  // paused for the one-second idle baseline only, so the cost of drawing can be measured against it
  const baseline = useHW((s) => s.benchRunning && s.benchStage === 'idle' && s.source === 'companion')
  const st = useStage(active)
  const light = useTheme() === 'light'
  PT.light = light
  const summary = useHWThrottled((s) => `Machine view: the parts of this computer with their live readings. CPU ${liveText('cpu', s.latest) || 'not measured'}. Memory ${liveText('ram', s.latest) || 'not measured'}. Storage ${liveText('ssd', s.latest) || 'not measured'}. Network ${liveText('nic', s.latest) || 'not measured'}.${s.path.length ? ` Selected: ${s.path.join(' ')}.` : ''}`, 1000)
  useStageKeys(st.wrap, () => { const h = useHW.getState(); if (!h.path.length) return false; h.back(); return true })
  return (
    <div ref={st.wrap} data-stage style={{ position: 'absolute', inset: 0, visibility: st.run ? undefined : 'hidden' }}>
      <Canvas frameloop={!st.run || baseline ? 'never' : recording ? 'demand' : 'always'} dpr={recording ? 1 : st.dpr} resize={{ debounce: { scroll: 0, resize: 100 }, scroll: false }} camera={{ position: [0.2, 13.6, 15.8], fov: 38 }} gl={{ antialias: false, powerPreference: 'high-performance' }}
        onPointerMissed={(e) => { if (e.type === 'click') { const h = useHW.getState(); let n = h.path.length; while (n-- > 0) useHW.getState().back() } }}>
        <LiteCtx.Provider value={st.lite}>
          <KitProvider>
            {st.run && recording && !baseline && <FpsCap fps={30} />}
            <SlowWatch onStep={st.step} />
            <FirstFrame name="machine" />
            <color attach="background" args={[light ? '#eef0fb' : '#05080f']} />
            <WheelScrollsPage />
            <fog attach="fog" args={[light ? '#eef0fb' : '#05080f', 26, 54]} />
            <ambientLight intensity={0.3} />
            <directionalLight position={[6, 12, 8]} intensity={1.3} />
            <Environment resolution={64} environmentIntensity={0.6}>
              <Lightformer form="rect" intensity={2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[16, 10, 1]} color="#9fb4ff" />
              <Lightformer form="rect" intensity={1.5} position={[-8, 3, 6]} rotation-y={Math.PI / 3} scale={[10, 4, 1]} color="#ffb867" />
            </Environment>
            <Pcb />
            <Chip pos={[-8.6, 0.2, 6.2]} name="▲ power  ○ data" sub="amber rails carry power, blue rails carry data" prio={0.3} />
            <DcIn /><Vrm /><CpuChip /><Ram /><Keyboard /><Screen />
            <Small pos={SSDP} id="ssd" name="SSD" sub="power not metered" live="ssd" act={() => activity().ssd} size={[3.2, 0.12, 0.85]} />
            <Small pos={NICP} id="nic" name="Network" sub="power not metered" live="nic" act={() => activity().nic} size={[1.2, 0.12, 1.2]} />
            <LanesHost />
            <Rails />
            <Rig />
            {st.bloom && !light && (
              <EffectComposer multisampling={recording || st.dpr <= 1 ? 0 : 4}>
                <Bloom mipmapBlur luminanceThreshold={0.8} luminanceSmoothing={0.2} intensity={1.15} radius={0.8} />
                <Vignette eskil={false} offset={0.25} darkness={0.8} />
              </EffectComposer>
            )}
          </KitProvider>
        </LiteCtx.Provider>
      </Canvas>
      <div className="nssr" role="img" aria-label={summary} />
    </div>
  )
}
