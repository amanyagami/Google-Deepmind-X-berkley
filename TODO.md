# Neural Studio: plan v3 (reviewed, ready to split)

Legend: `[x]` done and checked on the test PC, `[ ]` pending. "Checked" means a unit test, script or browser test ran
it against the real Hub, a real model and the real machine. Every task below has an **acceptance** line: a task is
done only when that check has run and passed.

This plan merges three independent reviews (architecture/security/speed, UX/visual design, benchmark methodology)
with the owner's requirements. Section 9 lists what the reviews changed and the decisions still open.

---

## 0. Product decisions (these govern everything below)

1. **A public website that measures the visitor's own device.** Everything a visitor sees must work in the browser
   alone (WebGPU / WebAssembly / Workers / OPFS). The Python companion is optional, localhost-only, for power users,
   and must be safe if a hostile site is open in another tab.
2. **One page, no tabs.** The sections (Model → Machine & electricity) stay stacked on one scrolling page (owner's
   choice). Only on-screen scenes draw. A sticky **top bar** (model picker, jump links) and a sticky **bottom dock**
   (Run, Test all, progress, Cancel) are always visible, so the main action never scrolls away.
3. **Consent before downloads.** Nothing over 25 MB downloads without a click that shows the size and time.
   The page opens "already run" by playing a **recorded run** (no download); the live run starts on the visitor's click.
4. **Honest numbers.** Every value is tagged `measured`, `estimated` (≈) or `not available`. Browsers have no power
   sensor, so every browser watt/joule is "estimated" and is **not** in the score. Browser and companion scores are
   separate scales and are never mixed or compared.
5. **Little text.** At most one short visible line per card; everything else behind a 💡 hint.
6. **Fewest files.** No new source files (one exception allowed only if the chosen host needs a headers file, see D1).
   Section 2 merges four files away.

---

## 1. Done (checked)
- [x] Header-only probe of any Hub repo (config + safetensors header by HTTP Range); pickle refused; repo ids validated.
- [x] Typed graph for Llama-family and GPT-2; one stack per tower for multi-part models (SmolVLM).
- [x] Companion: live forward pass with hooks, attention, edits, A/B compare, head scan (SmolLM2, GPT-2, Qwen2.5).
- [x] Machine: discovery, 10 Hz telemetry, benchmarks, device score; journey of a prompt per operation, dives to one dot product (matches the model to 3e-8).
- [x] Electricity: RAPL package and per-core power, 3D replay, energy per test, live readouts on every part.
- [x] Browser-only mode: WASM SIMD matmul, Workers, OPFS, WebGPU (290–398 GFLOP/s on the Radeon 780M), network; recorded packs when no companion.
- [x] Network zoo (MLP, CNN, GRU, ViT, toy VLM) trained here, computed in the browser, matched to PyTorch by tests; stress and robustness cards.
- [x] One continuous page; the real model drawn in the zoo's visual language; one shared prompt and Run.
- [x] 💡 `Hint` (click opens, mouse-leave closes) in the Model section and panels.
- [x] Any Hugging Face link: `resolveModel`, `checkFit`, `pickRuntime`, per-task default models and inputs (text, fill-mask, sentiment, image, speech).
- [x] In-browser engine: Transformers.js v4 runs all 5 tasks on WebGPU and WebAssembly.
- [x] Run score (`scoreRun`, `RunScoreCard`), not yet wired to the UI.
- [x] Repo trimmed to the needed files (69 tracked); 28 web unit tests, 7 Python tests pass.
- [ ] In flight: **C** Journey + Electricity merged into one Machine section (worktree `ns-wt-c`, uncommitted). Lands in Phase 0.

---

## 2. Phase 0: the gate (one owner, sequential, before anything is split) — ~½ day

Everything in Phase 1 depends on these. Nobody starts Phase 1 until the Phase 0 checks pass.

- [ ] **P0.1 Land workstream C.** Review its diff, merge `ws-c`, delete the `ns-wt-*` worktrees and branches.
  *Acceptance:* build, 28+ unit tests and `live.mjs` pass; Journey and Electricity are one section; zero page errors.
- [ ] **P0.2 Merge files away (4 fewer files).**
  `fps.tsx` → `aspect.tsx`; `gpuBench.ts` → `browserBench.ts`; `wasmKernel.ts` → `benchWorker.ts` (its only user);
  `MachineScene.tsx` → `PowerScene.tsx` (if C has not already). Move `runInBrowser`/`pickDtype` (the model runner)
  from `browserBench.ts` into `api.ts`, so **models live in one file and hardware tests in another**.
  *Acceptance:* same build size ±2 %, all tests pass, `git ls-files web/src | wc -l` = 21 (from 25).
