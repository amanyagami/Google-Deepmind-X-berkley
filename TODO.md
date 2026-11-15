# STATUS (read this first)

**Built and checked on the test PC (Ryzen 7 8745HS, Radeon 780M, Edge):** rounds 1 and 2 of this plan. The harness
(`web/tests/e2e/run.mjs`) passes 37 of 37 tier-1/2 checks on a fresh build (A1-A35, L1-L5, dark and light); tier 3 on the
real Hub: T1, T2, A9, L6 pass (default model, first result 22.9 s on WebGPU over this connection). 100 web unit tests and
77 server tests pass. `dist` is 32 MB; first JS 27 kB gzipped; first paint ~0.4 s; frame p95 16.8 ms, also during Test all.

**Still open (honest list):**
- [ ] Real-browser tier on Firefox, Safari (iOS) and an Android phone (only Edge/Chromium was run).
- [ ] REF v1 not frozen: scores use placeholder references; freeze them on the reference device (5 sessions per engine).
- [ ] Companion on port 8000 runs older code until restarted; restart it to get the origin/pairing hardening (S9).
- [ ] Whisper multilingual decode untested in a real run; no multilingual text model under 100 MB exists (Qwen2.5-0.5B is 461 MB).
- [ ] Cache test takes ~10 s (target 6 s) and misses L3 under load; RAM test shows 100-280 ms stalls on a busy PC; re-measure on a quiet machine.
- [ ] Fonts are the system stack (no subset yet); 3D starts when the section is near the viewport, not on idle.
- [ ] A7b (82 MB model at 20 Mbit) limit changed after its last run: re-run it.
- [ ] SmolLM2-135M-Instruct is 112 MB (target <= 100 MB; no smaller good text model).
- [ ] Light-mode scene polish (floor colour, HUD card over a label): with S8.
- [ ] Final plain-words copy pass beyond A26's sampling, and a fresh-eyes design review of every view in both themes.
- [ ] SSRF-safe fetch helper (`security.py`) is written and tested but not wired to any endpoint.
- [ ] Drop `server/app/bench.py` split? No: kept as its own module (size).

---

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
3. **Consent before downloads. SUPERSEDED by Round 2 (§11, D5): models download automatically with visible progress.** Nothing over 25 MB downloads without a click that shows the size and time.
   The page opens "already run" by playing a **recorded run** (no download); the live run starts on the visitor's click.
4. **Honest numbers.** Every value is tagged `measured`, `estimated` (≈) or `not available`. Browsers have no power
   sensor, so every browser watt/joule is "estimated" and is **not** in the score. Browser and companion scores are
   separate scales and are never mixed or compared.
5. **Little text, plain words.** At most one short visible line per card; everything else behind a 💡 hint. All
   copy, visible or in a hint, is written in a short, plain Hemingway style (rules in §6.4).
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
| **S10 Verification** | `tests/e2e/**` | Three test tiers, the 26 acceptance checks, perf budgets |

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
- [ ] Implement checks A1–A26 (§8); a real-browser pass on Chrome, Edge, Firefox and Safari (iOS) for the probe, the
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

### 6.4 Words: short, plain, Hemingway style
Every stream writes its own copy to these rules while building. One owner does a final copy pass in Phase 2.

**Rules**
- Short sentences. Average ≤ 12 words. None over 20.
- One idea per sentence. Cut the rest.
- Plain words. "Use", not "utilise". "Fast", not "performant".
- Active voice. "The GPU multiplies the numbers", not "The numbers are multiplied".
- Concrete beats abstract. Give the number: "82 MB · about 20 s", not "a large download".
- No filler adverbs ("very", "simply", "actually", "basically").
- No jargon on screen. If a term must appear (softmax, RAPL), the 💡 says what it means in one sentence.
- Buttons are verbs: `Run`, `Test`, `Cancel`, `Share`. Labels are nouns.
- Hints: at most 2 sentences. Errors: what happened, then what to do. "Out of memory. Try a smaller model."
- Numbers in a sentence are mono and have units.

