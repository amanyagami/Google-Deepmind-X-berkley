import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { aspectFit, FitFog, WheelScrollsPage } from '../aspect'
import { FpsCap } from '../fps'
import { CameraControls, Environment, Html, Lightformer, RoundedBox } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useHW } from './hwStore'
import { activityAt, benchActivity, locate, type Activity } from './timeline'
import { useScores } from './score'

const AMBER = new THREE.Color('#ffa94d')
const BLUE = new THREE.Color('#55a8ff')
const INK = new THREE.Color('#1a2342')
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const idle = (n: number): Activity => ({ stage: 'input', p: 0, flow: {}, cores: new Array(n).fill(0), l3: 0, ram: 0, gpu: 0, typed: 0, shown: 0, hud: '' })
const Act = createContext<{ current: Activity }>({ current: idle(8) })
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/* --- live readout under a label: the newest OS sample, 10 times a second (PowerScene uses it too) --- */
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

// --- layout (world units; the board is 19 x 11.5) -------------------------------------------
const POS = {
  key: V(-6.4, 0.1, 3.7), disp: V(6.2, 0.1, 3.9), cpu: V(0, 0.15, -0.6), ram: V(4.9, 0.1, -0.6), ssd: V(-4.8, 0.1, -3.2), nic: V(-6.6, 0.1, -0.5), hub: V(-9.6, 2.6, -5.2),
}
const Y = 0.2
const CURVES: Record<string, THREE.CatmullRomCurve3> = {
  usb: new THREE.CatmullRomCurve3([V(-6.4, Y, 3.1), V(-6.4, Y, 1.9), V(-1.4, Y, 1.9), V(-1.4, Y, 1.3)], false, 'catmullrom', 0.05),
  vid: new THREE.CatmullRomCurve3([V(1.4, Y, 1.3), V(1.4, Y, 2.2), V(6.2, Y, 2.2), V(6.2, Y, 3.3)], false, 'catmullrom', 0.05),
  ddrA: new THREE.CatmullRomCurve3([V(4.3, Y, -0.1), V(2.1, Y, -0.1)]),
  ddrB: new THREE.CatmullRomCurve3([V(4.3, Y, -1.1), V(2.1, Y, -1.1)]),
  ssd: new THREE.CatmullRomCurve3([V(-3.9, Y, -3.2), V(-1.4, Y, -3.2), V(-1.4, Y, -2.5)], false, 'catmullrom', 0.05),
  nic: new THREE.CatmullRomCurve3([V(-6.0, Y, -0.5), V(-2.1, Y, -0.5)]),
  wan: new THREE.CatmullRomCurve3([V(-9.6, 2.6, -5.2), V(-8.4, 1.4, -2.6), V(-6.7, 0.5, -0.9)]),
}

// --- small building blocks -------------------------------------------------------------------
function Slab({ size, pos = [0, 0, 0], color = '#131b33', radius = 0.05, metal = 0.55, rough = 0.32, emissive, ei = 0, matRef }: any) {
  return (
    <RoundedBox args={size} radius={radius} smoothness={3} position={pos}>
      <meshPhysicalMaterial ref={matRef} color={color} metalness={metal} roughness={rough} clearcoat={0.7} clearcoatRoughness={0.25} emissive={emissive ?? '#000'} emissiveIntensity={ei} />
    </RoundedBox>
  )
}

/** Fixed-size screen label. While diving into one part, labels of the other parts are hidden. */
function Label({ pos, name, sub, score, show = true, group, live }: { pos: [number, number, number]; name: string; sub?: string; score?: number | null; show?: boolean; group?: string; live?: LiveKey }) {
  const path = useHW((s) => s.path)
  const vis = show && !(path.length > 0 && group && path[0] !== group)
  // Always mounted, only hidden: unmounting drei <Html> while the camera moves can throw in React 19.
  return (
    <Html position={pos} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div className="mlabel" style={{ display: vis ? undefined : 'none' }}><b>{name}{score ? <em>{score}</em> : null}</b>{sub && <span>{sub}</span>}{live && <LiveLine k={live} />}</div>
    </Html>
  )
}

