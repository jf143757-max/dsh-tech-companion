import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, guidance, inject } from '../index.js'
import * as ledgerPlugin from '../harness/ledger.js'

const root = new URL('..', import.meta.url).pathname
const read = path => readFileSync(join(root, path), 'utf8')

test('registers a stable prompt contribution through the Harness service', () => {
  const sections = []
  apply({ systemPrompt: { section: value => sections.push(value) } })
  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tech-companion:guidance')
  assert.equal(sections[0].interpolate, false)
  assert.equal(sections[0].text, guidance.trim())
  assert.ok(Number.isFinite(sections[0].order))
})

test('guidance keeps the original boundaries and shapes each reminder as a card', () => {
  const rules = [
    'First answer the user\'s actual question or advance their task',
    'put it at the end of the task response',
    '“吱吱老师提醒你：”',
    'Omit the label and reminder when there is no technical wording to clarify',
    'explain the concern before the affected action',
    'Do not call valid informal shorthand, an obvious typo, a tentative hypothesis, an analogy, or a correct statement an error',
    'Do not invent the user\'s name',
    '“为什么：”',
    '“能这样说：”',
    '“易错点：”',
  ]
  const flat = guidance.replace(/\s+/g, ' ')
  for (const rule of rules) assert.ok(flat.includes(rule), rule)
})

test('the Hermes skill carries the same guidance verbatim, plus the ledger section', () => {
  const skill = read('skills/tech-companion/SKILL.md')
  assert.match(skill, /^---\nname: tech-companion\n/)
  assert.ok(skill.includes(guidance.trim()), 'SKILL.md must contain index.js guidance unchanged')
  assert.ok(skill.includes('node ${HERMES_SKILL_DIR}/scripts/companion.mjs'), 'commands use the skill dir template')
  assert.match(skill, /only runs while the Hermes gateway is\s+running/)
  assert.match(skill, /never promise the user will remember/)
})

test('the bundle inserts two rows, and the ledger subpath resolves to a shipped file', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id: tech-companion\n\s+name: dsh-tech-companion\n/)
  assert.match(patch, /id: tech-companion-ledger\n\s+name: dsh-tech-companion\/ledger\n/)
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./ledger'], './harness/ledger.js')
  for (const file of pkg.files) assert.ok(existsSync(join(root, file)), file)
  assert.ok(pkg.files.includes('skills/tech-companion/'), 'the whole skill folder ships, scripts included')
})

test('ledger plugin needs the tool registry, adds its own prompt section, and registers four tools', async () => {
  assert.deepEqual(ledgerPlugin.inject, ['tools', 'systemPrompt'])
  const sections = []
  const tools = []
  const home = mkdtempSync(join(tmpdir(), 'tc-plugin-'))
  ledgerPlugin.apply({ systemPrompt: { section: s => sections.push(s) }, tools: { register: t => tools.push(t) } }, { home })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tech-companion:ledger')
  assert.equal(sections[0].text, ledgerPlugin.ledgerGuidance.trim())
  assert.deepEqual(tools.map(t => t.name), ['tech_companion_card', 'tech_companion_digest', 'tech_companion_review', 'tech_companion_settings'])
  for (const t of tools) {
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.output.render, 'function')
    assert.equal(typeof t.execute, 'function')
  }
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))
  const first = await byName.tech_companion_card.execute({ point: '点', why: '因', task: '任务', sayItLike: '说法' })
  assert.equal(first.reason, 'consent-required')
  assert.match(byName.tech_companion_card.output.render({}, first)[0].text, /默认套餐/)
  assert.equal((await byName.tech_companion_settings.execute({ accept: true })).ok, true)
  assert.equal((await byName.tech_companion_card.execute({ point: '点', why: '因', task: '任务', sayItLike: '说法' })).ok, true)
  const digest = await byName.tech_companion_digest.execute({ trigger: 'user' })
  assert.equal(digest.send, true)
  assert.match(byName.tech_companion_digest.output.render({}, digest)[0].text, /吱吱老师今日汇总/)
  const changed = await byName.tech_companion_settings.execute({ say: '改成 22 点' })
  assert.equal(changed.hostScheduleNeedsUpdate, true)
  assert.ok(JSON.parse(readFileSync(join(home, 'ledger.json'), 'utf8')).cards.length === 1)
})

test('ledger guidance only promises a timer when one was actually created', () => {
  const text = ledgerPlugin.ledgerGuidance
  assert.match(text, /only if schedule_create is available/)
  assert.match(text, /say plainly that there is no timer here/)
  assert.match(text, /Never say a digest will arrive\s+automatically unless the reminder was actually created/)
})