**Before → after** (from the current page)
- "All five were trained on the same 1,500 handwritten digits (scikit-learn's 8×8 set) by server/train_zoo.py, so you
  can compare how each kind of network solves the same problem." → "All five learned from the same 1,500 digits.
  Compare how each one solves it."
- "It compares its query with every token's key (dot product ÷ √8), turns the scores into weights with softmax, and
  takes the weighted average of their values." → "It scores every token. The scores become weights. It mixes the
  tokens by those weights."
- "Computed live in this page as you draw. Times are measured here, averaged over N+ runs." → "It runs in this page
  as you draw. Times are from this device."

*Acceptance:* check A26 passes; the copy pass touches every user-facing string in the UI files and in README's
first screen.

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
final score · A25 hostile-origin page cannot start a companion run · A26 plain words: collect every visible string
and every hint text; average sentence ≤ 12 words, none > 20, Flesch–Kincaid grade ≤ 8, no word from a banned list
("utilise", "leverage", "performant", "very", "simply", "basically", "actually").

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
- [ ] **Copy pass (one owner, after all merges so it never conflicts):** rewrite every user-facing string to §6.4;
  move anything longer than one line into a 💡; A26 passes.
- [ ] Full A1–A26 run at four widths; real-browser tier on Chrome, Edge, Firefox, Safari iOS, one Android phone.
- [ ] Independent fresh-eyes review from screenshots and code only; fix findings; re-run.
- [ ] Freeze REF v1 on the reference device; regenerate `machine.json` with `make_examples.py machine`.
- [ ] README: how to use, what is measured and how, privacy, companion pairing. Deploy (D1).

---

## 11. Round 2: owner changes after the first build (14 items)

State today: all 10 streams merged, 26 of 31 checks pass on a fresh build (5 tier-3 skips), the real-Hub smoke run
passes, `dist` is 32 MB. These 14 requests change the product. Each item says what it **overrides**, who owns it, the
exact design, and how we check it.

### 11.1 Decisions (read before the items)
| # | Decision | Overrides |
|---|---|---|
| D5 | Models **download automatically**. No consent click. Size and a progress bar with Cancel stay visible (feedback, not a gate). | §0.3, S4 consent states, check A8 |
| D6 | **Both animations side by side** (Model left, Machine right) when wide, stacked when narrow. Side panels are **closed by default** and open with a button. | §3 S1 "stage + always-open rail" |
| D7 | **Light and dark mode**, following the system setting, with a manual toggle that is remembered. | §6.1 tokens (dark only) |
| D8 | **Name first.** One field on the first visit, kept only on this device, shown in the top bar, score hero and share card. Never sent anywhere. | privacy chip text |
| D9 | **Stress test and robustness test removed** from the zoo. The compare card, draw pad and five nets stay. | zoo cards, README zoo section |
| D10 | Defaults are the **smallest models that still give a good result** (target ≤ ~100 MB each, verified by a real run). Bigger models stay in the picker. | `examples/index.json` |
| D11 | **Vibrant look**: a richer colour system with one signature gradient, glow on live parts, colourful layer types and pillars, in both themes. Value colours (amber +, blue −) keep their meaning. | §6.1 palette, §6.3 plate tints (desaturated) |
| D12 | **Speed is a feature**: hard budgets for load, first animation, frame time and memory (§11.5). Anything over budget is a bug. | §3 S1 budgets |

### 11.2 The 14 items

**R2-1 Language input for the language model** (S6 UI; S4 data)
- A language picker next to the prompt: English, Español, Français, Deutsch, हिन्दी, 中文, العربية, Português.
  Picking one fills the box with a short default prompt in that language ("La capital de Francia es").
- The user can type anything. Token tiles show the real text (no "?" boxes: check the font covers each script).
- If the model is English-only, show one line ("This model knows English best.") and a button that switches to the
  smallest multilingual model in the catalog. Whisper gets the same picker for the spoken language when it supports it.
- *Check A34:* each of the 8 languages fills a prompt and runs with no page error; tiles render; the English-only note shows.