function Interactive({ id, children, pos, dive }: { id: string; children: any; pos: THREE.Vector3; dive?: string[] }) {
  const set = useHW((s) => s.setHover)
  return (
    <group position={pos}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; set(id) }}
      onPointerOut={() => { document.body.style.cursor = ''; set(null) }}
      onDoubleClick={(e) => { e.stopPropagation(); useHW.getState().dive(dive ?? [id]) }}>
      {children}
    </group>
  )
}

function Trace({ curve, flowKey, color }: { curve: THREE.CatmullRomCurve3; flowKey: string; color: THREE.Color }) {
  const act = useContext(Act)
  const mat = useRef<THREE.MeshBasicMaterial>(null!)
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 48, 0.028, 6, false), [curve])
  useFrame(() => { const r = act.current.flow[flowKey] ?? 0; const f = Number.isFinite(r) ? r : 0; mat.current.opacity = 0.22 + 0.7 * f; mat.current.color.copy(color).multiplyScalar(0.5 + 1.6 * f) })
  return <mesh geometry={geo}><meshBasicMaterial ref={mat} transparent toneMapped={false} /></mesh>
}

/** Glowing packets along a trace. Position depends only on the playhead, so it scrubs and rewinds. */
function Packets({ curve, flowKey, color, count = 16, speed = 0.55, reverse = false }: any) {
  const act = useContext(Act)
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const p = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const raw = act.current.flow[flowKey] ?? 0
    const f = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    const t = useHW.getState().playhead || 0
    const on = Math.ceil(f * count)
    for (let i = 0; i < count; i++) {
      let u = (((t * speed * (0.5 + f) + i / count) % 1) + 1) % 1
      if (!Number.isFinite(u)) u = 0
      if (reverse) u = Math.min(1, 1 - u)
      curve.getPointAt(u, p)
      d.position.copy(p)
      d.scale.setScalar(i < on ? 0.06 + 0.04 * f : 0.0001)
      d.updateMatrix()
      mesh.current.setMatrixAt(i, d.matrix)
    }
    mesh.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={mesh} args={[undefined as any, undefined as any, count]} frustumCulled={false}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial color={color.clone().multiplyScalar(2.6)} toneMapped={false} />
    </instancedMesh>
  )
}

// --- the machine ------------------------------------------------------------------------------
function Board() {
  const geo = useMemo(() => {
    const pts: number[] = []
    for (let x = -9.5; x <= 8.5; x += 0.5) pts.push(x, 0.012, -5.5, x, 0.012, 5.5)
    for (let z = -5.5; z <= 5.5; z += 0.5) pts.push(-9.5, 0.012, z, 8.5, 0.012, z)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return g
  }, [])
  return (
    <group>
      <RoundedBox args={[19, 0.3, 11.5]} radius={0.18} smoothness={4} position={[-0.5, -0.15, 0]}>
        <meshPhysicalMaterial color="#0b1224" metalness={0.45} roughness={0.6} clearcoat={0.3} />
      </RoundedBox>
      <lineSegments geometry={geo}><lineBasicMaterial color="#1a2646" transparent opacity={0.55} /></lineSegments>
    </group>
  )
}

function Keyboard() {
  const act = useContext(Act)
  const typed = useHW((s) => (s.journey ? s.journey.input.text : ''))
  const keys = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])
  useEffect(() => {
    let i = 0
    for (let r = 0; r < 4; r++) for (let c = 0; c < 14; c++) { d.position.set(-1.35 + c * 0.208, 0.1, -0.42 + r * 0.26); d.scale.set(1, 1, 1); d.updateMatrix(); keys.current.setMatrixAt(i++, d.matrix) }
    keys.current.instanceMatrix.needsUpdate = true
  }, [d])
  useFrame(() => {
    const a = act.current
    const lit = a.stage === 'input' ? (a.typed * 11) % 56 : -1
    for (let i = 0; i < 56; i++) { col.set('#202a4a'); if (i === lit) col.copy(AMBER).multiplyScalar(3); keys.current.setColorAt(i, col) }
    keys.current.instanceColor!.needsUpdate = true
  })
  return (
    <Interactive id="keyboard" pos={POS.key}>
      <Slab size={[3.2, 0.14, 1.5]} color="#182041" />
      <instancedMesh ref={keys} args={[undefined as any, undefined as any, 56]}>
        <boxGeometry args={[0.17, 0.07, 0.19]} /><meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <Label group="keyboard" pos={[0, 0.9, 0.9]} name="Keyboard" sub="you type here" />
      <TypedBubble text={typed} />
    </Interactive>
  )
}

