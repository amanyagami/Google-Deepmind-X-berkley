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

## Deploy to Cloud Run

Cloud Run serves the web app only (browser mode). The `Dockerfile` builds `web/` and serves it with nginx on port
8080, with the same headers as `web/public/_headers` (set in `nginx.conf.template`; keep the two in step).
Replace `PROJECT_ID` and `REGION` (for example `europe-west1`).

```powershell
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud run deploy neural-studio --source . --region REGION --allow-unauthenticated --port 8080 --memory 512Mi --cpu 1 --min-instances 0
```

The last command prints the app's URL. Run it again to ship a new version.

Test the image on this PC first (needs Docker Desktop):

```powershell
docker build -t neural-studio .
docker run --rm -p 8080:8080 -e PORT=8080 neural-studio   # open http://127.0.0.1:8080
```

## What you see

One page, no tabs. **Model** (left) and **Machine** (right) sit side by side on a wide screen and stack on a phone.
Each has a **Details** drawer, closed until you open it (Esc or a click outside closes it). A slim score strip sits on top.

- **First visit.** Type your name (it stays on this device and goes on your score card). The default model downloads by
  itself with a progress bar and Cancel, then runs. Models are saved on this device: the second visit downloads nothing
  and works offline. Open the 💡 in the top bar to see what is saved and clear it.
- **Light and dark.** The toggle in the top bar follows your system and remembers your choice.
- **💡 explainers.** Each animation explains itself in a few short lines when the page opens. The 💡 next to it shows it
  again; it vanishes when the mouse leaves.
- **Model.** The real model as a 3D machine: your prompt as tiles, one sphere per token per block, attention heads and
  arcs, next-word scores. Types of layer differ in shape and colour. Pick a language for the prompt (8 to start), type
  anything, press Run. Click a block to open the inspector: weights as a heatmap that zooms down to the real numbers,
  vectors, and top-10 logits. Nothing loads until you click. The five tiny nets (MLP, CNN, RNN, ViT, VLM) sit in the same
  box: draw a digit on the big pad (or tap 0-9) and all five answer at once.
- **Machine.** Every part of the machine shows live numbers, and the same prompt is replayed through the real hardware
  (companion only). The score strip shows your overall score; the Machine drawer shows it again with five rows
  (Compute, Memory, GPU, Storage, Model). Click a row to open its tests; every test has a default input and "use my own".
  After "Test all" you get one score with how much was tested, the weakest part, and a share card.
- **Speed.** First JS is about 27 kB gzipped; the 3D loads when needed; models run in a Web Worker so the page never
  stalls. The service worker makes repeat visits instant.
- **Privacy.** Everything runs in your browser. Only model files come from Hugging Face. Your name never leaves the device.

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

## Default models (smallest good model per task)

Sizes are what the browser downloaded on this PC (real Hub, cold cache). "First result" is page load of the model plus the first answer, measured here with WebGPU / WASM. Run `web/public/examples/index.json` order: the first model of a task without a recording is the default.

| Task | Model | Download (WebGPU / WASM) | First result, cold (WebGPU / WASM) | Note |
| --- | --- | --- | --- | --- |
| Text | SmolLM2-135M-Instruct | 118 MB / 137 MB | 19 s / 19 s | Slightly over 100 MB: no smaller text model gave good sentences. |
| Text (old default) | DistilGPT-2 | 329 MB / 322 MB | 40 s / 40 s | The engine fetches more than the 85 MB quantized file. Kept in the picker only. |
| Fill-mask | DistilBERT base uncased | 72 MB / 68 MB | 9.8 s / 11.6 s | |
| Sentiment | DistilBERT SST-2 | 73 MB / 68 MB | 12 s / 10.4 s | |
| Image | MobileViT small | 7 MB / 6 MB | 12 s / 8.3 s | Smallest. Lower accuracy than ViT. |
| Image | ViT base patch16 | 51 MB / 88 MB | 9.6 s / 16.8 s | Better accuracy. |
| Speech | Whisper tiny (English) | 52 MB / 41 MB | 10.6 s / 8.7 s | |
| Speech, many languages | Whisper tiny | 52 MB / 41 MB | 11 s / 8.3 s | |
| Many languages (text) | none under 300 MB works yet | | | Gemma 3 270M (273 MB) failed to load in the browser. The language picker still works; the English-only note names the gap. |
