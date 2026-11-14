import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { WheelScrollsPage } from '../aspect'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'

const AMBER = new THREE.Color('#ffa94d')
const BLUE = new THREE.Color('#55a8ff')
const INK = new THREE.Color('#9aa5c7')
const WHITE = new THREE.Color('#ffffff')
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

interface Layout {
  L: number; nh: number; sp: number; bw: number; zW: number; attnH: number; mlpH: number; stackH: number; bottom: number
  total: number; ex: number; hx: number; te: number; runnable: boolean; blockH: number[]
  x: (i: number) => number
}

function layout(graph: any): Layout {
  const d = graph.dims || {}
  const L = graph.blocks.length
  const sp = Math.min(0.62, 9.5 / Math.max(1, L))
  const total = (L - 1) * sp
  const runnable = graph.runnable
  const nh = d.nh || 1
  const ratio = runnable ? d.I / d.H : 3
  const attnH = 1.0, gap = 0.12
  const mlpH = Math.min(3.4, 0.4 * ratio)
  const stackH = runnable ? attnH + gap + mlpH : 2.4
  const maxP = Math.max(1, ...graph.blocks.map((b: any) => b.params))
  const blockH = graph.blocks.map((b: any) => 0.8 + 2.4 * Math.sqrt(b.params / maxP))
  const V = d.V || 50000
  const te = 0.25 + (0.9 * V) / 160000
  return {
    L, nh, sp, bw: sp * 0.5, zW: 1.5, attnH, mlpH, stackH, bottom: -stackH / 2, total, te, runnable, blockH,
    ex: -total / 2 - 0.9 - te / 2, hx: total / 2 + 0.9 + te / 2, x: (i) => -total / 2 + i * sp,
  }
}

function Box({ w, h, d, pos, fill, edge, onClick, onOver, onOut }: any) {
  const geo = useMemo(() => new THREE.BoxGeometry(w, h, d), [w, h, d])
  return (
    <group position={pos}>
      <mesh geometry={geo} onClick={onClick} onPointerOver={onOver} onPointerOut={onOut}>
        <meshBasicMaterial ref={fill} transparent depthWrite={false} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[geo]} />
        <lineBasicMaterial ref={edge} transparent />
      </lineSegments>
    </group>
  )
}

function Slab({ x, lay, kind }: { x: number; lay: Layout; kind: 'embed' | 'head' }) {
  const fill = useRef<THREE.MeshBasicMaterial>(null!)
  const edge = useRef<THREE.LineBasicMaterial>(null!)
  const g = useRef(0)
  useFrame((_, dt) => {
    const s = useStore.getState()
    const target = kind === 'embed' ? (s.embed ? 0.6 : 0.1) : s.final && s.revealed >= lay.L ? 0.5 + 0.5 * (s.final.topk?.[0]?.p ?? 0) : 0.1
    g.current += (target - g.current) * Math.min(1, dt * 6)
    fill.current.color.copy(INK).lerp(AMBER, g.current); fill.current.opacity = 0.05 + 0.4 * g.current
    edge.current.color.copy(INK).lerp(AMBER, g.current); edge.current.opacity = 0.35 + 0.65 * g.current
  })
  const h = Math.max(1.7, lay.stackH * 0.8)
  return <Box w={lay.te} h={h} d={lay.zW} pos={[x, 0, 0]} fill={fill} edge={edge}
    onOver={(e: any) => { e.stopPropagation(); useStore.getState().setHover(kind === 'embed' ? 'embed_tokens · token embeddings' : 'lm_head · logits over the vocabulary') }}
    onOut={() => useStore.getState().setHover(null)} />
}