function TypedBubble({ text }: { text: string }) {
  const stage = useHW((s) => locate(s.tl, s.playhead).seg.id)
  const typed = useHW((s) => (s.journey ? activityAt(s.journey, s.tl, s.playhead, s.peaks()).typed : 0))
  const vis = !!text && ['input', 'send'].includes(stage)
  return (
    <Html position={[0.6, 1.9, -0.4]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
      <div className="bubble mono" style={{ display: vis ? undefined : 'none' }}>{text.slice(0, typed)}<i className="caret" /></div>
    </Html>
  )
}

function Display() {
  const j = useHW((s) => s.journey)
  const stage = useHW((s) => locate(s.tl, s.playhead).seg.id)
  const shown = useHW((s) => (s.journey ? activityAt(s.journey, s.tl, s.playhead, s.peaks()).shown : 0))
  const act = useContext(Act)
  const mat = useRef<THREE.MeshBasicMaterial>(null!)
  useFrame(() => { const f = (act.current.flow.vid ?? 0); mat.current.color.copy(INK).lerp(BLUE, 0.25 + 0.5 * f).multiplyScalar(0.6 + 1.4 * f) })
  const text = j ? j.input.text + j.decode.tokens.slice(0, Math.max(0, shown)).map((t: any) => t.text).join('') : ''
  const showOut = !!j && shown > 0 && ['output', 'decode'].includes(stage)
  return (
    <Interactive id="display" pos={POS.disp}>
      <Slab size={[3.4, 2.0, 0.12]} pos={[0, 1.05, 0]} color="#10172e" radius={0.08} />
      <mesh position={[0, 1.05, 0.07]}><planeGeometry args={[3.15, 1.78]} /><meshBasicMaterial ref={mat} toneMapped={false} /></mesh>
      <Slab size={[0.3, 0.7, 0.2]} pos={[0, 0.35, -0.05]} color="#10172e" />
      <Label group="display" pos={[0, 2.5, 0]} name="Screen" sub="shows the answer" />
      <Html position={[0, 1.05, 0.1]} center transform distanceFactor={4.2} zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
        <div className="screen mono" style={{ display: showOut ? undefined : 'none' }}>{text}<i className="caret" /></div>
      </Html>
    </Interactive>
  )
}

function Core({ k, x, z, size, live }: { k: number; x: number; z: number; size: number; live: number }) {
  const act = useContext(Act)
  const mat = useRef<THREE.MeshPhysicalMaterial>(null!)
  const bar = useRef<THREE.Mesh>(null!)
  const bar2 = useRef<THREE.Mesh>(null!)
  const hov = useHW((s) => s.hover === `core${k}`)
  const tmp = useMemo(() => new THREE.Color(), [])
  useFrame(() => {
    const v = act.current.cores[k] ?? 0
    tmp.copy(INK).lerp(AMBER, Math.min(1, v * 1.1)); mat.current.color.copy(tmp)
    mat.current.emissive.copy(AMBER); mat.current.emissiveIntensity = v * 1.6 + (hov ? 0.5 : 0)
    // two hardware threads (SMT) per core: one live bar each, from the OS's per-logical-CPU load
    const u = useHW.getState().latest?.cpu
    const l1 = u ? (u[k * 2] ?? 0) / 100 : 0, l2 = u ? (u[k * 2 + 1] ?? 0) / 100 : 0
    bar.current.scale.y = Math.max(0.02, l1); bar.current.position.y = 0.06 + (0.4 * Math.max(0.02, l1)) / 2
    bar2.current.scale.y = Math.max(0.02, l2); bar2.current.position.y = 0.06 + (0.4 * Math.max(0.02, l2)) / 2
  })
  return (
    <group position={[x, 0.2, z]}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; useHW.getState().setHover(`core${k}`) }}
      onPointerOut={() => { document.body.style.cursor = ''; useHW.getState().setHover(null) }}
      onDoubleClick={(e) => { e.stopPropagation(); useHW.getState().dive(['cpu', `core${k}`]) }}>
      <RoundedBox args={[size, 0.1, size]} radius={0.04} smoothness={3}>
        <meshPhysicalMaterial ref={mat} color="#1a2342" metalness={0.5} roughness={0.35} clearcoat={0.8} />
      </RoundedBox>
      <mesh ref={bar} position={[size / 2 - 0.15, 0.1, size / 2 - 0.07]} scale={[1, 0.02, 1]}>
        <boxGeometry args={[0.06, 0.4, 0.06]} /><meshBasicMaterial color={BLUE.clone().multiplyScalar(2)} toneMapped={false} />
      </mesh>
      <mesh ref={bar2} position={[size / 2 - 0.06, 0.1, size / 2 - 0.07]} scale={[1, 0.02, 1]}>
        <boxGeometry args={[0.06, 0.4, 0.06]} /><meshBasicMaterial color={BLUE.clone().multiplyScalar(1.3)} toneMapped={false} />
      </mesh>
    </group>
  )
}

