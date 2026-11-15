# Kundali

Paste a Hugging Face link and see the model as a 3D machine, run it live, change it, and see how this computer
computes it. You can follow one prompt through the real hardware, watch the electricity of every test, and compare
five kinds of neural network (MLP, CNN, RNN, ViT, VLM) computing in the page.

## Three ways to run it

| Mode | How | What you get |
| --- | --- | --- |
| **Companion** (full) | `.\start.ps1`, open http://127.0.0.1:8000 | live runs of real Hub models, OS telemetry, native benchmarks, **measured** CPU power (RAPL, per core) |
| **Web app + companion** | host `dist` anywhere, run `start.ps1` on the PC | same as above: open the page with `?companion` and it finds the companion on 127.0.0.1:8000 (opened from localhost, it looks by itself) |
| **Web app only** | host `dist` anywhere (any static server, any sub-path) | benchmarks from inside the browser (WebAssembly SIMD, Web Workers, browser storage, WebGPU), a real language model running in the page on the GPU, the network zoo, recorded runs. Power is an **estimate** (browsers cannot read power sensors) |

Add `?browser` to the URL to force web-app-only mode. If the companion is started with `NEURAL_STUDIO_TOKEN`, open
the page with `?token=...`.

```powershell
# once
python -m venv server\.venv
server\.venv\Scripts\python -m pip install -r server\requirements.txt psutil scikit-learn pillow pytest
npm install ; npm run build

# every time
.\start.ps1                                         # companion + app on http://127.0.0.1:8000
python -m http.server 5180 --directory dist     # or: the app alone, as a static web app
```

### In VS Code

Open the `neural-studio` folder (File > Open Folder), then:
- **Ctrl+Shift+B** starts the companion (task "Kundali: start").
- **View in VS Code**: Ctrl+Shift+P > "Simple Browser: Show" > `http://127.0.0.1:8000/#machine`. VS Code's built-in
  browser may not offer WebGPU, so the GPU test can report "unavailable" there.
- **F5** opens it in Edge with the debugger attached (full WebGPU).
- Terminal > Run Task has the build, the unit tests, the web-app-only server and the live 3D browser test.

## Deploy to Cloud Run

Cloud Run serves the web app (browser mode) and the score leaderboard from one container. The `Dockerfile` builds
the repo root and runs `server-web/server.mjs`, one small Node 22 server (no framework) on port 8080. It serves `dist`
with the headers of `public/_headers` (it reads that file, so there is one place to change them), and the
leaderboard API. Scores are stored in Firestore in the same project. Replace `PROJECT_ID` and `REGION`
(for example `europe-west1`).

```powershell
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com

# once: the Firestore database (Native mode) for the leaderboard
gcloud firestore databases create --location=REGION

# once: let the service's account read and write Firestore. Cloud Run uses the Compute Engine default
# service account unless you pick another: PROJECT_NUMBER-compute@developer.gserviceaccount.com
gcloud projects describe PROJECT_ID --format="value(projectNumber)"
gcloud projects add-iam-policy-binding PROJECT_ID --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" --role="roles/datastore.user"

gcloud run deploy kundali --source . --region REGION --allow-unauthenticated --port 8080 --memory 512Mi --cpu 1 --min-instances 0 --set-env-vars GOOGLE_CLOUD_PROJECT=PROJECT_ID
```

The last command prints the app's URL. Run it again to ship a new version.

The API (same origin only; other sites get 403 and no CORS headers):

| Call | What it does |
| --- | --- |
| `POST /api/scores` | `{deviceId, name, score, pillars, tested, backend, appVersion}`. One row per device: its best score is kept, the latest score, date and visit count are updated. Stored as `scores/{sha256(deviceId)}`; the raw device ID is never stored. Body at most 4 kB; values are range-checked and the score must match its five parts; simple name blocklist; 10 writes per device and 30 per IP per hour (per instance). |
| `GET /api/leaderboard?limit=50` | top N by best score: rank, name, best, parts, date |
| `GET /api/leaderboard/me?deviceId=...` | this device's rank, even outside the top N |

