// The electricity view: where the watts go while the machine works.
// Package and per-core power come from the CPU's own energy counters (RAPL, read by the companion) or, in a
// browser without the companion, from a labelled estimate. Everything that moves is driven by those numbers:
// particle speed and density on the copper follow package watts, each core's colour, height and sparks follow
// that core's watts, and the regulator phases fire in turn at a rate that follows the load.
import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { aspectFit, FitFog, WheelScrollsPage } from '../aspect'
import { FpsCap } from '../fps'
import { CameraControls, Environment, Html, Lightformer, RoundedBox } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { powerNow, useHW, type PowerMode, type PowerSample } from './hwStore'
import { LiveLine, type LiveKey } from './MachineScene'

const AMBER = new THREE.Color('#ffa94d')
const BLUE = new THREE.Color('#55a8ff')
const WHITE = new THREE.Color('#fff4e0')
const INK = new THREE.Color('#1a2342')
const COPPER = new THREE.Color('#c77b3a')
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The sample to draw now: the test being recorded, the live sensors, or a replay. Computed once per store change. */
let memoState: unknown = null
let memo: { s: PowerSample | null; mode: PowerMode } = { s: null, mode: 'none' }
export function currentSample(): { s: PowerSample | null; mode: PowerMode } {
  const h = useHW.getState()
  if (h !== memoState) { memoState = h; memo = powerNow(h) }
  return memo
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0)
/** How busy RAM, SSD and network are (0..1). Their supplies are not metered, so they glow with activity:
 *  from the OS disk and network counters when live, from the test that is running otherwise. */
function activity(): { ram: number; ssd: number; nic: number } {
  const { s, mode } = currentSample()
  if (mode === 'live') {
    const t = useHW.getState().latest
    return { ram: 0.08, ssd: 0.05 + 0.95 * clamp01(Math.sqrt(((t?.disk_read_bps ?? 0) + (t?.disk_write_bps ?? 0)) / 1e9)), nic: 0.05 + 0.95 * clamp01(Math.sqrt((t?.net_recv_bps ?? 0) / 1.25e7)) }
  }
  const st = s?.stage
  return { ram: st === 'dram' ? 1 : st === 'ai' ? 0.8 : st === 'cache' ? 0.3 : 0.08, ssd: st === 'disk' || st === 'ai_load' ? 1 : 0.05, nic: st === 'net' ? 1 : 0.05 }
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
  ram: curve([V(-6.2, Y, 4.4), V(4.0, Y, 4.4), V(5.6, Y, 2.6), V(6.6, Y, 1.6)]),
  ssd: curve([V(-6.2, Y, 4.0), V(-1.0, Y, 4.0), V(0.0, Y, 5.0)]),
  nic: curve([V(-6.8, Y, 3.0), V(-6.8, Y, 0.0), V(-6.4, Y, -3.0)]),
}

// ---- pieces -----------------------------------------------------------------------------------------
function Slab({ size, pos = [0, 0, 0], color = '#131b33', radius = 0.05, metal = 0.55, rough = 0.32, matRef }: any) {
  return (
    <RoundedBox args={size} radius={radius} smoothness={3} position={pos}>
      <meshPhysicalMaterial ref={matRef} color={color} metalness={metal} roughness={rough} clearcoat={0.7} clearcoatRoughness={0.25} />
    </RoundedBox>
  )
}

function Tag({ pos, name, sub, show = true, live }: { pos: [number, number, number]; name: string; sub?: string; show?: boolean; live?: LiveKey }) {
  return (
    <Html position={pos} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div className="mlabel" style={{ display: show ? undefined : 'none' }}><b>{name}</b>{sub && <span>{sub}</span>}{live && <LiveLine k={live} />}</div>
    </Html>
  )
}

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
        <meshPhysicalMaterial color="#08101f" metalness={0.4} roughness={0.65} clearcoat={0.4} />
      </RoundedBox>
      <lineSegments geometry={geo}><lineBasicMaterial color="#17223f" transparent opacity={0.5} /></lineSegments>
    </group>
  )
}

