import { chromium } from 'playwright-core'
const URL = process.argv[2]
const avgPower = async (secs = 3) => {
  const xs = []
  for (let i = 0; i < secs * 4; i++) { const r = await (await fetch('http://127.0.0.1:8000/api/hw/power')).json(); xs.push(r.pkg_w); await new Promise((r) => setTimeout(r, 250)) }
  return (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)
}
console.log('no browser:', await avgPower())
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] })
console.log('browser, blank page:', await avgPower())
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hw?.getState().info, null, { timeout: 60000 })
await page.waitForTimeout(2000)
console.log('machine view, live (3D drawing):', await avgPower())
await page.click('header .seg button:has-text("Machine")'); await page.waitForTimeout(2000)
console.log('machine view again (3D drawing):', await avgPower())
await page.evaluate(() => window.__hw.setState({ benchRunning: true }))
await page.waitForTimeout(1500)
console.log('machine view, 3D paused:', await avgPower())
await page.goto('about:blank'); await page.waitForTimeout(1500)
console.log('about:blank again:', await avgPower())
await browser.close()
