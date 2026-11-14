# Neural Studio: status and pending work

Legend: `[x]` done and checked on the test PC, `[ ]` pending. "Checked" means a unit test, script or browser test
ran it against the real Hub, a real model and the real machine (see `web/tests/e2e/README.md`).

## Done (checked)
- [x] Header-only probe of any Hub repo (config + safetensors header by HTTP Range, zero weights). Pickle refused. Repo ids validated.
- [x] Typed graph for Llama-family and GPT-2; **one stack per tower** for multi-part models (SmolVLM-256M: text 30 blocks, vision 12, connector 7.1 M).
- [x] Live forward pass with hooks, attention rebuilt from q and k (max error 0), edits, A/B compare, head scan. SmolLM2, GPT-2, Qwen2.5.
- [x] Machine view: discovery (incl. PCIe Gen/lanes), 10 Hz telemetry, benchmarks with spread over repeat runs, device score with per-component sub-scores.
- [x] Journey of a prompt, timed per operation, scrub/rewind, dives down to one dot product. **Checked on SmolLM2, GPT-2 and Qwen2.5** (dot products match the model to 3e-8 and 7e-9).
- [x] **Live electricity**: the 3D view is live before, during and after the test (sensors at 10 Hz; SSD and network from OS counters); its own cost is measured each run (+3.5 W here). Live / Replay switch after a test.
- [x] **Electricity**: RAPL package and per-core power during every test (incl. the browser's WebGPU test), 3D replay on demand, energy per test, work per joule, per-core energy, efficiency sub-scores, thermal-throttle flag.
- [x] **Web app**: static build that runs from any host; finds the companion on 127.0.0.1 when present; otherwise measures from the browser (hand-written WASM SIMD matmul, Web Workers, OPFS, WebGPU, network) and runs SmolLM2 in the page (WebGPU or WASM).
- [x] WebGPU benchmark verified on the real Radeon 780M (290–398 GFLOP/s).
- [x] The model on the integrated GPU: in the web app, SmolLM2 runs on the Radeon through WebGPU (75–86 tokens/s).
- [x] Replay mode for the Machine view without a companion: recorded journey and a recorded measured (RAPL) run, labelled as the test PC.
- [x] Network zoo: MLP, CNN, RNN (GRU), ViT and a toy VLM, trained here, computed in the browser and matched to PyTorch by tests.
- [x] SMT threads drawn (a live load bar each); cache lines and the KV cache in the dives.
- [x] Other layouts: 16 cores / 4 DIMMs render (simulated hardware info); phone width without overflow; cameras and fog adapt to the screen shape.
- [x] Automated tests: 17 web unit tests (vitest), 7 Python tests (pytest), 9 browser end-to-end scripts (`live.mjs` checks the 3D is drawing in every stage).
- [x] Code-split bundle (first page ~200 kB of app code; each view loads on demand).
- [x] Optional token (`NEURAL_STUDIO_TOKEN`) for exposing the companion beyond localhost.

## Pending
- [ ] **Per-operation core attribution.** Per-core power is measured, but PyTorch does not say which core ran which operation. Needs hardware counters or pinned custom kernels.
- [ ] **Real cache and DRAM counters** (hits, misses, bytes). Needs AMD uProf / VTune / ETW PMC access (admin).
- [ ] **Die temperature and RAM/SSD power.** Windows exposes only an ACPI board thermal zone here; no rail meters for RAM or SSD.
- [ ] **Model on the iGPU in the companion** (DirectML / ONNX Runtime). The web app already does it through WebGPU.
- [ ] **Live run of real VLMs** (SmolVLM's `idefics3` needs a run adapter: image processor, vision tower, connector). The probe already shows its stacks; the zoo's toy VLM shows the mechanism.
- [ ] **Browser power estimate** is fitted to one PC. A per-device calibration (run once with the companion) would make it measured-anchored.
- [ ] **Real other machines.** Layouts were checked with simulated info, not on a 16-core desktop or a discrete GPU.
- [ ] **Accessibility.** Done: reduced motion, keyboard timeline, phone layout. Still to do: a text description of each 3D scene for screen readers, keyboard-only dives.
- [ ] **Warm vs cold runs.** A toggle that measures with an idle cool-down first.
- [ ] **Publishing.** The static build is ready to host; it has not been deployed to a public URL.
