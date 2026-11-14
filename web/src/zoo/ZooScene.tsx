// The model zoo in 3D. One layout per kind of network; every value drawn is computed live in the browser
// (nets.ts) and everything that moves is a pure function of the playhead, so the flow scrubs and rewinds.
// Amber = positive, blue = negative, brightness = size. Double-click any unit to see how its number was computed.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { WheelScrollsPage } from '../aspect'
import { CameraControls, Environment, Lightformer, RoundedBox } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { create } from 'zustand'
import { reach, useZoo, type Inspect, type NetId } from './zooStore'
import { useStore } from '../store'
import { InspectTip, isInspectOn, useInspectOn } from '../ui/charts'
import { Chip, fitBox, KitProvider, LiteCtx, markTween, reduceMotion, SlowWatch, useStage, useStageKeys, Word } from '../stageKit'

const AMBER = new THREE.Color('#ffa94d')
const BLUE = new THREE.Color('#55a8ff')
const INK = new THREE.Color('#1a2342')
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
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

/* ------------------------------------------------------------------------------------ layer types */
export type LayerTypeId = 'embed' | 'mlp' | 'attention' | 'conv' | 'recurrent' | 'pool' | 'norm' | 'output'
/** The layer types of the 3D scenes (TODO 6.3). Shape is the first cue, the glyph the second, the faint plate tint the
 *  third; tints are never applied to nodes, so amber/blue keep meaning positive/negative. `plate: false` = no plate.
 *  Listed in the order that passes the palette check (adjacent CVD delta E >= 8.2 on #0a0e19); a legend should keep it. */
export const LAYER_TYPES: { id: LayerTypeId; label: string; glyph: string; tint: string; plate: boolean; shape: string }[] = [
  { id: 'embed', label: 'Embedding / input', glyph: '▦', tint: '#7d8bb0', plate: true, shape: 'flat tiles' },
  { id: 'mlp', label: 'MLP / dense', glyph: '●', tint: '#c9a46a', plate: true, shape: 'spheres' },
  { id: 'attention', label: 'Attention', glyph: '◎', tint: '#7b86e0', plate: true, shape: 'head teeth and arcs' },
  { id: 'conv', label: 'Convolution', glyph: '▣', tint: '#3fb3a6', plate: true, shape: 'cell grid and kernel frame' },
  { id: 'recurrent', label: 'Recurrent', glyph: '↻', tint: '#a68bd8', plate: true, shape: 'spheres and loop ring' },
  { id: 'pool', label: 'Pooling', glyph: '▫', tint: '#8fd1c8', plate: true, shape: 'flatter cells' },
  { id: 'norm', label: 'Norm', glyph: '○', tint: '#8a95b8', plate: false, shape: 'thin outline ring' },
  { id: 'output', label: 'Output', glyph: '▮', tint: '#7d8bb0', plate: true, shape: 'bars' },
]
const LT = Object.fromEntries(LAYER_TYPES.map((t) => [t.id, t])) as Record<LayerTypeId, (typeof LAYER_TYPES)[number]>

/* ------------------------------------------------------------------------------- selection plumbing */
interface Pick { key: string; inspect: NonNullable<Inspect>; text: string; box: THREE.Box3 }
interface Group { id: string; label: string; type: LayerTypeId; box: [number, number, number, number]; match: (l: string) => boolean; sub?: string }
interface SceneDef {
  key: string
  bounds: THREE.Box3
  groups: Group[]
  resolve(layer: string, i: number): Pick | null
  chip(grp: string): Pick | null
  boxOf(ins: NonNullable<Inspect>): THREE.Box3 | null
  litOf(ins: NonNullable<Inspect>): (layer: string, i: number) => boolean
  summary(): string
}
const DefCtx = createContext<SceneDef | null>(null)
const DEFS: Partial<Record<NetId, SceneDef>> = {}
const mkBox = (cx: number, cz: number, w: number, d: number, h = 1.1) => new THREE.Box3(V(cx - w / 2, 0, cz - d / 2), V(cx + w / 2, h, cz + d / 2))

/** What is dimmed (to 25 %) while something is selected. Read every frame by the drawing loops, set when `inspect` changes. */
const SEL = { on: false, lit: (_l: string, _i: number): boolean => true }
const dimOf = (layer: string, i: number) => (SEL.on && !SEL.lit(layer, i) ? 0.25 : 1)
const linkDim = () => (SEL.on ? 0.3 : 1)

const useUI = create<{ hover: Pick | null; x: number; y: number }>(() => ({ hover: null, x: 0, y: 0 }))
const setCursor = (on: boolean) => { try { document.body.style.cursor = on ? 'pointer' : '' } catch { /* ignore */ } }
function hoverPick(p: Pick | null, e?: ThreeEvent<PointerEvent>) {
  if (useUI.getState().hover?.key !== p?.key) { useUI.setState({ hover: p }); setCursor(!!p) }
  if (p && e) {
    const ne = e.nativeEvent as PointerEvent, u = useUI.getState()
    if (Math.abs(ne.offsetX - u.x) > 6 || Math.abs(ne.offsetY - u.y) > 6) useUI.setState({ x: ne.offsetX, y: ne.offsetY })
  }
}
/** Pointer handlers for an instanced mesh whose instances map to inspectable things. */
function usePick(layer: string) {
  const def = useContext(DefCtx), me = useMe()
  return {
    onClick: (e: ThreeEvent<MouseEvent>) => { if (Z().net !== me || e.instanceId === undefined) return; const p = def?.resolve(layer, e.instanceId); if (p) { e.stopPropagation(); Z().setInspect(p.inspect) } },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => { if (Z().net !== me || e.instanceId === undefined) return; const p = def?.resolve(layer, e.instanceId); if (p) { e.stopPropagation(); hoverPick(p, e) } },
    onPointerOut: () => { if (Z().net === me) hoverPick(null) },
  }
}

const sameInspect = (a: Inspect, b: Inspect) => !!a && !!b && a.kind === b.kind && a.layer === b.layer && a.part === b.part && a.name === b.name && (a.index ?? -1) === (b.index ?? -1)