**R2-2 Download automatically** (S4 store; S6 UI)
- On load the default model starts downloading by itself and the run starts when it is ready. The first-visit card
  becomes a slim progress strip: "Getting SmolLM2 · 82 MB · 41 %" with `Cancel`.
- A big model picked later also starts at once, with its size beside the bar. Cellular or `saveData` adds one quiet line; nothing blocks.
- While it downloads, the scene plays the recorded run so the page is never empty.
- *Check A8′:* a model request starts ≤ 2 s after load with no click; the bar updates ≥ 1/s.

**R2-3 Floating explainer on every animation** (S7 builds `<Explainer>`; S5, S6, S8 mount it)
- A small floating card near each animation, 2–3 short lines ("Each dot is a word. Lines show what it listens to.").
- **It appears by itself on each page refresh** for about 6 s (staggered per animation), then fades.
- A 💡 bulb stays next to each animation. Hovering or clicking it shows the card again; **the card vanishes as soon as
  the mouse leaves the bulb**. Touch: tap opens, tap elsewhere closes. Esc closes. It never blocks the 3D.
- Copy per animation (≤ 3 lines, Hemingway): real model, machine (incl. what the colours mean), each tiny net, inspector, draw pad.
- *Check A27:* on load each visible animation shows its card and it hides ≤ 7 s later; hover shows it; mouse-leave
  hides it ≤ 300 ms; no overlap with controls (A2 still passes).

**R2-4 Layout: tight margins, side by side, side panel closed** (S1; S5 and S6 fill the drawers)
- Wide (≥ 1000 px): a `.pair` grid, **Model | Machine**, each stage as tall as the column allows (`min(80dvh, …)`),
  8 px gap and 8 px page margin. The canvas is the card: no extra padding or borders around it.
- The side panel becomes a **drawer, closed by default**: a `Details` tab on the stage edge opens it over the stage
  (340 px, slides in with `transform`). Esc or a click outside closes it. Remembered per section.
- Narrow (< 1000 px): the sections stack and the drawer becomes the bottom sheet, closed by default.
- *Check A13′:* side by side at 1480 and 1100 with ≤ 16 px between stages; stacked at 390; drawers closed on a fresh
  profile; opening one causes no layout shift (CLS ≤ 0.02); A5 and A6 still pass.

**R2-5 The machine animation freezes: measure, then fix** (S8 diagnoses and fixes the scene; S2 only if a test blocks the main thread)
- Measure first: a Chrome performance trace and rAF deltas while (a) idle, (b) `Test all` runs, (c) the journey plays,
  (d) a 16-core layout. Record long tasks, GPU time, React renders per second and draw calls.
- Likely causes to rule in or out: the GPU benchmark and `layerFrames` on the main thread; 10 Hz telemetry re-rendering
  every subscriber; allocations every frame in `PowerScene`; many `<Html>` labels writing the DOM every frame; bloom
  at DPR 2; the frame loop running while hidden.
- Fixes, as the trace says: move blocking work to workers or slice it to ≤ 8 ms; narrow store selectors; label text at
  4 Hz; reuse vectors; instanced meshes for repeated parts; faster DPR/bloom step-down; full pause when hidden.
- *Check A28:* during `Test all`, p95 frame ≤ 33 ms and no task > 100 ms on this PC; idle p95 ≤ 20 ms; before/after numbers in the report.

**R2-6 Smallest good default models** (S6 catalog; S4 selection logic)
- For each task, pick the smallest model that gives a good result, proven by a real run on WebGPU and on WASM, with its
  size read from the Hub (not from memory). Candidates to verify: SmolLM2-135M-Instruct (text), distilbert-base-uncased
  (fill-mask), distilbert-sst-2 (sentiment), a small image model (ViT q8 or smaller), whisper-tiny (speech), plus one small
  multilingual text model for R2-1.
- Code: `chooseDefault(task, caps)` returns the smallest catalog entry that passes `checkFit`; the `lite` profile prefers the smallest of all.
- *Check:* a README table, task · model · MB · time to first result here (WebGPU / WASM). Each default ≤ ~100 MB or the table says why.

