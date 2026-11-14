// The electricity view is live: before, during and after the test. Usage:
//   node tests/e2e/live.mjs <out-dir> http://127.0.0.1:8000/#machine
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const URL = process.argv[3]
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
const hud = async () => (await page.locator('#sec-power .phud').innerText()).replace(/\s+/g, ' ').slice(0, 150)
// the 3D canvas is on screen and drawing: two grabs of the visible canvas 300 ms apart differ
const drawing = async (tag) => {
  const c = page.locator('#sec-power .scenewrap canvas').first()
  const vis = await c.isVisible()
  const a = await c.screenshot(); await page.waitForTimeout(300); const b = await c.screenshot()
  console.log(`${tag}: canvas visible ${vis}, frames changing ${!a.equals(b)}`)
  if (!vis || a.equals(b)) problems.push(`${tag}: 3D not live`)
}

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hw?.getState().info, null, { timeout: 60000, polling: 300 })
await page.waitForFunction(() => document.querySelector('#sec-power .pbadge')?.textContent?.startsWith('live'), null, { timeout: 20000, polling: 300 })
await page.waitForTimeout(1500)
console.log('before test:', await hud())
await drawing('before test')
await shot('v01-live-idle')

await page.click('#sec-power .phud button:has-text("Run the test")')
const ORDER = ['idle', 'draw', 'matmul_1', 'matmul_n', 'dram', 'cache', 'disk', 'net', 'gpu', 'ai_load', 'ai', 'cool']
for (const st of ['matmul_1', 'dram', 'gpu', 'ai']) {
  // this stage or a later one (short stages can pass while the previous check runs)
  const got = await page.waitForFunction(([s, order]) => { const h = window.__hw.getState(); return !h.benchRunning || order.indexOf(h.benchStage) >= order.indexOf(s) }, [st, ORDER], { timeout: 200000, polling: 100 })
  if (!(await page.evaluate(() => window.__hw.getState().benchRunning))) break
  await page.waitForTimeout(300)
  console.log(`during ${st}:`, await hud())
  await drawing(`during ${st}`)
  await shot(`v02-live-${st}`)
}
await page.waitForFunction(() => !window.__hw.getState().benchRunning, null, { timeout: 400000, polling: 500 })
await page.waitForTimeout(1500)
const S = await page.evaluate(() => window.__hw.getState().power?.summary)
for (const k of ['idle', 'draw', 'matmul_1', 'matmul_n', 'ai']) if (S?.[k]) console.log('  ', k.padEnd(9), JSON.stringify({ avg: S[k].avg_w, peak: S[k].peak_w, J: S[k].joules }))
const B = await page.evaluate(() => { const b = window.__hw.getState().bench; return { m1: b.matmul_1?.gflops, mn: b.matmul_n?.gflops, ram: b.dram?.copy_gbps, gpu: b.gpu?.gflops, ai: b.ai?.tps } })
console.log('results', JSON.stringify(B), '| score', (await page.locator('.hero-score').innerText()).replace(/\s+/g, ' ').slice(0, 30))
if (!(await page.locator('#sec-power .tabs').count())) await page.click('#sec-power .detbtn')
await page.click('#sec-power .tabs button:has-text("Energy")'); await page.waitForTimeout(400)
console.log('energy note:', (await page.locator('.machine .pane').innerText()).match(/The live 3D view[^.]*\./)?.[0] ?? 'missing')
await page.click('#sec-power .tabs button:has-text("Score")')
console.log('after test:', await hud(), '| mode', await page.evaluate(() => window.__hw.getState().pMode))
await drawing('after test')
await shot('v03-live-after')
await page.click('#sec-power .mtl button:has-text("Replay the test")')
await page.waitForTimeout(2500)
console.log('replay:', await hud())
await shot('v04-replay')
await page.click('#sec-power .mtl button:has-text("Live now")')
await page.waitForTimeout(1200)
console.log('back to live:', await hud())
await page.click('header .seg button:has-text("Model")'); await page.waitForTimeout(800)
await page.click('header .seg button:has-text("Machine")'); await page.waitForTimeout(800)
await drawing('machine view after coming back')
console.log('problems:', problems.length ? '\n  ' + [...new Set(problems)].join('\n  ') : 'none')
await browser.close()