- [ ] **P0.3 Freeze the contracts** (types and empty stubs only, no behaviour). Every Phase 1 stream imports these and
  may not change them without the gate owner:
  - `TestResult`, `ComponentId`, `Flag`, `Runner`, `Registry row` in `hwStore.ts` (schema in §5).
  - `Capabilities` and `probe()` signature in `browserBench.ts` (§4).
  - `TensorWindow` request/response, `parseHeader()` signature, `Activation` in `api.ts` (§7).
  - Download manager interface in `api.ts`: `ensureModel(spec, {onProgress, signal}) → {cached, bytes}`.
  - Selection state in `zooStore.ts`: `sel: {kind:'block'|'tensor'|'token'|'output'|'part', id, layer?, name?} | null`, `setSel()`.
  - CSS tokens and slot class names in `styles.css` (§6): `.topbar .dock .rail .stage .card .chip .hero .sheet`.
  *Acceptance:* `tsc` passes with stubs; a one-page `CONTRACTS` section at the top of each file says who owns it.
- [ ] **P0.4 Worktrees.** Create one worktree per stream outside the repo (`../ns-wt-<stream>`, node_modules junction).

---

## 3. Phase 1: parallel workstreams (disjoint file ownership)

Each stream edits **only** its own files. Anything else is a request to the owner. Streams can start with mocks
against the frozen contracts on day one.

| Stream | Owns (exclusive) | In one line |
|---|---|---|
| **S1 Shell, layout, visual system, hosting** | `App.tsx`, `main.tsx`, `base.ts`, `aspect.tsx`, `styles.css`, `index.html`, `vite.config.ts` | Top bar, dock, rail/sheet, tokens, responsive layout, CSP/isolation, fonts |
| **S2 Measurement engine** | `hw/browserBench.ts`, `hw/benchWorker.ts`, `tests/kernel.test.ts` | Capability probe and every hardware test runner, honest kernels |
| **S3 Scoring and results** | `hw/score.ts`, `hw/hwStore.ts`, `hw/timeline.ts`, `tests/machine.test.ts`, `tests/power.test.ts` | Registry, results store, stats, final score, history, export |
| **S4 Models engine** | `api.ts`, `store.ts` | Downloads with consent, model runner, task inputs, tensor window, activations |
| **S5 Machine UI** | `hw/MachineUI.tsx`, `hw/PowerUI.tsx`, `ui/panels.tsx` | Test cards, score hero, share card, honesty badges, privacy chip |
| **S6 Model UI** | `zoo/ZooUI.tsx`, `zoo/zooStore.ts`, `zoo/nets.ts`, `tests/zoo.test.ts` | First visit, model picker, task inputs, run score, inspector mount |
| **S7 Inspector and hints** | `ui/charts.tsx` | Inspector card, semantic-zoom heatmap, vectors, logits, new `Hint` |
| **S8 3D scenes** | `zoo/ZooScene.tsx`, `hw/PowerScene.tsx` | Layer-type styling, label chips, selection, camera, resize, DPR |
| **S9 Companion** | `server/**` | Origin hardening, per-component runs, cancel, header validation |
| **S10 Verification** | `tests/e2e/**` | Three test tiers, the 25 acceptance checks, perf budgets |

Dependency graph (→ = needs the contract or output of):
`S5 → S3, S2` · `S6 → S4, S7` · `S7 → S4 (tensor window), S8 (selection)` · `S8 → S6 (sel)` · `S10 → all` ·
S1, S2, S3, S4, S9 depend only on Phase 0.

### S1 Shell, layout, visual system, hosting
- [ ] **Top bar (48 px, sticky):** brand, **model picker slot** (filled by S6), jump links, device chip
  (`This device · WebGPU · ~8 GB` or `WebAssembly (slower)`), privacy chip (`Runs on your device · nothing uploaded 💡`).
  Remove the example chips and URL box from the header (they move into the picker).
- [ ] **Dock (56 px, sticky bottom):** `▶ Run`, `Test all`, determinate progress (`RAM 3/7 · 12 s`), `Cancel`, timeline scrub. The single obvious action.
- [ ] **Section layout:** each section = `stage` (canvas) + `rail` (cards). Shell uses a **container query**:
  ≥ 960 px rail on the right (`clamp(340px, 32cqw, 440px)`), below that the rail becomes a **bottom sheet** with a drag
  handle (peek 25 dvh). Panels that sit side by side use `repeat(auto-fit, minmax(min(100%, 420px), 1fr))` so they flow
  left-to-right when wide and top-to-bottom when narrow. Stage height `min(72dvh, …)`, phone 45 dvh.
- [ ] **Smoothness:** remove scroll-snap; View Transitions only for discrete changes (sheet snap, section jump); during
  window drag the layout simply follows (no FLIP). Animate only `transform`/`opacity`. No `backdrop-filter` over WebGL.
