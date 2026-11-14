# Neural Studio

Paste a Hugging Face link and see the model as a 3D machine, run it live, change it, and see how this computer
computes it. You can follow one prompt through the real hardware, watch the electricity of every test, and compare
five kinds of neural network (MLP, CNN, RNN, ViT, VLM) computing in the page.

## Three ways to run it

| Mode | How | What you get |
| --- | --- | --- |
| **Companion** (full) | `.\start.ps1`, open http://127.0.0.1:8000 | live runs of real Hub models, OS telemetry, native benchmarks, **measured** CPU power (RAPL, per core) |
| **Web app + companion** | host `web/dist` anywhere, run `start.ps1` on the PC | same as above: the page finds the companion on 127.0.0.1:8000 by itself |
| **Web app only** | host `web/dist` anywhere (any static server, any sub-path) | benchmarks from inside the browser (WebAssembly SIMD, Web Workers, browser storage, WebGPU), a real language model running in the page on the GPU, the network zoo, recorded runs. Power is an **estimate** (browsers cannot read power sensors) |

Add `?browser` to the URL to force web-app-only mode. If the companion is started with `NEURAL_STUDIO_TOKEN`, open
the page with `?token=...`.

```powershell
# once
python -m venv server\.venv
server\.venv\Scripts\python -m pip install -r server\requirements.txt psutil scikit-learn pillow pytest
cd web ; npm install ; npm run build ; cd ..

# every time
.\start.ps1                                         # companion + app on http://127.0.0.1:8000
python -m http.server 5180 --directory web\dist     # or: the app alone, as a static web app
```

### In VS Code

Open the `neural-studio` folder (File > Open Folder), then:
- **Ctrl+Shift+B** starts the companion (task "Neural Studio: start").
- **View in VS Code**: Ctrl+Shift+P > "Simple Browser: Show" > `http://127.0.0.1:8000/#machine`. VS Code's built-in
  browser may not offer WebGPU, so the GPU test can report "unavailable" there.
- **F5** opens it in Edge with the debugger attached (full WebGPU).
- Terminal > Run Task has the build, the unit tests, the web-app-only server and the live 3D browser test.

## The four views

They are not tabs: it is **one continuous page**. The four sections are stacked, each as tall as the window, and you
scroll through them (the page settles on each one). The top bar is the same everywhere: it jumps to a section and
shows which one you are at (`#model`, `#journey`, `#power`, `#zoo` in the URL open the page there). The Hugging Face
link and the example chips stay put, so the same model carries across Model, Journey and Electricity. Only the sections
on screen draw their 3D, so four live scenes do not slow each other (or the measurements) down. A plain mouse wheel over
a 3D scene scrolls the page; **Ctrl + wheel** (or a trackpad pinch) zooms it. On a phone the page scrolls normally and
only the row of section links stays on screen.

- **Model**: the probe reads `config.json` and the safetensors header with HTTP Range requests (no weights
  downloaded) and draws the model. Multi-part models such as SmolVLM show their vision tower, connector and
  language model as separate stacks. It runs live, with attention rebuilt from q and k, reversible edits, A/B
  comparison and a head scan.
- **Journey** and **Electricity** (the machine). Every part of the 3D machine shows its live numbers on its label (CPU
  load, clock and watts, each core, RAM in use, SSD and network throughput), 10 times a second. The side panel (score,
  flow, live charts, speed, specs) is behind the **Details** button.
  - *Journey of a prompt* follows one prompt from keystroke to screen through the real CPU, caches, RAM, SSD and
    network, timed per operation. The timeline can be scrubbed and rewound. Double-click to dive: component, core
    (with both SMT threads), then one real dot product in cache lines. The RAM dive shows the KV cache growing.
  - *Electricity* is a **live** 3D view of the power in this machine: current flows from the power input through the
    voltage regulator into each core, with every core's colour, height and sparks driven by its own measured watts,
    10 times a second. It is live at all times: open any app and watch it change, and while the test runs every
    stage drives it as it happens. SSD and network glow from the OS disk and network counters. After the test, one
    click replays the recorded run (scrub and rewind); "Live now" goes back. You get energy per test, work per
    joule, per-core energy, thermal-throttle detection, and what the live 3D view itself costs.
  - The device score has sub-scores per component, live while measuring, with the spread across repeat runs.
