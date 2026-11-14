import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const URL = process.argv[3]
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true,
  args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
})
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !/api\/health|WebSocket|Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`) })
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot', n) }

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForSelector('.kv', { timeout: 30000 })
console.log('status:', (await page.textContent('.status')).trim(), '| badges:', (await page.locator('.badges').innerText()).replace(/\s+/g, ' '))
await page.waitForTimeout(1500)
for (const t of ['GPT-2', 'Qwen2.5-0.5B', 'SmolLM2-135M']) {
  await page.click(`.chips button:has-text("${t}")`)
  await page.waitForSelector('.kv .big', { timeout: 20000 })
  await page.waitForTimeout(500)
  const params = await page.locator('.kv dd.big').innerText()
  console.log(`loaded ${t}: params ${params}`)
}
await page.click('#sec-model .tabs button:has-text("Run")')
await page.click('button:has-text("Run"):not(.tabs button)')
await page.waitForSelector('.verify', { timeout: 30000 })
await page.waitForTimeout(2500)
console.log('replay top:', await page.locator('.topbars .tbl').first().textContent(), await page.locator('.topbars .tbv').first().textContent(), '|', (await page.textContent('.verify')).trim().slice(0, 60))
await shot('r01-run')
await page.click('#sec-model .tabs button:has-text("Edit")')
await page.click('button:has-text("Scan all heads")')
await page.waitForSelector('.hgrid .hc', { timeout: 20000 })
await page.click('.chips2 button:has-text("top 3 heads")')
await page.waitForSelector('.ab', { timeout: 10000 })
await page.waitForTimeout(600)
console.log('replay A/B:', (await page.locator('.abhead').innerText()).replace(/\s+/g, ' '), '|', (await page.locator('.abcols .gen').nth(1).innerText()).slice(0, 60))
await shot('r02-ab')
console.log('problems:', problems.length ? '\n  ' + [...new Set(problems)].join('\n  ') : 'none')
await browser.close()