function BlockMesh({ i, lay }: { i: number; lay: Layout }) {
  const aFill = useRef<THREE.MeshBasicMaterial>(null!)
  const aEdge = useRef<THREE.LineBasicMaterial>(null!)
  const mFill = useRef<THREE.MeshBasicMaterial>(null!)
  const mEdge = useRef<THREE.LineBasicMaterial>(null!)
  const hMats = useRef<(THREE.MeshBasicMaterial | null)[]>([])
  const glow = useRef({ a: 0, m: 0, h: [] as number[] })
  const selEdge = useRef<THREE.LineBasicMaterial>(null!)
  const tmp = useMemo(() => new THREE.Color(), [])
  const { runnable, nh, attnH, mlpH, zW, bw, bottom } = lay
  const x = lay.x(i)
  const plateH = lay.blockH[i]

  useFrame((_, dt) => {
    const s = useStore.getState()
    const f = s.layers[i]
    const lit = !!f && i < s.revealed
    const k = Math.min(1, dt * 8)
    const norm = (v: number, m: number) => (lit ? Math.pow(Math.min(1, Math.abs(v) / (m || 1)), 0.6) : 0)
    const ga = f ? norm(f.attn_norm.at(-1), s.maxes.attn) : 0
    const gm = f ? norm(f.mlp_norm.at(-1), s.maxes.mlp) : 0
    const G = glow.current
    G.a += ((lit ? ga : 0) - G.a) * k
    G.m += ((lit ? gm : 0) - G.m) * k
    const sign = f && f.resid_mean < 0 ? BLUE : AMBER
    const msign = f && f.mlp.mean < 0 ? BLUE : AMBER
    const sel = s.selLayer === i
    const lerpMat = (fill: THREE.MeshBasicMaterial, edge: THREE.LineBasicMaterial, g: number, c: THREE.Color) => {
      tmp.copy(INK).lerp(c, g)
      fill.color.copy(tmp); fill.opacity = 0.05 + 0.5 * g + (sel ? 0.1 : 0)
      edge.color.copy(sel ? tmp.lerp(WHITE, 0.55) : tmp); edge.opacity = 0.32 + 0.68 * g + (sel ? 0.3 : 0)
    }
    if (runnable) {
      lerpMat(aFill.current, aEdge.current, G.a, sign)
      lerpMat(mFill.current, mEdge.current, G.m, msign)
      for (let h = 0; h < nh; h++) {
        const m = hMats.current[h]
        if (!m) continue
        const imp = s.showImportance && s.scan ? Math.max(0, s.scan.heads[i]?.[h] ?? 0) / (s.scanMax || 1) : -1
        const target = imp >= 0 ? Math.pow(imp, 0.6) : lit && f ? Math.pow(Math.min(1, (f.head_norm[h] ?? 0) / (s.maxes.head || 1)), 0.7) : 0
        G.h[h] = (G.h[h] ?? 0) + (target - (G.h[h] ?? 0)) * k
        m.color.copy(INK).lerp(imp >= 0 ? AMBER : sign, G.h[h])
        m.opacity = 0.12 + 0.88 * G.h[h] + (sel && s.selHead === h ? 0.0 : 0)
        const sc = sel && s.selHead === h ? 1.35 : 1
        m.userData.mesh && m.userData.mesh.scale.setScalar(sc)
      }
    } else {
      lerpMat(aFill.current, aEdge.current, G.a, sign)
    }
  })

  const hover = (txt: string) => ({
    onOver: (e: any) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; useStore.getState().setHover(txt) },
    onOut: () => { document.body.style.cursor = ''; useStore.getState().setHover(null) },
    onClick: (e: any) => { e.stopPropagation(); useStore.getState().selectLayer(i) },
  })

  if (!runnable) {
    return <Box w={lay.bw} h={plateH} d={zW} pos={[x, 0, 0]} fill={aFill} edge={aEdge} {...hover(`block ${i} · ${(lay.blockH[i]).toFixed(1)} · generic layer`)} />
  }
  const attnY = bottom + attnH / 2
  const mlpY = bottom + attnH + 0.12 + mlpH / 2
  const dz = zW / nh
  return (
    <group>
      <Box w={bw} h={attnH} d={zW} pos={[x, attnY, 0]} fill={aFill} edge={aEdge} {...hover(`block ${i + 1} · attention · ${nh} heads`)} />
      <Box w={bw} h={mlpH} d={zW} pos={[x, mlpY, 0]} fill={mFill} edge={mEdge} {...hover(`block ${i + 1} · MLP`)} />
      {Array.from({ length: nh }).map((_, h) => (
        <mesh key={h} position={[x, bottom + attnH + 0.07, -zW / 2 + dz * (h + 0.5)]}
          ref={(m) => { if (m) { (m.material as any).userData = { mesh: m }; hMats.current[h] = m.material as THREE.MeshBasicMaterial } }}
          onClick={(e) => { e.stopPropagation(); useStore.getState().selectLayer(i); useStore.getState().selectHead(h) }}
          onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; useStore.getState().setHover(`block ${i + 1} · head ${h}`) }}
          onPointerOut={() => { document.body.style.cursor = ''; useStore.getState().setHover(null) }}>
          <boxGeometry args={[bw * 0.8, 0.14, dz * 0.62]} />
          <meshBasicMaterial transparent />
        </mesh>
      ))}
    </group>
  )
}

