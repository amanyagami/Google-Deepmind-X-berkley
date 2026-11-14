// The model zoo in 3D. One layout per kind of network; every value drawn is computed live in the browser
// (nets.ts) and everything that moves is a pure function of the playhead, so the flow scrubs and rewinds.
// Amber = positive, blue = negative, brightness = size. Double-click any unit to see how its number was computed.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { aspectFit, FitFog, WheelScrollsPage } from '../aspect'
import { CameraControls, Environment, Html, Lightformer, RoundedBox } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { reach, useZoo, type NetId } from './zooStore'
import { useStore } from '../store'

const AMBER = new THREE.Color('#ffa94d')
const BLUE = new THREE.Color('#55a8ff')
const INK = new THREE.Color('#1a2342')
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const Z = () => useZoo.getState()
/** Which network a piece of the scene belongs to. Every loaded network stays mounted (unmounting HTML labels breaks
 *  in React 19); only the active one draws, shows its labels and reads the current output. */
const NetCtx = createContext<NetId>('mlp')
const useActive = () => { const me = useContext(NetCtx); return useZoo((s) => s.net === me) }
const useMe = () => useContext(NetCtx)

function valueColor(v: number, max: number, out: THREE.Color, lit = 1) {
  const x = Math.max(-1, Math.min(1, v / (max || 1)))
  out.copy(INK).lerp(x >= 0 ? AMBER : BLUE, Math.min(1, Math.abs(x) * 1.15) * lit)
  return out.multiplyScalar(1 + Math.abs(x) * 1.6 * lit)
}

function Tag({ pos, name, sub }: { pos: [number, number, number]; name: string; sub?: string }) {
  const on = useActive()
  return (
    <Html position={pos} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div className="mlabel" style={{ display: on ? undefined : 'none' }}><b>{name}</b>{sub && <span>{sub}</span>}</div>
    </Html>
  )
}

const pick = (kind: string, layer: string) => (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.instanceId !== undefined) Z().select({ kind, layer, index: e.instanceId }) }