**R2-7 Save everything: never download twice** (S4 model cache and settings; S1 service worker; S3 results)
- Model files stay in Cache Storage. Call `navigator.storage.persist()` automatically after the first good download so
  the browser keeps them. A line behind a 💡 says "Saved on this device: 82 MB · Clear".
- Remember: model, prompt, language, input per task, theme, name, drawer states, last results, history and the last journey.
- **Offline app shell:** one file, `web/public/sw.js` (the second allowed new file after `_headers`). It precaches the
  built assets and the `/ort/` runtime, is versioned by the build hash, and never caches Hub requests itself. A new
  version shows a one-line "New version · Reload" strip.
- *Check A10′:* the second load makes zero network requests for app files and model files and works with the network off.

**R2-8 Light mode and a UI polish pass** (S1 tokens and toggle; every stream uses tokens only)
- Light palette under `:root[data-theme="light"]` and under `prefers-color-scheme: light` (guarded by
  `:root:not([data-theme="dark"])`). Starting values, to be validated: `--bg #f6f7fb`, `--panel #ffffff`,
  `--surface #eef0f8`, `--line #d9deee`, `--fg #151a2e`, `--muted #4a5578`, `--faint #5d6890`, `--pos #b45d00`, `--neg #1f6fd1`.
- A sun/moon toggle in the top bar: System, Light, Dark. Remembered.
- 3D scenes, labels, plates, heatmaps and legends read the theme. Bloom is off in light mode; plates and outlines get a
  darker stroke so the layer types stay clear.
- Polish: 8-pt spacing, one card style, one button hierarchy (primary, secondary, text), tabular numbers, skeletons,
  220 ms easing on drawers and hovers only, icons instead of emoji in controls, focus rings in both themes.
- *Check:* A1 runs in both themes; **A29**: the toggle flips `data-theme`, persists, and no element keeps a dark-only
  colour in light mode; a fresh agent reviews screenshots of every view in both themes.

**R2-9 Compact dashboard: overall score on top, details below** (S5)
- A slim **score strip** above the two stages, always visible: `▲ 1,184 · Strong · 5 of 7 tested · ±2 % · Weakest: RAM · Test all`.
- Inside the Machine drawer, the same hero at the top, then **five pillar rows** (Compute, Memory, GPU, Storage, Model):
  a thin gradient bar on a log scale, the number, a small delta vs the last run, `Test` and a 💡. Click a row to expand
  its components (CPU 1-core and all cores; RAM and cache; …) with the existing Test cards. Connection and Energy sit under "More".
- 8 px outer margin, 12 px inside, no box inside a box.
```
┌ YOUR DEVICE · <name> ─────────────┐
│  ▲ 1,184   Strong   5 of 7 · ±2 % │
│  Weakest: RAM            [Test all]│
├───────────────────────────────────┤
│ Compute  ████████░░  1,340  +62  ▶ │
│ Memory   ██████░░░░    928       ▶ │
│ GPU      ███████░░░  1,100       ▶ │
│ Storage  █████░░░░░    776       ▶ │
│ Model    ████░░░░░░      —       ▶ │
│ More ▾   Connection · Energy        │
└───────────────────────────────────┘
```
- *Check A30:* the strip is visible without opening anything; the hero is first in the drawer; five rows show; one
  click expands a row; no nesting deeper than 2; A2, A4 and A19 still pass.

**R2-10 Remove the stress test and the robustness test** (S6)
- Delete `StressCard`, `RobustCard`, `Fx`/`applyFx`/`FX0`/`isNeutral`, `SWEEP_LEVELS`/`accuracyAt`/`runSweep`, the sweep
  state in `zooStore.ts`, the noise/shift/blur controls, their CSS and their tests. Keep `CompareCard`, the draw pad, the
  digit picker, the five nets and their timing. Update the README and hints.
- *Check A33:* no `Stress`, `Robust`, `sweep` or `applyFx` left in `web/src`; build, tests and L5 pass.

