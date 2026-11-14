import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const URL = process.argv[3]
const MODE = process.argv[4] ?? 'companion'
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true,
  args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-webgpu'],
})
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !/api\/health|WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text())) problems.push(`[console] ${m.text()}`) })
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot', n) }
const hw = (fn, arg) => page.evaluate(fn, arg)

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hw?.getState().info, null, { timeout: 60000, polling: 300 })
console.log('source:', await hw(() => window.__hw.getState().source), '| cores:', await hw(() => window.__hw.getState().info.cpu.cores))
await page.click('header .seg button:has-text("Machine")')
await page.waitForTimeout(2500)
await shot(`${MODE}-p01-live`)
console.log('hud before:', (await page.locator('#sec-power .phud').innerText()).replace(/\s+/g, ' ').slice(0, 160))
if (MODE === 'browser') await hw((v) => window.__hw.getState().setAiInBrowser(v), process.env.AI === '1')
await page.click('#sec-power .phud button')
// mid-run
await page.waitForFunction(() => window.__hw.getState().benchStage === 'matmul_n', null, { timeout: 60000, polling: 300 })
await page.waitForTimeout(700)
await shot(`${MODE}-p02-recording-allcores`)
console.log('recording hud:', (await page.locator('#sec-power .phud').innerText()).replace(/\s+/g, ' ').slice(0, 160))
await page.waitForFunction(() => !window.__hw.getState().benchRunning, null, { timeout: 400000, polling: 500 })
const st = await hw(() => { const s = window.__hw.getState(); return { n: s.power?.samples.length, dur: s.power?.samples.at(-1)?.t, est: s.power?.estimated, keys: Object.keys(s.bench), summary: s.power?.summary, bench: s.bench, playing: s.pPlaying } })
console.log('power samples', st.n, 'duration', st.dur, 'estimated', st.est, 'replay playing', st.playing)
console.log('bench keys', st.keys.join(','))
for (const [k, v] of Object.entries(st.summary ?? {})) console.log('  ', k.padEnd(9), JSON.stringify({ s: v.seconds, avg: v.avg_w, peak: v.peak_w, J: v.joules }))
console.log('results', JSON.stringify({ m1: st.bench.matmul_1?.gflops, mn: st.bench.matmul_n?.gflops, ram: st.bench.dram?.copy_gbps, cacheMax: Math.max(...(st.bench.cache ?? [{ gbps: 0 }]).map((c) => c.gbps)), disk: st.bench.disk?.gbps, net: st.bench.net?.mbps, gpu: st.bench.gpu?.gflops ?? st.bench.gpu?.reason, ai: st.bench.ai?.tps, aiDev: st.bench.ai?.device }))
// scrub to points of the replay: all cores, memory, AI
await hw(() => window.__hw.getState().pPause())
for (const stage of ['matmul_1', 'matmul_n', 'gpu', 'ai']) {
  const t = await hw((stg) => { const s = window.__hw.getState().power.samples.filter((x) => x.stage === stg); return s.length ? s[Math.floor(s.length / 2)].t : null }, stage)
  if (t === null) continue
  await hw((tt) => window.__hw.getState().setPHead(tt), t)
  await page.waitForTimeout(1200)
  console.log(`replay @${t}s (${stage}):`, (await page.locator('#sec-power .phud').innerText()).replace(/\s+/g, ' ').slice(0, 170))
  await shot(`${MODE}-p03-replay-${stage}`)
}
// rewind check: the same playhead gives the same readout
await hw(() => window.__hw.getState().setPHead(3.3)); await page.waitForTimeout(400)
const a = await page.locator('#sec-power .phud .pbig').innerText()
await hw(() => window.__hw.getState().setPHead(9.9)); await page.waitForTimeout(400)
const b = await page.locator('#sec-power .phud .pbig').innerText()
await hw(() => window.__hw.getState().setPHead(3.3)); await page.waitForTimeout(400)
const c = await page.locator('#sec-power .phud .pbig').innerText()
console.log('rewind same:', a === c, `(${a} / ${b} / ${c})`)
// energy tab + score tab
if (!(await page.locator('#sec-power .tabs').count())) await page.click('#sec-power .detbtn')
await page.click('#sec-power .tabs button:has-text("Energy")'); await page.waitForTimeout(500)
await shot(`${MODE}-p04-energy`)
console.log('energy tab:', (await page.locator('.machine .pane').innerText()).replace(/\s+/g, ' ').slice(0, 600))
await page.click('#sec-power .tabs button:has-text("Score")'); await page.waitForTimeout(1500)
console.log('score:', (await page.locator('.hero-score').innerText()).replace(/\s+/g, ' ').slice(0, 80))
console.log('cards:', (await page.locator('.ccard .chead').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '))
await shot(`${MODE}-p05-score`)
// dive to the CPU
await hw(() => window.__hw.getState().dive(['cpu'])); await page.waitForTimeout(1800)
await shot(`${MODE}-p06-cpu-close`)
console.log('problems:', problems.length ? '\n  ' + [...new Set(problems)].join('\n  ') : 'none')
await browser.close()