/** A copper rail with current flowing along it. `level` returns 0..1 for how much power it carries now. */
function Rail({ c, level, color = AMBER, count = 26, width = 0.045, speed = 1 }: { c: THREE.CatmullRomCurve3; level: () => number; color?: THREE.Color; count?: number; width?: number; speed?: number }) {
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
      <Tag pos={[0, 1.4, 0]} name="Power in" sub="DC from the wall adapter" />
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
    <group>
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
      <Tag pos={[-3.4, 1.1, -3.6]} name="Voltage regulator" sub="phases take turns · ~1 V out for the cores" />
    </group>
  )
}

/** The CPU: package, a power grid ring, and one tile per core whose colour, height and sparks follow its watts. */
function Chip() {
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
  const d = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])
  const HEAT = 14
  const arcGeo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(nCores * 2 * 6 * 2 * 3), 3)); return g }, [nCores])
  const lastArc = useRef(0)
  useFrame(({ clock }) => {
    const s = currentSample().s
    const time = clock.elapsedTime
    const cw = s?.core_w ?? []
    const coreSum = cw.reduce((a, b) => a + (b ?? 0), 0)
    ring.current.color.copy(AMBER).multiplyScalar(0.3 + 2.4 * Math.min(1, (s?.pkg_w ?? 0) / 65))
    soc.current.emissiveIntensity = 0.05 + 1.2 * Math.min(1, Math.max(0, ((s?.pkg_w ?? 0) - coreSum) / 25))
    for (const c of cores) {
      const w = cw[c.k] ?? 0
      const h = 0.1 + Math.min(1.4, w * 0.15)
      d.position.set(c.x, 0.3 + h / 2, c.z); d.scale.set(1, h, 1); d.updateMatrix(); tiles.current.setMatrixAt(c.k, d.matrix)
      heat(w, col); tiles.current.setColorAt(c.k, col.clone().multiplyScalar(1 + Math.min(2.2, w / 3)))
      for (let i = 0; i < HEAT; i++) {
        const life = ((time * (0.25 + w * 0.06) + i / HEAT + c.k * 0.37) % 1)
        const on = i < Math.round(HEAT * Math.min(1, w / 8))
        d.position.set(c.x + Math.sin(i * 7.1 + c.k) * sp * 0.28, 0.4 + h + life * 2.2, c.z + Math.cos(i * 3.7 + c.k) * sp * 0.28)
        d.scale.setScalar(on && !reduceMotion ? 0.05 * (1 - life) + 0.01 : 0.0001); d.updateMatrix(); heatM.current.setMatrixAt(c.k * HEAT + i, d.matrix)
      }
      const el = labels.current[c.k]
      if (el) el.textContent = `${w.toFixed(1)} W`
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
    <group position={CPU.toArray()}>
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
      {cores.map((c) => (
        <Html key={c.k} position={[c.x, 0.2, c.z + sp * 0.5]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <div className="wlabel mono" ref={(el) => { labels.current[c.k] = el }}>—</div>
        </Html>
      ))}
      <Tag pos={[0, 1.9, -2.7]} name="CPU" sub={`${nCores} cores${logical ? ' (assumed: 2 threads each)' : ''} · watts per core`} />
      <Tag pos={[0, 0.8, 2.25]} name="Graphics, caches, memory controller" sub="package minus cores: the built-in GPU is here" />
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
    <group position={RAMP.toArray()}>
      {Array.from({ length: sticks }, (_, i) => (
        <RoundedBox key={i} args={[0.16, 1.4, 4.2]} radius={0.03} smoothness={2} position={[i * 0.6 - (sticks - 1) * 0.3, 0.7, 0]}>
          <meshPhysicalMaterial ref={(m) => { if (m) mats.current[i] = m }} color="#16204a" emissive={AMBER} emissiveIntensity={0.05} metalness={0.5} roughness={0.35} />
        </RoundedBox>
      ))}
      <Tag pos={[0, 1.9, 0]} name="RAM" sub="own supply · power not metered" live="ram" />
    </group>
  )
}

function Small({ pos, name, sub, act, size, live }: { pos: THREE.Vector3; name: string; sub: string; act: () => number; size: [number, number, number]; live?: LiveKey }) {
  const m = useRef<THREE.MeshPhysicalMaterial>(null!)
  useFrame(() => { m.current.emissiveIntensity = 0.04 + act() * 0.9 })
  return (
    <group position={pos.toArray()}>
      <RoundedBox args={size} radius={0.05} smoothness={2} position={[0, size[1] / 2, 0]}>
        <meshPhysicalMaterial ref={m} color="#14203f" emissive={BLUE} emissiveIntensity={0.05} metalness={0.5} roughness={0.35} />
      </RoundedBox>
      <Tag pos={[0, 0.9, 0]} name={name} sub={sub} live={live} />
    </group>
  )
}

function Rails() {
  const lvl = (fn: (s: PowerSample) => number) => () => { const s = currentSample().s; return s ? fn(s) : 0 }
  const coreSum = (s: PowerSample) => s.core_w.reduce((a, b) => a + (b ?? 0), 0)
  return (
    <group>
      <Rail c={RAILS.input} level={lvl((s) => s.pkg_w / 65)} width={0.07} count={34} speed={0.9} />
      {RAILS.phases.map((c, k) => <Rail key={k} c={c} level={lvl((s) => coreSum(s) / 50)} width={0.04} count={14} speed={1.3 + (k % 3) * 0.1} />)}
      <Rail c={RAILS.ram} level={() => activity().ram} color={BLUE} width={0.035} count={18} />
      <Rail c={RAILS.ssd} level={() => activity().ssd} color={BLUE} width={0.03} count={12} />
      <Rail c={RAILS.nic} level={() => activity().nic} color={BLUE} width={0.03} count={12} />
    </group>
  )
}

function Rig() {
  const ctl = useRef<CameraControls>(null!)
  const focus = useHW((s) => s.path[0])
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height))
  useEffect(() => {
    const c = ctl.current; if (!c) return
    const [p0, t] = focus === 'cpu' ? [[1.2, 6.2, 5.8], [1.2, 0.3, -0.3]] : focus === 'vrm' ? [[-3.0, 5.2, 4.2], [-2.6, 0.2, -2.0]] : [[0.2, 13.6, 15.8], [0.2, 0, 0.5]]
    const p = aspectFit(p0, t, aspect)
    c.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], !reduceMotion)
  }, [focus, aspect])
  return <CameraControls ref={ctl} makeDefault smoothTime={0.8} minDistance={2} maxDistance={102} maxPolarAngle={Math.PI * 0.49} />
}

