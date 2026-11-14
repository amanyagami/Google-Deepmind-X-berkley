# Browser end-to-end checks

These drive the real app in Microsoft Edge (playwright-core, no bundled browser) on the real GPU and print what they
measured; each ends with `problems: none` when the page threw no errors. Screenshots go to the folder given first.

| Script | Needs | Checks |
| --- | --- | --- |
| `power.mjs <out> http://127.0.0.1:8000/#machine companion` | companion | full test with RAPL power, 3D replay, rewind, Energy and Score tabs |
| `power.mjs <out> "http://127.0.0.1:5180/?browser#machine" browser` (`AI=1` to include the language model) | static server | the same, measured from inside the browser |
| `browsermode.mjs <out> "http://127.0.0.1:5180/?browser#machine"` | static server | recorded journey, measured reference replay, in-browser test, scores |
| `zoo.mjs <out> "http://127.0.0.1:5180/?browser#zoo"` | static server | five networks, calculation cards, a hand-drawn digit |
| `models.mjs <out>` | companion | SmolVLM stacks, journeys for GPT-2 and Qwen2.5 with their dot products |
| `layouts.mjs <out> http://127.0.0.1:8000` | companion | 16-core / 4-DIMM layout, phone width without overflow |
| `replay.mjs <out> "http://127.0.0.1:5180/?browser"` | static server | the model view from recorded runs |
| `idlecost.mjs http://127.0.0.1:8000/#machine` | companion | how many watts each page state costs |

Static server: `python -m http.server 5180 --directory web/dist`. Unit tests: `npm test` (web) and
`server\.venv\Scripts\python -m pytest server/tests`.