- [ ] **Tokens** (§6) incl. `--faint` lifted to `#8a95b8`, type scale, 4-pt spacing, radii, motion, `--hit` 40/44 px.
  Inline-SVG icon set (1.75 px stroke) replaces emoji glyphs in controls; `tabular-nums` on live numbers.
- [ ] **States:** skeletons instead of "Loading…", offline strip, unsupported banner, error component (one sentence + one button).
- [ ] **Hosting:** self-host fonts (drop Google Fonts) and ORT wasm (`wasmPaths`); CSP
  (`default-src 'self'`; `connect-src 'self' huggingface.co *.hf.co cdn-lfs*.huggingface.co http://127.0.0.1:8000`;
  `worker-src 'self' blob:`; `'wasm-unsafe-eval'`); cross-origin isolation via COOP `same-origin` + COEP
  (`credentialless` where supported) or a service-worker shim on hosts without headers (see D1). Immutable caching for hashed assets.
- *Acceptance:* checks A1–A6, A13, A14, A20, A22 (§8); `crossOriginIsolated === true` on the deployed URL; the network
  log shows only allowlisted hosts; first JS chunk ≤ 100 kB gzip, three.js chunk ≤ 300 kB gzip.

### S2 Measurement engine (browser first)
- [ ] **Capability probe (≤ 2 s, no downloads):** `crossOriginIsolated`, `hardwareConcurrency`, `deviceMemory`, WASM
  SIMD, timer resolution (page and worker), WebGPU adapter + `isFallbackAdapter` + `shader-f16`/`timestamp-query`,
  a 4×4 WGSL canary (f32 and f16 vs CPU), OPFS + sync handle, `storage.estimate()`, `connection.saveData/type`,
  battery, visibility, rAF rate. Returns `Capabilities` with a `profile`: `lite` (≤ 2 GB or phone) / `standard` / `full`.
- [ ] **Runner rules for every test:** serial; warm-up discarded; samples ≥ 50 ms (≥ 250 ms if the timer is ≥ 1 ms);
  ≥ 5 samples; **median** (max kept only as a "peak" label); stop early when the median's 95 % CI ≤ 2 %; flag `noisy`
  if CV > 15 %; `AbortSignal` → workers terminated, GPU device destroyed, idle within 250 ms; hidden tab → flag;
  `RangeError` → halve the size and flag. Worker pool capped at 8.
- [ ] **Kernels (fixes from the benchmark review):**
  - CPU 1-core / all-core: WASM SIMD matmul, n = 256, enough multiplies per sample; all-core adds a 3 s sustained re-run (sustained/burst ratio).
  - Cache: pointer-chase latency + read bandwidth sweep over 13 sizes (16 KB–256 MB), knee detection shows L1/L2/L3.
  - RAM: STREAM triad (24 B per element, labelled), array ≥ 4× the largest cache knee, ≤ 12 % of device memory.
  - Storage: OPFS 128 MB sequential write (+flush), sequential read, 4K random read QD1 for 1 s. Labelled
    **"browser file storage"**, never "SSD".
  - GPU: tiled 4×4 register-blocked matmul, N = 1024, batched dispatches so a sample ≥ 100 ms, warm-up until stable,
    output spot-check vs CPU; a software adapter is flagged and not scored; `device.lost` handled.
  - Connection (not in the device score): 15 idle latency probes, a 4-stream ramped download against a CORS CDN
    target, latency under load. Confirm first on cellular / `saveData`.
- *Acceptance:* probe returns in ≤ 2 s with all fields on Chromium (Firefox/Safari in the real-browser tier); 20 repeat
  runs on one device agree within the reported CI ≥ 90 % of the time; the cache sweep shows this PC's L1/L2/L3 within
  one step; RAM within 10 % of a native STREAM build on the same PC; a 2 GB-phone emulation finishes with a partial
  result and no tab crash; cancel ≤ 250 ms in a unit test with a fake clock.

### S3 Scoring and results
- [ ] **Registry** (one row per component, §5) mapping ids to S2 runners, input schema, caps, defaults, REF, weight, workload version.
- [ ] **Results store:** one `results: Record<ComponentId, TestResult>` + `history` (≤ 10, `localStorage`, versioned,
  try/catch, unknown versions discarded). Every companion `bench` entry and model `RunStats` is mapped into `TestResult` by one function.
- [ ] **Component score** `S = 1000 × median / REF[scale][workload v]`, no cap; CI from the samples.
- [ ] **Final score** (§5): five pillars, weighted geometric mean; "not available" counts as 50, "not tested" makes the
  score *provisional (k of 5)*; never raises when a component is missing; limiting component; 95 % CI; flags.