export function PowerScene({ active = true }: { active?: boolean }) {
  // Live while tests run too. Drawing has a small cost of its own; it is the same in every stage, so it sits
  // inside the idle baseline the other stages are compared with.
  const recording = useHW((s) => s.benchRunning)
  // paused for the one-second idle baseline only, so the cost of drawing can be measured against it
  const baseline = useHW((s) => s.benchRunning && s.benchStage === 'idle' && s.source === 'companion')
  return (
    <Canvas frameloop={!active || baseline ? 'never' : recording ? 'demand' : 'always'} dpr={recording ? 1 : [1, 1.75]} camera={{ position: [0.2, 13.6, 15.8], fov: 38 }} gl={{ antialias: false, powerPreference: 'high-performance' }}
      onDoubleClick={() => { const p = useHW.getState().path; useHW.getState().dive(p[0] === 'cpu' ? [] : ['cpu']) }}>
      {active && recording && !baseline && <FpsCap fps={30} />}
      <color attach="background" args={['#05080f']} />
      <WheelScrollsPage />
      <FitFog color="#05080f" near={26} far={54} />
      <ambientLight intensity={0.3} />
      <directionalLight position={[6, 12, 8]} intensity={1.3} />
      <Environment resolution={64} environmentIntensity={0.6}>
        <Lightformer form="rect" intensity={2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[16, 10, 1]} color="#9fb4ff" />
        <Lightformer form="rect" intensity={1.5} position={[-8, 3, 6]} rotation-y={Math.PI / 3} scale={[10, 4, 1]} color="#ffb867" />
      </Environment>
      <Pcb />
      <DcIn /><Vrm /><Chip /><Ram />
      <Small pos={SSDP} name="SSD" sub="3.3 V rail · power not metered" live="ssd" act={() => activity().ssd} size={[3.2, 0.12, 0.85]} />
      <Small pos={NICP} name="Network" sub="power not metered" live="nic" act={() => activity().nic} size={[1.2, 0.12, 1.2]} />
      <Rails />
      <Rig />
      <EffectComposer multisampling={recording ? 0 : 4}>
        <Bloom mipmapBlur luminanceThreshold={0.8} luminanceSmoothing={0.2} intensity={1.15} radius={0.8} />
        <Vignette eskil={false} offset={0.25} darkness={0.8} />
      </EffectComposer>
    </Canvas>
  )
}
