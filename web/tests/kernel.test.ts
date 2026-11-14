// The hand-assembled WebAssembly SIMD matrix multiply must agree with a plain JavaScript reference.
import { expect, test } from 'vitest'
import { loadKernel, MAX_N } from '../src/hw/wasmKernel'

test('wasm kernel computes C += A x B exactly enough, for every supported size', async () => {
  const k = await loadKernel()
  for (const n of [16, 64, 128, MAX_N]) {
    const A = k.f32.subarray(0, n * n), B = k.f32.subarray(n * n, 2 * n * n), C = k.f32.subarray(2 * n * n, 3 * n * n)
    for (let i = 0; i < n * n; i++) { A[i] = Math.sin(i) * 0.5; B[i] = Math.cos(i * 0.7) * 0.5 }
    C.fill(1) // the kernel accumulates, so C starts at 1
    k.mm(n)
    let worst = 0
    for (let i = 0; i < n; i += 5) for (let j = 0; j < n; j += 3) {
      let s = 1; for (let q = 0; q < n; q++) s += A[i * n + q] * B[q * n + j]
      worst = Math.max(worst, Math.abs(s - C[i * n + j]))
    }
    expect(worst).toBeLessThan(1e-4 * Math.sqrt(n))
  }
})