- [ ] **Model score** rework of `scoreRun`: speed + response only (fit is a separate verdict), real token/patch/frame
  counts, Whisper fixed 30 s window, 1 warm-up + ≥ 3 timed runs, accuracy gate (golden output) or no score; text
  generation reports prefill and decode separately.
- [ ] Store raw samples and medians, not scores, so a REF change re-scores history. Export JSON (no user data, device
  strings only on opt-in).
- *Acceptance:* unit tests: reference inputs ≈ 1000 per component and scale; omitting any component can never raise
  the final score (`machine.json` case); mixing scales throws; CV flag at exactly 15 %; a 5 s and a 30 s clip score the
  same within noise; a model failing its gate yields no score.

### S4 Models engine
- [ ] **Download manager:** size and estimated time before any download; consent rule (< 25 MB one click;
  25–150 MB size shown; > 150 MB or cellular/`saveData` → warning + "use smaller model"); determinate progress with
  MB/s and ETA; Cancel via `AbortController`; Cache Storage with `storage.persist()` on click; `estimate()` shown;
  "Clear downloaded models"; `QuotaExceededError` → message; `dispose()` on switch, one model in memory at a time.
- [ ] **Runner:** `runInBrowser` (moved here in P0.2) gets a degenerate-output check for **every** task (not only text
  generation), dtype chosen from the probe's f16 canary, error codes instead of regex on messages.
- [ ] **Task inputs:** text (≤ 512 tokens, ≤ 128 on < 4 GB), image (default sample, upload, URL, drag-drop; ≤ 10 MB,
  downscaled), audio (default clip, upload, mic after a click; ≤ 30 s). Validation with caps in the message. Custom input remembered per task.
- [ ] **Tensor window (browser-first, §7):** `parseHeader()` validated (offsets, sizes, overlaps, BigInt products),
  Range reads straight from `huggingface.co` pinned to the commit SHA, F32/F16/BF16/F8 decode, strided overview
  (never "first N rows"), caps (16 MiB per window, 15 s, 8 ranges in flight, LRU 64 MB), quantized tensors reported as such.
- [ ] **Activations:** from the companion when present; in the browser only if the ONNX export exposes hidden states
  (the probe says yes/no), otherwise the inspector shows weights only and says why.
- [ ] Run gating: browser-only models can run (today Run is gated on the companion probe).
- *Acceptance:* zero model-file requests before the Start click (A8); second load makes zero model requests and says
  "cached" (A10); `parseHeader` unit tests (§7 list); a window's decoded values match a tiny fixture byte-for-byte;
  switching models 10 times keeps one pipeline alive.

### S5 Machine UI
- [ ] **Test card** (same shape for every component): `idle → running → result → error`. Default shown pre-filled
  (`Default: 128 MB · ~4 s`); "Use my own" disclosure reveals one typed field (number + unit + min/max + visible cap)
  with inline validation; Test disables while invalid or while another test runs; thin progress bar, live value,
  Cancel, `aria-live` line.
- [ ] **Label chip** on each 3D part (from S8) shows live value then score; click selects the part and opens its card.
- [ ] **Score hero** (top of the rail, one line on phones): `▲ 1,184 · 5 of 7 tested · ±2 %`, tier, weakest
  component (link), delta vs last run, "estimated in your browser" badge, `Test the rest`, `Share`.
- [ ] **Share:** 1200×630 PNG (score, tier, coverage, mini bars, device class, date; no UA/hostname unless opted in),
  JSON download, score in the URL hash; `navigator.share` on phones.
- [ ] Honesty badges everywhere (`● measured` / `≈ estimated` / `— not available`); browser energy shown, unscored.
- [ ] Machine/Details text moved into hints (one visible line per card); the ambiguous "Machine"/"Details" corner buttons replaced.
- *Acceptance:* A7, A11, A16–A19, A21, A23.

### S6 Model UI
- [ ] **First visit:** a card over the stage: "See an AI run on your device", device line from the probe, model line
  with size and time, one button `▶ Start (download 82 MB)` or `▶ Start (cached)`, a link "watch a recorded run".
  Meanwhile the scene plays the recorded run so the page never looks empty.
- [ ] **Model picker** (top bar slot): grouped by task (Text, Fill-mask, Sentiment, Image, Speech) with size, time and
  "cached ✓"; "Use another model…" holds the Hugging Face box; the fit verdict (runs / slow / too big + suggestion) inline.
- [ ] **Task-aware input** in the dock's Run area (text, image, audio controls from S4).
- [ ] After a run: `RunScoreCard` (where it ran and why, speed, response, fit verdict separately).
- [ ] Rail shows only `Run` by default; "See the maths" and "Change weights" open from the inspector (plain names instead of Calculate / Edit & compare).
- [ ] Mounts the S7 inspector when `sel` is set; breadcrumb `Model › Block 12 › Attention`.
- *Acceptance:* A6, A8, A10, A15 (with S7), the 5 default tasks each end with a score on screen and zero page errors.