function Cpu() {
  const act = useContext(Act)
  const info = useHW((s) => s.info)
  const path = useHW((s) => s.path)
  const n = info?.cpu?.cores ?? 8
  const cols = Math.ceil(n / 2)
  const sp = Math.min(0.8, 3.1 / cols)
  const l3 = useRef<THREE.MeshPhysicalMaterial>(null!)
  const igpu = useRef<THREE.MeshPhysicalMaterial>(null!)
  const sc = useScores().by
  useFrame(() => { l3.current.emissiveIntensity = 0.2 + act.current.l3 * 2.2; igpu.current.emissiveIntensity = 0.05 + act.current.gpu * 2.4 })
  const cores = Array.from({ length: n }, (_, k) => ({ k, x: (k % cols - (cols - 1) / 2) * sp, z: (Math.floor(k / cols) - 0.5) * sp - 0.35 }))
  const deep = path[0] === 'cpu'
  return (
    <Interactive id="cpu" pos={POS.cpu} dive={['cpu']}>
      <Slab size={[4.1, 0.2, 3.9]} color="#171f3a" radius={0.12} />
      <Slab size={[3.6, 0.1, 3.4]} pos={[0, 0.14, 0]} color="#0e1530" radius={0.08} />
      {cores.map((c) => <Core key={c.k} k={c.k} x={c.x} z={c.z} size={sp * 0.82} live={0} />)}
      <Slab size={[3.3, 0.07, 0.42]} pos={[0, 0.2, 0.55]} color="#13264a" emissive="#55a8ff" ei={0.3} matRef={l3} />
      <Slab size={[1.5, 0.08, 0.8]} pos={[0.95, 0.2, 1.2]} color="#1c2140" emissive="#ffa94d" ei={0.05} matRef={igpu} />
      <Slab size={[1.3, 0.08, 0.8]} pos={[-1.0, 0.2, 1.2]} color="#16203d" />
      <Label group="cpu" pos={[0, 0.9, -2.1]} name="CPU" live="cpu" score={sc.cpu} sub={info ? `${info.cpu.name.replace(/\s*w\/.*$/, '')} · ${n} cores / ${info.cpu.threads} threads` : '8 cores'} show={!deep || path.length === 1} />
      <Label group="cpu" pos={[0.95, 0.5, 1.2]} name="GPU" score={sc.gpu} show={!deep && !!sc.gpu} />
      <Label group="cpu" pos={[0, 0.5, 0.55]} name="Cache" score={sc.cache} show={!deep && !!sc.cache} />
      <Label group="cpu" pos={[0, 0.55, 0.55]} name="L3 cache" score={sc.cache} sub={info ? `${Math.round(info.cpu.caches.L3 / 2 ** 20)} MB shared` : ''} show={deep && path.length === 1} />
      <Label group="cpu" pos={[0.95, 0.5, 1.2]} name="iGPU" score={sc.gpu} sub={`${info?.gpus?.[0]?.name?.replace('AMD ', '') ?? 'graphics'}`} show={deep && path.length === 1} />
      <Label group="cpu" pos={[-1.0, 0.5, 1.2]} name="Memory controller" sub="talks to RAM" show={deep && path.length === 1} />
      {cores.map((c) => <Label key={c.k} group="cpu" pos={[c.x, 0.5, c.z + sp * 0.62]} name={`Core ${c.k}`} live={`core${c.k}`} show={deep && path.length === 1} />)}
      <Label group="cpu" pos={[0, 0.9, -2.1]} name={`Core ${path[1]?.slice(4) ?? ''}`} sub="2 threads · its own L1 and L2 · a 16-wide vector unit" show={deep && path.length > 1} />
    </Interactive>
  )
}

