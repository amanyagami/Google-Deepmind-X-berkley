// Real GPU benchmark through WebGPU: a tiled 1024 x 1024 fp32 matrix multiply (2.1 GFLOP per run).
// PyTorch on this install is a CPU build, so this is how the integrated GPU gets measured at all.

const N = 1024
const WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
const N: u32 = ${N}u;
const TS: u32 = 16u;
var<workgroup> As: array<f32, 256>;
var<workgroup> Bs: array<f32, 256>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  var acc = 0.0;
  for (var t = 0u; t < N / TS; t = t + 1u) {
    As[l.y * TS + l.x] = A[g.y * N + t * TS + l.x];
    Bs[l.y * TS + l.x] = B[(t * TS + l.y) * N + g.x];
    workgroupBarrier();
    for (var k = 0u; k < TS; k = k + 1u) { acc = acc + As[l.y * TS + k] * Bs[k * TS + l.x]; }
    workgroupBarrier();
  }
  C[g.y * N + g.x] = acc;
}`

export interface GpuResult { gflops: number; adapter: string; n: number; unavailable?: false }

export async function gpuBench(onProgress: (v: number, best: number) => void): Promise<GpuResult | { unavailable: true; reason: string }> {
  const gpu = (navigator as any).gpu
  if (!gpu) return { unavailable: true, reason: 'This browser has no WebGPU.' }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { unavailable: true, reason: 'No WebGPU adapter found.' }
    const ai = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
    const name = [ai.vendor, ai.architecture, ai.description].filter(Boolean).join(' ') || 'GPU'
    const device = await adapter.requestDevice()
    const U = (globalThis as any).GPUBufferUsage
    const bytes = N * N * 4
    const mk = (fill: boolean) => {
      const b = device.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC, mappedAtCreation: fill })
      if (fill) { const a = new Float32Array(b.getMappedRange()); for (let i = 0; i < a.length; i++) a[i] = Math.random() - 0.5; b.unmap() }
      return b
    }
    const A = mk(true), B = mk(true), C = mk(false)
    const module = device.createShaderModule({ code: WGSL })
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [A, B, C].map((buffer, i) => ({ binding: i, resource: { buffer } })) })
    const run = async () => {
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(N / 16, N / 16); pass.end()
      const t = performance.now()
      device.queue.submit([enc.finish()])
      await device.queue.onSubmittedWorkDone()
      return (2 * N ** 3) / ((performance.now() - t) / 1000) / 1e9
    }
    await run() // warm-up: shader compile
    let best = 0
    for (let i = 0; i < 12; i++) { const v = await run(); best = Math.max(best, v); onProgress(v, best) }
    device.destroy?.()
    return { gflops: Math.round(best * 10) / 10, adapter: name, n: N }
  } catch (e: any) {
    return { unavailable: true, reason: e?.message ?? String(e) }
  }
}
