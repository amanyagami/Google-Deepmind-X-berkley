// Screenshots for visual review: node tests/e2e/shots.mjs <base> <outdir> [tag] [--test]
import path from 'node:path'
import { launch } from './lib.mjs'
const base = process.argv[2] || 'http://127.0.0.1:8091', out = process.argv[3] || '.', tag = process.argv[4] || 'a', full = process.argv.includes('--test')
const b = await launch()
for (const [w, h, mobile] of [[390, 844, true], [1480, 900, false]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
  const shot = (n) => p.screenshot({ path: path.join(out, `${tag}-${w}-${n}.png`) })
  await p.goto(base, { waitUntil: 'load' }); await p.waitForTimeout(2000); await shot('1name')
  await p.fill('.namecard input', 'Asha').catch(() => {}); await p.click('.namecard button[type=submit]').catch(() => {})
  await p.waitForTimeout(5000); await shot('2model')
  if (mobile) { await p.click('.phonetabs button:nth-child(2)').catch(() => {}); await p.waitForTimeout(3500); await shot('3machine') }
  await p.click('.phud .nspeek button, .phud button').catch(() => {}); await p.waitForTimeout(700); await shot('3b-live')
  await p.keyboard.press('Escape')
  if (full) { await p.click('[data-testall]').catch(() => {}); await p.waitForFunction(() => document.querySelector('[data-score]'), null, { timeout: 200000 }).catch(() => {}); await p.waitForTimeout(3000); await shot('5score') }
  await p.click('[data-board]').catch(() => {}); await p.waitForTimeout(1500); await shot('6board')
  console.log(w, 'errors', errs.slice(0, 6), 'scrollW', await p.evaluate(() => document.documentElement.scrollWidth), 'labels', await p.$$eval('.mlabel', (e) => e.map((x) => x.textContent).slice(0, 12)))
  await ctx.close()
}
await b.close()