/* ------------------------------------------------------------------------------- primitives */
/** A grid of tiles; tile height and colour follow the values. `order` reveals tiles one by one while `stage` runs. */
function Tiles({ get, count, place, size = 0.3, stage, maxAbs = 1, kind = 'tile', layer = '', lift = 0.6, scanReveal = false }:
  { get: () => number[] | null; count: number; place: (i: number) => [number, number, number]; size?: number; stage: string; maxAbs?: number | (() => number); kind?: string; layer?: string; lift?: number; scanReveal?: boolean }) {
  const me = useMe()
  const m = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const c = useMemo(() => new THREE.Color(), [])
  useFrame(() => {
    if (Z().net !== me) return
    const vals = get(); const s = Z()
    const r = stage ? reach(s.net, s.t, stage) : 1
    const mx = typeof maxAbs === 'function' ? maxAbs() : maxAbs
    const sel = s.sel?.layer === layer ? s.sel.index : -1
    for (let i = 0; i < count; i++) {
      const v = vals?.[i] ?? 0
      const shown = scanReveal ? (i + 1) / count <= r + 1e-6 : r > 0
      const lit = shown ? (scanReveal ? 1 : r) : 0
      const h = 0.04 + Math.min(1, Math.abs(v) / (mx || 1)) * lift * lit
      const [x, y, z] = place(i)
      d.position.set(x, y + h / 2, z); d.scale.set(size, h, size); d.updateMatrix(); m.current.setMatrixAt(i, d.matrix)
      valueColor(v, mx, c, lit); if (i === sel) c.setRGB(1, 1, 1).multiplyScalar(2.5)
      m.current.setColorAt(i, c)
    }
    m.current.instanceMatrix.needsUpdate = true; if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={m} args={[undefined as any, undefined as any, count]} frustumCulled={false} onDoubleClick={pick(kind, layer)}>
      <boxGeometry args={[0.92, 1, 0.92]} /><meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

/** Neurons as glowing spheres. */
function Nodes({ get, count, place, stage, maxAbs, layer, r = 0.17 }: { get: () => number[] | null; count: number; place: (i: number) => [number, number, number]; stage: string; maxAbs: () => number; layer: string; r?: number }) {
  const me = useMe()
  const m = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const c = useMemo(() => new THREE.Color(), [])
  useFrame(() => {
    if (Z().net !== me) return
    const vals = get(); const s = Z(); const rr = reach(s.net, s.t, stage); const mx = maxAbs()
    const sel = s.sel?.layer === layer ? s.sel.index : -1
    for (let i = 0; i < count; i++) {
      const v = vals?.[i] ?? 0
      const lit = Math.max(0, Math.min(1, rr * 1.6 - (i / count) * 0.6))
      d.position.set(...place(i)); d.scale.setScalar(r * (0.75 + 0.6 * Math.min(1, Math.abs(v) / (mx || 1)) * lit)); d.updateMatrix(); m.current.setMatrixAt(i, d.matrix)
      valueColor(v, mx, c, lit); if (i === sel) c.setRGB(3, 3, 3)
      m.current.setColorAt(i, c)
    }
    m.current.instanceMatrix.needsUpdate = true; if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={m} args={[undefined as any, undefined as any, count]} frustumCulled={false} onDoubleClick={pick('neuron', layer)}>
      <sphereGeometry args={[1, 18, 18]} /><meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

/** Weighted connections: for each target, its strongest incoming contributions (weight x activation). */
function Links({ compute, stage, max = 2000 }: { compute: () => { a: THREE.Vector3; b: THREE.Vector3; v: number }[]; stage: string; max?: number }) {
  const me = useMe()
  const geo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(max * 6), 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(max * 6), 3)); return g }, [max])
  const c = useMemo(() => new THREE.Color(), [])
  const key = useRef('')
  const links = useRef<{ a: THREE.Vector3; b: THREE.Vector3; v: number }[]>([])
  useFrame(() => {
    if (Z().net !== me) return
    const s = Z()
    const k = `${s.net}:${s.out ? s.img.join(',') : ''}`
    if (k !== key.current) { key.current = k; links.current = s.out ? compute() : [] }
    const r = reach(s.net, s.t, stage)
    const L = links.current, mx = Math.max(1e-6, ...L.map((l) => Math.abs(l.v)))
    const pos = geo.getAttribute('position') as THREE.BufferAttribute, col = geo.getAttribute('color') as THREE.BufferAttribute
    const n = Math.min(max, L.length), shown = Math.floor(n * Math.min(1, r * 1.25))
    for (let i = 0; i < max; i++) {
      if (i < shown) {
        const l = L[i]
        // a packet of light runs along each link while its stage plays
        const u = r < 1 ? Math.min(1, (r * 1.25 * n - i) / Math.max(1, n * 0.15)) : 1
        pos.setXYZ(i * 2, l.a.x, l.a.y, l.a.z)
        pos.setXYZ(i * 2 + 1, l.a.x + (l.b.x - l.a.x) * u, l.a.y + (l.b.y - l.a.y) * u, l.a.z + (l.b.z - l.a.z) * u)
        valueColor(l.v, mx, c, 0.35 + 0.65 * Math.abs(l.v) / mx)
        col.setXYZ(i * 2, c.r * 0.5, c.g * 0.5, c.b * 0.5); col.setXYZ(i * 2 + 1, c.r, c.g, c.b)
      } else { pos.setXYZ(i * 2, 0, -50, 0); pos.setXYZ(i * 2 + 1, 0, -50, 0) }
    }
    pos.needsUpdate = true; col.needsUpdate = true
  })
  return <lineSegments geometry={geo} frustumCulled={false}><lineBasicMaterial vertexColors transparent opacity={0.85} toneMapped={false} /></lineSegments>
}

/** Arcs between token positions, opacity by attention weight. */
function Arcs({ compute, stage, max = 600, bend = [0, 1, 0] }: { compute: () => { a: THREE.Vector3; b: THREE.Vector3; w: number; head: number }[]; stage: string; max?: number; bend?: [number, number, number] }) {
  const me = useMe()
  const SEG = 12
  const geo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(max * SEG * 6), 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(max * SEG * 6), 3)); return g }, [max])
  const p = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    if (Z().net !== me) return
    const s = Z(); const r = reach(s.net, s.t, stage)
    const arcs = s.out ? compute() : []
    const pos = geo.getAttribute('position') as THREE.BufferAttribute, col = geo.getAttribute('color') as THREE.BufferAttribute
    let o = 0
    for (const a of arcs.slice(0, max)) {
      const h = 0.6 + a.a.distanceTo(a.b) * 0.22
      const k = Math.min(1, a.w * 2.2) * r
      const cc = (a.head ? BLUE : AMBER).clone().multiplyScalar(0.25 + 2.6 * k)
      for (let sgi = 0; sgi < SEG; sgi++) {
        for (const e of [sgi, sgi + 1]) {
          const u = (e / SEG) * Math.min(1, r * 1.3)
          const lift = Math.sin(u * Math.PI) * h * (a.head ? 1.25 : 1)
          p.lerpVectors(a.a, a.b, u); p.x += lift * bend[0]; p.y += lift * bend[1]; p.z += lift * bend[2]
          pos.setXYZ(o, p.x, p.y, p.z); col.setXYZ(o, cc.r * k, cc.g * k, cc.b * k); o++
        }
      }
    }
    for (; o < max * SEG * 2; o++) pos.setXYZ(o, 0, -50, 0)
    pos.needsUpdate = true; col.needsUpdate = true
  })
  return <lineSegments geometry={geo} frustumCulled={false}><lineBasicMaterial vertexColors transparent opacity={0.95} toneMapped={false} /></lineSegments>
}