### S7 Inspector and hints (`charts.tsx`)
- [ ] **Inspector states** (never by default):
  0 overview (one-time pill "Click any block to inspect") → 1 hover (outline + one-line tooltip) → 2 select (camera
  eases 350 ms, others dim) → 3 inspector card (type, shape, params, dtype, buttons `Weights ▸ Input ▸ Output ▸`) →
  4 tensor view (pooled thumbnail, legend, stats: min/max/mean/std/% zero/norm, histogram) → 5 semantic zoom
  (pooled → cells → numbers ≥ 28 px, 3 significant figures, coordinate readout) → 6 vector view (heat strip per token,
  "Show all numbers" table, hover links to the 3D token) → 7 output view (top-10 logits with softmax %, Show 50,
  temperature slider). `Esc`/breadcrumb goes up one level.
- [ ] **Rendering:** a 2D canvas, mipmaps built once in a worker, only visible cells drawn, ≤ 40×40 numbers on canvas,
  ≤ 4 M values per view (above: pooled only, says so); diverging map (amber +, blue −, dark 0) with `+`/`−` in the numbers tier.
  "Load this tensor (2.3 MB)" button, never a silent fetch. Copy TSV / CSV / PNG (≤ 100 k values, truncation stated).
- [ ] **Input:** keyboard (Tab, arrows, Enter, Esc, +/−, Home), touch (tap, pinch, drag; `touch-action:none` only on the focused heatmap), screen-reader summary.
- [ ] **New `Hint`:** 28 px icon in a 40 px hit area, 150 ms close delay so the mouse can reach the bubble, tap-to-open
  and tap-outside-to-close on touch, `relatedTarget` check so focus inside the bubble does not close it.
- *Acceptance:* A15, A17; heatmap at max zoom shows the exact value of the fetched tensor at that index; 60 fps
  (p95 frame ≤ 20 ms) while panning a 4 M-value tensor on the test PC.

### S8 3D scenes
- [ ] **Layer-type styling** (slight but clear; shape first, colour second, §6.3) for the real model and the zoo nets.
- [ ] **Label chips:** name + value/score only, sub-lines on hover/select; clamped inside the stage (flip anchor,
  leader line when overlapping, e.g. Cache over the CPU); 48 px top safe area. Labels stay mounted (drei `<Html>` rule).
- [ ] **Selection:** hover outline, click/Enter sets `sel`, focus order left→right then layers; camera spring that cancels on a new click.
- [ ] **Resize:** one `ResizeObserver` per canvas applied on the next frame; buffer resized only on ≥ 1 px change;
  DPR cap 2 (desktop) / 1.5 (phone), drops to 1 if frames > 24 ms for 30 frames; camera re-fit from the content's bounds keeping the orbit angle.
- [ ] **Lite mode** (from the probe): lower DPR, no bloom, fewer spheres. Scene pauses when hidden or off-screen.
- [ ] Text alternative per scene (what is shown, current numbers).
- *Acceptance:* A2, A3, A14; no label outside the stage at 390/820/1100/1480; the camera re-fit keeps the whole model
  in view after every resize step.

### S9 Companion (optional, power users)
- [ ] **Hardening first (blocker):** `Origin` and `Host` allowlist on HTTP and WebSocket (same-origin, `localhost:8000`,
  `NEURAL_STUDIO_ORIGINS`), `Allow-Private-Network` only for allowed origins, a pairing code printed at start and
  sent in a header (`compare_digest`), no token in URLs or logs.
- [ ] **Per-component runs:** `/ws/bench` first message `{type:'start', only, params}`, `{type:'cancel'}`; ids and
  params validated against the registry enum and caps; cooperative cancel at the next safe point (ops ≤ 50 ms) or
  ≤ 250 ms except model download; a server-wide busy state returns 409 instead of blocking; the lock is released on
  disconnect; per-task ids for client round trips; per-component power summary.
- [ ] Same statistics as S2 (median, CI, warm-up); storage test on a private temp file with unbuffered I/O, always
  deleted; energy from counter deltas over windows ≥ 2 s; efficiency = total work / total joules of the same window.
- [ ] `parseHeader` port with the same rules as S4; shard headers fetched in parallel (capped); `_PROBES` bounded;
  `psutil.Process` cached (per-process core load is 0 today).
- [ ] User URL / file-size inputs only after hardening, with SSRF rules (https, public IPs only, re-checked per redirect, pinned IP, size/time caps).
- *Acceptance:* pytest: a cross-origin WebSocket is refused; wrong `Host` refused; preflight from a foreign origin gets
  no PNA header; a second bench gets `busy` fast; a disconnect stops the worker in ≤ 1 s; the SSRF and header
  fuzz lists from the review all rejected.