function Ram() {
  const act = useContext(Act)
  const info = useHW((s) => s.info)
  const sticks = Math.max(1, info?.ram?.sticks?.length ?? 2)
  const ramScore = useScores().by.ram
  const chips = useRef<THREE.InstancedMesh>(null!)
  const meter = useRef<THREE.Mesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])
  const count = sticks * 16
  useEffect(() => {
    let i = 0
    for (let s = 0; s < sticks; s++) for (let side of [-1, 1]) for (let c = 0; c < 8; c++) { d.position.set(s * 0.62 + side * 0.09, 0.95, -1.35 + c * 0.38); d.scale.set(1, 1, 1); d.updateMatrix(); chips.current.setMatrixAt(i++, d.matrix) }
    chips.current.instanceMatrix.needsUpdate = true
  }, [d, sticks])
  useFrame(({ clock }) => {
    const r = act.current.ram
    for (let i = 0; i < count; i++) { const w = Math.max(0, Math.sin(clock.elapsedTime * 7 - i * 0.7)); col.set('#1f2a4d').lerp(AMBER, r * (0.35 + 0.65 * w)).multiplyScalar(1 + r * 1.8 * w); chips.current.setColorAt(i, col) }
    chips.current.instanceColor!.needsUpdate = true
    const l = useHW.getState().latest
    const used = l ? l.ram_used / l.ram_total : 0.4
    meter.current.scale.y = Math.max(0.02, used)
  })
  return (
    <Interactive id="ram" pos={POS.ram} dive={['ram']}>
      <Slab size={[1.6, 0.1, 3.9]} color="#10172e" />
      {Array.from({ length: sticks }, (_, s) => (
        <group key={s} position={[s * 0.62, 0, 0]}>
          <Slab size={[0.14, 1.7, 3.6]} pos={[0, 0.95, 0]} color="#16204a" radius={0.03} />
        </group>
      ))}
      <instancedMesh ref={chips} args={[undefined as any, undefined as any, count]}>
        <boxGeometry args={[0.06, 0.34, 0.3]} /><meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh ref={meter} position={[-0.4, 0.95, -1.9]} scale={[1, 0.4, 1]}><boxGeometry args={[0.05, 1.5, 0.05]} /><meshBasicMaterial color={BLUE.clone().multiplyScalar(2)} toneMapped={false} /></mesh>
      <Label group="ram" pos={[0.3, 2.2, 0]} name="RAM" live="ram" score={ramScore} sub={info ? `${Math.round(info.ram.total / 2 ** 30)} GB ${info.ram.type ?? ''}-${info.ram.mts ?? ''} · ${info.ram.channels} channels` : 'memory'} />
    </Interactive>
  )
}