function Tokens({ lay }: { lay: Layout }) {
  const n = useStore((s) => s.tokens.length)
  const refs = useRef<(THREE.Mesh | null)[]>([])
  const x = useRef(lay.ex)
  const tmp = useMemo(() => new THREE.Color(), [])
  useFrame((st, dt) => {
    const s = useStore.getState()
    const fi = Math.min(s.revealed, lay.L)
    const tx = s.layers.length === 0 && s.revealed === 0 ? lay.ex : fi >= lay.L ? lay.hx : fi <= 0 ? lay.ex + 0.4 : lay.x(fi - 1)
    x.current += (tx - x.current) * Math.min(1, dt * 7)
    const f = s.layers[Math.max(0, fi - 1)]
    const lane = Math.min(0.17, (lay.zW * 0.8) / Math.max(1, n))
    refs.current.forEach((m, j) => {
      if (!m) return
      const nrm = f ? Math.abs(f.resid_norm[j] ?? 0) : 0
      const sc = 0.05 + 0.09 * Math.pow(Math.min(1, nrm / Math.max(1e-6, Math.max(...(f?.resid_norm ?? [1]).map(Math.abs)))), 0.5)
      m.position.set(x.current, Math.sin(st.clock.elapsedTime * 2 + j) * 0.04, (j - (n - 1) / 2) * lane)
      m.scale.setScalar(reduceMotion ? 0.12 : sc * 8)
      tmp.copy(f && f.resid_mean < 0 ? BLUE : AMBER)
      ;(m.material as THREE.MeshBasicMaterial).color.copy(tmp)
    })
  })
  return <>{Array.from({ length: n }).map((_, j) => (
    <mesh key={j} ref={(m) => { refs.current[j] = m }}>
      <sphereGeometry args={[0.1, 12, 12]} /><meshBasicMaterial />
    </mesh>
  ))}</>
}

function Thread({ lay }: { lay: Layout }) {
  const geo = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(lay.ex, 0, 0), new THREE.Vector3(lay.hx, 0, 0)]), [lay])
  return <line><primitive object={geo} attach="geometry" /><lineBasicMaterial color="#9aa5c7" transparent opacity={0.45} /></line>
}

/** Other stacks of a multi-part model (a VLM's vision tower, an audio encoder) as rows behind the language model,
 *  joined to it by the connector. Label slots are always mounted and only hidden (React 19 + drei Html). */