/** Ten score bars with their digits; the winner glows. */
function Bars({ origin, stage, along = 'z', labels }: { origin: [number, number, number]; stage: string; along?: 'z' | 'x'; labels?: string[] }) {
  const me = useMe()
  const m = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const c = useMemo(() => new THREE.Color(), [])
  const tags = useRef<(HTMLDivElement | null)[]>([])
  const on = useActive()
  useFrame(() => {
    if (Z().net !== me) return
    const s = Z(); const pr: number[] = s.out?.probs ?? new Array(10).fill(0); const r = reach(s.net, s.t, stage)
    const best = pr.indexOf(Math.max(...pr))
    for (let i = 0; i < 10; i++) {
      const h = 0.05 + pr[i] * 3.2 * r
      const off = (i - 4.5) * 0.62
      d.position.set(origin[0] + (along === 'x' ? off : 0), origin[1] + h / 2, origin[2] + (along === 'z' ? off : 0)); d.scale.set(0.42, h, 0.42); d.updateMatrix(); m.current.setMatrixAt(i, d.matrix)
      c.copy(i === best && r > 0.5 ? AMBER : INK).multiplyScalar(i === best && r > 0.5 ? 2.4 : 1.6); m.current.setColorAt(i, c)
      const el = tags.current[i]; if (el) { el.textContent = `${labels?.[i] ?? i}${r > 0.6 ? ` · ${(pr[i] * 100).toFixed(0)}%` : ''}`; el.style.opacity = i === best || pr[i] > 0.05 ? '1' : '0.45' }
    }
    m.current.instanceMatrix.needsUpdate = true; if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true
  })
  return (
    <group>
      <instancedMesh ref={m} args={[undefined as any, undefined as any, 10]} frustumCulled={false}><boxGeometry args={[1, 1, 1]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      {Array.from({ length: 10 }, (_, i) => {
        const off = (i - 4.5) * 0.62
        return <Html key={i} position={[origin[0] + (along === 'x' ? off : 0.55), origin[1] - 0.05, origin[2] + (along === 'z' ? off : 0.6)]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}><div className="wlabel mono" style={{ display: on ? undefined : 'none' }} ref={(el) => { tags.current[i] = el }}>{i}</div></Html>
      })}
    </group>
  )
}

/** A 3x3 window frame that slides over a grid while a convolution stage plays. */
function Kernel({ stage, n, at, size }: { stage: string; n: number; at: (x: number, y: number) => [number, number, number]; size: number }) {
  const me = useMe()
  const g = useRef<THREE.LineSegments>(null!)
  const geo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(size * 3, 0.5, size * 3)), [size])
  useFrame(() => {
    if (Z().net !== me) return
    const s = Z(); const r = reach(s.net, s.t, stage)
    g.current.visible = r > 0 && r < 1
    const k = Math.min(n * n - 1, Math.floor(r * n * n))
    const [x, y, z] = at(k % n, Math.floor(k / n)); g.current.position.set(x, y + 0.25, z)
  })
  return <lineSegments ref={g} geometry={geo}><lineBasicMaterial color={new THREE.Color('#ffffff').multiplyScalar(2.5)} toneMapped={false} /></lineSegments>
}