### S10 Verification (starts day one with mocks)
- [ ] **Three tiers:** (1) unit tests with mocked `fetch`, fake `navigator.gpu` and an injected clock; (2) mock
  end-to-end: Playwright with `route()` stubbing the Hub and the companion, a tiny safetensors fixture and a 2-layer
  ONNX; (3) a small real smoke run (real Hub, real model, real companion), manual or nightly, not gating.
- [ ] Assert shapes and invariants (a score exists, flags consistent, zero page errors via `onerror` /
  `unhandledrejection` counters), never absolute GFLOP/s.
- [ ] Implement checks A1–A25 (§8); a real-browser pass on Chrome, Edge, Firefox and Safari (iOS) for the probe, the
  5 default tasks and the score.
- [ ] One consolidated e2e entry (`tests/e2e/run.mjs --grep`) replacing the nine scripts where they overlap.
- *Acceptance:* tier 1 + tier 2 run in ≤ 3 min and gate every merge; tier 3 log attached to the release.

---

## 4. Per-component test protocol (browser; the companion mirrors it with native kernels)

| Component | Default input | "Use my own" (hard caps) | Budget | Statistic | In final score? | Flags |
|---|---|---|---|---|---|---|
| Probe | none | none | ≤ 2 s | — | — | not isolated, coarse timer, software GPU, lite |
| CPU 1-core | WASM SIMD matmul n=256 | n 128–1024; 1–30 s; ≤ 5 % memory | 2.5 s | median of ≥ 5 | Compute | hot start, battery, hidden |
| CPU all-core | same, 1 worker per thread (≤ 8 pool) | threads 1..cores | 3.5 s + 3 s sustained | median | Compute | sustained < 85 %, SMT |
| Cache | latency + bandwidth sweep, 13 sizes | max size ≤ 25 % of memory budget (`lite` ≤ 32 MB) | ~5 s | median per size, knees | Memory | no clear knee |
| RAM | STREAM triad, ≥ 4× L3 knee | 16–128 MB per worker; total ≤ 12 % device memory | 4 s | median | Memory | size halved, memory unknown |
| File storage | OPFS 128 MB write/read + 4K random 1 s | 16–512 MB, ≤ 10 % free quota | 6 s | median, geomean of 3 | Storage | cached read, small quota, private mode |
| GPU | WebGPU matmul N=1024, f32 (f16 if available) | N 512–4096; buffers ≤ min(256 MB, device limit) | 5 s | median, correctness gate | GPU | software adapter (not scored), device lost |
| Model (per task) | catalog reference model and input | text/image/audio inputs, caps in S4 | ~10 s after download | median of ≥ 3, gate | Model | cold load, runtime, dtype, threads, custom |
| Connection | latency probes + 4-stream download | https + CORS URL; ≤ 100 MB or 15 s | ≤ 10 s | median, p95, jitter | **no** (shown apart) | offline, cellular, saveData |
| Energy | estimate (browser) / RAPL (companion) | power class | — | — | **no** | estimated, package-only |

Downloads are never part of `Test all`. Custom inputs produce a "Custom (not in the score)" result that never
overwrites the standard one.

---

## 5. Data contracts and the final score

```ts
interface TestResult {
  v: 1; component: ComponentId              // 'cpu1'|'cpun'|'cache'|'ram'|'storage'|'gpu'|'net'|'energy'|`model:${Task}`
  scale: 'browser' | 'native'               // never mixed in one score
  workload: { id: string; v: number }       // e.g. { id: 'matmul_f32_simd', v: 1 }
  input: { kind: 'default' | 'custom'; summary: string }   // no raw user data
  samples: number[]; value: number; unit: string            // value = median
  ci95: [number, number]; cv: number
  score: number | null                      // null = custom, failed gate or unscored
  flags: Flag[]                             // 'noisy'|'hidden-tab'|'on-battery'|'not-isolated'|'coarse-timer'|'software-gpu'|'size-halved'|'estimated'|'cancelled'|`fallback:${string}`
  env: { where: 'companion'|'webgpu'|'wasm'; threads?: number; isolated?: boolean; adapter?: string }
  energy?: { joules: number; estimated: boolean }
  at: string
}
// registry row
{ id, label, pillar, weight, defaultInput, inputSchema: { type, min, max, unit, step, cap(caps: Capabilities) },
  run(input, signal, onProgress): Promise<TestResult>, ref: Record<Scale, Record<number /*workload v*/, number>> }
```

**Final score** = weighted geometric mean of five pillars: Compute 0.35 (1-core 0.4, all-core 0.6), Memory 0.25
(RAM 0.6, cache 0.4), GPU 0.15, Storage 0.10, Model 0.15 (geomean of the tasks run).
- *Not available* on this device (no WebGPU, no OPFS) counts as 50 and says so; *not tested* is excluded and the score
  is shown as **provisional (k of 5)** until Compute, Memory and one more pillar exist.
