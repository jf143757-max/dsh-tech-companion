#!/usr/bin/env node
// Tech Companion ledger CLI. Used by the Hermes skill (through the terminal
// tool), by Hermes cron gate scripts, and by anyone who wants to look at or
// clear their own cards. Needs Node.js 18+. No network access.
//
//   companion.mjs status                      settings and counts
//   companion.mjs defaults                    print the default package
//   companion.mjs accept [sentence]           accept the default package (start recording cards)
//   companion.mjs card '<json>'               record one card (or pass JSON on stdin)
//   companion.mjs digest [--peek] [--json]    today's digest on demand ("今天汇总")
//   companion.mjs review <id> <记得|忘了>       record a review answer
//   companion.mjs set <sentence>              change a setting, e.g. "改成 22 点"
//   companion.mjs set --key=value ...         change settings explicitly
//   companion.mjs list                        list cards (card fields only)
//   companion.mjs clear --yes                 delete the ledger file
//   companion.mjs cron-text                   timer tick, digest text or nothing (Hermes no-agent mode)
//   companion.mjs cron-gate                   timer tick, wakeAgent JSON (Hermes agent mode)
//
// Global options: --home=<dir> (default $TECH_COMPANION_HOME or ~/.tech-companion),
//                 --today=YYYY-MM-DD and --now=<ISO time> (testing only).

import { readFileSync } from 'node:fs'
import * as ledger from './ledger.mjs'

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (const arg of argv) {
    const m = arg.match(/^--([\w-]+)(?:=(.*))?$/)
    if (m) flags[m[1]] = m[2] ?? true
    else rest.push(arg)
  }
  return { flags, rest }
}

function coerce(value) {
  if (value === true || value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^\d+$/.test(value)) return Number(value)
  return value
}

const SETTING_KEYS = ['digestTime', 'frequency', 'channel', 'maxNew', 'maxReview', 'reviewMode', 'recording', 'reviewQuestion', 'showPitfall', 'timezone']

function print(value, asJson) {
  if (asJson || typeof value !== 'string') process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${value}\n`)
}

function main() {
  const { flags, rest: positional } = parseArgs(process.argv.slice(2))
  const [command = 'status', ...rest] = positional
  const store = ledger.openStore({ home: typeof flags.home === 'string' ? flags.home : undefined })
  const opts = {}
  if (typeof flags.today === 'string') opts.today = flags.today
  if (typeof flags.now === 'string') opts.now = new Date(flags.now)

  switch (command) {
    case 'status': {
      const s = ledger.status(store, opts)
      if (flags.json) return print(s, true)
      return print([`文件：${s.file}${s.fileExists ? '' : '（还没有创建）'}`, `卡片：${s.cards}（已掌握 ${s.mastered}），今天新增 ${s.newToday}，今天到期 ${s.dueToday}`, ...s.summary].join('\n'))
    }
    case 'defaults':
      return print(ledger.defaultPackageText())
    case 'accept': {
      const r = ledger.updateSettings(store, { accept: true, say: rest.join(' ') || undefined }, opts)
      return print(flags.json ? r : r.ok ? ['已按这个设置开始记录：', ...r.summary].join('\n') : r.message, flags.json)
    }
    case 'card': {
      const raw = rest[0] ?? readFileSync(0, 'utf8')
      let input
      try {
        input = JSON.parse(raw)
      } catch {
        print({ ok: false, reason: 'invalid', message: '卡片必须是 JSON' }, true)
        process.exitCode = 2
        return
      }
      return print(ledger.addCard(store, input, opts), true)
    }
    case 'digest': {
      const r = ledger.digest(store, { ...opts, trigger: 'user', mark: !flags.peek })
      if (flags.json) return print(r, true)
      return print(r.send ? r.text : r.reason === 'not-set-up' ? `还没开始记录。\n\n${r.defaults}` : '今天没有新知识点，也没有到期要复习的点。')
    }
    case 'review': {
      const [id, result] = rest
      const r = ledger.review(store, { id, result }, opts)
      if (!r.ok) process.exitCode = 2
      return print(flags.json ? r : r.message, flags.json)
    }
    case 'set': {
      const patch = {}
      for (const key of SETTING_KEYS) if (key in flags) patch[key] = coerce(flags[key])
      const say = rest.join(' ') || undefined
      const r = ledger.updateSettings(store, { say, patch: Object.keys(patch).length ? patch : undefined }, opts)
      if (!r.ok) process.exitCode = 2
      if (flags.json) return print(r, true)
      return print(r.ok ? [`已改：${r.changed.join(', ') || '（没有变化）'}`, ...r.summary, ...(r.hostScheduleNeedsUpdate ? ['注意：时间/频率/渠道改了，宿主里的定时任务也要同步改。'] : [])].join('\n') : r.message)
    }
    case 'list':
      return print(ledger.listCards(store), true)
    case 'clear':
      if (!flags.yes) {
        print('会删除全部卡片和设置：确认请加 --yes')
        process.exitCode = 2
        return
      }
      store.clear()
      return print(`已删除 ${store.path}`)
    case 'cron-text': {
      // Hermes no-agent cron: stdout is delivered verbatim; empty stdout = silent tick.
      const r = ledger.digest(store, { ...opts, trigger: 'schedule', checkTime: true })
      if (r.send) print(r.text)
      return
    }
    case 'cron-gate': {
      // Hermes agent cron pre-check: last stdout line {"wakeAgent": false} skips the model.
      const r = ledger.digest(store, { ...opts, trigger: 'schedule', checkTime: true })
      const line = r.send
        ? { wakeAgent: true, context: { tech_companion_digest: { date: r.date, newPoints: r.newPoints, reviews: r.reviews, reviewQuestion: r.reviewQuestion, reviewQuestionIsTemplate: r.reviewQuestionIsTemplate, text: r.text } } }
        : { wakeAgent: false }
      process.stdout.write(`${JSON.stringify(line)}\n`)
      return
    }
    default:
      print(`未知命令：${command}。可用：status defaults accept card digest review set list clear cron-text cron-gate`)
      process.exitCode = 2
  }
}

main()