const grid = (n: number, x0: number, z0: number, sz: number, y = 0) => (i: number): [number, number, number] => [x0 + ((i % n) - (n - 1) / 2) * sz, y, z0 + (Math.floor(i / n) - (n - 1) / 2) * sz]
const maxOf = (f: () => number[] | null | undefined) => () => Math.max(1e-6, ...(f() ?? [0]).map(Math.abs))

/* ------------------------------------------------------------------------------------- layouts */
function InputImage({ x, label = 'Input', sub = '8 × 8 pixels' }: { x: number; label?: string; sub?: string }) {
  return (
    <group>
      <Tiles get={() => Z().out?.input ?? null} count={64} place={grid(8, x, 0, 0.36)} size={0.33} stage="input" maxAbs={1} layer="input" kind="pixel" />
      <Tag pos={[x, 0.2, 2.0]} name={label} sub={sub} />
    </group>
  )
}

function MlpScene() {
  const P = {
    in: grid(8, -7, 0, 0.36), h1: (i: number): [number, number, number] => [-2.6 + (i % 4) * 0.5, 0.4, (Math.floor(i / 4) - 3.5) * 0.55],
    h2: (i: number): [number, number, number] => [1.6 + (i % 4) * 0.55, 0.4, (Math.floor(i / 4) - 1.5) * 0.7],
  }
  const vec = (f: (i: number) => [number, number, number], i: number, dy = 0) => { const p = f(i); return V(p[0], p[1] + dy, p[2]) }
  const top = (W: { shape: number[]; data: number[] }, a: number[], fromP: (i: number) => THREE.Vector3, toP: (j: number) => THREE.Vector3, k: number) => {
    const [o, n] = W.shape, out: { a: THREE.Vector3; b: THREE.Vector3; v: number }[] = []
    for (let j = 0; j < o; j++) {
      const c: { i: number; v: number }[] = []; for (let i = 0; i < n; i++) if (a[i]) c.push({ i, v: W.data[j * n + i] * a[i] })
      c.sort((x, y) => Math.abs(y.v) - Math.abs(x.v)); for (const t of c.slice(0, k)) out.push({ a: fromP(t.i), b: toP(j), v: t.v })
    }
    return out
  }
  const w = () => Z().packs.mlp!.weights
  return (
    <group>
      <InputImage x={-7} />
      <Links stage="h1" compute={() => top(w()['fc1.weight'], Z().out.input, (i) => vec(P.in, i, 0.1), (j) => vec(P.h1, j), 5)} />
      <Nodes get={() => Z().out?.h1} count={32} place={P.h1} stage="h1" maxAbs={maxOf(() => Z().out?.h1)} layer="h1" />
      <Tag pos={[-1.85, 0.2, 2.75]} name="Hidden layer 1" sub="32 neurons · ReLU" />
      <Links stage="h2" compute={() => top(w()['fc2.weight'], Z().out.h1, (i) => vec(P.h1, i), (j) => vec(P.h2, j), 5)} />
      <Nodes get={() => Z().out?.h2} count={16} place={P.h2} stage="h2" maxAbs={maxOf(() => Z().out?.h2)} layer="h2" r={0.2} />
      <Tag pos={[2.4, 0.2, 1.9]} name="Hidden layer 2" sub="16 neurons · ReLU" />
      <Links stage="out" compute={() => top(w()['fc3.weight'], Z().out.h2, (i) => vec(P.h2, i), (j) => V(5.6, 0.1, (j - 4.5) * 0.62), 4)} />
      <Bars origin={[5.6, 0, 0]} stage="out" />
      <Tag pos={[5.6, 0.2, 3.6]} name="Scores" sub="softmax over 10 digits" />
    </group>
  )
}