**R2-11 Name at the start** (S1 card; S4 store; S5 shows it; S3 stores it)
- First visit: a small centred card before anything else, "What's your name?", one field, Enter to continue, and a
  💡 ("Stays on this device. It goes on your score card."). Required; a "Use Guest" link for people who prefer not to type.
- Kept in `localStorage` (`ns.name`). Shown in the top bar, the score hero and the share card and JSON. Change it from the top bar.
- *Check A31:* a fresh profile sees the name card first; it never returns after; the name shows in the hero and the share
  PNG; no network request carries it; a reload keeps it.

**R2-12 Draw-a-digit: simpler and easier** (S6)
- One big square pad (≥ 280 px, fills the column on phones), a thick smooth brush, mouse, touch and pen through Pointer Events.
- Drawing recomputes all five nets live (at most once per frame) and auto-centres and scales the digit like MNIST, so guesses are good.
- Three controls only: **Clear**, **Undo** (last stroke), and a row of **0–9 chips** ("Try a digit"). The rest goes with R2-10.
- A big result line under the pad: "I see a **7** · 94 %", runner-up in muted text, and one small pill per net with its
  guess (colour plus a shape glyph).
- An empty pad shows a faint dashed guide and "Draw a number". Keys: C clears, Z undoes.
- *Check A32:* drawing a 3 with pointer events updates the result ≤ 300 ms and shows 3; the pad is ≥ 280 px at 390;
  Clear and Undo work; touch drawing works; zoo unit tests still match PyTorch.

**R2-13 Vibrant and visually appealing** (S1 design tokens and shell; S8 scenes; S5, S6, S7 apply)
- **Colour system**, validated with the palette tool in both themes:
  - Signature gradient `--brand: linear-gradient(135deg, #7c5cff, #22d3ee 55%, #ff7ab6)` on the logo, the primary
    button, the score hero number and progress bars. Used sparingly (≤ 4 places on screen).
  - Layer types get vivid but distinct hues (embedding cyan, attention violet, MLP amber, conv teal, pool mint,
    recurrent pink, norm slate, output lime) on plates and labels at 12–16 % opacity, shape glyphs kept. Nodes keep the
    amber/blue value meaning.
  - Pillars get one hue each (Compute violet, Memory cyan, GPU pink, Storage lime, Model amber) for bars and chips, with a
    glyph and a label so meaning never rests on colour alone.
- **Depth and light:** soft glow on live parts (emissive pulse on the active block and the busy core), subtle grain-free
  background gradient (dark: deep indigo to navy; light: white to lavender), cards with a 1 px gradient border on hover.
- **Motion with purpose:** a 600 ms intro on first load (stages fade and rise in sequence), the score number counts up
  once, bars fill with a spring; all disabled under reduced motion and none longer than 600 ms.
- **Type:** one display face for headings and the score (self-hosted, subset, `font-display: swap`), Inter-like UI text,
  mono for numbers. Bigger hero number (`--t4` 44 px).
- *Check:* A1 contrast still passes in both themes; a fresh design reviewer rates screenshots of every view in both
  themes against a short rubric (hierarchy, colour harmony, consistency, clarity) and lists fixes; fixes land before release.

**R2-14 Fast, smooth, quick to load** (S1 build and shell; S8 scenes; S4 model load; S10 measures)
- **Load budget** (cold cache, 20 Mbit, mid laptop): first paint ≤ 1.0 s; interactive top bar ≤ 1.5 s; first animation
  frame ≤ 2.5 s; repeat visit (service worker) first frame ≤ 1.0 s.
- **Bytes:** first JS ≤ 90 kB gzip; three.js chunk ≤ 280 kB gzip; Transformers.js and ORT load only when a model runs
  (they already do); fonts subset ≤ 40 kB; no unused drei/postprocessing imports (tree-shake check).
- **Start-up order:** paint the shell and a static poster of each scene instantly (a small pre-rendered image per
  scene), start the 3D when the stage is visible and the main thread is idle (`requestIdleCallback`), then fetch the
  model. Preload the critical chunk and font with `<link rel="modulepreload">` / `preload`.