const SLOTS = 3
function ExtraStacks({ graph, lay }: { graph: any; lay: Layout }) {
  const extra: any[] = (graph.stacks ?? []).slice(1, 1 + SLOTS)
  const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} B` : `${(n / 1e6).toFixed(1)} M`)
  return (
    <>
      {extra.map((st, k) => {
        const z = -(k + 1) * 3.0, n = st.count, sp = Math.min(0.62, 9.5 / Math.max(1, n)), total = (n - 1) * sp
        const maxP = Math.max(1, ...st.block_params)
        const col = st.role === 'vision' ? BLUE : st.role === 'audio' ? WHITE : AMBER
        return (
          <group key={st.prefix} position={[0, 0, z]}>
            {st.block_params.map((p: number, i: number) => {
              const h = 0.8 + 2.4 * Math.sqrt(p / maxP)
              return (
                <group key={i} position={[-total / 2 + i * sp, 0, 0]}>
                  <mesh><boxGeometry args={[sp * 0.5, h, 1.2]} /><meshBasicMaterial color={col} transparent opacity={0.16} depthWrite={false} /></mesh>
                  <lineSegments><edgesGeometry args={[new THREE.BoxGeometry(sp * 0.5, h, 1.2)]} /><lineBasicMaterial color={col} transparent opacity={0.7} /></lineSegments>
                </group>
              )
            })}
          </group>
        )
      })}
      {extra.length > 0 && graph.connector && (
        <group position={[lay.ex, 0, -1.5]}>
          <mesh><boxGeometry args={[0.5, 0.6, 1.2]} /><meshBasicMaterial color={AMBER} transparent opacity={0.35} depthWrite={false} /></mesh>
          <lineSegments><edgesGeometry args={[new THREE.BoxGeometry(0.5, 0.6, 1.2)]} /><lineBasicMaterial color={AMBER} /></lineSegments>
        </group>
      )}
      {Array.from({ length: SLOTS }, (_, k) => {
        const st = extra[k]
        const n = st?.count ?? 1, sp = Math.min(0.62, 9.5 / Math.max(1, n)), total = (n - 1) * sp
        return (
          <Html key={k} position={[total / 2 + 0.8, 1.9, -(k + 1) * 3.0]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
            <div className="mlabel" style={{ display: st ? undefined : 'none' }}><b>{st ? `${st.role[0].toUpperCase()}${st.role.slice(1)} stack` : ''}</b><span>{st ? `${st.prefix} · ${st.count} blocks · ${fmt(st.params)}` : ''}</span></div>
          </Html>
        )
      })}
      <Html position={[lay.ex, 0.9, -1.5]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
        <div className="mlabel" style={{ display: extra.length > 0 && graph.connector ? undefined : 'none' }}><b>Connector</b><span>{graph.connector ? `${fmt(graph.connector.params)} · image features → text width` : ''}</span></div>
      </Html>
      <Html position={[-lay.total / 2 - 0.6, 2.2, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
        <div className="mlabel" style={{ display: extra.length > 0 ? undefined : 'none' }}><b>Language stack</b><span>{graph.stacks?.[0] ? `${graph.stacks[0].prefix} · ${graph.stacks[0].count} blocks` : ''}</span></div>
      </Html>
    </>
  )
}

function Fit({ lay, depth = 0 }: { lay: Layout; depth?: number }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height)
    const th = Math.tan((38 / 2) * Math.PI / 180)
    const dh = ((lay.total / 2 + 2.4) * 0.95) / (th * aspect)
    const dv = (lay.stackH / 2 + 1.4) / th
    const d = Math.max(dh, dv, 9) * (1.08 + 0.12 * depth)
    camera.position.set(d * 0.52, d * 0.3, d * 0.8)
    camera.lookAt(0, 0, 0)
  }, [lay, depth, size.width, size.height, camera])
  return null
}

function Stack({ graph }: { graph: any }) {
  const lay = useMemo(() => layout(graph), [graph])
  if (!lay.L) return null
  return (
    <>
      <Fit lay={lay} depth={Math.min(SLOTS, Math.max(0, (graph.stacks?.length ?? 1) - 1))} />
      <ExtraStacks graph={graph} lay={lay} />
      <Slab x={lay.ex} lay={lay} kind="embed" />
      {Array.from({ length: lay.L }).map((_, i) => <BlockMesh key={i} i={i} lay={lay} />)}
      <Slab x={lay.hx} lay={lay} kind="head" />
      <Thread lay={lay} />
      <Tokens lay={lay} />
    </>
  )
}

export function ModelScene() {
  // keep drawing the last graph while the next model loads: the canvas never unmounts (React 19 + drei Html)
  const current = useStore((s) => s.probe?.graph)
  const keep = useRef<any>(current)
  if (current) keep.current = current
  const graph = keep.current
  const hover = useStore((s) => s.hover)
  const running = useStore((s) => s.running)
  const revealed = useStore((s) => s.revealed)
  const shown = useStore((s) => !!s.visible.model)
  const L = graph?.blocks.length ?? 0
  const [auto, setAuto] = useState(!reduceMotion)
  return (
    <div className="scene">
      {graph && (
        <Canvas frameloop={shown ? 'always' : 'never'} dpr={[1, 2]} camera={{ fov: 38, position: [8, 4, 13] }} gl={{ antialias: true, alpha: true }}>
          <WheelScrollsPage />
          <Stack graph={graph} />
          <OrbitControls enablePan={false} enableDamping autoRotate={auto && !running} autoRotateSpeed={0.5} minDistance={5} maxDistance={40} onStart={() => setAuto(false)} />
        </Canvas>
      )}
      <div className="hud">
        <i className={running ? 'live' : ''} />
        <span>{hover ?? (running ? `signal at block ${Math.min(revealed, L)} / ${L}` : 'drag to rotate · Ctrl + scroll to zoom · click a plate or head')}</span>
      </div>
      <div className="legend3d">
        <span><b style={{ background: 'var(--pos)' }} />positive</span><span><b style={{ background: 'var(--neg)' }} />negative</span><span>brighter = larger</span>
      </div>
    </div>
  )
}