function Ssd() {
  const led = useRef<THREE.MeshBasicMaterial>(null!)
  const info = useHW((s) => s.info)
  const ssdScore = useScores().by.ssd
  useFrame(() => { const r = useHW.getState().latest?.disk_read_bps ?? 0; led.current.color.copy(BLUE).multiplyScalar(0.4 + Math.min(4, r / 3e8)) })
  return (
    <Interactive id="ssd" pos={POS.ssd}>
      <Slab size={[3.4, 0.08, 0.9]} pos={[0, 0.06, 0]} color="#14203f" />
      <Slab size={[0.8, 0.07, 0.6]} pos={[-1.1, 0.14, 0]} color="#0b1020" />
      {[0, 1].map((i) => <Slab key={i} size={[0.9, 0.06, 0.6]} pos={[0.2 + i * 1.0, 0.13, 0]} color="#0e1630" />)}
      <mesh position={[1.55, 0.14, 0]}><boxGeometry args={[0.08, 0.04, 0.08]} /><meshBasicMaterial ref={led} toneMapped={false} /></mesh>
      <Label group="ssd" pos={[0, 0.9, 0]} name="SSD" live="ssd" score={ssdScore} sub={info?.disks?.[0] ? `${info.disks[0].bus} · ${Math.round(info.disks[0].bytes / 1e9)} GB` : 'storage'} />
    </Interactive>
  )
}

function Nic() {
  const info = useHW((s) => s.info)
  const nicScore = useScores().by.nic
  const led = useRef<THREE.MeshBasicMaterial>(null!)
  useFrame(() => { const r = useHW.getState().latest?.net_recv_bps ?? 0; led.current.color.copy(AMBER).multiplyScalar(0.4 + Math.min(4, r / 2e6)) })
  return (
    <Interactive id="nic" pos={POS.nic}>
      <Slab size={[1.0, 0.08, 1.2]} color="#14203f" />
      <Slab size={[0.4, 0.1, 0.4]} pos={[0, 0.1, 0]} color="#0b1020" />
      <mesh position={[0.35, 0.12, 0.45]}><boxGeometry args={[0.07, 0.05, 0.07]} /><meshBasicMaterial ref={led} toneMapped={false} /></mesh>
      <Label group="nic" pos={[0, 0.85, 0]} name="Network" live="nic" score={nicScore} sub={info?.nics?.[0] ? `Wi-Fi · ${info.nics[0].link}` : ''} />
    </Interactive>
  )
}

function Hub() {
  const g = useRef<THREE.Group>(null!)
  useFrame(({ clock }) => { g.current.rotation.y = clock.elapsedTime * 0.25; g.current.position.y = POS.hub.y + Math.sin(clock.elapsedTime * 0.8) * 0.12 })
  return (
    <group position={[POS.hub.x, 0, POS.hub.z]}>
      <group ref={g} position={[0, POS.hub.y, 0]}>
        <mesh><icosahedronGeometry args={[0.7, 1]} /><meshBasicMaterial color={BLUE.clone().multiplyScalar(1.4)} wireframe toneMapped={false} /></mesh>
        <mesh rotation={[Math.PI / 2.4, 0, 0]}><torusGeometry args={[1.05, 0.015, 8, 64]} /><meshBasicMaterial color={AMBER.clone().multiplyScalar(2)} toneMapped={false} /></mesh>
      </group>
      <Label group="nic" pos={[0, POS.hub.y + 1.5, 0]} name="Hugging Face Hub" sub="weights came from here, once" />
    </group>
  )
}

function Gpu() { return null }

/** Level 3: one dot product, 16 numbers at a time, using the real numbers from this model. */
function Lanes({ origin, active }: { origin: THREE.Vector3; active: boolean }) {
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
    <group position={origin.toArray()} scale={0.75} visible={on}>
      {[0, 1, 2].map((r) => (
        <instancedMesh key={r} ref={(m) => { if (m) rows.current[r] = m }} args={[undefined as any, undefined as any, 16]} frustumCulled={false}>
          <boxGeometry args={[0.14, 1, 0.3]} /><meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      ))}
      <mesh ref={sum} position={[0, 0.05, 2.35]}><boxGeometry args={[1, 0.12, 0.3]} /><meshBasicMaterial color={AMBER.clone().multiplyScalar(2.4)} toneMapped={false} /></mesh>
      <Label group="cpu" pos={[-2.1, 0.45, 0]} name="x" sub="16 numbers from the previous step" show={on} />
      <Label group="cpu" pos={[-2.1, 0.45, 0.75]} name="w" sub="16 weights fetched from RAM" show={on} />
      <Label group="cpu" pos={[-2.1, 0.45, 1.5]} name="x × w" sub="16 multiplies, all at once" show={on} />
      <Label group="cpu" pos={[-2.1, 0.3, 2.35]} name="Σ" sub={`chunk 1 of ${micro?.fma_instructions ?? ''}`} show={on} />
    </group>
  )
}