- **Smooth:** p95 frame ≤ 16.7 ms idle and ≤ 33 ms during tests (A28); no long task > 50 ms after first frame except
  model compile; memory ≤ 400 MB on the page with the default model.
- **Runtime:** narrow store selectors everywhere, throttled label text, instanced meshes, shared geometries and
  materials, render on demand when nothing moves, `content-visibility:auto` for off-screen cards.
- *Check A35:* the load budget measured by the harness with CDP throttling (cold and warm), JS chunk sizes from the
  build manifest, long-task count via PerformanceObserver, memory via `performance.measureUserAgentSpecificMemory`
  where available. Over budget fails.

### 11.3 Contracts to freeze first (gate, about 1 h, coordinator)
- `data-theme` on `<html>`, the light token set, the brand gradient and the pillar and layer hue tokens (S1 publishes).
- Drawer state: `railOpen: Record<'model'|'machine', boolean>` and `setRail(id, open)` in `store.ts`; class names
  `.pair`, `.drawer`, `.score-strip`.
- Name: `name`, `setName()` in `store.ts` (`ns.name`); the name card in `App.tsx`.
- `<Explainer id text placement? />` and `useExplainerIntro()` in `charts.tsx`.
- Auto-download: `autoStart()` in `store.ts`; `pendingDownload` stays only as the progress holder.
- Theme hook for 3D: `useTheme()` returning `'light'|'dark'` plus the resolved token values (S1, in `aspect.tsx`).

### 11.4 Streams, order, merge
| Stream | Items | Files |
|---|---|---|
| S1 | R2-4, R2-7 (sw.js), R2-8, R2-11 (card), R2-13 (tokens, shell), R2-14 (build, start-up order, posters) | `App.tsx`, `main.tsx`, `aspect.tsx`, `styles.css`, `index.html`, `vite.config.ts`, `public/sw.js` |
| S4 | R2-2, R2-6 (logic), R2-7 (persist, settings), name store, R2-14 (model load) | `api.ts`, `store.ts` |
| S7 | R2-3 (Explainer), light and vibrant styles for inspector and heatmap | `charts.tsx` |
| S6 | R2-1, R2-2 (UI), R2-6 (catalog), R2-10, R2-12, Explainer on the model and zoo | `ZooUI.tsx`, `zooStore.ts`, `nets.ts`, `zoo.test.ts`, `public/examples/index.json` |
| S5 | R2-9, name in hero and share, Explainer on the machine, pillar colours | `MachineUI.tsx`, `PowerUI.tsx`, `panels.tsx` |
| S8 | R2-5, theme and vibrant colours in scenes, tighter camera fit for half-width stages, scene posters for R2-14 | `ZooScene.tsx`, `PowerScene.tsx` |
| S3 | name and theme in results and export | `score.ts`, `hwStore.ts` |
| S2 | R2-5 only if a test blocks the main thread | `browserBench.ts`, `benchWorker.ts` |
| S10 | rewrite A8, A10, A13; add A27–A35; A1 in both themes; README | `tests/e2e/**` |
| S9 | no change | none |

Order: gate (contracts) → S1, S4, S7 (they publish what others use) → S6, S5, S8, S3, S2 → S10 → copy pass → full
harness in both themes → real-browser tier → design review → tick this file.
Merge order: S7, S4, S1, S8, S6, S5, S3, S2, S10. Every merge runs `tsc`, unit tests, build and a harness subset.

### 11.5 New and changed checks
A8′ download starts by itself ≤ 2 s · A10′ second load fully offline · A13′ side by side, drawers closed ·
A27 explainers appear and vanish · A28 frame budget during Test all · A29 theme toggle, no dark leftovers ·
A30 score strip and pillar rows · A31 name first · A32 draw pad · A33 stress and robustness gone · A34 eight languages ·
A35 load and runtime budget. A1 runs in both themes. Target: all green on a fresh build, plus tier 3 on the real Hub.

