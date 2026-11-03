import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const skillDir = join(root, 'skills/tech-companion')
const cli = join(skillDir, 'scripts/companion.mjs')
const T = '2026-11-03'

function run(home, args, input) {
  const r = spawnSync(process.execPath, [cli, `--home=${home}`, ...args], { input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function setUp() {
  const home = mkdtempSync(join(tmpdir(), 'tc-cli-'))
  run(home, ['accept', `--today=${T}`])
  run(home, ['set', '--digestTime=21:00', '--timezone=Asia/Shanghai', `--today=${T}`])
  return home
}

const card = JSON.stringify({ point: 'GitHub 是代码仓库，不是应用商店', why: '它托管源代码', task: '找开源工具', sayItLike: '源码在 GitHub 上。' })

test('cli: card from stdin, digest on request, one-sentence settings, review answers', () => {
  const home = setUp()
  assert.match(run(home, ['card', `--today=${T}`], card).out, /"ok": true/)
  const digest = run(home, ['digest', `--today=${T}`]).out
  assert.match(digest, /吱吱老师今日汇总 · 2026-11-03/)
  assert.match(digest, /能这样说：源码在 GitHub 上。/)
  assert.match(run(home, ['digest', `--today=${T}`]).out, /今天没有新知识点/)
  assert.match(run(home, ['set', '改成', '22', '点', `--today=${T}`]).out, /时间：每天 22:00/)
  assert.match(run(home, ['review', 'c1', '记得', '--today=2026-11-04']).out, /下次复习在 2026-11-06/)
  assert.equal(run(home, ['clear']).code, 2, 'clear needs --yes')
})

test('cli: cron-text prints the digest once after digestTime and nothing otherwise', () => {
  const home = setUp()
  run(home, ['card', `--today=${T}`], card)
  assert.equal(run(home, ['cron-text', `--now=${T}T20:30:00+08:00`]).out, '', 'before 21:00: silent')
  assert.match(run(home, ['cron-text', `--now=${T}T21:00:00+08:00`]).out, /吱吱老师今日汇总/)
  assert.equal(run(home, ['cron-text', `--now=${T}T21:30:00+08:00`]).out, '', 'once a day')
  assert.equal(run(home, ['cron-text', '--now=2026-11-04T21:00:00+08:00']).out.includes('复习快问'), true, 'next day: the point comes back for review')
  assert.equal(run(home, ['cron-text', '--now=2026-11-05T21:00:00+08:00']).out, '', 'empty day: silent')
})

test('cli: cron-gate wakes the agent only when there is something to send', () => {
  const home = setUp()
  const last = out => JSON.parse(out.trim().split('\n').pop())
  assert.deepEqual(last(run(home, ['cron-gate', `--now=${T}T21:00:00+08:00`]).out), { wakeAgent: false }, 'no cards yet')
  const home2 = setUp()
  run(home2, ['card', `--today=${T}`], card)
  const woke = last(run(home2, ['cron-gate', `--now=${T}T21:05:00+08:00`]).out)
  assert.equal(woke.wakeAgent, true)
  assert.equal(woke.context.tech_companion_digest.newPoints[0].point, 'GitHub 是代码仓库，不是应用商店')
  assert.deepEqual(last(run(home2, ['cron-gate', `--now=${T}T21:35:00+08:00`]).out), { wakeAgent: false })
  run(home2, ['set', '暂停汇总'])
  assert.deepEqual(last(run(home2, ['cron-gate', '--now=2026-11-04T21:00:00+08:00']).out), { wakeAgent: false }, 'manual mode')
})

test('hermes wrapper scripts find a symlinked skill under $HERMES_HOME/skills', () => {
  const hermesHome = mkdtempSync(join(tmpdir(), 'tc-hermes-'))
  mkdirSync(join(hermesHome, 'skills', 'communication'), { recursive: true })
  symlinkSync(skillDir, join(hermesHome, 'skills', 'communication', 'tech-companion'))
  const env = { ...process.env, HERMES_HOME: hermesHome, TECH_COMPANION_HOME: mkdtempSync(join(tmpdir(), 'tc-ledger-')) }
  const gate = execFileSync('bash', [join(skillDir, 'scripts/hermes-cron-gate.sh')], { env, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(gate.trim()), { wakeAgent: false })
  const text = execFileSync('bash', [join(skillDir, 'scripts/hermes-cron-text.sh')], { env, encoding: 'utf8' })
  assert.equal(text, '')
  const missing = spawnSync('bash', [join(skillDir, 'scripts/hermes-cron-gate.sh')], { env: { ...env, HERMES_HOME: mkdtempSync(join(tmpdir(), 'tc-empty-')) }, encoding: 'utf8' })
  assert.notEqual(missing.status, 0, 'a missing skill is an error, so Hermes reports it instead of staying silent')
})
