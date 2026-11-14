// Shared plumbing for the two 3D stages (the model zoo and the machine), owned by stream S8.
// Label chips that stay inside the stage and never overlap, one resize path, a DPR that backs off when frames are slow,
// scenes that pause when hidden, a camera fit from a bounding box, and a lite mode from the capability probe.
// Rule that shapes this file: drei <Html> content is rendered in its own React root, so hooks that need context are
// called OUTSIDE the <Html> and the results passed in; and labels are never unmounted, only hidden.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

/* ------------------------------------------------------------------------------------------ css */
const CSS = `
.nsc{position:relative;pointer-events:auto;display:flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;background:none;border:0;padding:0;margin:0;font:inherit;color:var(--fg,#e8ecf8);cursor:pointer;touch-action:manipulation}
.nsc.ns-static{pointer-events:none;min-height:0;min-width:0;cursor:default}
.nsc .box{position:relative;display:flex;flex-direction:column;align-items:center;gap:1px;background:rgba(6,9,19,.78);border:1px solid var(--line,#27314f);border-radius:9px;padding:3px 9px;white-space:nowrap;backdrop-filter:blur(4px);font:500 11.5px/1.25 var(--body,system-ui,sans-serif);text-align:center}
.nsc b{font-weight:600;font-size:12px;display:block}
.nsc .g{opacity:.85;margin-right:4px}
.nsc .sub{display:none;color:var(--muted,#9aa5c7);font-size:11.5px}
.nsc:hover .sub,.nsc:focus-visible .sub,.nsc.on .sub{display:block}
.nsc .lv{display:block;font:600 11.5px var(--mono,ui-monospace,monospace);font-style:normal;color:var(--ok,#4ed8a0)}
.nsc .lv .livedot{width:5px;height:5px;margin:0 5px 0 0;vertical-align:1px;box-shadow:none}
.nsc .sc{display:block;font:600 11.5px var(--mono,ui-monospace,monospace);font-style:normal;color:var(--pos,#ffa94d)}
.nsc:hover .box,.nsc.on .box,.nsc.hov .box{border-color:var(--pos,#ffa94d)}
.nsc:focus-visible{outline:none}
.nsc:focus-visible .box{outline:2px solid var(--fg,#e8ecf8);outline-offset:1px}
.nsc .lead{position:absolute;left:50%;top:50%;height:0;border-top:1px dashed rgba(154,165,199,.7);transform-origin:0 0;pointer-events:none;display:none;z-index:-1}
.nsc .lead::after{content:"";position:absolute;right:-2px;top:-3px;width:5px;height:5px;border-radius:50%;background:#9aa5c7}
.nsw{font:500 11.5px var(--mono,ui-monospace,monospace);color:var(--fg,#e8ecf8);background:rgba(6,9,19,.82);border-radius:6px;padding:0 5px;white-space:nowrap;pointer-events:none}
.nstip{position:absolute;left:0;top:0;z-index:6;pointer-events:none;background:rgba(6,9,19,.92);border:1px solid var(--line,#27314f);border-radius:8px;padding:4px 9px;font:500 11.5px var(--body,system-ui,sans-serif);color:var(--fg,#e8ecf8);white-space:nowrap;display:none}
.nssr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`
if (typeof document !== 'undefined' && !document.getElementById('ns-stage-css')) {
  const s = document.createElement('style'); s.id = 'ns-stage-css'; s.textContent = CSS; document.head.appendChild(s)
}

export const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* ------------------------------------------------------------------------------------- lite mode */
let liteP: Promise<boolean> | null = null
/** True on a weak device: the capability probe says 'lite' (or ?lite=1 for testing). Resolved once, never throws. */
export function getLite(): Promise<boolean> {
  return (liteP ??= (async () => {
    try { if (/[?&]lite=1/.test(location.search)) return true } catch { /* ignore */ }
    try { const m: any = await import('./hw/browserBench'); return (await m.probe()).profile === 'lite' } catch { return false }
  })())
}
export const LiteCtx = createContext(false)