- **Network zoo**: five tiny networks trained here on 8×8 handwritten digits, computed in the browser. Draw a digit
  and every network recomputes. A timeline plays each one's flow, and double-clicking any neuron, cell, memory unit or
  token shows its arithmetic with the real numbers. The VLM writes a caption word by word, and its attention arcs show
  where it looks. Beside the 3D view:
  - **All five networks** read the same image side by side (digit, confidence, measured time per image on this device).
  - **Stress test**: noise, shift and stroke width change the image every network sees.
  - **Robustness test**: accuracy of all five on the 48 test digits at six noise levels, drawn as one chart with a table view.

## What is where

| Path | What it does |
| --- | --- |
| `server/app/hub.py` | Hub access: config, safetensors header by Range, single-tensor reads, repo-id validation |
| `server/app/adapters.py` | tensor names to a typed graph, one stack per tower (VLMs) |
| `server/app/runner.py` | live forward pass, hooks, reversible edits, A/B compare, head scan |
| `server/app/hw.py` | hardware discovery, telemetry, benchmarks with power recording, per-operation timing |
| `server/app/power.py` | RAPL package and per-core power, effective clock, thermal zone (Windows performance counters) |
| `server/train_zoo.py` | trains and exports the five zoo networks |
| `server/make_examples.py` | records the replay packs the web app plays without a companion (`python make_examples.py machine` for the Machine pack) |
| `web/src/hw` | machine view: timeline, scenes, score, power, browser benchmarks (`wasmKernel.ts`: hand-written WASM SIMD) |
| `web/src/zoo` | network zoo: forward passes and stress tests (`nets.ts`), state (`zooStore.ts`), 3D scene, UI (`ZooUI.tsx`, including the comparison and robustness cards) |
| `web/tests`, `server/tests` | unit tests (`npm test`, `pytest`); `web/tests/e2e` drives the real app in Edge |

## Checked on the test PC (Ryzen 7 8745HS, Radeon 780M, DDR5-5600, NVMe Gen4 x4)

| Measurement | Companion (native) | Web app only |
| --- | --- | --- |
| One core, all cores | 125–128, 534–634 GFLOP/s | 37, 179–202 GFLOP/s (WASM SIMD) |
| RAM, cache peak | 39–41, 117–133 GB/s | 54, 208 GB/s (memcpy) |
| GPU (WebGPU) | 290–398 GFLOP/s | 290–364 GFLOP/s |
| SmolLM2-135M writing | 23–24 tokens/s (PyTorch fp32, CPU) | 75–86 tokens/s (WebGPU q4f16), 37 (WASM q8) |
| CPU package power | idle 10–12 W, one core 25–27 W, all cores 52–55 W, model 42 W | estimated from a model |
| Device score | 1,138–1,205 | 1,134 |

## Honest notes

- Scores are ratios to fixed reference values (1000 = a recent mainstream laptop). They are a yardstick for this
  app, not an industry benchmark. Browser-mode references are scaled so this test PC scores the same both ways.
- Power is measured only for the CPU package and its cores (RAPL). RAM, SSD and network supplies are not metered, so
  in 3D they glow with activity only. In web-app-only mode every watt is an estimate, and labelled so.
- The thermal zone is an ACPI board sensor, not the CPU die.
- The 3D view stays live while tests run. On a laptop chip the GPU that draws it is inside the package being
  measured, so while measuring it draws at 30 frames a second at 1x resolution, and pauses for the idle baseline
  (1.5 s) only. The next 1.5 s ("idle, drawing the live 3D view") measure its cost, shown in the Energy tab: about
  +3.5 W in a quiet run on the test PC. Background activity can hide a difference that small; the tab says so when
  it does. Scores with the live view were 1,049–1,175 against 1,138–1,205 without it.