function Tag({ pos, name, sub, grp, prio = 1, onKey }: { pos: [number, number, number]; name: string; sub?: string; grp?: string; prio?: number; onKey?: (e: React.KeyboardEvent) => void }) {
  const on = useActive(), def = useContext(DefCtx)
  const target = grp ? def?.chip(grp) : null
  const sel = useZoo((s) => (target ? sameInspect(s.inspect, target.inspect) : false))
  const glyph = grp ? LT[def?.groups.find((g) => g.id === grp)?.type ?? 'mlp']?.glyph : undefined
  return <Chip pos={pos} name={name} sub={sub} glyph={glyph} hidden={!on} selected={sel} prio={prio}
    onClick={target ? () => Z().setInspect(sel ? null : target.inspect) : undefined} onHover={target ? (h) => hoverPick(h ? target : null) : undefined} onKey={onKey} />
}

/** The plate under a group: the type's tint at 8 %, a thin border, and the type's own mark (kernel frame and cell grid,
 *  loop ring, head teeth). Plain meshes only, so it may live in a keyed group. */
function Plate({ g, def }: { g: Group; def?: SceneDef }) {
  const me = useMe(), t = LT[g.type]
  const [cx, cz, w, d] = g.box
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)), [w, d])
  const extra = useMemo(() => {
    const pts: number[] = []
    if (g.type === 'conv') {
      const k = Math.min(0.5, w * 0.3), x0 = -w / 2 + 0.12, z0 = -d / 2 + 0.12
      pts.push(x0, 0, z0, x0 + k, 0, z0, x0 + k, 0, z0, x0 + k, 0, z0 + k, x0 + k, 0, z0 + k, x0, 0, z0 + k, x0, 0, z0 + k, x0, 0, z0)
      for (let i = 1; i < 12; i++) { const z = -d / 2 + (d * i) / 12; pts.push(-w / 2, 0, z, w / 2, 0, z) }
    }
    if (g.type === 'attention') { for (let i = 0; i <= Math.min(24, Math.floor(d / 0.5)); i++) { const z = -d / 2 + 0.1 + i * 0.5; pts.push(-w / 2, 0, z, -w / 2 + 0.28, 0, z, w / 2, 0, z, w / 2 - 0.28, 0, z) } }
    if (!pts.length) return null
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return gg
  }, [g.type, w, d])
  const pk = def ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { if (Z().net !== me) return; const p = def.chip(g.id); if (p) { e.stopPropagation(); Z().setInspect(p.inspect) } },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => { if (Z().net !== me) return; const p = def.chip(g.id); if (p) { e.stopPropagation(); hoverPick(p, e) } },
    onPointerOut: () => { if (Z().net === me) hoverPick(null) },
  } : {}
  return (
    <group position={[cx, 0, cz]}>
      <mesh rotation-x={-Math.PI / 2} position-y={0.006} renderOrder={-1} {...pk}><planeGeometry args={[w, d]} /><meshBasicMaterial color={t.tint} transparent opacity={0.1} depthWrite={false} toneMapped={false} /></mesh>
      <lineSegments geometry={edges} rotation-x={-Math.PI / 2} position-y={0.008}><lineBasicMaterial color={t.tint} transparent opacity={0.7} toneMapped={false} /></lineSegments>
      {extra && <lineSegments geometry={extra} position-y={0.01}><lineBasicMaterial color={t.tint} transparent opacity={g.type === 'conv' ? 0.3 : 0.55} toneMapped={false} /></lineSegments>}
      {g.type === 'recurrent' && <mesh rotation-x={-Math.PI / 2} position-y={0.05} scale={[w / 2 - 0.2, d / 2 - 0.1, 1]}><torusGeometry args={[1, 0.018, 6, 64]} /><meshBasicMaterial color={t.tint} transparent opacity={0.7} toneMapped={false} /></mesh>}
    </group>
  )
}
const Plates = ({ def }: { def: SceneDef }) => <>{def.groups.filter((g) => LT[g.type].plate).map((g) => <Plate key={g.id} g={g} def={def} />)}</>

/** Tiny nets: a fixed table of groups (position, type, which drawing layers belong to it) gives plates, hover text,
 *  selection boxes and the dimming rule from one place. */
function tinyDef(net: NetId, title: string, groups: Group[]): SceneDef {
  const gOf = (id: string) => groups.find((g) => g.id === id)
  const outG = () => groups.find((x) => x.type === 'output')
  const pk = (g: Group): Pick => ({ key: g.id, inspect: g.type === 'output' ? { kind: 'output', name: g.id } : { kind: 'tensor', name: g.id }, text: `${g.label} · ${LT[g.type].label}${g.sub ? ` · ${g.sub}` : ''}`, box: mkBox(g.box[0], g.box[1], g.box[2], g.box[3]) })
  const xs = groups.flatMap((g) => [g.box[0] - g.box[2] / 2, g.box[0] + g.box[2] / 2]), zs = groups.flatMap((g) => [g.box[1] - g.box[3] / 2, g.box[1] + g.box[3] / 2])
  return {
    key: net, groups, bounds: new THREE.Box3(V(Math.min(...xs), 0, Math.min(...zs)), V(Math.max(...xs), 1.3, Math.max(...zs))),
    resolve: (layer) => { const g = groups.find((x) => x.match(layer)); return g ? pk(g) : null },
    chip: (id) => { const g = gOf(id); return g ? pk(g) : null },
    boxOf: (ins) => { const g = ins.kind === 'output' ? outG() : gOf(ins.name ?? ''); return g ? pk(g).box : null },
    litOf: (ins) => { const g = ins.kind === 'output' ? outG() : gOf(ins.name ?? ''); return g ? (l) => g.match(l) : () => true },
    summary: () => `${title}. Layers: ${groups.map((g) => g.label).join(', ')}.`,
  }
}
const is = (...ids: string[]) => (l: string) => ids.includes(l)
const reRows = (r: RegExp) => (l: string) => r.test(l)
const INPUT: Group = { id: 'input', label: 'Input', type: 'embed', box: [0, 0, 3.2, 3.2], match: is('input'), sub: '8 × 8 pixels' }
const at = (g: Group, x: number, z = 0): Group => ({ ...g, box: [x, z, g.box[2], g.box[3]] })
const SCORES = (x: number, label = 'Scores'): Group => ({ id: 'scores', label, type: 'output', box: [x, 0, 1.4, 6.8], match: is('scores'), sub: '10 bars' })
DEFS.mlp = tinyDef('mlp', 'Small neural network reading a digit', [at(INPUT, -7),
  { id: 'h1', label: 'Hidden layer 1', type: 'mlp', box: [-1.85, 0, 2.2, 4.6], match: is('h1'), sub: '32 neurons' },
  { id: 'h2', label: 'Hidden layer 2', type: 'mlp', box: [2.4, 0, 2.4, 2.8], match: is('h2'), sub: '16 neurons' }, SCORES(5.6)])
