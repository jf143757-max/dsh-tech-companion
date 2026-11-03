// The brief's examples, run through the card → digest → review path. Model
// replies themselves cannot be checked here (no model in `npm test`); see
// test/eval-examples.mjs for a live run against a real model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from '../skills/tech-companion/scripts/ledger.mjs'
import { examples } from './fixtures/examples.mjs'

const T = '2026-11-03'

function store() {
  const s = L.openStore({ home: mkdtempSync(join(tmpdir(), 'tc-examples-')) })
  L.updateSettings(s, { accept: true }, { today: T })
  return s
}

test('there are 13 examples: 5 headline ones plus the 8 in-task statements', () => {
  assert.equal(examples.length, 13)
  assert.equal(new Set(examples.map(e => e.key)).size, 13)
})

for (const example of examples) {
  test(`example "${example.key}" becomes a card and a digest entry with 知识点/为什么/任务场景/能这样说`, () => {
    const s = store()
    const r = L.addCard(s, example.card, { today: T })
    assert.equal(r.ok, true, r.message)
    const saved = JSON.parse(readFileSync(s.path, 'utf8')).cards[0]
    for (const field of Object.keys(saved)) assert.ok(['id', 'meta', ...L.CARD_FIELDS].includes(field), field)
    const d = L.digest(s, { today: T })
    assert.equal(d.send, true)
    assert.ok(d.text.includes(`知识点：${example.card.point}`))
    assert.ok(d.text.includes(`为什么：${example.card.why}`))
    assert.ok(d.text.includes(`任务场景：${example.card.task}`))
    assert.ok(d.text.includes(`能这样说：${example.card.sayItLike}`))
    // Next day it comes back as one quick question with the answer kept apart.
    const next = L.digest(s, { today: L.addDays(T, 1) })
    assert.equal(next.reviews.length, 1)
    const q = next.reviews[0].question
    assert.ok(example.card.quote ? q.includes(example.card.quote) : q.includes(example.card.task))
    assert.ok(!q.includes(example.card.sayItLike), 'the question does not give away the answer')
  })
}

test('a realistic week: headline examples on day 0, in-task ones on day 1, reviews afterwards', () => {
  const s = store()
  const [headline, inTask] = [examples.slice(0, 5), examples.slice(5)]
  for (const e of headline) L.addCard(s, e.card, { today: T })
  const d0 = L.digest(s, { today: T })
  assert.equal(d0.newPoints.length, 3)
  assert.deepEqual(d0.newPoints.map(p => p.point), headline.filter(e => e.card.impact === 'high').map(e => e.card.point).slice(0, 3))

  const t1 = L.addDays(T, 1)
  for (const e of inTask) L.addCard(s, { ...e.card, date: t1 }, { today: t1 })
  const d1 = L.digest(s, { today: t1 })
  assert.equal(d1.newPoints.length, 3)
  assert.ok(d1.newPoints.some(p => p.point.includes('API Key')), 'the high-impact safety point wins a slot')
  assert.equal(d1.reviews.length, 3, 'day-0 points come back as quick questions, capped at 3')
  for (const r of d1.reviews) L.review(s, { id: r.id, result: r.id === d1.reviews[0].id ? '忘了' : '记得' }, { today: t1 })

  const t2 = L.addDays(T, 2)
  const d2 = L.digest(s, { today: t2 })
  assert.equal(d2.newPoints.length, 0)
  assert.ok(d2.reviews.some(r => r.id === d1.reviews[0].id), 'the forgotten point is back the next day')
  assert.ok(!d2.reviews.some(r => r.id === d1.reviews[1].id), 'a remembered point waits for its longer interval')
})

test('the safety examples are marked for a warning before the action', () => {
  assert.deepEqual(examples.filter(e => e.beforeAction).map(e => e.key).sort(), ['api-key', 'conflict', 'push-main'])
})