function CnnScene() {
  const mapZ = (k: number, n: number) => (k - (n - 1) / 2) * 1.45
  const c1 = (i: number): [number, number, number] => { const m = Math.floor(i / 64), r = i % 64; return [-3.6 + ((r % 8) - 3.5) * 0.15, 0, mapZ(m, 8) + (Math.floor(r / 8) - 3.5) * 0.15] }
  const p1 = (i: number): [number, number, number] => { const m = Math.floor(i / 16), r = i % 16; return [-1.2 + ((r % 4) - 1.5) * 0.2, 0, mapZ(m, 8) + (Math.floor(r / 4) - 1.5) * 0.2] }
  const c2 = (i: number): [number, number, number] => { const m = Math.floor(i / 16), r = i % 16; const col = m % 2, row = Math.floor(m / 2); return [1.0 + col * 1.0 + ((r % 4) - 1.5) * 0.18, 0, mapZ(row, 8) + (Math.floor(r / 4) - 1.5) * 0.18] }
  const p2 = (i: number): [number, number, number] => { const m = Math.floor(i / 4), r = i % 4; const col = m % 2, row = Math.floor(m / 2); return [3.5 + col * 0.6 + ((r % 2) - 0.5) * 0.2, 0, mapZ(row, 8) + (Math.floor(r / 2) - 0.5) * 0.2] }
  return (
    <group>
      <InputImage x={-7.5} />
      <Kernel stage="conv1" n={8} size={0.36} at={(x, y) => [-7.5 + (x - 3.5) * 0.36, 0.3, (y - 3.5) * 0.36]} />
      <Tiles get={() => Z().out?.conv1} count={512} place={c1} size={0.14} stage="conv1" maxAbs={maxOf(() => Z().out?.conv1)} layer="conv1" kind="cell" lift={0.5} scanReveal />
      <Tag pos={[-3.6, 0.2, 6.6]} name="Convolution 1" sub="8 filters of 3×3 · ReLU" />
      <Tiles get={() => Z().out?.pool1} count={128} place={p1} size={0.18} stage="pool1" maxAbs={maxOf(() => Z().out?.pool1)} layer="pool1" kind="cell" lift={0.5} />
      <Tag pos={[-1.2, 0.2, -6.6]} name="Max pool" sub="keep the largest of each 2×2" />
      <Kernel stage="conv2" n={4} size={0.2} at={(x, y) => [-1.2 + (x - 1.5) * 0.2, 0.3, mapZ(0, 8) + (y - 1.5) * 0.2]} />
      <Tiles get={() => Z().out?.conv2} count={256} place={c2} size={0.16} stage="conv2" maxAbs={maxOf(() => Z().out?.conv2)} layer="conv2" kind="cell" lift={0.5} scanReveal />
      <Tag pos={[1.5, 0.2, 6.6]} name="Convolution 2" sub="16 filters, each sees all 8 maps" />
      <Tiles get={() => Z().out?.pool2} count={64} place={p2} size={0.18} stage="pool2" maxAbs={maxOf(() => Z().out?.pool2)} layer="pool2" kind="cell" lift={0.5} />
      <Bars origin={[6.4, 0, 0]} stage="out" />
      <Tag pos={[6.4, 0.2, 3.6]} name="Scores" sub="one dense layer on 64 numbers" />
    </group>
  )
}