DEFS.cnn = tinyDef('cnn', 'Convolutional network reading a digit', [at(INPUT, -7.5),
  { id: 'conv1', label: 'Convolution 1', type: 'conv', box: [-3.6, 0, 1.6, 11.2], match: is('conv1'), sub: '8 filters' },
  { id: 'pool1', label: 'Max pool 1', type: 'pool', box: [-1.2, 0, 1.0, 11.2], match: is('pool1') },
  { id: 'conv2', label: 'Convolution 2', type: 'conv', box: [1.5, 0, 2.2, 11.2], match: is('conv2'), sub: '16 filters' },
  { id: 'pool2', label: 'Max pool 2', type: 'pool', box: [3.8, 0, 1.4, 11.2], match: is('pool2') }, SCORES(6.4)])
DEFS.rnn = tinyDef('rnn', 'Recurrent network reading a digit one row at a time', [at(INPUT, -8),
  { id: 'rows', label: 'Rows read', type: 'embed', box: [1.5, 2.2, 10.8, 0.8], match: reRows(/^x\d/), sub: 'one row per step' },
  { id: 'hidden', label: 'Hidden state', type: 'recurrent', box: [1.5, -1.4, 10.8, 2.4], match: reRows(/^h\d/), sub: '24 numbers of memory' }, SCORES(8.2)])
DEFS.vit = tinyDef('vit', 'Small vision transformer reading a digit', [at(INPUT, -8.2),
  { id: 'patch', label: '16 patches', type: 'embed', box: [-4.2, 0, 4.4, 4.4], match: is('patch') },
  { id: 'tokens', label: '17 tokens', type: 'embed', box: [-0.6, 0, 1.0, 12.4], match: is('tokens') },
  { id: 'attn', label: 'Attention', type: 'attention', box: [1.4, 0, 1.8, 12.4], match: () => false, sub: '2 heads' },
  { id: 'after', label: 'After the block', type: 'mlp', box: [3.4, 0, 1.0, 12.4], match: is('out') }, SCORES(7.0)])
DEFS.vlm = tinyDef('vlm', 'Tiny vision-language model describing a digit', [at(INPUT, -9),
  { id: 'img', label: 'Image tokens', type: 'embed', box: [-4.3, 0, 3.6, 3.6], match: is('img') },
  { id: 'words', label: 'Language model', type: 'attention', box: [4.95, 3.2, 12.6, 1.0], match: () => false, sub: 'writes one word at a time' }])

const pick = (kind: string, layer: string) => (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.instanceId !== undefined) Z().select({ kind, layer, index: e.instanceId }) }

/* ------------------------------------------------------------------------------- primitives */
/** A grid of tiles; tile height and colour follow the values. `order` reveals tiles one by one while `stage` runs. */
function Tiles({ get, count, place, size = 0.3, stage, maxAbs = 1, kind = 'tile', layer = '', lift = 0.6, scanReveal = false, shape = 'tile' }:
  { shape?: 'tile' | 'tooth'; get: () => number[] | null; count: number; place: (i: number) => [number, number, number]; size?: number; stage: string; maxAbs?: number | (() => number); kind?: string; layer?: string; lift?: number; scanReveal?: boolean }) {
  const me = useMe(), pk = usePick(layer)
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
      c.multiplyScalar(dimOf(layer, i)); m.current.setColorAt(i, c)
    }
    m.current.instanceMatrix.needsUpdate = true; if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={m} args={[undefined as any, undefined as any, count]} frustumCulled={false} onDoubleClick={pick(kind, layer)} {...pk}>
      <boxGeometry args={[shape === 'tooth' ? 0.42 : 0.92, 1, 0.92]} /><meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