/* ------------------------------------------------------------------------------ stage environment */
function useMq(q: string) {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches)
  useEffect(() => { const mq = matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); f(); return () => mq.removeEventListener('change', f) }, [q])
  return m
}
/** Everything a stage needs around its canvas: a ref for the wrapper, whether to draw, the DPR, lite mode. */
export function useStage(shown = true) {
  const wrap = useRef<HTMLDivElement>(null)
  const [vis, setVis] = useState(typeof document === 'undefined' || !document.hidden)
  const [onScreen, setOn] = useState(true)
  const [lite, setLite] = useState(false)
  const [slow, setSlow] = useState(false)
  const phone = useMq('(max-width: 600px), (pointer: coarse) and (max-width: 900px)')
  useEffect(() => { let ok = true; getLite().then((l) => { if (ok) setLite(l) }); return () => { ok = false } }, [])
  useEffect(() => { const f = () => setVis(!document.hidden); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f) }, [])
  useEffect(() => {
    const el = wrap.current; if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((e) => { for (const x of e) setOn(x.isIntersecting) }); io.observe(el)
    return () => io.disconnect()
  }, [])
  const dpr = slow || lite ? 1 : Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, phone ? 1.5 : 2)
  const onSlow = useCallback(() => setSlow(true), [])
  return { wrap, run: shown && vis && onScreen, dpr, lite, onSlow }
}

/** Counts frames slower than 24 ms; after 30 in a row it asks for DPR 1. Ignores the first second and tab switches. */
export function SlowWatch({ onSlow }: { onSlow: () => void }) {
  const n = useRef(0), age = useRef(0)
  useFrame((_, dt) => {
    age.current += dt
    if (age.current < 1 || dt > 0.5) { n.current = 0; return }
    n.current = dt > 0.024 ? n.current + 1 : 0
    if (n.current >= 30) { n.current = 0; onSlow() }
  })
  return null
}

/** Esc (or any callback) only while the pointer or focus is inside the stage, so it never fights the page's own Esc. */
export function useStageKeys(wrap: React.RefObject<HTMLElement | null>, onEsc: () => boolean) {
  const cb = useRef(onEsc); cb.current = onEsc
  useEffect(() => {
    const el = wrap.current; if (!el) return
    let inside = false
    const enter = () => { inside = true }, leave = () => { inside = el.contains(document.activeElement) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && inside && cb.current()) e.preventDefault() }
    el.addEventListener('pointerenter', enter); el.addEventListener('pointerleave', leave); el.addEventListener('focusin', enter); el.addEventListener('focusout', leave)
    document.addEventListener('keydown', key)
    return () => { el.removeEventListener('pointerenter', enter); el.removeEventListener('pointerleave', leave); el.removeEventListener('focusin', enter); el.removeEventListener('focusout', leave); document.removeEventListener('keydown', key) }
  }, [wrap])
}

/* -------------------------------------------------------------------------------------- camera fit */
const _cam = new THREE.PerspectiveCamera(), _c = new THREE.Vector3(), _corner = new THREE.Vector3()
/** Where to put the camera so the whole box is in view: keeps the viewing direction `dir`, looks at the box centre, finds
 *  the smallest distance that keeps every corner inside the frame (with a margin, and `topPx` kept free for the stage's
 *  own controls). Works for any aspect, so a resize only has to call it again. */
export function fitBox(box: THREE.Box3, dir: THREE.Vector3, fov: number, W: number, H: number, topPx = 56, marginPx = 14) {
  const target = box.getCenter(new THREE.Vector3())
  const d0 = dir.clone().normalize()
  _cam.fov = fov; _cam.aspect = W / Math.max(1, H); _cam.near = 0.1; _cam.far = 1000; _cam.updateProjectionMatrix()
  const mx = 1 - (2 * marginPx) / Math.max(1, W), my = -1 + (2 * marginPx) / Math.max(1, H), ty = 1 - (2 * topPx) / Math.max(1, H)
  const ok = (d: number) => {
    _cam.position.copy(target).addScaledVector(d0, d); _cam.lookAt(target); _cam.updateMatrixWorld(true)
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      _c.copy(_corner).project(_cam)
      if (_c.z > 1 || Math.abs(_c.x) > mx || _c.y > ty || _c.y < my) return false
    }
    return true
  }
  let lo = 1, hi = 400
  if (!ok(hi)) return { target, dist: hi, pos: target.clone().addScaledVector(d0, hi) }
  for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m }
  return { target, dist: hi, pos: target.clone().addScaledVector(d0, hi) }
}