function RnnScene() {
  const hid = (t: number) => (i: number): [number, number, number] => [-3.6 + t * 1.45 + ((i % 4) - 1.5) * 0.24, 0.5, -1.4 + (Math.floor(i / 4) - 2.5) * 0.3]
  const row = (t: number) => (i: number): [number, number, number] => [-3.6 + t * 1.45 + (i - 3.5) * 0.15, 0, 2.2]
  return (
    <group>
      <InputImage x={-8} sub="read one row per step" />
      {Array.from({ length: 8 }, (_, t) => (
        <group key={t}>
          <Tiles get={() => Z().out?.input.slice(t * 8, t * 8 + 8)} count={8} place={row(t)} size={0.13} stage={`t${t}`} maxAbs={1} layer={`x${t}`} kind="pixel" lift={0.4} />
          <Nodes get={() => Z().out?.hidden[t]} count={24} place={hid(t)} stage={`t${t}`} maxAbs={() => 1} layer={`h${t}`} r={0.1} />
          <Links stage={`t${t}`} compute={() => {
            const out = Z().out, Wi = Z().packs.rnn!.weights['gru.weight_ih'].data
            const res: { a: THREE.Vector3; b: THREE.Vector3; v: number }[] = []
            // memory carried over: each unit of the previous step feeds the same unit now
            if (t > 0) for (let j = 0; j < 24; j++) { const a = hid(t - 1)(j), b = hid(t)(j); res.push({ a: V(...a), b: V(...b), v: out.hidden[t - 1][j] }) }
            // each lit pixel of this row, linked to the memory unit its candidate weight pushes hardest
            for (let i = 0; i < 8; i++) {
              const x = out.input[t * 8 + i]; if (x < 0.15) continue
              let best = 0, bv = 0
              for (let j = 0; j < 24; j++) { const v = Wi[(48 + j) * 8 + i] * x; if (Math.abs(v) > Math.abs(bv)) { bv = v; best = j } }
              res.push({ a: V(...row(t)(i)), b: V(...hid(t)(best)), v: bv })
            }
            return res
          }} />
          {t === 0 || t === 7 ? <Tag pos={[-3.6 + t * 1.45, 0.2, 3.1]} name={`step ${t + 1}`} sub={t === 0 ? 'row 1 + empty memory' : 'row 8 + memory of rows 1–7'} /> : null}
        </group>
      ))}
      <Tag pos={[1.5, 1.6, -3.4]} name="Hidden state (memory)" sub="24 numbers, carried from step to step" />
      <Bars origin={[8.2, 0, 0]} stage="out" />
    </group>
  )
}

const tokZ = (i: number, n: number) => (i - (n - 1) / 2) * 0.72

function VitScene() {
  const patchPos = (i: number): [number, number, number] => { const p = Math.floor(i / 4), k = i % 4; const px = p % 4, py = Math.floor(p / 4); return [-4.2 + (px - 1.5) * 0.95 + ((k % 2) - 0.5) * 0.3, 0, (py - 1.5) * 0.95 + (Math.floor(k / 2) - 0.5) * 0.3] }
  const tokCell = (x: number) => (i: number): [number, number, number] => { const t = Math.floor(i / 16), k = i % 16; return [x + ((k % 4) - 1.5) * 0.11, 0, tokZ(t, 17) + (Math.floor(k / 4) - 1.5) * 0.11] }
  return (
    <group>
      <InputImage x={-8.2} />
      <Tiles get={() => Z().out?.patches.flat()} count={64} place={patchPos} size={0.28} stage="patch" maxAbs={1} layer="patch" kind="pixel" lift={0.4} />
      <Tag pos={[-4.2, 0.2, 2.6]} name="16 patches" sub="2 × 2 pixels each" />
      <Tiles get={() => Z().out?.tokens.flat()} count={17 * 16} place={tokCell(-0.6)} size={0.1} stage="embed" maxAbs={maxOf(() => Z().out?.tokens.flat())} layer="tokens" kind="token" lift={0.35} />
      <Tag pos={[-0.6, 0.2, 6.9]} name="17 tokens" sub="a summary token + one per patch, 16 numbers each" />
      <Arcs stage="attn" bend={[1.1, 0.5, 0]} compute={() => {
        const o = Z().out, sel = Z().sel?.layer === 'tokens' || Z().sel?.layer === 'out' ? Math.floor(Z().sel!.index / 16) : 0
        const res: { a: THREE.Vector3; b: THREE.Vector3; w: number; head: number }[] = []
        for (let h = 0; h < 2; h++) for (let j = 0; j < 17; j++) res.push({ a: V(1.4, 0.3, tokZ(sel, 17)), b: V(1.4, 0.3, tokZ(j, 17)), w: o.attn[h][sel][j], head: h })
        return res
      }} />
      <Tag pos={[1.4, 2.4, -6.6]} name="Attention" sub="who this token listens to · amber head 1, blue head 2" />
      <Tiles get={() => Z().out?.out.flat()} count={17 * 16} place={tokCell(3.4)} size={0.1} stage="mlp" maxAbs={maxOf(() => Z().out?.out.flat())} layer="out" kind="token" lift={0.35} />
      <Tag pos={[3.4, 0.2, 6.9]} name="After the block" sub="attention + MLP, added to each token" />
      <Bars origin={[7.0, 0, 0]} stage="out" />
      <Tag pos={[7.0, 0.2, 3.6]} name="Scores" sub="read from the summary token" />
    </group>
  )
}

