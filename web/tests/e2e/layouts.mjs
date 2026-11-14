// Other machines (16 cores, 4 DIMMs) and a phone-sized screen.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
const OUT = process.argv[2], BASE = process.argv[3]
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] })
const problems = []
const watch = (page) => {
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text())) problems.push(`[console] ${m.text()}`) })
}
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } }); watch(page)
await page.goto(`${BASE}/#machine`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hw?.getState().info, null, { timeout: 30000, polling: 300 })
await page.evaluate(() => {
  const s = window.__hw.getState(), i = structuredClone(s.info)
  i.cpu.cores = 16; i.cpu.threads = 32; i.cpu.name = 'Test layout: 16-core desktop'
  i.ram.sticks = [0, 1, 2, 3].map((k) => ({ slot: `P0 CHANNEL ${'AB'[k % 2]}`, gb: 16, mts: 6000, type: 'DDR5' }))
  window.__hw.setState({ info: i })
})
await page.waitForTimeout(2000)
await page.screenshot({ path: path.join(OUT, 'l-16core-machine.png') }); console.log('shot 16-core machine')
await page.click('header .seg button:has-text("Electricity")'); await page.waitForTimeout(2000)
await page.screenshot({ path: path.join(OUT, 'l-16core-power.png') }); console.log('shot 16-core power')
await page.close()

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); watch(phone)
for (const v of ['zoo', 'machine', '']) {
  await phone.goto(`${BASE}/?browser#${v}`, { waitUntil: 'domcontentloaded' })
  await phone.waitForTimeout(3500)
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  console.log(`phone ${v || 'model'}: horizontal overflow ${overflow}px`)
  await phone.screenshot({ path: path.join(OUT, `l-phone-${v || 'model'}.png`) })
}
console.log('problems:', problems.length ? '\n  ' + [...new Set(problems)].join('\n  ') : 'none')
await browser.close()