- Shown with: 95 % CI, coverage, the limiting component (most negative `w·ln(Sᵢ/S)`), flags, workload versions.
- Worked example on this PC with current placeholder REFs: **1196 (CI ~1171–1222), limited by the GPU**. Today's
  formula gives 1238 and rises to 1301 if the GPU is skipped; the new one cannot rise.
- **REF v1:** one named reference device + browser, 5 sessions per engine, raw medians frozen; per-engine REFs only
  where engines differ by more than ±15 %. A small `reference_devices` table in `score.ts` lets the hero say
  "between device X and Y".

---

## 6. Visual system

### 6.1 Tokens (S1 owns; everyone uses)
```css
:root{
  --bg:#0a0e19; --panel:#0f1526; --surface:#141c32; --surface2:#1b2542; --line:#27314f;
  --fg:#e8ecf8; --muted:#9aa5c7; --faint:#8a95b8;              /* faint lifted to pass 4.5:1 */
  --pos:#ffa94d; --neg:#55a8ff; --ok:#4ed8a0; --bad:#ff7a7a; --warn:#ffd36b; --est:#b9a6ff;
  --t-1:11.5px; --t0:14px; --t1:16px; --t2:20px; --t3:28px; --t4:44px;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px;
  --r-sm:8px; --r-md:12px; --r-lg:18px; --r-pill:999px;
  --ease:cubic-bezier(.2,.8,.2,1); --d1:120ms; --d2:220ms; --d3:360ms;
  --hit:40px;
}
@media (pointer:coarse){ :root{ --hit:44px } }
@media (prefers-reduced-motion:reduce){ :root{ --d1:0ms; --d2:0ms; --d3:0ms } }
```
Meaning never by colour alone: positive/compute `▲` + solid, negative/data `○` + dashed; heatmap numbers carry `+`/`−`.

### 6.2 Density
1480: chips with one sub-line, rail 380–440 px · 1100: rail 340 px, no sub-lines · 820: rail becomes the bottom
sheet · 390: chips only, one card at a time, dock 56 px.

### 6.3 Layer types (slight, consistent differentiation)
Shape is the primary cue, an icon the second, a faint tinted **plate** under the group (6–10 % opacity) the third.
Plate tints are desaturated and never applied to nodes, so amber/blue keep meaning +/− values.

| Layer type | Where | Shape | Plate tint | Icon |
|---|---|---|---|---|
| Embedding / input | LLM tokens, ViT patches, pixels | flat tiles | slate `#7d8bb0` | ▦ |
| Attention | LLM heads, ViT, VLM | head "teeth" + arcs | indigo `#7b86e0` | ◎ |
| MLP / dense | LLM blocks, MLP net | spheres | sand `#c9a46a` | ● |
| Convolution | CNN | cell grid + kernel frame | teal `#3fb3a6` | ▣ |
| Pooling | CNN | flatter cells | pale teal `#8fd1c8` | ▫ |
| Recurrent | GRU | spheres + loop ring | violet `#a68bd8` | ↻ |
| Norm | LLM | thin outline ring | none | ○ |
| Output | next-word / class bars | bars | slate | ▮ |

A legend sits behind a 💡 in each scene. *Acceptance:* the plate tints pass the palette validator as a categorical set
on `--bg` (ΔE ≥ 8 adjacent under CVD); a viewer can name the layer type from shape alone in greyscale screenshots.

---

## 7. Inspector data APIs (S4 implements, S7 consumes)

```ts
// tensor window: data as one ArrayBuffer (never JSON numbers)
req  { repo, file /* from the header, never typed */, name, i0?, r0, c0, rows, cols, stride? }
resp { name, dtype, shape, r0, c0, rows, cols, stride, out: 'F32', data: ArrayBuffer,
       fetchedBytes, requests, truncated, decoded: boolean /* false for quantized */ }
// activation (on demand)
req  { repo, input, layer, pos, kind: 'resid'|'attn'|'mlp' }
resp { available: false, reason } | { dim, data: Float32Array, stats, source: 'companion'|'onnx' }
```
`parseHeader` rejects: header length 0 or > 16 MiB, non-dict entries, missing fields, unknown dtypes, > 8 dims,
negative/float dims, offsets out of file, overlapping, or `b − a ≠ prod(shape) × itemsize` (BigInt). 3-D+ tensors
need `i0`. Caps: 16 MiB read per window, ≤ 1024×1024 out, 15 s, 8 ranges in flight, LRU 64 MB, commit-SHA pinned.

---

## 8. Acceptance checks (Playwright; S10 implements, owners make them pass)

