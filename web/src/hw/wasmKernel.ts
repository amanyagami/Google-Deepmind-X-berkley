// A hand-assembled WebAssembly SIMD kernel: C += A x B for n x n float32 matrices (n a multiple of 16).
// Layout in the module's own memory: A at 0, B at n*n*4, C at 2*n*n*4. Loop order i-k-j, and the j loop
// handles 16 floats per turn as four 128-bit vectors: c[i, j..j+15] += splat(a[i,k]) * b[k, j..j+15].
// Written by hand so the browser benchmark needs no toolchain and every instruction is visible here.

const uleb = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b) } while (n); return o }
const sleb = (n: number) => { const o: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) { o.push(b); return o } o.push(b | 0x80) } }
const str = (s: string) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))]
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body]
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()]

// opcodes
const get = (i: number) => [0x20, i], set = (i: number) => [0x21, i]
const i32c = (v: number) => [0x41, ...sleb(v)]
const ADD = 0x6a, MUL = 0x6c, SHL = 0x74, GEU = 0x4f
const BLOCK = [0x02, 0x40], LOOP = [0x03, 0x40], END = 0x0b
const brIf = (d: number) => [0x0d, d], br = (d: number) => [0x0c, d]
const f32load = [0x2a, 2, 0]
const simd = (op: number) => [0xfd, ...uleb(op)]
const vload = (off: number) => [...simd(0x00), 4, ...uleb(off)]
const vstore = (off: number) => [...simd(0x0b), 4, ...uleb(off)]
const SPLAT = simd(0x13), FADD = simd(0xe4), FMUL = simd(0xe6)

// locals: 0 n (param) | 1 i, 2 k, 3 rowBytes, 4 Bbase, 5 Cbase, 6 bRow, 7 cRow, 8 jEnd (i32) | 9 av (v128)
const [N, I, K, RB, BB, CB, BR, CR, JE, AV] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

function body(): number[] {
  const madd = (off: number) => [...get(CR), ...get(CR), ...vload(off), ...get(AV), ...get(BR), ...vload(off), ...FMUL, ...FADD, ...vstore(off)]
  const code = [
    ...get(N), ...i32c(2), SHL, ...set(RB),
    ...get(N), ...get(RB), MUL, ...set(BB),
    ...get(BB), ...i32c(1), SHL, ...set(CB),
    ...i32c(0), ...set(I),
    ...BLOCK, ...LOOP,
    ...get(I), ...get(N), GEU, ...brIf(1),
    ...i32c(0), ...set(K),
    ...BLOCK, ...LOOP,
    ...get(K), ...get(N), GEU, ...brIf(1),
    // av = splat(A[i][k])
    ...get(I), ...get(RB), MUL, ...get(K), ...i32c(2), SHL, ADD, ...f32load, ...SPLAT, ...set(AV),
    ...get(BB), ...get(K), ...get(RB), MUL, ADD, ...set(BR),
    ...get(CB), ...get(I), ...get(RB), MUL, ADD, ...set(CR),
    ...get(CR), ...get(RB), ADD, ...set(JE),
    ...BLOCK, ...LOOP,
    ...get(CR), ...get(JE), GEU, ...brIf(1),
    ...madd(0), ...madd(16), ...madd(32), ...madd(48),
    ...get(CR), ...i32c(64), ADD, ...set(CR),
    ...get(BR), ...i32c(64), ADD, ...set(BR),
    ...br(0), END, END,
    ...get(K), ...i32c(1), ADD, ...set(K),
    ...br(0), END, END,
    ...get(I), ...i32c(1), ADD, ...set(I),
    ...br(0), END, END,
    END,
  ]
  const locals = vec([[...uleb(8), 0x7f], [...uleb(1), 0x7b]])
  const fn = [...locals, ...code]
  return [...uleb(fn.length), ...fn]
}

export const MAX_N = 512
export function kernelBytes(): Uint8Array {
  const pages = Math.ceil((3 * MAX_N * MAX_N * 4) / 65536)
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([[0x60, 1, 0x7f, 0]])),            // type: (i32) -> ()
    ...section(3, vec([[0]])),                           // one function of type 0
    ...section(5, vec([[0x00, ...uleb(pages)]])),        // memory
    ...section(7, vec([[...str('mm'), 0x00, 0], [...str('mem'), 0x02, 0]])),
    ...section(10, vec([body()])),
  ]
  return new Uint8Array(bytes)
}

export interface Kernel { mm: (n: number) => void; f32: Float32Array }
export async function loadKernel(): Promise<Kernel> {
  const mod = await WebAssembly.compile(kernelBytes() as BufferSource)
  const instance = await WebAssembly.instantiate(mod)
  const ex = instance.exports as any
  return { mm: ex.mm, f32: new Float32Array(ex.mem.buffer) }
}