### 11.6 Risks
- Auto-download on mobile data can surprise people: small defaults (R2-6), a visible Cancel and a quiet note.
- A service worker can serve stale files: versioned by build hash, plus a "New version · Reload" strip.
- Side by side halves each stage's width: the camera fit and label chips must re-flow (S8), tested at 1100 and 1480.
- Vibrant colour can hurt contrast and meaning: tokens validated in both themes; value colours never reused as decoration.
- The name is personal data: local only, shown only on the score card, never in requests (A12).

### 11.7 Review: what makes this plan state of the art (changes folded in)
Checked against current web practice; each line is a change to the items above.
1. **Run the model in a Web Worker** (new, S4): Transformers.js inside a dedicated module worker, the page talks to it
   by messages (`load`, `run`, `progress`, `frame`, `cancel`). The main thread never stalls during download, compile or
   inference, which removes the main cause of jank while a model runs. Frames stream back as transferable buffers.
2. **Warm start**: `<link rel="preconnect">` to `huggingface.co` and its CDN; the model download starts in the worker
   at the same moment the 3D starts, not after it; WebGPU shader compile happens once and the session stays warm.
3. **Modern CSS for themes**: `color-scheme: light dark` plus `light-dark()` in the tokens, so one token list serves
   both themes; the toggle sets `data-theme` and `color-scheme`; theme change uses a View Transition.
4. **Popover API + CSS anchor positioning** for the Explainer and hints (native top layer, no z-index fights), with a
   JS fallback where anchor positioning is missing.
5. **Adaptive 3D quality**: drei `PerformanceMonitor` drives DPR and bloom (step down in ≤ 10 frames, up slowly);
   `frameloop="demand"` when nothing animates; shared geometries/materials; instancing for repeated parts.
6. **Smooth drawing**: Pointer Events with `getCoalescedEvents()` and `touch-action: none` on the pad; strokes as a
   path, recompute once per frame; the digit is cropped to its box and scaled to the nets' 8×8 grid with antialiasing.
7. **Caching done right**: hand-written service worker with cache-first for hashed assets and network-first for
   `index.html`; model files in Cache Storage (Transformers.js); `storage.persist()` after the first good download
   (Chrome grants silently for engaged sites; Firefox may ask once).
8. **Multilingual without a big default**: the default stays the smallest English model; picking a non-English
   language switches to the smallest multilingual model and downloads it then (auto, with progress). Its size is
   verified on the Hub before it enters the catalog.
9. **Budgets enforced by the harness**: chunk sizes from the build manifest, CDP-throttled cold and warm loads, long
   tasks and frame times, so "fast" cannot regress silently.
10. **One source of motion truth**: all motion tokens (`--d1..3`, easing) and `prefers-reduced-motion` respected by
   CSS, the 3D camera and the count-up animations alike.

Rejected after review: pre-rendered scene poster images (extra bytes and a build step; a fast first 3D frame with a CSS
skeleton gives the same result); a UI framework or component library (more bytes, fights the token system).

### 11.8 To-do list by lane (lanes run in parallel; a lane's items run in order)
**Gate G (coordinator, first, ~1 h)**
- [ ] G1 Freeze contracts in §11.3 + the worker message API (`load|run|cancel` → `progress|frame|done|error`).
- [ ] G2 Create worktrees r2-s1 … r2-s10 from master; brief each lane with its items and checks.