// --- camera -----------------------------------------------------------------------------------
const STAGE_CAM: Record<string, [number[], number[]]> = {
  input: [[-3.4, 10.5, 15.0], [-3.2, 0, 3.0]], send: [[-3.0, 10.5, 14.2], [-2.6, 0, 2.6]], tokenize: [[0.6, 8.0, 8.4], [0, 0.2, -0.6]],
  embed: [[2.6, 9.0, 10.0], [2.4, 0.2, -0.6]], blocks: [[1.6, 11.0, 12.8], [1.6, 0, -0.4]], logits: [[2.6, 10.0, 11.0], [2.4, 0, -0.5]],
  pick: [[0.6, 8.0, 8.4], [0, 0.2, -0.6]], output: [[3.4, 9.0, 12.0], [3.2, 0.3, 2.0]], decode: [[2.4, 11.0, 12.8], [2.2, 0, 0.6]],
}
const OVERVIEW: [number[], number[]] = [[0.5, 13, 16.5], [-0.5, 0, 0.4]]

function diveTarget(path: string[], cores: number, cols: number): [number[], number[]] {
  const c = path[0]
  // the caption card covers the lower part of the view, so aim slightly in front of the subject to lift it up
  const lift = (p: number[], t: number[]): [number[], number[]] => [[p[0], p[1], p[2] + 1.4], [t[0], t[1], t[2] + 1.4]]
  if (c === 'cpu' && path[1]?.startsWith('core')) {
    const k = +path[1].slice(4); const sp = Math.min(0.8, 3.1 / cols)
    const x = (k % cols - (cols - 1) / 2) * sp, z = (Math.floor(k / cols) - 0.5) * sp - 0.35 - 0.6
    return [[x + 0.3, 4.4, z + 8.0], [x, 0.4, z + 2.9]]
  }
  if (c === 'cpu') return lift([0, 5.6, 4.8], [0, 0.2, -0.6])
  if (c === 'ram') return lift([4.9, 4.6, 5.4], [4.9, 0.8, -0.6])
  if (c === 'ssd') return lift([-4.8, 4.0, 0.8], [-4.8, 0.1, -3.2])
  if (c === 'nic') return lift([-6.6, 3.8, 2.4], [-6.6, 0.1, -0.5])
  if (c === 'keyboard') return lift([-6.4, 4.0, 7.2], [-6.4, 0.1, 3.7])
  if (c === 'display') return lift([6.2, 3.8, 8.4], [6.2, 1.0, 3.9])
  return OVERVIEW
}

function Rig() {
  const ctl = useRef<CameraControls>(null!)
  const stage = useHW((s) => locate(s.tl, s.playhead).seg.id)
  const path = useHW((s) => s.path)
  // before a journey exists there is nothing to follow: show the whole machine and its live numbers
  const follow = useHW((s) => s.follow && !!s.journey)
  const cores = useHW((s) => s.info?.cpu?.cores ?? 8)
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height))
  useEffect(() => {
    const c = ctl.current
    if (!c) return
    const [p0, t] = path.length ? diveTarget(path, cores, Math.ceil(cores / 2)) : follow ? (STAGE_CAM[stage] ?? OVERVIEW) : OVERVIEW
    const p = aspectFit(p0, t, aspect)
    c.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], !reduceMotion)
  }, [stage, path, follow, cores, aspect])
  return <CameraControls ref={ctl} makeDefault smoothTime={0.9} minDistance={1.2} maxDistance={96} maxPolarAngle={Math.PI * 0.49} onStart={() => { if (useHW.getState().follow && !useHW.getState().path.length) useHW.getState().setFollow(false) }} />
}