/* -------------------------------------------------------------------------- label layout (the chips) */
interface Item { el: HTMLElement; kind: 'chip' | 'word'; dx: number; dy: number; show: boolean; lead: string }
type Reg = Map<HTMLElement, Item>
const KitCtx = createContext<Reg | null>(null)

function layout(reg: Reg, cv: HTMLElement, top: number) {
  const cr = cv.getBoundingClientRect(), W = cr.width, H = cr.height
  if (W < 10 || H < 10) return
  type B = { it: Item; ax: number; ay: number; w: number; h: number; p: number; x: number; y: number }
  const chips: B[] = [], words: B[] = []
  for (const it of reg.values()) {
    const r = it.el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const b: B = { it, ax: r.left + r.width / 2 - it.dx - cr.left, ay: r.top + r.height / 2 - it.dy - cr.top, w: Math.max(r.width, it.kind === 'chip' ? 40 : 0), h: Math.max(r.height, it.kind === 'chip' ? 40 : 0), p: +(it.el.dataset.prio ?? 1) * (it.kind === 'word' ? parseFloat(it.el.style.opacity || '1') : 1), x: 0, y: 0 }
    ;(it.kind === 'chip' ? chips : words).push(b)
  }
  const placed: B[] = []
  const hit = (b: B) => placed.some((p) => Math.abs(b.x - p.x) < (b.w + p.w) / 2 + 3 && Math.abs(b.y - p.y) < (b.h + p.h) / 2 + 2)
  const clampX = (b: B, x: number) => (W - 16 < b.w ? W / 2 : Math.min(W - 8 - b.w / 2, Math.max(8 + b.w / 2, x)))
  const clampY = (b: B, y: number) => (H - top - 8 < b.h ? (H + top) / 2 : Math.min(H - 8 - b.h / 2, Math.max(top + b.h / 2, y)))
  chips.sort((a, b) => b.p - a.p || a.ax - b.ax)
  for (const b of chips) {
    const offs: [number, number][] = [[0, 0], [0, -b.h], [0, b.h], [-b.w, 0], [b.w, 0], [-b.w, -b.h], [b.w, -b.h], [-b.w, b.h], [b.w, b.h], [0, -2 * b.h], [0, 2 * b.h], [-b.w * 1.6, 0], [b.w * 1.6, 0]]
    let done = false
    for (const [ox, oy] of offs) { b.x = clampX(b, b.ax + ox); b.y = clampY(b, b.ay + oy); if (!hit(b)) { done = true; break } }
    if (!done) { b.x = clampX(b, b.ax); b.y = clampY(b, b.ay) }
    placed.push(b)
  }
  for (const b of words) {
    b.x = b.ax; b.y = b.ay
    const inside = b.x - b.w / 2 >= 2 && b.x + b.w / 2 <= W - 2 && b.y - b.h / 2 >= 2 && b.y + b.h / 2 <= H - 2
    b.it.show = inside && !hit(b)
  }
  words.sort((a, b) => b.p - a.p)
  placed.length = chips.length
  for (const b of words) {
    const inside = b.ax - b.w / 2 >= 2 && b.ax + b.w / 2 <= W - 2 && b.ay - b.h / 2 >= 2 && b.ay + b.h / 2 <= H - 2
    b.x = b.ax; b.y = b.ay
    b.it.show = inside && !hit(b)
    if (b.it.show) placed.push(b)
  }
  // writes
  for (const b of chips) {
    const dx = Math.round(b.x - b.ax), dy = Math.round(b.y - b.ay), it = b.it
    if (dx !== it.dx || dy !== it.dy) { it.dx = dx; it.dy = dy; it.el.style.transform = dx || dy ? `translate(${dx}px,${dy}px)` : '' }
    const far = Math.hypot(dx, dy) > 26
    const lead = far ? `${Math.hypot(dx, dy).toFixed(0)}|${(Math.atan2(-dy, -dx) * 180 / Math.PI).toFixed(1)}` : ''
    if (lead !== it.lead) {
      it.lead = lead
      const ld = it.el.querySelector('.lead') as HTMLElement | null
      if (ld) { if (far) { ld.style.display = 'block'; ld.style.width = `${Math.hypot(dx, dy)}px`; ld.style.transform = `rotate(${(Math.atan2(-dy, -dx) * 180 / Math.PI).toFixed(1)}deg)` } else ld.style.display = 'none' }
    }
  }
  for (const b of words) { const v = b.it.show ? 'visible' : 'hidden'; if (b.it.el.style.visibility !== v) b.it.el.style.visibility = v }
}

