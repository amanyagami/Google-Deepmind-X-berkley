# Browser end-to-end checks (stream S10)

One harness, any build. It drives Microsoft Edge through `playwright-core` (no bundled browser) and measures; it never asserts
absolute GFLOP/s. Screenshots, `report.json`, `a26-strings.txt` and `tier3.log` go to `%TEMP%\ns-s10`, never the repo.

```
cd web && npm run build && npx vite preview --port 5110 --host 127.0.0.1
node tests/e2e/run.mjs --base http://127.0.0.1:5110 [--grep A15,A2] [--tier 2|3] [--widths 1480,1100,820,390] [--query ?browser]
```
Prints PASS / FAIL / SKIP with the measured value per check and exits 1 on any tier-2 FAIL. Every check also fails if the page
raised an error (`pageerror`, `window.onerror`, `unhandledrejection`). A check whose feature is missing in the build is a SKIP
(`needs S5` ...), so the harness tightens as streams merge. Features are detected by the hooks listed below.
In tier 2 the page's own `/api` and `/ws` paths and port 8000 are blocked, so a running companion never leaks in (browser mode is forced).

| Tier | What | Run |
| --- | --- | --- |
| 1 | Unit tests (`npm test`: mocked fetch, fake `navigator.gpu`, injected clock) | owned by S2, S3, S4, S6 in `web/tests` |
| 2 | Mock end to end: Hub and `*.hf.co` stubbed in code (64x64 F32 safetensors fixture with a known value function, HTTP Range), companion refused, fake `navigator.gpu/storage/connection/getBattery/getUserMedia`, `WebAssembly.Memory` and `requestDevice` failures, offline, phone profile | default; gates every merge |
| 3 | Real Hub, real model (Xenova/distilgpt2), real companion on 8000, read only, no long power test; never gates | `--tier 3` |

Device profiles for `env.open({profile})` in `lib.mjs`: `nogpu mem saveData cellular battery quota mic oom phone`.
A25 starts a second local origin (blank page on a random port) and tries `fetch` and `WebSocket` to the companion; it needs the real companion running.
Playwright cannot stream a stubbed response, so the update rate of A9 is only gated against the real Hub (A9b, tier 3).