function VlmScene() {
  const vocab = useZoo((s) => s.packs.vlm?.vocab ?? [])
  const nWords = useZoo((s) => s.out?.ids?.length ?? 0)
  const imgTok = (i: number): [number, number, number] => [-4.3 + ((i % 4) - 1.5) * 0.85, 0, ((Math.floor(i / 4)) - 1.5) * 0.85]
  const imgCell = (i: number): [number, number, number] => { const t = Math.floor(i / 24), k = i % 24; const p = imgTok(t); return [p[0] + ((k % 6) - 2.5) * 0.1, 0, p[2] + (Math.floor(k / 6) - 1.5) * 0.1] }
  const wordX = (k: number) => -1.0 + k * 1.08
  const wordsRef = useRef<(HTMLDivElement | null)[]>([])
  const active = useActive()
  const pills = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const c = useMemo(() => new THREE.Color(), [])
  useFrame(() => {
    if (Z().net !== 'vlm') return
    const s = Z(); const r = reach(s.net, s.t, 'write'); const ids: number[] = s.out?.ids ?? []
    const shown = Math.min(ids.length, Math.floor(r * ids.length + 1e-6) + (r > 0 ? 1 : 0))
    for (let k = 0; k < 12; k++) {
      const on = k < shown && k < ids.length
      d.position.set(wordX(k), 0.08, 3.2); if (on) d.scale.set(0.78, 0.1, 0.34); else d.scale.setScalar(0.0001); d.updateMatrix(); pills.current.setMatrixAt(k, d.matrix)
      if (k === shown - 1) c.copy(AMBER).multiplyScalar(2.2); else c.copy(INK).lerp(BLUE, 0.45); pills.current.setColorAt(k, c)
      const el = wordsRef.current[k]; if (el) { el.style.display = on ? '' : 'none'; el.textContent = on ? vocab[ids[k]] ?? '' : '' }
    }
    pills.current.instanceMatrix.needsUpdate = true; if (pills.current.instanceColor) pills.current.instanceColor.needsUpdate = true
  })
  return (
    <group>
      <InputImage x={-9} />
      <Tiles get={() => Z().out?.img.flat()} count={16 * 24} place={imgCell} size={0.085} stage="connect" maxAbs={maxOf(() => Z().out?.img.flat())} layer="img" kind="imgtok" lift={0.35} />
      <Tag pos={[-4.3, 0.2, -2.6]} name="Image tokens" sub="vision tower → connector → 16 tokens the language model can read" />
      <Arcs stage="vision" compute={() => {
        const o = Z().out; const res: { a: THREE.Vector3; b: THREE.Vector3; w: number; head: number }[] = []
        for (let j = 0; j < 16; j++) { const a = imgTok(5), b = imgTok(j); res.push({ a: V(a[0], 0.2, a[2]), b: V(b[0], 0.2, b[2]), w: o.v_attn[0][5][j], head: 0 }) }
        return res
      }} />
      <instancedMesh ref={pills} args={[undefined as any, undefined as any, 12]} frustumCulled={false}><boxGeometry args={[1, 1, 1]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      {Array.from({ length: 12 }, (_, k) => (
        <Html key={k} position={[wordX(k), 0.55, 3.2]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}><div style={{ display: active ? undefined : 'none' }}><div className="wordtag mono" ref={(el) => { wordsRef.current[k] = el }} style={{ display: 'none' }} /></div></Html>
      ))}
      <Arcs stage="write" max={64} compute={() => {
        const s = Z(); const o = s.out; const ids: number[] = o.ids
        const r = reach(s.net, s.t, 'write'); const k = Math.max(1, Math.min(ids.length - 1, Math.floor(r * ids.length)))
        const step = o.steps[Math.min(o.steps.length - 1, k - 1)]
        if (!step) return []
        const row = 16 + k - 1
        const res: { a: THREE.Vector3; b: THREE.Vector3; w: number; head: number }[] = []
        for (let h = 0; h < 2; h++) {
          for (let j = 0; j < 16; j++) { const b = imgTok(j); res.push({ a: V(wordX(k - 1), 0.3, 3.2), b: V(b[0], 0.3, b[2]), w: step.attn[h][row][j], head: h }) }
          for (let j = 0; j < k; j++) res.push({ a: V(wordX(k - 1), 0.3, 3.2), b: V(wordX(j), 0.3, 3.2), w: step.attn[h][row][16 + j], head: h })
        }
        return res
      }} />
      <Tag pos={[3.8, 0.2, 4.3]} name="Language model" sub={`writes one word at a time · ${nWords ? nWords - 1 : 0} words`} />
    </group>
  )
}

const SCENES: Record<NetId, () => ReactElement> = { mlp: MlpScene, cnn: CnnScene, rnn: RnnScene, vit: VitScene, vlm: VlmScene }
function Stage() {
  const net = useZoo((s) => s.net)
  const loaded = useZoo((s) => (Object.keys(s.packs) as NetId[]).join(','))
  const ready = useZoo((s) => !!s.out)
  if (!ready) return null
  return (
    <>
      {(loaded.split(',').filter(Boolean) as NetId[]).map((n) => { const S = SCENES[n]; return <NetCtx.Provider key={n} value={n}><group visible={n === net}><S /></group></NetCtx.Provider> })}
    </>
  )
}

const CAM: Record<NetId, [number[], number[]]> = {
  mlp: [[-1.4, 14.5, 17.5], [-1.4, 0, 0.6]], cnn: [[-0.6, 17.5, 18.5], [-0.6, 0, 0.6]], rnn: [[0, 14.5, 17.0], [0, 0, 0.4]],
  vit: [[-1.2, 16.5, 18.5], [-1.2, 0, 0.6]], vlm: [[-2.0, 15.5, 18.0], [-2.0, 0, 1.2]],
}
function Rig() {
  const ctl = useRef<CameraControls>(null!)
  const net = useZoo((s) => s.net)
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height))
  useEffect(() => { const [p0, t] = CAM[net]; const p = aspectFit(p0, t, aspect); ctl.current?.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], !reduceMotion) }, [net, aspect])
  return <CameraControls ref={ctl} makeDefault smoothTime={0.7} minDistance={2} maxDistance={126} maxPolarAngle={Math.PI * 0.48} />
}

export function ZooScene() {
  const shown = useStore((s) => !!s.visible.zoo)
  return (
    <Canvas frameloop={shown ? 'always' : 'never'} dpr={[1, 1.75]} camera={{ position: [-0.6, 14.5, 17.5], fov: 38 }} gl={{ antialias: false }} onPointerMissed={(e) => { if (e.type === 'dblclick') Z().select(null) }}>
      <color attach="background" args={['#060913']} />
      <WheelScrollsPage />
      <FitFog color="#060913" near={22} far={46} />
      <ambientLight intensity={0.4} />
      <Environment resolution={64} environmentIntensity={0.5}>
        <Lightformer form="rect" intensity={2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[16, 10, 1]} color="#9fb4ff" />
      </Environment>
      <RoundedBox args={[22, 0.2, 15]} radius={0.15} smoothness={3} position={[0, -0.12, 0.3]}><meshPhysicalMaterial color="#0a1122" metalness={0.4} roughness={0.7} /></RoundedBox>
      <Stage />
      <Rig />
      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={0.9} radius={0.7} />
        <Vignette eskil={false} offset={0.25} darkness={0.7} />
      </EffectComposer>
    </Canvas>
  )
}