function World() {
  const act = useRef<Activity>(idle(8))
  const path = useHW((s) => s.path)
  const info = useHW((s) => s.info)
  useFrame(() => {
    const h = useHW.getState()
    const nc = h.info?.cpu?.cores ?? 8
    act.current = h.benchRunning && h.benchStage ? benchActivity(h.benchStage, nc, h.benchLive ? Math.min(1, h.benchLive.value / Math.max(1, h.benchLive.best)) : 0)
      : h.journey ? activityAt(h.journey, h.tl, h.playhead, h.peaks(), nc) : idle(nc)
  })
  const cores = info?.cpu?.cores ?? 8
  const cols = Math.ceil(cores / 2), sp = Math.min(0.8, 3.1 / cols)
  const k = path[0] === 'cpu' && path[1]?.startsWith('core') ? +path[1].slice(4) : -1
  const origin = k >= 0 ? V((k % cols - (cols - 1) / 2) * sp, 0.5, (Math.floor(k / cols) - 0.5) * sp - 0.35 - 0.6 + 1.6) : V(0, 0, 0)
  return (
    <Act.Provider value={act}>
      <Board />
      <Keyboard /><Display /><Cpu /><Ram /><Ssd /><Nic /><Hub /><Gpu />
      <Trace curve={CURVES.usb} flowKey="usb" color={AMBER} /><Packets curve={CURVES.usb} flowKey="usb" color={AMBER} />
      <Trace curve={CURVES.vid} flowKey="vid" color={BLUE} /><Packets curve={CURVES.vid} flowKey="vid" color={BLUE} />
      <Trace curve={CURVES.ddrA} flowKey="ddr" color={AMBER} /><Packets curve={CURVES.ddrA} flowKey="ddr" color={AMBER} reverse speed={0.9} />
      <Trace curve={CURVES.ddrB} flowKey="ddr" color={AMBER} /><Packets curve={CURVES.ddrB} flowKey="ddr" color={AMBER} reverse speed={0.9} />
      <Trace curve={CURVES.ssd} flowKey="ssd" color={BLUE} /><Packets curve={CURVES.ssd} flowKey="ssd" color={BLUE} speed={0.8} />
      <Trace curve={CURVES.nic} flowKey="nic" color={BLUE} /><Packets curve={CURVES.nic} flowKey="nic" color={BLUE} speed={0.6} />
      <Trace curve={CURVES.wan} flowKey="wan" color={BLUE} /><Packets curve={CURVES.wan} flowKey="wan" color={BLUE} speed={0.5} />
      <Lanes origin={origin} active={k >= 0} />
    </Act.Provider>
  )
}

export function MachineScene({ active = true }: { active?: boolean }) {
  const benching = useHW((s) => s.benchRunning)
  const profiling = useHW((s) => !!s.journeyBusy && !s.benchRunning)
  const measuring = benching || profiling
  const baseline = useHW((s) => s.benchRunning && s.benchStage === 'idle' && s.source === 'companion')
  // live while measuring too, at 30 fps and 1x resolution so it takes little from the chip being measured;
  // paused only for the idle baseline second, so the cost of drawing can be measured
  return (
    <Canvas frameloop={!active || baseline ? 'never' : measuring ? 'demand' : 'always'} dpr={measuring ? 1 : [1, 1.75]} camera={{ position: [0.5, 11.5, 14], fov: 34 }} gl={{ antialias: false, powerPreference: 'high-performance' }}>
      {active && measuring && !baseline && <FpsCap fps={30} />}
      <color attach="background" args={['#060913']} />
      <WheelScrollsPage />
      <FitFog color="#060913" near={24} far={52} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[6, 12, 8]} intensity={1.5} />
      <Environment resolution={64} environmentIntensity={0.7}>
        <Lightformer form="rect" intensity={2.2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[16, 10, 1]} color="#9fb4ff" />
        <Lightformer form="rect" intensity={1.4} position={[-8, 3, 6]} rotation-y={Math.PI / 3} scale={[10, 4, 1]} color="#ffb867" />
      </Environment>
      <World />
      <Rig />
      <EffectComposer multisampling={measuring ? 0 : 4}>
        <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={0.9} radius={0.75} />
        <Vignette eskil={false} offset={0.25} darkness={0.75} />
      </EffectComposer>
    </Canvas>
  )
}
