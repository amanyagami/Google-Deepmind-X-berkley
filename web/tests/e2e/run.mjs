// Single entry. node tests/e2e/run.mjs --base http://127.0.0.1:5110 [--grep A15,A2] [--tier 2|3] [--widths 1480,1100,820,390] [--query ?browser]
import fs from 'node:fs'
import path from 'node:path'
import { launch, makeEnv, OUT } from './lib.mjs'
import { checks } from './checks.mjs'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const base = arg('base', 'http://127.0.0.1:5110').replace(/\/$/, '')
const grep = arg('grep') ? new RegExp(arg('grep').split(',').map((s) => `^${s}$`).join('|'), 'i') : null
const tier = +arg('tier', 2), widths = arg('widths', '1480,1100,820,390').split(',').map(Number), query = arg('query', '')
const LIMIT = 300000

const browser = await launch()
const env = makeEnv(browser, base, widths, query)
const probe = await env.open(); await probe.goto(); const have = await probe.features(); await env.closeAll()
console.log(`base ${base} | tier ${tier} | widths ${widths.join(',')} | features: ${Object.entries(have).map(([k, v]) => `${k}${v ? '+' : '-'}`).join(' ')} | out ${OUT}\n`)

const rows = []
for (const c of checks) {
  if (grep && !grep.test(c.id)) continue
  if ((c.tier ?? 2) > tier) { rows.push({ id: c.id, status: 'SKIP', value: `tier ${c.tier} only (use --tier 3)`, title: c.title }); continue }
  const miss = (c.needs ?? []).filter((n) => !have[n])
  let r, t = Date.now()
  if (miss.length) r = { status: 'SKIP', value: `needs ${miss.join('+')} (not in this build)` }
  else try { r = await Promise.race([c.run(env), new Promise((_, rej) => setTimeout(() => rej(new Error('check timed out')), LIMIT))]) } catch (e) { r = { status: 'FAIL', value: 'threw: ' + String(e.message).split('\n')[0].slice(0, 160) } }
  const errs = await env.closeAll()
  if (errs && r.status !== 'SKIP') r = { status: 'FAIL', value: `${errs} page error(s); ${r.value}` }
  rows.push({ id: c.id, title: c.title, tier: c.tier ?? 2, ...r, ms: Date.now() - t })
  console.log(`${r.status.padEnd(4)} ${c.id.padEnd(4)} ${String(r.value).slice(0, 150)}`)
}
await browser.close()
const n = (s) => rows.filter((r) => r.status === s).length
console.log(`\n${'ID'.padEnd(5)}${'RESULT'.padEnd(7)}CHECK / MEASURED`)
for (const r of rows) console.log(`${r.id.padEnd(5)}${r.status.padEnd(7)}${r.title}\n${' '.repeat(12)}${String(r.value).slice(0, 220)}`)
console.log(`\nPASS ${n('PASS')}  FAIL ${n('FAIL')}  SKIP ${n('SKIP')}`)
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ base, tier, widths, features: have, rows }, null, 1))
if (tier >= 3) fs.appendFileSync(path.join(OUT, 'tier3.log'), `${new Date().toISOString()} ${base}\n${rows.filter((r) => r.tier === 3).map((r) => `${r.id} ${r.status} ${r.value}`).join('\n')}\n`)
process.exit(rows.some((r) => r.status === 'FAIL' && (r.tier ?? 2) < 3) ? 1 : 0)