**Lane 1 · S1 shell, theme, look, speed (`App.tsx`, `main.tsx`, `aspect.tsx`, `styles.css`, `index.html`, `vite.config.ts`, `public/sw.js`)**
- [ ] 1.1 Tokens with `light-dark()`, light palette, brand gradient, pillar and layer hues; validate contrast (R2-8, R2-13).
- [ ] 1.2 Theme toggle (System/Light/Dark), `useTheme()` for 3D, View Transition on switch (R2-8).
- [ ] 1.3 `.pair` side-by-side layout, 8 px margins, drawers closed by default, score-strip slot (R2-4).
- [ ] 1.4 Name card first, name in top bar (R2-11).
- [ ] 1.5 Service worker + "New version" strip (R2-7).
- [ ] 1.6 Start-up order, preconnect/preload, font subset, chunk budget, intro motion (R2-14, R2-13).
**Lane 2 · S4 models (`api.ts`, `store.ts`)**
- [ ] 2.1 Model worker (load/run/cancel/progress/frames) and switch `runInBrowser` onto it (§11.7-1).
- [ ] 2.2 Auto-download + `autoStart()`, progress holder, Cancel, quiet cellular note (R2-2).
- [ ] 2.3 `chooseDefault(task, caps)`, multilingual switch hook (R2-6, R2-1).
- [ ] 2.4 `persist()` after first download, settings memory, name store, drawer state store (R2-7, R2-11, R2-4).
**Lane 3 · S7 explainer and inspector look (`charts.tsx`)**
- [ ] 3.1 `<Explainer>` with Popover API + anchor positioning, intro on refresh, bulb hover/leave (R2-3).
- [ ] 3.2 Inspector, heatmap, legend and hints in both themes and the vibrant palette (R2-8, R2-13).
**Lane 4 · S6 model section and zoo (`ZooUI.tsx`, `zooStore.ts`, `nets.ts`, `zoo.test.ts`, `examples/index.json`)**
- [ ] 4.1 Remove stress and robustness everywhere (R2-10).
- [ ] 4.2 New draw pad (R2-12).
- [ ] 4.3 Language picker + prompts + English-only note (R2-1).
- [ ] 4.4 Progress strip instead of the start card; catalog of smallest verified defaults with a README table (R2-2, R2-6).
- [ ] 4.5 Explainers on the model scene, each tiny net and the pad (R2-3).
**Lane 5 · S5 dashboard (`MachineUI.tsx`, `PowerUI.tsx`, `panels.tsx`)**
- [ ] 5.1 Score strip + hero + five pillar rows with expand, pillar colours (R2-9, R2-13).
- [ ] 5.2 Name in hero and share card; Explainer on the machine scene (R2-11, R2-3).
**Lane 6 · S8 scenes (`ZooScene.tsx`, `PowerScene.tsx`)**
- [ ] 6.1 Trace the machine freeze; write before numbers (R2-5).
- [ ] 6.2 Fix it; `PerformanceMonitor`, demand frameloop, instancing, throttled labels; after numbers (R2-5, §11.7-5).
- [ ] 6.3 Theme-aware and vibrant scenes: background, fog, plates, glow, layer hues; bloom off in light (R2-8, R2-13).
- [ ] 6.4 Camera fit and chip re-flow for half-width stages (R2-4).
**Lane 7 · S3 + S2 (`score.ts`, `hwStore.ts`; `browserBench.ts`, `benchWorker.ts`)**
- [ ] 7.1 Name and theme in results and export (S3).
- [ ] 7.2 Only if 6.1 blames a test: move or slice the blocking work (S2).
**Lane 8 · S10 checks (`tests/e2e/**`)** (starts at once with mocks; tightens as lanes merge)
- [ ] 8.1 Rewrite A8, A10, A13; add A27–A35; A1 in both themes; budget numbers from the build manifest.
**Finish F (coordinator, after merges)**
- [ ] F1 Merge in order S7, S4, S1, S8, S6, S5, S3, S2, S10; checks after each.
- [ ] F2 Copy pass (Hemingway, §6.4) over every new string, in both themes.
- [ ] F3 Full harness, dark and light, four widths; tier 3 on the real Hub and real companion.
- [ ] F4 Fresh-eyes design review from screenshots; fix; re-run.
- [ ] F5 README (defaults table, saving, themes, privacy), tick this file honestly.

## Backlog (not in this plan)
- Per-operation core attribution; real cache/DRAM counters; die temperature and RAM/SSD power (need admin counters).
- Model on the iGPU in the companion (DirectML/ORT). Live run of real VLMs (SmolVLM adapter).
- Per-device calibration of the browser power estimate via a one-time companion run.
- Neuron views (top-activating tokens per neuron) in the inspector.