/** Neurons as glowing spheres. */
function Nodes({ get, count, place, stage, maxAbs, layer, r = 0.17 }: { get: () => number[] | null; count: number; place: (i: number) => [number, number, number]; stage: string; maxAbs: () => number; layer: string; r?: number }) {
  const me = useMe(), pk = usePick(layer), lite = useContext(LiteCtx)
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
      c.multiplyScalar(dimOf(layer, i)); m.current.setColorAt(i, c)
    }
    m.current.instanceMatrix.needsUpdate = true; if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={m} args={[undefined as any, undefined as any, count]} frustumCulled={false} onDoubleClick={pick('neuron', layer)} {...pk}>
      <sphereGeometry args={lite ? [1, 8, 6] : [1, 18, 18]} /><meshBasicMaterial toneMapped={false} />
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
    const k = `${s.net}:${s.out ? (s.out.id ?? s.img.join(',')) : ''}`
    if (k !== key.current) { key.current = k; links.current = s.out ? compute() : [] }
    const r = reach(s.net, s.t, stage), dm = linkDim()
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
        col.setXYZ(i * 2, c.r * 0.5 * dm, c.g * 0.5 * dm, c.b * 0.5 * dm); col.setXYZ(i * 2 + 1, c.r * dm, c.g * dm, c.b * dm)
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
    const s = Z(); const r = reach(s.net, s.t, stage); const dm = linkDim()
    const arcs = s.out ? compute() : []
    const pos = geo.getAttribute('position') as THREE.BufferAttribute, col = geo.getAttribute('color') as THREE.BufferAttribute
    let o = 0
    for (const a of arcs.slice(0, max)) {
      const h = 0.6 + a.a.distanceTo(a.b) * 0.22
      const k = Math.min(1, a.w * 2.2) * r * dm
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
  const me = useMe(), pk = usePick('scores')
  const m = useRef<THREE.InstancedMesh>(null!)
  const d = useMemo(() => new THREE.Object3D(), [])
  const c = useMemo(() => new THREE.Color(), [])
  const tags = useRef<(HTMLDivElement | null)[]>([])
  const on = useActive()
  useFrame(() => {
    if (Z().net !== me) return
    const s = Z(); const pr: number[] = s.out?.probs ?? new Array(10).fill(0); const r = reach(s.net, s.t, stage)
    const best = pr.indexOf(Math.max(...pr)), dm = dimOf('scores', 0)
    for (let i = 0; i < 10; i++) {
      const h = 0.05 + pr[i] * 3.2 * r
      const off = (i - 4.5) * 0.62
      d.position.set(origin[0] + (along === 'x' ? off : 0), origin[1] + h / 2, origin[2] + (along === 'z' ? off : 0)); d.scale.set(0.42, h, 0.42); d.updateMatrix(); m.current.setMatrixAt(i, d.matrix)
      c.copy(i === best && r > 0.5 ? AMBER : INK).multiplyScalar((i === best && r > 0.5 ? 2.4 : 1.6) * dm); m.current.setColorAt(i, c)
      const el = tags.current[i]; if (el) { el.textContent = `${s.out?.labels?.[i] ?? labels?.[i] ?? i}${r > 0.6 ? ` · ${(pr[i] * 100).toFixed(0)}%` : ''}`; el.style.opacity = i === best || pr[i] > 0.05 ? '1' : '0.45' }
    }
    m.current.instanceMatrix.needsUpdate = true; if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true
  })
  return (
    <group>
      <instancedMesh ref={m} args={[undefined as any, undefined as any, 10]} frustumCulled={false} {...pk}><boxGeometry args={[1, 1, 1]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      {Array.from({ length: 10 }, (_, i) => {
        const off = (i - 4.5) * 0.62
        return <Word key={i} pos={[origin[0] + (along === 'x' ? off : 0.55), origin[1] - 0.05, origin[2] + (along === 'z' ? off : 0.6)]} hidden={!on} elRef={(el) => { tags.current[i] = el }}>{i}</Word>
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
      <Tag pos={[x, 0.2, 2.0]} name={label} sub={sub} grp="input" />
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
      <Tag pos={[-1.85, 0.2, 2.75]} name="Hidden layer 1" grp="h1" sub="32 neurons · ReLU" />
      <Links stage="h2" compute={() => top(w()['fc2.weight'], Z().out.h1, (i) => vec(P.h1, i), (j) => vec(P.h2, j), 5)} />
      <Nodes get={() => Z().out?.h2} count={16} place={P.h2} stage="h2" maxAbs={maxOf(() => Z().out?.h2)} layer="h2" r={0.2} />
      <Tag pos={[2.4, 0.2, 1.9]} name="Hidden layer 2" grp="h2" sub="16 neurons · ReLU" />
      <Links stage="out" compute={() => top(w()['fc3.weight'], Z().out.h2, (i) => vec(P.h2, i), (j) => V(5.6, 0.1, (j - 4.5) * 0.62), 4)} />
      <Bars origin={[5.6, 0, 0]} stage="out" />
      <Tag pos={[5.6, 0.2, 3.6]} name="Scores" grp="scores" sub="softmax over 10 digits" />
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
      <Tag pos={[-3.6, 0.2, 6.6]} name="Convolution 1" grp="conv1" sub="8 filters of 3×3 · ReLU" />
      <Tiles get={() => Z().out?.pool1} count={128} place={p1} size={0.18} stage="pool1" maxAbs={maxOf(() => Z().out?.pool1)} layer="pool1" kind="cell" lift={0.2} />
      <Tag pos={[-1.2, 0.2, -6.6]} name="Max pool" grp="pool1" sub="keep the largest of each 2×2" />
      <Kernel stage="conv2" n={4} size={0.2} at={(x, y) => [-1.2 + (x - 1.5) * 0.2, 0.3, mapZ(0, 8) + (y - 1.5) * 0.2]} />
      <Tiles get={() => Z().out?.conv2} count={256} place={c2} size={0.16} stage="conv2" maxAbs={maxOf(() => Z().out?.conv2)} layer="conv2" kind="cell" lift={0.5} scanReveal />
      <Tag pos={[1.5, 0.2, 6.6]} name="Convolution 2" grp="conv2" sub="16 filters, each sees all 8 maps" />
      <Tiles get={() => Z().out?.pool2} count={64} place={p2} size={0.18} stage="pool2" maxAbs={maxOf(() => Z().out?.pool2)} layer="pool2" kind="cell" lift={0.2} />
      <Bars origin={[6.4, 0, 0]} stage="out" />
      <Tag pos={[6.4, 0.2, 3.6]} name="Scores" grp="scores" sub="one dense layer on 64 numbers" />
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
          {t === 0 || t === 7 ? <Tag pos={[-3.6 + t * 1.45, 0.2, 3.1]} grp="hidden" name={`step ${t + 1}`} sub={t === 0 ? 'row 1 + empty memory' : 'row 8 + memory of rows 1–7'} /> : null}
        </group>
      ))}
      <Tag pos={[1.5, 1.6, -3.4]} name="Hidden state (memory)" grp="hidden" sub="24 numbers, carried from step to step" />
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
      <Tag pos={[-4.2, 0.2, 2.6]} name="16 patches" grp="patch" sub="2 × 2 pixels each" />
      <Tiles get={() => Z().out?.tokens.flat()} count={17 * 16} place={tokCell(-0.6)} size={0.1} stage="embed" maxAbs={maxOf(() => Z().out?.tokens.flat())} layer="tokens" kind="token" lift={0.35} />
      <Tag pos={[-0.6, 0.2, 6.9]} name="17 tokens" grp="tokens" sub="a summary token + one per patch, 16 numbers each" />
      <Arcs stage="attn" bend={[1.1, 0.5, 0]} compute={() => {
        const o = Z().out, sel = Z().sel?.layer === 'tokens' || Z().sel?.layer === 'out' ? Math.floor(Z().sel!.index / 16) : 0
        const res: { a: THREE.Vector3; b: THREE.Vector3; w: number; head: number }[] = []
        for (let h = 0; h < 2; h++) for (let j = 0; j < 17; j++) res.push({ a: V(1.4, 0.3, tokZ(sel, 17)), b: V(1.4, 0.3, tokZ(j, 17)), w: o.attn[h][sel][j], head: h })
        return res
      }} />
      <Tag pos={[1.4, 2.4, -6.6]} name="Attention" grp="attn" sub="who this token listens to · amber head 1, blue head 2" />
      <Tiles get={() => Z().out?.out.flat()} count={17 * 16} place={tokCell(3.4)} size={0.1} stage="mlp" maxAbs={maxOf(() => Z().out?.out.flat())} layer="out" kind="token" lift={0.35} />
      <Tag pos={[3.4, 0.2, 6.9]} name="After the block" grp="after" sub="attention + MLP, added to each token" />
      <Bars origin={[7.0, 0, 0]} stage="out" />
      <Tag pos={[7.0, 0.2, 3.6]} name="Scores" grp="scores" sub="read from the summary token" />
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
      <Tag pos={[-4.3, 0.2, -2.6]} name="Image tokens" grp="img" sub="vision tower → connector → 16 tokens the language model can read" />
      <Arcs stage="vision" compute={() => {
        const o = Z().out; const res: { a: THREE.Vector3; b: THREE.Vector3; w: number; head: number }[] = []
        for (let j = 0; j < 16; j++) { const a = imgTok(5), b = imgTok(j); res.push({ a: V(a[0], 0.2, a[2]), b: V(b[0], 0.2, b[2]), w: o.v_attn[0][5][j], head: 0 }) }
        return res
      }} />
      <instancedMesh ref={pills} args={[undefined as any, undefined as any, 12]} frustumCulled={false}><boxGeometry args={[1, 1, 1]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      {Array.from({ length: 12 }, (_, k) => (
        <Word key={k} pos={[wordX(k), 0.55, 3.2]} hidden={!active} elRef={(el) => { wordsRef.current[k] = el }} />
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
      <Tag pos={[3.8, 0.2, 4.3]} grp="words" name="Language model" sub={`writes one word at a time · ${nWords ? nWords - 1 : 0} words`} />
    </group>
  )
}


/* --------------------------------------------------------------------------- the real model */
/** The model loaded at the top of the page, on the shared prompt, in the same visual language as the small networks:
 *  prompt tokens, then one column of glowing spheres per block (each sphere: one token's signal after that block, from
 *  the real run), the attention of the last token in the block being played, and the next-word scores. */
const MAXT = 48 // token labels are mounted once, for up to this many prompt tokens (HTML labels must never unmount)
function LlmScene() {
  const T = useZoo((s) => (s.net === 'llm' ? s.out?.T ?? 0 : 0))
  const L = useZoo((s) => (s.net === 'llm' ? s.out?.L ?? 0 : 0))
  const nh = useZoo((s) => (s.net === 'llm' ? s.out?.nh ?? 0 : 0))
  const last = useRef<{ T: number; L: number; nh: number } | null>(null)
  if (T && L) last.current = { T, L, nh }
  return last.current ? <LlmLayout {...last.current} /> : <group />
}

const PARTS = ['attn', 'mlp', 'norm'] as const
/** Geometry, hover text, selection boxes and the dimming rule of the real-model scene for a run of T tokens, L blocks, nh heads. */
function llmDef(T: number, L: number, nh: number): SceneDef {
  const step = 11.4 / Math.max(1, L - 1)
  const colX = (k: number) => -6.0 + k * step
  const z = (t: number) => tokZ(t, T)
  const zHead = z(0) - 0.9, zH0 = zHead - nh * 0.2 - 0.1, zT0 = z(0) - 0.4, zT1 = z(T - 1) + 0.4
  const hw = Math.max(0.22, Math.min(0.5, step * 0.45))
  const box = (x0: number, x1: number, z0: number, z1: number, h = 1.1) => new THREE.Box3(V(x0, 0, z0), V(x1, h, z1))
  const blockBox = (k: number, part?: string) => part === 'attn' ? box(colX(k) - hw, colX(k) + hw, zH0, zHead + 0.3) : part === 'mlp' ? box(colX(k) - hw, colX(k) + hw, zT0, zT1) : box(colX(k) - hw, colX(k) + hw, zH0, zT1)
  const PN: Record<string, string> = { attn: 'Attention', mlp: 'MLP', norm: 'Norm' }
  const tokText = (t: number) => { const v = Z().net === 'llm' ? Z().out?.tokens?.[t] : ''; return (typeof v === 'string' ? v : '').replace(/\n/g, '⏎').trim() || '·' }
  const blockPick = (k: number, part: 'attn' | 'mlp' | 'norm', index?: number): Pick => ({
    key: `b${k}${part}`, inspect: { kind: 'block', layer: k, part, ...(index !== undefined ? { index } : {}) },
    text: `Block ${k + 1} · ${PN[part]}${part === 'attn' ? ` · ${nh} heads` : part === 'mlp' ? ` · ${T} tokens` : ''}`, box: blockBox(k, part),
  })
  const tokPick = (t: number): Pick => ({ key: `t${t}`, inspect: { kind: 'token', index: t }, text: `Token ${t + 1} · “${tokText(t)}”`, box: box(-8.8, colX(L - 1) + 0.4, z(t) - 0.4, z(t) + 0.4) })
  const outPick: Pick = { key: 'out', inspect: { kind: 'output', name: 'scores' }, text: 'Next word · top 10 guesses', box: box(6.9, 8.3, -3.2, 3.2) }
  const mid = Math.floor(L / 2), zc = (z(0) + z(T - 1)) / 2, span = z(T - 1) - z(0) + 1.0
  const groups: Group[] = [
    { id: 'tok', label: 'Your prompt', type: 'embed', box: [-8.2, zc, 1.1, span], match: is('tok') },
    { id: 'blocks', label: 'Blocks', type: 'mlp', box: [(colX(0) + colX(L - 1)) / 2, zc, colX(L - 1) - colX(0) + 1.0, span], match: is('resid') },
    { id: 'heads', label: 'Attention heads', type: 'attention', box: [(colX(0) + colX(L - 1)) / 2, (zHead + zH0) / 2, colX(L - 1) - colX(0) + 1.0, Math.max(0.6, zHead - zH0 + 0.5)], match: is('heads') },
    { id: 'scores', label: 'Next word', type: 'output', box: [7.6, 0, 1.4, 6.8], match: is('scores') },
  ]
  return {
    key: `${T}x${L}x${nh}`, groups,
    bounds: new THREE.Box3(V(-9.6, 0, zH0 - 0.3), V(8.5, 1.2, z(T - 1) + 0.9)),
    resolve: (layer, i) => layer === 'tok' ? tokPick(i) : layer === 'resid' ? blockPick(Math.floor(i / T), 'mlp') : layer === 'heads' ? blockPick(Math.floor(i / Math.max(1, nh)), 'attn', i % Math.max(1, nh)) : layer === 'scores' ? outPick : null,
    chip: (g) => g === 'tok' ? tokPick(T - 1) : g === 'blocks' ? blockPick(mid, 'mlp') : g === 'heads' ? blockPick(mid, 'attn') : g === 'scores' ? outPick : null,
    boxOf: (ins) => ins.kind === 'block' ? blockBox(Math.max(0, Math.min(L - 1, ins.layer ?? 0)), ins.part) : ins.kind === 'token' ? tokPick(Math.max(0, Math.min(T - 1, ins.index ?? T - 1))).box : ins.kind === 'output' ? outPick.box : null,
    litOf: (ins) => {
      if (ins.kind === 'block') { const k = ins.layer ?? 0, p = ins.part; return (l, i) => (l === 'heads' && p !== 'mlp' && Math.floor(i / Math.max(1, nh)) === k) || (l === 'resid' && p !== 'attn' && Math.floor(i / T) === k) }
      if (ins.kind === 'token') { const t = ins.index ?? T - 1; return (l, i) => (l === 'tok' && i === t) || (l === 'resid' && i % T === t) }
      if (ins.kind === 'output') return (l) => l === 'scores'
      return () => true
    },
    summary: () => `The model on your prompt: ${T} tokens, ${L} blocks, ${nh} attention heads per block, then the next-word scores.`,
  }
}

function LlmLayout({ T, L, nh }: { T: number; L: number; nh: number }) {
  const active = useActive()
  const def = useMemo(() => llmDef(T, L, nh), [T, L, nh])
  DEFS.llm = def
  const colX = (k: number) => -6.0 + k * (11.4 / Math.max(1, L - 1))
  const z = (t: number) => tokZ(t, T)
  const zHead = z(0) - 0.9
  const node = (i: number): [number, number, number] => [colX(Math.floor(i / T)), 0.35, z(i % T)]
  const head = (i: number): [number, number, number] => [colX(Math.floor(i / nh)), 0, zHead - (i % nh) * 0.2]
  const words = useRef<(HTMLDivElement | null)[]>([])
  const marker = useRef<THREE.Mesh>(null!)
  const blockTag = useRef<HTMLElement | null>(null)
  const blockAt = () => { const s = Z(); return Math.min(L - 1, Math.floor(reach('llm', s.t, 'blocks') * L)) }
  useFrame(() => {
    if (Z().net !== 'llm') return
    const s = Z(), r = reach('llm', s.t, 'blocks'), k = blockAt()
    if (!marker.current) return
    marker.current.visible = r > 0 && r < 1
    marker.current.position.x = colX(k)
    if (blockTag.current) blockTag.current.textContent = r <= 0 ? 'waiting for the prompt' : r >= 1 ? `all ${L} blocks done` : `block ${k + 1} of ${L}`
    const toks: string[] = s.out?.tokens ?? []
    for (let t = 0; t < MAXT; t++) { const el = words.current[t]; if (el) { el.style.display = t < T ? '' : 'none'; if (t < T) { el.textContent = (toks[t] ?? '').replace(/\n/g, '⏎') || '·'; el.style.opacity = reach('llm', s.t, 'input') > (t + 0.5) / T ? '1' : '0.25' } } }
  })
  const span = z(T - 1) - z(0) + 1.4
  const norm = useMemo(() => {
    const pts: number[] = [], w = Math.min(0.3, 11.4 / Math.max(1, L - 1) * 0.3), z0 = z(0) - 0.35, z1 = z(T - 1) + 0.35
    for (let k = 0; k < L; k++) { const x = colX(k); pts.push(x - w, 0.03, z0, x + w, 0.03, z0, x + w, 0.03, z0, x + w, 0.03, z1, x + w, 0.03, z1, x - w, 0.03, z1, x - w, 0.03, z1, x - w, 0.03, z0) }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return g
  }, [T, L])
  const mid = Math.floor(L / 2)
  const blocksKey = (e: React.KeyboardEvent) => {
    const cur = Z().inspect, k = cur?.kind === 'block' ? cur.layer ?? mid : mid, part = (cur?.kind === 'block' ? cur.part : 'mlp') ?? 'mlp'
    const set = (kk: number, pp: (typeof PARTS)[number]) => { e.preventDefault(); Z().setInspect({ kind: 'block', layer: Math.max(0, Math.min(L - 1, kk)), part: pp }) }
    if (e.key === 'ArrowRight') set(k + 1, part as any); else if (e.key === 'ArrowLeft') set(k - 1, part as any)
    else if (e.key === 'ArrowDown') set(k, PARTS[(PARTS.indexOf(part as any) + 1) % 3]); else if (e.key === 'ArrowUp') set(k, PARTS[(PARTS.indexOf(part as any) + 2) % 3])
  }
  return (
    <DefCtx.Provider value={def}>
      {/* Only plain meshes live in the keyed group: they are rebuilt when a run changes shape. Every HTML label sits
          outside it and stays mounted for good (drei <Html> breaks if it unmounts while the camera moves). */}
      <group key={`${T}x${L}x${nh}`}>
        <Plates def={def} />
        {/* norm: a thin outline ring around each block */}
        <lineSegments geometry={norm}><lineBasicMaterial color="#8a95b8" transparent opacity={0.55} toneMapped={false} /></lineSegments>
        {/* the prompt, one flat tile per token: height = size of its embedding */}
        <Tiles get={() => Z().out?.emb ?? null} count={T} place={(t) => [-8.2, 0, z(t)]} size={0.5} stage="input" maxAbs={1} layer="tok" kind="token" lift={0.5} scanReveal />
        {/* each token's signal as it leaves every block, linked block to block */}
        <Links stage="blocks" max={T * L + 20} compute={() => {
          const o = Z().out; const res: { a: THREE.Vector3; b: THREE.Vector3; v: number }[] = []
          for (let t = 0; t < T; t++) res.push({ a: V(-8.2, 0.3, z(t)), b: V(colX(0), 0.35, z(t)), v: o.emb[t] ?? 0 })
          for (let k = 1; k < L; k++) for (let t = 0; t < T; t++) res.push({ a: V(colX(k - 1), 0.35, z(t)), b: V(colX(k), 0.35, z(t)), v: o.resid[k * T + t] ?? 0 })
          return res
        }} />
        <Nodes get={() => Z().out?.resid ?? null} count={T * L} place={node} stage="blocks" maxAbs={() => 1} layer="resid" r={Math.min(0.15, 4.2 / L)} />
        <Tiles get={() => Z().out?.heads ?? null} count={L * nh} place={head} size={Math.min(0.17, 4.5 / L)} stage="blocks" maxAbs={1} layer="heads" kind="head" lift={0.45} scanReveal shape="tooth" />
        {/* the block being played, and who the last token listens to inside it */}
        <mesh ref={marker} position={[colX(0), 0.35, (z(0) + z(T - 1)) / 2]} visible={false}>
          <boxGeometry args={[0.06, 0.7, span]} /><meshBasicMaterial color={AMBER.clone().multiplyScalar(1.6)} transparent opacity={0.55} toneMapped={false} />
        </mesh>
        <Arcs stage="blocks" max={T} bend={[0.8, 0.6, 0]} compute={() => {
          const o = Z().out, k = blockAt(), x = colX(k)
          return Array.from({ length: T }, (_, j) => ({ a: V(x, 0.4, z(T - 1)), b: V(x, 0.4, z(j)), w: o.attn[k]?.[j] ?? 0, head: 0 }))
        }} />
        {/* the last token predicts the next word */}
        <Links stage="out" compute={() => { const o = Z().out; return Array.from({ length: 10 }, (_, i) => ({ a: V(colX(L - 1), 0.35, z(T - 1)), b: V(7.6, 0.1, (i - 4.5) * 0.62), v: o.probs[i] ?? 0 })) }} />
      </group>
      {Array.from({ length: MAXT }, (_, t) => (
        <Word key={t} pos={[-9.0, 0.25, z(Math.min(t, T - 1))]} hidden={!active} elRef={(el) => { words.current[t] = el }} />
      ))}
      <Tag pos={[-8.2, 0.2, z(T - 1) + 1.3]} name="Your prompt" sub={`${T} tokens`} grp="tok" />
      <Tag pos={[0, 0.2, zHead - nh * 0.2 - 0.5]} name="Attention heads" sub={`${nh} per block`} grp="heads" />
      <Tag pos={[colX(mid), 0.2, z(T - 1) + 1.3]} name={`${L} blocks`} sub="one sphere per token, per block · arrows pick a block" grp="blocks" onKey={blocksKey} />
      <Chip pos={[0, 1.6, zHead - nh * 0.2 - 1.3]} name="Now playing" hidden={!active} liveRef={(el) => { blockTag.current = el }} />
      <Bars origin={[7.6, 0, 0]} stage="out" />
      <Tag pos={[7.6, 0.2, 3.9]} name="Next word" sub="top 10 guesses" grp="scores" />
    </DefCtx.Provider>
  )
}

const SCENES: Record<NetId, () => ReactElement> = { llm: LlmScene, mlp: MlpScene, cnn: CnnScene, rnn: RnnScene, vit: VitScene, vlm: VlmScene }
function Stage() {
  const net = useZoo((s) => s.net)
  const loaded = useZoo((s) => ['llm', ...Object.keys(s.packs)].join(','))
  const ready = useZoo((s) => !!s.out)
  if (!ready) return null
  return (
    <>
      {(loaded.split(',').filter(Boolean) as NetId[]).map((n) => {
        const S = SCENES[n], def = n === 'llm' ? null : DEFS[n] ?? null
        return <NetCtx.Provider key={n} value={n}><group visible={n === net}>{def && <DefCtx.Provider value={def}><Plates def={def} /></DefCtx.Provider>}{def ? <DefCtx.Provider value={def}><S /></DefCtx.Provider> : <S />}</group></NetCtx.Provider>
      })}
    </>
  )
}

/* ------------------------------------------------------------------------------------------ camera */
const CAM: Record<NetId, [number[], number[]]> = {
  llm: [[-0.6, 15.0, 17.5], [-0.6, 0, 0.2]],
  mlp: [[-1.4, 14.5, 17.5], [-1.4, 0, 0.6]], cnn: [[-0.6, 17.5, 18.5], [-0.6, 0, 0.6]], rnn: [[0, 14.5, 17.0], [0, 0, 0.4]],
  vit: [[-1.2, 16.5, 18.5], [-1.2, 0, 0.6]], vlm: [[-2.0, 15.5, 18.0], [-2.0, 0, 1.2]],
}
const FALLBACK = new THREE.Box3(V(-10, 0, -6), V(9, 1.3, 6))
const TOP_SAFE = 56
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3()

/** The camera. Fits the whole model (or the selection) from its bounding box and the stage's aspect, keeps the
 *  user's orbit angle on a resize, and eases to a selection in about 350 ms (a new click re-aims it at once). */
function Rig() {
  const ctl = useRef<CameraControls>(null!)
  const net = useZoo((s) => s.net)
  const key = useZoo((s) => (s.out ? `${s.net}:${s.out.T ?? ''}x${s.out.L ?? ''}x${s.out.nh ?? ''}` : ''))
  const inspect = useZoo((s) => s.inspect)
  const size = useThree((s) => s.size)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const scene = useThree((s) => s.scene)
  const last = useRef({ w: 0, h: 0, net: '', key: '', ins: null as Inspect, tid: 0 })
  // dimming rule + outline box follow the selection
  useEffect(() => {
    const def = DEFS[net]
    SEL.on = !!inspect && !!def && !!def.boxOf(inspect)
    SEL.lit = inspect && def ? def.litOf(inspect) : () => true
  }, [inspect, net, key])
  useEffect(() => {
    const L = last.current, c = ctl.current
    if (!c) return
    const same = L.net === net && L.key === key, insChanged = L.ins !== inspect
    if (same && !insChanged && Math.abs(size.width - L.w) < 1 && Math.abs(size.height - L.h) < 1) return
    const kind: 'resize' | 'select' | 'net' = !same ? 'net' : insChanged ? 'select' : 'resize'
    L.w = size.width; L.h = size.height; L.net = net; L.key = key; L.ins = inspect
    const id = requestAnimationFrame(() => {
      const def = DEFS[net]
      const whole = def?.bounds ?? FALLBACK
      const sb = inspect && def ? def.boxOf(inspect) : null
      const box = sb ?? whole
      const dir = new THREE.Vector3()
      if (kind === 'net' || !Number.isFinite(c.distance) || c.distance < 1e-3) { const [p0, t0] = CAM[net]; dir.set(p0[0] - t0[0], p0[1] - t0[1], p0[2] - t0[2]) }
      else { c.getPosition(_v1); c.getTarget(_v2); dir.copy(_v1).sub(_v2); if (dir.lengthSq() < 1e-6) dir.set(0, 0.6, 0.8) }
      const f = fitBox(box, dir, camera.fov, size.width, size.height, TOP_SAFE)
      const animate = !reduceMotion && kind !== 'resize'
      window.clearTimeout(L.tid)
      if (kind === 'select') { c.smoothTime = 0.12; L.tid = window.setTimeout(() => { if (ctl.current) ctl.current.smoothTime = 0.7 }, 700) } else c.smoothTime = 0.7
      if (animate) markTween(kind === 'select' ? 450 : 900)
      c.setLookAt(f.pos.x, f.pos.y, f.pos.z, f.target.x, f.target.y, f.target.z, animate)
    })
    return () => cancelAnimationFrame(id)
  }, [net, key, inspect, size.width, size.height, camera])
  useFrame(() => {
    const f = scene.fog as THREE.Fog | null; if (!f || !ctl.current) return
    ctl.current.getTarget(_v2); const d = camera.position.distanceTo(_v2)
    f.near = d * 0.97 + 8; f.far = d * 2.0 + 24
  })
  return <CameraControls ref={ctl} makeDefault smoothTime={0.7} minDistance={2} maxDistance={126} maxPolarAngle={Math.PI * 0.48} />
}

/** Outline of the hovered thing (white) and of the selected thing (amber): a wire box. */
const UNIT = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
function Outlines() {
  const hov = useRef<THREE.LineSegments>(null!), sel = useRef<THREE.LineSegments>(null!)
  const net = useZoo((s) => s.net)
  const inspect = useZoo((s) => s.inspect)
  const key = useZoo((s) => (s.out ? `${s.out.T}x${s.out.L}x${s.out.nh}` : ''))
  const selBox = useMemo(() => (inspect ? DEFS[net]?.boxOf(inspect) ?? null : null), [inspect, net, key])
  const put = (o: THREE.LineSegments, b: THREE.Box3 | null | undefined) => { o.visible = !!b; if (b) { b.getCenter(o.position); b.getSize(o.scale); o.scale.addScalar(0.06) } }
  useFrame(() => { put(hov.current, isInspectOn() ? useUI.getState().hover?.box : null); put(sel.current, selBox) })
  return (
    <>
      <lineSegments ref={hov} geometry={UNIT} visible={false} renderOrder={5}><lineBasicMaterial color="#ffffff" transparent opacity={0.7} depthTest={false} toneMapped={false} /></lineSegments>
      <lineSegments ref={sel} geometry={UNIT} visible={false} renderOrder={5}><lineBasicMaterial color="#ffa94d" depthTest={false} toneMapped={false} /></lineSegments>
    </>
  )
}

function Tip() {
  const h = useUI((s) => s.hover), x = useUI((s) => s.x), y = useUI((s) => s.y), on = useInspectOn()
  if (!h || !on) return null
  return <InspectTip label={h.text} x={Math.max(8, x + 14)} y={Math.max(52, y + 16)} />
}

export function ZooScene() {
  const shown = useStore((s) => !!s.visible.model)
  const st = useStage(shown)
  const net = useZoo((s) => s.net)
  const summary = useZoo((s) => {
    const o = s.out; if (!o) return '3D view is loading.'
    const def = DEFS[s.net]
    let top = ''
    if (o.probs) { const pr: number[] = o.probs, b = pr.indexOf(Math.max(...pr)); top = ` Top guess: ${o.labels?.[b] ?? b}, ${(pr[b] * 100).toFixed(0)} percent.` }
    const sel = s.inspect ? ` Selected: ${(s.inspect.kind === 'block' ? `block ${(s.inspect.layer ?? 0) + 1} ${s.inspect.part ?? ''}` : s.inspect.kind === 'token' ? `token ${(s.inspect.index ?? 0) + 1}` : s.inspect.name ?? s.inspect.kind)}.` : ''
    return `${def?.summary() ?? ''}${top}${sel}`
  })
  useStageKeys(st.wrap, () => { if (!Z().inspect) return false; Z().setInspect(null); return true })
  useEffect(() => { Z().setInspect(null); useUI.setState({ hover: null }); setCursor(false) }, [net])
  return (
    <div ref={st.wrap} data-stage style={{ position: 'absolute', inset: 0, visibility: st.run ? undefined : 'hidden' }}>
      <Canvas frameloop={st.run ? 'always' : 'never'} dpr={st.dpr} resize={{ debounce: { scroll: 0, resize: 100 }, scroll: false }} camera={{ position: [-0.6, 14.5, 17.5], fov: 38 }} gl={{ antialias: false }}
        onPointerMissed={(e) => { if (e.type === 'dblclick') Z().select(null); else if (e.type === 'click') Z().setInspect(null) }}>
        <LiteCtx.Provider value={st.lite}>
          <KitProvider>
            <color attach="background" args={['#060913']} />
            <WheelScrollsPage />
            <fog attach="fog" args={['#060913', 30, 56]} />
            <SlowWatch onSlow={st.onSlow} />
            <ambientLight intensity={0.4} />
            <Environment resolution={64} environmentIntensity={0.5}>
              <Lightformer form="rect" intensity={2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[16, 10, 1]} color="#9fb4ff" />
            </Environment>
            <RoundedBox args={[22, 0.2, 15]} radius={0.15} smoothness={3} position={[0, -0.34, 0.3]}><meshPhysicalMaterial color="#0a1122" metalness={0.4} roughness={0.7} /></RoundedBox>
            <Stage />
            <Outlines />
            <Rig />
            {!st.lite && (
              <EffectComposer multisampling={st.dpr > 1 ? 4 : 0}>
                <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={0.9} radius={0.7} />
                <Vignette eskil={false} offset={0.25} darkness={0.7} />
              </EffectComposer>
            )}
          </KitProvider>
        </LiteCtx.Provider>
      </Canvas>
      <Tip />
      <div className="nssr" role="img" aria-label={summary} />
    </div>
  )
}
