import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
const OUT = process.argv[2], URL = process.argv[3]
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] })
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text())) problems.push(`[console] ${m.text()}`) })
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot', n) }
const z = (fn, a) => page.evaluate(fn, a)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__zoo?.getState().out, null, { timeout: 30000, polling: 300 })
for (const net of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) {
  await z((n) => window.__zoo.getState().setNet(n), net)
  await page.waitForFunction((n) => window.__zoo.getState().out && window.__zoo.getState().net === n, net, { timeout: 10000, polling: 200 })
  await z(() => window.__zoo.getState().pause())
  const T = await z(() => { const s = window.__zoo.getState(); return { T: [0].concat(0), total: null } })
  // middle of the flow, then the end
  await z(() => { const s = window.__zoo.getState(); s.setT(s.net === 'vlm' ? 6.5 : 3.6) }); await page.waitForTimeout(1600)
  await shot(`z-${net}-mid`)
  await z(() => { const s = window.__zoo.getState(); s.setT(1e9) }); await page.waitForTimeout(1600)
  await shot(`z-${net}-end`)
  const outTxt = (await page.locator('.ccard').first().innerText()).replace(/\s+/g, ' ').slice(0, 120)
  console.log(net, '|', (await page.locator('.zoohud').innerText()).replace(/\s+/g, ' ').slice(0, 110), '|', outTxt)
}
// calculation cards
for (const [net, sel] of [['mlp', { kind: 'neuron', layer: 'h1', index: 3 }], ['cnn', { kind: 'cell', layer: 'conv1', index: 2 * 64 + 27 }], ['rnn', { kind: 'neuron', layer: 'h5', index: 7 }], ['vit', { kind: 'token', layer: 'tokens', index: 16 * 6 }], ['vlm', { kind: 'imgtok', layer: 'img', index: 0 }]]) {
  await z((n) => window.__zoo.getState().setNet(n), net)
  await page.waitForTimeout(400)
  await z((s) => { const st = window.__zoo.getState(); st.pause(); st.setT(st.net === 'vlm' ? 7.5 : 1e9); st.select(s) }, sel)
  await page.waitForTimeout(1200)
  console.log('calc', net, '|', (await page.locator('.ccard.calc').innerText()).replace(/\s+/g, ' ').slice(0, 260))
  await shot(`z-${net}-calc`)
}
// draw a "1": a vertical stroke, and check the networks follow
await z(() => window.__zoo.getState().setNet('cnn'))
await page.click('.drawpad button:has-text("Clear")')
const box = await page.locator('.drawpad canvas').boundingBox()
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.1); await page.mouse.down()
for (let i = 0; i <= 12; i++) await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * (0.1 + i * 0.065))
await page.mouse.up()
await page.waitForTimeout(500)
for (const net of ['mlp', 'cnn', 'rnn', 'vit', 'vlm']) {
  await z((n) => window.__zoo.getState().setNet(n), net); await page.waitForTimeout(300)
  const r = await z(() => { const s = window.__zoo.getState(); if (s.net === 'vlm') return s.out.ids.map((i) => s.packs.vlm.vocab[i]).join(' '); const p = s.out.probs; const b = p.indexOf(Math.max(...p)); return `${b} (${(p[b] * 100).toFixed(0)}%)` })
  console.log('drawn stroke ->', net, r)
}
await z(() => { const s = window.__zoo.getState(); s.pause(); s.setT(1e9) }); await page.waitForTimeout(1200)
await shot('z-drawn-vlm')
console.log('problems:', problems.length ? '\n  ' + [...new Set(problems)].join('\n  ') : 'none')
await browser.close()
