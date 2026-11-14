// SmolVLM in the model view (multi-stack), then the machine journey for GPT-2 and Qwen2.5 (never clicked before).
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
const OUT = process.argv[2]
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-webgpu'] })
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message} @ ${(e.stack ?? '').split(String.fromCharCode(10)).slice(1, 5).join(' | ')}`))
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`) })
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot', n) }
await page.goto('http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__studio?.getState().backend === 'online', null, { timeout: 30000, polling: 300 })
await page.fill('#repo', 'https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct')
await page.click('.urlform button')
await page.waitForFunction(() => window.__studio.getState().probe?.graph?.stacks?.length > 1, null, { timeout: 60000, polling: 300 })
await page.waitForTimeout(2500)
console.log('vlm facts:', (await page.locator('.kv').innerText()).replace(/\s+/g, ' ').slice(0, 300))
await shot('m-smolvlm')
// back to a text model, then the machine journey for GPT-2 and Qwen
for (const [title, repo] of [['GPT-2', 'openai-community/gpt2'], ['Qwen2.5-0.5B', 'Qwen/Qwen2.5-0.5B']]) {
  await page.click('.seg button:has-text("Model")')
  await page.click(`.chips button:has-text("${title}")`)
  await page.waitForFunction((r) => window.__studio.getState().probe?.repo === r, repo, { timeout: 60000, polling: 300 })
  await page.click('.seg button:has-text("Machine")')
  await page.waitForFunction(() => window.__hw?.getState().info, null, { timeout: 60000, polling: 300 })
  await page.evaluate(() => window.__hw.setState({ journey: null }))
  await page.waitForTimeout(500)
  await page.click('#sec-power .mtl button:has-text("Start the journey")')
  await page.waitForFunction(() => window.__hw.getState().journey && !window.__hw.getState().journeyBusy, null, { timeout: 300000, polling: 1000 })
  const j = await page.evaluate(() => { const j = window.__hw.getState().journey; return { repo: j.repo, L: j.L, tokens: j.tokenize.tokens.length, prefill_ms: j.prefill.total_ms, tps: j.decode.tps, ops: j.decode.ops.length, eff: j.decode.effective_gbps, wb: j.decode.weight_bytes, chosen: j.sample.chosen, err: window.__hw.getState().journeyErr } })
  console.log(title, JSON.stringify(j))
  await page.evaluate(() => { const s = window.__hw.getState(); s.pause(); s.setPlayhead(s.tl.segs.find((x) => x.id === 'blocks').v0 + 1.5) })
  await page.waitForTimeout(1500)
  await shot(`m-journey-${title}`)
  await page.evaluate(() => window.__hw.getState().dive(['cpu', 'core2']))
  await page.waitForFunction(() => window.__hw.getState().micro, null, { timeout: 30000, polling: 500 })
  const m = await page.evaluate(() => window.__hw.getState().micro)
  console.log(title, 'microscope', m.op, 'length', m.length, 'dot', m.dot, 'model', m.module_output, 'err', m.match_err)
  await page.evaluate(() => window.__hw.setState({ micro: null, path: [] }))
}
console.log('problems:', problems.length ? '\n  ' + [...new Set(problems)].join('\n  ') : 'none')
await browser.close()