/** Wrap everything inside the <Canvas> in this. It runs the chip layout ~30 times a second. */
export function KitProvider({ children, top = 48 }: { children: ReactNode; top?: number }) {
  const reg = useRef<Reg>(new Map()).current
  const gl = useThree((s) => s.gl)
  const n = useRef(0)
  useFrame(() => { if (n.current++ & 1) return; layout(reg, gl.domElement, top) })
  return <KitCtx.Provider value={reg}>{children}</KitCtx.Provider>
}

export interface ChipProps {
  pos: [number, number, number]; name: string; glyph?: string; sub?: string
  live?: ReactNode; liveRef?: (el: HTMLElement | null) => void; score?: string
  hidden?: boolean; selected?: boolean; hovered?: boolean; prio?: number; label?: string
  onClick?: () => void; onHover?: (on: boolean) => void; onKey?: (e: React.KeyboardEvent) => void
}
/** A label: name + live value/score; the sub-line only on hover, focus or selection. Always mounted; `hidden` hides it. */
export function Chip(p: ChipProps) {
  const reg = useContext(KitCtx)
  const setRef = useCallback((el: HTMLElement | null) => {
    if (!el || !reg) return
    reg.set(el, { el, kind: 'chip', dx: 0, dy: 0, show: true, lead: '' })
    return () => { reg.delete(el) }
  }, [reg])
  const cls = `nsc${p.onClick ? '' : ' ns-static'}${p.selected ? ' on' : ''}${p.hovered ? ' hov' : ''}`
  const inner = (
    <>
      <i className="lead" aria-hidden />
      <span className="box">
        <b>{p.glyph && <span className="g" aria-hidden>{p.glyph}</span>}{p.name}</b>
        {(p.live || p.liveRef) && <i className="lv" ref={p.liveRef as any}>{p.live}</i>}
        {p.score && <i className="sc">{p.score}</i>}
        {p.sub && <span className="sub">{p.sub}</span>}
      </span>
    </>
  )
  const style = { display: p.hidden ? 'none' : undefined } as const
  return (
    <Html position={p.pos} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      {p.onClick
        ? <button type="button" ref={setRef} className={cls} style={style} data-prio={p.prio ?? 1} aria-label={p.label ?? [p.name, p.score, p.sub].filter(Boolean).join(', ')} aria-pressed={p.selected ? true : undefined}
            onClick={p.onClick} onKeyDown={p.onKey} onPointerEnter={() => p.onHover?.(true)} onPointerLeave={() => p.onHover?.(false)} onFocus={() => p.onHover?.(true)} onBlur={() => p.onHover?.(false)}>{inner}</button>
        : <div ref={setRef} className={cls} style={style} data-prio={p.prio ?? 1}>{inner}</div>}
    </Html>
  )
}

/** A small value label (a token, a score, a core's watts). Hidden by the layout when it would collide or leave the stage.
 *  Use `ref` to write its text each frame; it stays mounted. */
export function Word({ pos, elRef, hidden, prio = 1, children }: { pos: [number, number, number]; elRef?: (el: HTMLDivElement | null) => void; hidden?: boolean; prio?: number; children?: ReactNode }) {
  const reg = useContext(KitCtx)
  const er = useRef(elRef); er.current = elRef
  const setRef = useCallback((el: HTMLDivElement | null) => {
    er.current?.(el)
    if (!el || !reg) return
    reg.set(el, { el, kind: 'word', dx: 0, dy: 0, show: true, lead: '' })
    return () => { reg.delete(el); er.current?.(null) }
  }, [reg])
  return (
    <Html position={pos} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
      <div ref={setRef} className="nsw" data-prio={prio} style={{ display: hidden ? 'none' : undefined }}>{children}</div>
    </Html>
  )
}