Settings (environment): `KUNDALI_STORE=memory` keeps scores in memory (local runs and tests; also the default when
neither `GOOGLE_CLOUD_PROJECT` nor Cloud Run's `K_SERVICE` is set), `KUNDALI_FIRESTORE_DB` for a database other
than `(default)`, `KUNDALI_RATE_DEVICE`, `KUNDALI_RATE_IP`, `KUNDALI_ORIGINS` (extra allowed origins, comma separated).

Run it on this PC without Google Cloud, and test it:

```powershell
npm run build ; npm run install:server ; cd server-web
$env:KUNDALI_STORE='memory'; $env:PORT='8090'; node server.mjs     # open http://127.0.0.1:8090
node --test server.test.mjs                                        # validation, upsert, ranking, limits, headers
```

Test the image on this PC first (needs Docker Desktop):

```powershell
docker build -t kundali .
docker run --rm -p 8080:8080 -e PORT=8080 -e KUNDALI_STORE=memory kundali   # open http://127.0.0.1:8080
```

## What you see

One page, no tabs. **Model** (left) and **Machine** (right) sit side by side on a wide screen and stack on a phone.
Each has a **Details** drawer, closed until you open it (Esc or a click outside closes it). A slim score strip sits on top.

- **First visit.** Type your name. It goes on your score card and, after Test all, on the public leaderboard
  (tick "Keep me off the leaderboard" to send nothing). The default model downloads by
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
  After "Test all" you get one score with how much was tested, the weakest part, and a share card. The score also
  goes on the global **Leaderboard** (button next to Test all and Share): the top 50 devices by best score, and your
  own rank even outside the top 50.
- **Speed.** First JS is about 30 kB gzipped; the 3D loads when needed; models run in a Web Worker so the page never
  stalls. The service worker makes repeat visits instant.
- **Privacy.** Everything runs in your browser. Only model files come from Hugging Face. After Test all, your name,
  your score and its five parts go on the public leaderboard, with a random device ID that this browser keeps (the
  server stores only a hash of it). Tick "Keep me off the leaderboard" on the name card and nothing is sent.

## What is where

| Path | What it does |
| --- | --- |
| `server/app/hub.py` | Hub access: config, safetensors header by Range, single-tensor reads, repo-id validation |
| `server/app/adapters.py` | tensor names to a typed graph, one stack per tower (VLMs) |
| `server/app/runner.py` | live forward pass, hooks, reversible edits, A/B compare, head scan |
| `server/app/hw.py` | hardware discovery, telemetry, benchmarks with power recording, per-operation timing |
| `server/app/power.py` | RAPL package and per-core power, effective clock, thermal zone (Windows performance counters) |
| `server/train_zoo.py` | trains and exports the five zoo networks |
| `server/make_examples.py` | records the replay packs the web app plays without a companion; `python make_examples.py machine` rewrites the Machine fixture used by the unit tests (`web/tests/fixtures/machine.json`) |
| `src/hw` | machine view: timeline, scenes, score, power, browser benchmarks (`wasmKernel.ts`: hand-written WASM SIMD) |
| `src/zoo` | network zoo: forward passes and stress tests (`nets.ts`), state (`zooStore.ts`), 3D scene, UI (`ZooUI.tsx`, including the comparison and robustness cards) |
| `server-web/server.mjs` | Cloud Run server: static files with the security headers, leaderboard API, Firestore or memory store |
| `src/board.tsx`, `src/ui/Leaderboard.tsx` | leaderboard: device ID, opt-out, submit after Test all; the dialog (loaded on first open) |
| `tests`, `server/tests` | unit tests (`npm test`, `pytest`); `tests/e2e` drives the real app in Edge |

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