A1 text contrast ≥ 4.5:1 (3:1 large/UI) · A2 no overlapping interactive boxes or labels · A3 no label outside the
stage · A4 touch targets ≥ 40 px (dock ≥ 44) at 390 · A5 no horizontal scroll at 390/820/1100/1480 · A6 the primary
action visible without scrolling at all four widths · A7 time to first score: ≤ 10 s for a default component test,
≤ 60 s for an 82 MB model at 20 Mbit/s; first paint ≤ 2.5 s · A8 zero model-file requests before Start; size visible
first · A9 download progress updates ≥ 1/s with `role=progressbar` · A10 second load: zero model requests, "cached" ·
A11 every browser W/J shows "estimated"/≈ · A12 no request leaves the origin except allowlisted hosts and user-typed
URLs · A13 panels side by side at 1100, stacked at 390 · A14 resize 1480→390 in 20 steps: p95 frame ≤ 20 ms, buffer =
CSS size × capped DPR · A15 inspector: click → card ≤ 500 ms → Esc back; max zoom value = fetched value · A16 keyboard
reaches every Test button and block; visible focus ring · A17 💡: click opens, mouse-leave closes ≤ 300 ms, tap
outside closes on touch, stays in viewport · A18 ▲/○ and +/− present (colour independence) · A19 ≤ 1 visible
sentence (≤ 120 chars) per card · A20 CLS ≤ 0.02 during a full Test all · A21 mocked no-WebGPU / out-of-memory /
offline / mic-denied each show a message + button within 2 s, zero page errors · A22 reduced motion: no transition
> 1 ms, no camera tween · A23 share PNG 1200×630 without hostname or UA · A24 omitting a component never raises the
final score · A25 hostile-origin page cannot start a companion run.

---

## 9. Review log and open decisions

**What the three reviews changed (all folded in above):**
1. Browser-first: the companion became optional and hardened (S9); every visitor feature has a browser path.
2. Scores: median not max, longer samples, honest kernels (cache, RAM, storage, GPU), missing components can no
   longer raise the score, network and energy left out of the device score, fit separated from model speed.
3. Trust: capability probe, consent and size before downloads, CSP and allowlisted hosts, self-hosted fonts and ORT,
   privacy chip, estimated-vs-measured badges, no device strings in exports by default.
4. UX: sticky top bar + dock (Run never scrolls away), rail/bottom sheet per section, one result-card pattern for
   every component, score hero with coverage and weakest part, semantic-zoom inspector, `--faint` contrast fix,
   colour-independent glyphs, 40/44 px hit targets, layer types differentiated by shape.
5. The UX review proposed tabs that swap one scene; **rejected** (owner wants one page). Its benefit (one live GPU
   scene at a time) is kept by drawing only on-screen scenes.
6. Testing: three tiers with mocks so the gate is fast and deterministic; absolute numbers never asserted.

**Decisions with a recommended default (Phase 1 proceeds on the default unless the owner says otherwise):**
- **D1 Host:** Cloudflare Pages or Netlify (can set COOP/COEP/CSP headers; needs one `_headers` file, the only new
  file). GitHub Pages would need a service-worker shim instead.
- **D2 Reference device for REF v1:** this test PC (Ryzen 7 8745HS, Radeon 780M) in Edge, measured 5 times.
- **D3 Connection test target:** a file on the site's own host (CORS-safe, no third-party terms); Hub CDN as fallback.
- **D4 Companion on the public site:** hidden unless the visitor turns on "I run the companion" in settings.

**Not verified yet (checked in the real-browser tier):** Safari/Firefox WebGPU and COEP `credentialless`, timer
resolution outside Chromium, whether ORT loads from the CDN or the bundle, multi-range support on the Hub CDN,
whether the f16 zero-output issue appears on other GPUs.

---

## 10. Phase 2: integration and release (after Phase 1)
- [ ] Merge streams in this order: S3, S2, S4, S1, S8, S7, S6, S5, S9; tier 1 + 2 tests after each merge.
- [ ] Full A1–A25 run at four widths; real-browser tier on Chrome, Edge, Firefox, Safari iOS, one Android phone.
- [ ] Independent fresh-eyes review from screenshots and code only; fix findings; re-run.
- [ ] Freeze REF v1 on the reference device; regenerate `machine.json` with `make_examples.py machine`.
- [ ] README: how to use, what is measured and how, privacy, companion pairing. Deploy (D1).

## Backlog (not in this plan)
- Per-operation core attribution; real cache/DRAM counters; die temperature and RAM/SSD power (need admin counters).
- Model on the iGPU in the companion (DirectML/ORT). Live run of real VLMs (SmolVLM adapter).
- Per-device calibration of the browser power estimate via a one-time companion run.
- Neuron views (top-activating tokens per neuron) in the inspector.
