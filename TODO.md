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

## Done since the last checkpoint (checked)
- [x] One continuous page with a fixed top bar (jump links), only on-screen scenes draw; Ctrl+wheel zooms a scene, plain wheel scrolls the page.
- [x] The real model drawn in the zoo's visual language (prompt tokens, per-block signal, heads, attention, next-word scores) on one shared prompt and one Run; every model opens already run.
- [x] Explanations live behind a 💡 `Hint` (click opens, mouse-leave closes) in the Model section and panels.
- [x] Live numbers on every part of the machine (CPU, cores, RAM, SSD, network).
- [x] Run score (`scoreRun`, `RunScoreCard`) with 5 unit tests (merged from workstream D; not yet wired to the UI).

## In flight (parallel workstreams, each in its own git worktree)
- [ ] **A** Any Hugging Face link: `resolveModel`, `checkFit`, `pickRuntime`, per-task defaults in `examples/index.json`.
- [ ] **B** In-browser engine: Transformers.js v4, `runInBrowser` for 5 tasks on WebGPU / WebAssembly.
- [ ] **C** Journey + Electricity merged into one Machine section (Electricity look), one timeline.

## The plan: every component is live, has a Test button with an input, and gives a score
**Definition.** A *component* is anything the page measures or animates: CPU (1 core, all cores), Cache, RAM, SSD, Network, GPU, Power/Energy, and the Model (per task). Each one (1) shows live numbers, (2) has a **Test** button, (3) takes an **input** (a default standard workload, or the user's own, validated), (4) returns a **component score** with spread and the exact workload version, and (5) feeds one **final score**.

**File budget.** No new source files. Everything lands in existing files: `server/app/hw.py` + `main.py`, `web/src/hw/{hwStore,score,browserBench,MachineUI,PowerScene}.ts(x)`, `web/src/{api,store,App}.ts(x)`, `web/src/ui/{panels,charts}.tsx`, `web/src/styles.css`, tests in the existing test files. Consolidation (also reduces files): merge `fps.tsx` into `aspect.tsx`; fold `gpuBench.ts` and `wasmKernel.ts` into `browserBench.ts` (`benchWorker.ts` stays: a Worker needs its own entry). Dev leftovers (explore/smoke scripts, logs, old screenshots, editor settings) are already removed or ignored; `make_machine_pack.py` is folded into `make_examples.py machine`.

### P1. Contract and engine (sequential: everything depends on it)
- [ ] **T1 Component registry**: one table in `hwStore.ts`: `{ id, label, live(): number, defaultInput, inputSchema{type,min,max,unit,step,safeCap}, run(input, signal), reference, workloadVersion }`. UI, server calls and scoring read it; adding a component = one row.
- [ ] **T2 Server per-component runs**: `bench_run(emit, client, only=[ids], params={})`; `/ws/bench` accepts `{only, params}` as its first message. Each stage runs alone (own idle baseline option), reports `progress`/`result` with `workload_version`, spread over repeats, and a `cancel` message stops it within 250 ms and cleans temp files.
- [ ] **T3 Input validation and caps (server side, never trust the browser)**: RAM test size ≤ 50% of free RAM; SSD file ≤ min(4 GB, 20% of free disk) in a private temp dir, always deleted; network URL must be https, public host only (block private/loopback/link-local ranges and redirects to them: SSRF), size/time capped; matrix sizes capped by RAM; clear 4xx messages.
- [ ] **T4 Browser parity**: `browserBench.ts` exposes the same registry runners (WASM SIMD matmul, memory copy, OPFS read/write, fetch, WebGPU matmul), same input schema and same result shape, cancelable via `AbortSignal`.
- [ ] **T5 Scoring**: per-component score (existing `REF`/`REF_BROWSER` ratios, native and browser kept apart) plus **final score** = weighted geometric mean of the components that ran, shown with how many of N components it covers (a partial run says so; never a silently different scale). Model run score from `scoreRun`. Export a result as JSON with workload versions.
- [ ] **T6 Wire the merged workstreams**: A's `spec/fit/input/lastStats`, B's `runInBrowser`, C's Machine section; one `Test` entry point per component calls the registry.

### P2. UI (after T1; the three tasks are independent and run in parallel)
- [ ] **U1 Machine section**: every part's 3D label gets a ▶ Test button (CPU, cores, Cache, RAM, SSD, Network, GPU); click shows an input popover (default value pre-filled, "Use my own…" reveals the schema field with unit, min/max and the safe cap); live gauge during the test; the part shows its score chip afterwards. A **Test all** button in the Machine play bar runs every component with defaults in a fixed order with the idle baseline and cooldown.
- [ ] **U2 Model section**: a **Test** button beside Run with a task-aware input: text prompt (text, fill-mask, sentiment), image (default sample, URL, upload, drag-drop), audio (default clip, upload, mic with permission prompt). Defaults per model type from the catalog; custom input remembered per task. After the run: `RunScoreCard` with where it ran (companion / WebGPU / WebAssembly) and why.
- [ ] **U3 Final score hero**: one card (top of the Machine section and in Details) with the final score, tier, coverage ("5 of 7 tested"), the weakest component highlighted ("RAM is the limit"), and the model run score. Click a part → its result detail. History of the last 10 results in `localStorage` with a compare-to-previous delta.
- [ ] **U4 Dynamic layout**: auto-fit grid so animations sit left-to-right when wide and top-to-bottom when narrow; container queries per section; one resize observer per canvas, camera re-fit, frame times measured while resizing.
- [ ] **U5 Text diet**: finish moving explanations to `Hint` in Machine/Details; at most one short line visible per card.

### P3. Robustness (continuous; owned per task)
- [ ] **R1** Every failure has a plain message and a next step: no companion, no WebGPU, mic denied, network blocked, model too big, out of memory, gated/private repo, offline.
- [ ] **R2** Safety rails: Test disabled while another test runs; battery / low-power-mode and thermal warnings before long tests (results flagged "on battery"); a visible Cancel; page visibility pause (a hidden tab throttles timers and skews results: flag or refuse).
- [ ] **R3** Measurement integrity: warm-up runs discarded, ≥3 repeats with min/median/spread, results flagged when spread > 15%, workload version stored; the drawing cost of the live 3D is measured and subtracted as today.
- [ ] **R4** Portability: Linux/macOS companion paths (no RAPL: fall back to estimate and say so; discovery without PowerShell), 16-core / discrete-GPU layouts, Safari/Firefox browser-only mode.

### P4. Verification (the finish line; nothing is "done" without it)
- [ ] **V1 Unit tests**: registry validation and caps (incl. SSRF cases), scoring (reference cases ≈ 1000, partial coverage, spread flags), fit math, cancel.
- [ ] **V2 End-to-end matrix** (Playwright, real browser, real companion): each component × {default input, custom input, invalid input, cancel} × {companion, browser-only} × {1480×900, 390×844}; each default model (text, fill-mask, sentiment, image, speech); a too-big model refused with a suggestion; a custom ONNX link; a custom non-ONNX link. Every path must end with a score on screen and zero page errors.
- [ ] **V3 Performance budgets**: first page JS ≤ 250 kB gzip; 60 fps resize on the 2-up layout; a test's own UI cost ≤ the existing measured baseline; no layout shift when results arrive.
- [ ] **V4 Accessibility**: Test buttons keyboard-reachable, results announced (`aria-live`), hints open on focus, reduced motion respected, text description of each 3D scene.
- [ ] **V5 Independent review** (a fresh agent that sees only the code and screenshots): visual polish, consistency, hidden-text and overlap checks; fix findings; re-run V2.
- [ ] **V6 Docs**: README sections for tests/inputs/scores; `web/tests/e2e/README.md` matrix; this file ticked honestly (checked = ran on the test PC).

### Review of this plan (what the first draft missed, now included above)
1. A per-component Test needs per-stage runs on the server; today `bench_run` is one fixed sequence (T2).
2. User-supplied inputs on the companion are an attack surface (a URL fetch is an SSRF hole; a file size can fill a disk): validation, caps and cleanup belong on the server (T3).
3. A "final score" is meaningless if components were skipped: coverage is part of the score (T5, U3), and workload versions keep scores comparable over time.
4. Scores must be trustworthy before pretty: spread, warm-up, battery/thermal and hidden-tab flags (R2, R3).
5. Browser-only and companion must return the same result shape or the UI forks (T1, T4).
6. The file budget is a requirement, so consolidation and deletion are explicit tasks, not a hope.

## Backlog (carried over, unchanged)
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