## Checks: what they measure, who makes them pass
| ID | Measures | Needs | Owner |
| --- | --- | --- | --- |
| A1 | min contrast of every visible text node (composited backgrounds; gradients skipped), 4.5:1, 3:1 large, at 4 widths | | S1 |
| A2 | pairwise overlap of buttons, links, inputs and `[data-label]` | | S1, S8 |
| A3 | every `[data-label]` inside its `[data-stage]` rect | S8 | S8 |
| A4 | min(w,h) of interactive boxes at 390 with touch: 40 px, 44 px inside `[data-dock]` | | S1 |
| A5 | `scrollWidth - innerWidth` at 390/820/1100/1480 | | S1 |
| A6 | `[data-primary]` (fallback `[data-dock] button`, `header .btn`) fully inside the first viewport at 4 widths | | S1 |
| A7 | first contentful paint, and Test click to `[data-score]`, at 20 Mbit (CDP throttle) | S5 | S1, S5 |
| A7b | 82 MB model first score at 20 Mbit, real Hub (tier 3) | S4 | S4 |
| A8 | no model-file request before the Start click; `[data-start]` text shows a size | S4 | S4, S6 |
| A9 | `[role=progressbar]` has valuenow/min/max (A9b: real update rate, tier 3) | S4 | S4, S6 |
| A10 | reload: zero Hub model requests, `[data-cached]` present | S4 | S4 |
| A11 | every W/J/Wh value sits in a card containing "estimated" or "≈" (or `[data-est]`) in browser mode | | S5 |
| A12 | every request goes to the origin, huggingface.co, `*.hf.co` or port 8000 | | S1 |
| A13 | first two `[data-panel]`: same top at 1100, same left at 390 | S1 | S1, S6 |
| A14 | 21-step resize with rAF deltas (p95 <= 20 ms) at DPR 3; canvas buffer = CSS size x min(DPR, `__scene.dprCap`) | S8 | S8 |
| A15 | select, then `[data-inspector]` <= 500 ms, Esc closes, `__inspector.zoomMax().value` equals the fixture tensor | S7, S6 | S7 |
| A16 | Tab x250: every `[data-test]`, `[data-block]`, `[data-start]` reached; outline >= 2 px and 3:1 | | S1, S5 |
| A17 | Hint: click opens, `aria-expanded`, leave closes <= 300 ms, outside tap on touch, popup inside viewport | | S7 |
| A18 | body text has ▲ and ○; inspector text has +/− before numbers | | S7, S8 |
| A19 | per `.card`/`.ccard`/`[data-card]`: <= 1 visible sentence of <= 120 chars (hints, buttons, `[data-detail]` excluded) | | S5, S6 |
| A20 | layout-shift sum during `[data-testall]` until `[data-score]` | S5 | S1, S5 |
| A21 | no-WebGPU, out-of-memory, offline, mic-denied each show `[data-error]` (text + button) <= 2 s, zero errors | S5, S6 | S4, S5, S6 |
| A22 | reduced motion: longest transition/animation on any element <= 1 ms; `__scene.camera.tweening` false | | S1, S8 |
| A23 | `[data-share]` download is a 1200x630 PNG with no host or UA strings in the file | S5 | S5 |
| A24 | `__score.final` with each component dropped never exceeds the full score (40 random sets) | S3 | S3 |
| A25 | a page from another local origin cannot POST a run or open the companion WebSocket | | S9 |
| A26 | visible strings of all sections plus every opened hint (prose lines only): avg sentence <= 12 words, max 20, FK grade <= 8, no banned word | | all (copy pass) |
| L1 | 3D canvases in model/zoo/machine change between two grabs 300 ms apart (was `live`) | | S8 |
| L2 | tour of sections and five networks, zero page errors (was `layouts`, `models`) | | all |
| L3 | measured replay: same playhead, same readout (was `power`, `replay`) | | S5 |
| L4 | recorded journey gives a numeric score (was `recscore`, `browsermode`) | | S3, S5 |
| L5 | five networks each produce an output (was `zoo`) | | S6 |
| L6 | companion idle watts, page open vs blank, information only (was `idlecost`; tier 3) | | |
| T1, T2 | tier 3 smoke: real Hub reachable, real companion answers, first real score | | |

## Hooks the owners expose (selectors and window APIs the checks use)
- S1: `[data-topbar]`, `[data-dock]` (all dock controls inside it), `[data-primary]` on the main action, `[data-panel]` on side-by-side panels, `[data-testall]` on Test all.
- S3: `window.__score = { components: string[], final(results: Record<componentId, number>) => number | {score:number} }`.
- S4/S6: `[data-start]` (text carries the size, e.g. "Start · 82 MB · about 20 s"), `[role=progressbar]` with `aria-valuenow/min/max`, `[data-cached]` once cached, `[data-picker]` on the model picker, `window.__zoo.getState().select({kind:'block',layer:0,index:0,name:'w'})` opening the tensor inspector.
- S5: `[data-test]` on every Test button (`data-test=gpu`, `data-test=mic`, ...), `[data-score]` on the score once a first score exists, `.card` or `[data-card]` on cards, `[data-est]` on estimated W/J values, `[data-share]` (starts a PNG download), `[data-error]` (message plus a button) for failures, `[data-detail]` for text exempt from the diet.
- S7: `[data-inspector]` card, `window.__inspector.zoomMax() => {name, r, c, value}`, keep `.hintbtn` / `.hintpop`.
- S8: `[data-label]` on label chips inside `[data-stage]`, `window.__scene = { dprCap, camera: { tweening: boolean } }`, `[data-block]` on keyboard-reachable blocks.
- S9: refuse a foreign `Origin` for `POST /api/*` and `/ws/*` (A25).

Unit tests: `npm test` (web) and `server\.venv\Scripts\python -m pytest server/tests`.
