// Live check of the reminder behaviour on a real model (not part of `npm test`;
// it needs an API key and makes 13 paid requests).
//
//   EVAL_API_KEY=sk-... node test/eval-examples.mjs
//   EVAL_BASE_URL=https://api.deepseek.com EVAL_MODEL=deepseek-chat (defaults)
//
// Each example from test/fixtures/examples.mjs is sent as a task with the
// plugin guidance as the system prompt, through an OpenAI-compatible
// /chat/completions endpoint. The script checks the shape of each reply and
// writes all replies to eval-replies.md for a human to read. Structure checks
// cannot judge whether the explanation is correct; read the replies.
import { writeFileSync } from 'node:fs'
import { guidance } from '../index.js'
import { examples } from './fixtures/examples.mjs'

const key = process.env.EVAL_API_KEY || process.env.DEEPSEEK_API_KEY
const base = (process.env.EVAL_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')
const model = process.env.EVAL_MODEL || 'deepseek-chat'
if (!key) {
  console.error('Set EVAL_API_KEY (or DEEPSEEK_API_KEY) to run the live eval.')
  process.exit(2)
}

const LABEL = '吱吱老师提醒你：'
const CAUTION = /(先别|不要|别直接|不能|风险|注意|确认|备份|冲突|泄露|作废|测试)/

function check(example, reply) {
  const at = reply.indexOf(LABEL)
  const results = { label: at >= 0, why: /为什么[:：]/.test(reply), sayIt: /能这样说[:：]/.test(reply) }
  if (example.beforeAction) {
    const firstThird = reply.slice(0, Math.max(80, Math.floor(reply.length / 3)))
    results.order = CAUTION.test(firstThird)
  } else {
    results.order = at > 0 && reply.slice(0, at).replace(/\s/g, '').length >= 10
  }
  return results
}

const rows = []
const log = [`# Live reminder eval\n\nmodel: ${model} @ ${base}\n`]
for (const example of examples) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: guidance.trim() }, { role: 'user', content: example.prompt }], temperature: 0.3 }),
  })
  if (!res.ok) throw new Error(`${example.key}: HTTP ${res.status} ${await res.text()}`)
  const reply = (await res.json()).choices?.[0]?.message?.content ?? ''
  const r = check(example, reply)
  rows.push({ key: example.key, ...r })
  log.push(`## ${example.key}${example.beforeAction ? '（应在操作前提醒）' : ''}\n\n> ${example.prompt}\n\n${reply}\n\n参考卡片：${example.card.point}\n`)
}
writeFileSync('eval-replies.md', log.join('\n'))

const mark = ok => (ok ? 'ok ' : 'NO ')
console.log('example          label order why  sayIt   (order = task first; for safety cases = caution early)')
for (const r of rows) console.log(`${r.key.padEnd(16)} ${mark(r.label)}   ${mark(r.order)}   ${mark(r.why)}  ${mark(r.sayIt)}`)
const hard = rows.filter(r => !(r.label && r.order && r.why))
console.log(`\n${rows.length - hard.length}/${rows.length} replies pass label + order + 为什么. 能这样说 is expected only when facts are verified. Replies: eval-replies.md`)
process.exitCode = hard.length ? 1 : 0
