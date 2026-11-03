import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from '../skills/tech-companion/scripts/ledger.mjs'

const T = '2026-11-03'
const day = n => L.addDays(T, n)

function freshStore({ accept = true } = {}) {
  const store = L.openStore({ home: mkdtempSync(join(tmpdir(), 'tc-ledger-')) })
  if (accept) L.updateSettings(store, { accept: true }, { today: T })
  return store
}

function card(point, extra = {}) {
  return { point, why: `${point} 的原因`, task: `${point} 的任务`, sayItLike: `${point} 能这样说`, ...extra }
}

// Put a card in the ledger as if it had gone through earlier days.
function seed(store, input, date, answers = []) {
  const r = L.addCard(store, { ...input, date }, { today: date })
  assert.equal(r.ok, true, r.message)
  for (const [when, result] of answers) L.review(store, { id: r.id, result }, { today: when })
  return r.id
}

// ---------------------------------------------------------------- 4. intervals

test('intervals: on-time "remembered" lands on +1, +3, +7, +15, +30 from day 0, then graduates', () => {
  assert.deepEqual([...L.REVIEW_OFFSETS], [1, 3, 7, 15, 30])
  const d0 = '2026-01-01'
  let s = L.newSchedule(d0)
  const dues = [s.due]
  while (!s.mastered) {
    s = L.applyReview(s, 'remembered', s.due)
    dues.push(s.due)
  }
  assert.deepEqual(dues, ['2026-01-02', '2026-01-04', '2026-01-08', '2026-01-16', '2026-01-31', null])
  assert.deepEqual(dues.slice(0, 5).map(d => L.diffDays(d, d0)), [1, 3, 7, 15, 30])
  assert.equal(s.mastered, true)
})

test('intervals: remembering lengthens the gap; forgetting goes back to +1 without other penalty', () => {
  let s = L.newSchedule(T)
  s = L.applyReview(s, 'remembered', day(1)) // gap 2
  s = L.applyReview(s, 'remembered', day(3)) // gap 4
  assert.equal(L.diffDays(s.due, day(3)), 4)
  s = L.applyReview(s, 'forgot', day(7))
  assert.equal(s.stage, 0)
  assert.equal(s.due, day(8), 'forgot → next review tomorrow')
  assert.equal(s.anchor, day(7), 'the +1/+3/+7… steps restart from the day it was forgotten')
  s = L.applyReview(s, 'remembered', day(8))
  assert.equal(s.due, day(10), 'then +3 from the new day 0')
})

test('intervals: a late review counts the next gap from the actual review day', () => {
  let s = L.newSchedule(T) // due +1
  s = L.applyReview(s, 'remembered', day(5)) // 4 days late, gap 2
  assert.equal(s.due, day(7))
})

test('intervals: remembering before the due day (daily mode) does not move the schedule', () => {
  let s = L.newSchedule(T)
  s = L.applyReview(s, 'remembered', day(1)) // due day 3
  const early = L.applyReview(s, 'remembered', day(2))
  assert.equal(early.due, s.due)
  assert.equal(early.stage, s.stage)
  assert.equal(early.streak, 2)
  assert.deepEqual(L.applyReview(early, 'remembered', day(2)), early, 'same answer twice on one day is ignored')
})

test('intervals: an unanswered quick question counts as seen — next interval, no daily nagging, no streak', () => {
  const store = freshStore()
  const ignored = seed(store, card('没人回答的点'), day(-1))
  assert.deepEqual(L.digest(store, { today: T }).reviews.map(r => r.id), [ignored])
  const tomorrow = L.digest(store, { today: day(1) })
  assert.equal(tomorrow.send, false, 'not asked again the next day')
  const c = L.listCards(store)[0]
  assert.equal(c.stage, 1)
  assert.equal(c.nextReview, day(2), 'moved on by the +3 step, counted from the day it was asked')
  assert.equal(store.load().cards[0].meta.streak, 0, 'seen is not the same as remembered')
  assert.equal(L.review(store, { id: ignored, result: '忘了' }, { today: day(1) }).nextReview, day(2), '忘了 still resets to +1')
})

// ---------------------------------------------------------------- 3. digest content

test('digest: today / yesterday / 7-days-ago cards → only the new point plus due points, no repeats', () => {
  const store = freshStore()
  // 7 days ago, reviewed on time at +1 and +3 → due again at +7 = today.
  const old = seed(store, card('七天前的点'), day(-7), [[day(-6), 'remembered'], [day(-4), 'remembered']])
  // yesterday, already digested yesterday → first review +1 = today.
  const yest = seed(store, card('昨天的点'), day(-1))
  assert.equal(L.digest(store, { today: day(-1) }).newPoints[0].id, yest)
  const now = seed(store, card('今天的点'), T)

  const d = L.digest(store, { today: T })
  assert.equal(d.send, true)
  assert.deepEqual(d.newPoints.map(p => p.id), [now])
  assert.deepEqual(d.reviews.map(r => r.id).sort(), [old, yest].sort())
  assert.match(d.text, /今天的新点（1）/)
  assert.match(d.text, /复习快问（2）/)
  assert.ok(!d.text.includes('七天前的点 的原因'), 'review points are asked, not re-explained')

  const again = L.digest(store, { today: T })
  assert.equal(again.send, false, 'nothing is repeated the same day')
  assert.equal(again.reason, 'empty')
})

test('digest: new points are capped (default 3) and ordered by impact on the task', () => {
  const store = freshStore()
  seed(store, card('低影响', { impact: 'low' }), T)
  seed(store, card('高影响一', { impact: 'high' }), T)
  seed(store, card('中影响', { impact: 'medium' }), T)
  seed(store, card('高影响二', { impact: 'high' }), T)
  seed(store, card('又一个低', { impact: 'low' }), T)
  const d = L.digest(store, { today: T })
  assert.deepEqual(d.newPoints.map(p => p.point), ['高影响一', '高影响二', '中影响'])
  // Asking again the same day shows the ones that did not fit, never the shown ones.
  assert.deepEqual(L.digest(store, { today: T }).newPoints.map(p => p.point), ['低影响', '又一个低'])
})

test('digest: due review points are capped (scheduled default 3), most overdue first', () => {
  const store = freshStore()
  for (let i = 1; i <= 5; i += 1) seed(store, card(`旧点${i}`), day(-i))
  const d = L.digest(store, { today: T })
  assert.equal(d.reviews.length, 3)
  assert.deepEqual(d.reviews.map(r => r.id), ['c5', 'c4', 'c3'])
  assert.ok(d.reviews.every(r => r.question && r.answer), 'each review point gets exactly one quick question')
})

test('digest: fixed format — 知识点/为什么/任务场景/能这样说 and one review question at the end', () => {
  const store = freshStore()
  seed(store, card('甲', { pitfall: '甲的易错点' }), T)
  seed(store, card('乙'), T)
  const d = L.digest(store, { today: T })
  for (const label of ['知识点：甲', '为什么：甲 的原因', '任务场景：甲 的任务', '能这样说：甲 能这样说']) assert.ok(d.text.includes(label), label)
  assert.ok(!d.text.includes('易错点'), 'pitfall hidden by default')
  assert.equal(d.text.match(/复盘小问题：/g).length, 1)
  assert.equal(d.reviewQuestionIsTemplate, true)
})

// ---------------------------------------------------------------- 6. empty day

test('empty day: no new and no due points → nothing to send, and no empty digest text', () => {
  const store = freshStore()
  seed(store, card('前天的点'), day(-2), [[day(-1), 'remembered']]) // next due day(+1)
  const d = L.digest(store, { today: T })
  assert.equal(d.send, false)
  assert.equal(d.reason, 'empty')
  assert.equal(d.text, undefined)
})

test('scheduled trigger: waits for digestTime, runs at most once a day, and is silent in manual mode', () => {
  const store = freshStore()
  seed(store, card('今天的点'), T)
  const tz = { timezone: 'Asia/Shanghai' }
  L.updateSettings(store, { patch: tz }, { today: T })
  const at = hhmm => new Date(`${T}T${hhmm}:00+08:00`)
  assert.equal(L.digest(store, { now: at('20:59'), trigger: 'schedule', checkTime: true }).reason, 'not-yet')
  assert.equal(L.digest(store, { now: at('21:00'), trigger: 'schedule', checkTime: true }).send, true)
  seed(store, card('晚到的点'), T)
  assert.equal(L.digest(store, { now: at('21:30'), trigger: 'schedule', checkTime: true }).reason, 'already-checked')
  assert.equal(L.digest(store, { now: at('21:31'), trigger: 'user' }).newPoints[0].point, '晚到的点', 'the user can still ask')
  L.updateSettings(store, { say: '暂停汇总' }, { today: T })
  assert.equal(L.digest(store, { now: new Date(`${day(1)}T22:00:00+08:00`), trigger: 'schedule', checkTime: true }).reason, 'manual')
})

test('an empty scheduled check still counts as today\'s check (no late surprise digests)', () => {
  const store = freshStore()
  assert.equal(L.digest(store, { today: T, trigger: 'schedule' }).reason, 'empty')
  seed(store, card('之后才记的点'), T)
  assert.equal(L.digest(store, { today: T, trigger: 'schedule' }).reason, 'already-checked')
})

// ---------------------------------------------------------------- 5. review modes

test('review modes: scheduled shows only due points; daily also asks recent unsettled points, max 5', () => {
  const store = freshStore()
  // Remembered yesterday at its +1 → next due day(+1): not due today.
  const recent = seed(store, card('前天的点'), day(-2), [[day(-1), 'remembered']])
  // Remembered twice in a row → settled for daily mode, and not due.
  const settled = seed(store, card('已稳的点'), day(-3), [[day(-2), 'remembered'], [day(-1), 'remembered']])
  // Older than 7 days and due today → both modes.
  // 15 days ago, on time at +1/+3/+7 → next due +15 = today.
  const olderDue = seed(store, card('十五天前的点'), day(-15), [[day(-14), 'remembered'], [day(-12), 'remembered'], [day(-8), 'remembered']])
  assert.equal(L.listCards(store).find(c => c.id === olderDue).nextReview, T)
  // Six more cards from yesterday … 6 days ago, never answered (all due).
  const fresh = [1, 2, 3, 4, 5, 6].map(i => seed(store, card(`第${i}天前`), day(-i)))

  const scheduled = L.selectReview(store.load().cards, T, 'scheduled', 3).map(c => c.id)
  assert.ok(!scheduled.includes(recent) && !scheduled.includes(settled), 'scheduled: only due points')
  assert.equal(scheduled.length, 3)

  assert.equal(L.updateSettings(store, { say: '改成每天复习' }, { today: T }).settings.reviewMode, 'daily')
  const d = L.digest(store, { today: T, mark: false })
  const ids = d.reviews.map(r => r.id)
  assert.equal(ids.length, 5, 'daily default cap is 5')
  assert.equal(ids[0], fresh[0], 'yesterday first')
  assert.ok(!ids.includes(settled), 'a point remembered twice in a row is not asked daily')
  const all = L.selectReview(store.load().cards, T, 'daily', 20).map(c => c.id)
  assert.ok(all.includes(recent), 'daily asks a recent point even though it is not due')
  assert.ok(all.includes(olderDue), 'daily still includes due points older than 7 days')
  assert.ok(all.indexOf(olderDue) > all.indexOf(fresh[5]), 'older due points fill after the 7-day window')

  assert.equal(L.updateSettings(store, { say: '改回定期复习' }, { today: T }).settings.reviewMode, 'scheduled')
  assert.equal(L.digest(store, { today: T, mark: false }).reviews.length, 3)
})

// ---------------------------------------------------------------- settings in one sentence

test('settings: every item has a default and one sentence changes one item', () => {
  assert.deepEqual({ ...L.DEFAULT_SETTINGS }, {
    recording: null, digestTime: '21:00', frequency: 'auto', channel: 'conversation', maxNew: 3,
    maxReview: null, reviewMode: 'scheduled', reviewQuestion: true, showPitfall: false, timezone: null,
  })
  const cases = {
    '改成 22 点': { digestTime: '22:00' },
    '改到晚上9点半': { digestTime: '21:30' },
    '每天 21:15 发': { digestTime: '21:15' },
    '以后只发 1 个': { maxNew: 1 },
    '新点最多两个': { maxNew: 2 },
    '复习最多 2 个': { maxReview: 2 },
    '改成每天复习': { reviewMode: 'daily' },
    '改回定期复习': { reviewMode: 'scheduled' },
    '关闭记录': { recording: false },
    '恢复记录': { recording: true },
    '只在我说的时候汇总': { frequency: 'manual' },
    '恢复定时汇总': { frequency: 'auto' },
    '不要复盘题': { reviewQuestion: false },
    '加上易错点': { showPitfall: true },
    '以后发到 Telegram': { channel: 'Telegram' },
    '就在对话里发': { channel: 'conversation' },
  }
  for (const [sentence, patch] of Object.entries(cases)) assert.deepEqual(L.parseSettingSentence(sentence), patch, sentence)
  assert.equal(L.parseSettingSentence('复习少一点'), null, 'no accidental 1:00')
  assert.equal(L.parseSettingSentence('今天天气不错'), null)

  const store = freshStore()
  const r = L.updateSettings(store, { say: '改成 22 点' }, { today: T })
  assert.deepEqual(r.changed, ['digestTime'])
  assert.equal(r.hostScheduleNeedsUpdate, true, 'the host timer must follow a time change')
  assert.equal(L.updateSettings(store, { say: '以后只发 1 个' }, { today: T }).hostScheduleNeedsUpdate, false)
  assert.equal(L.updateSettings(store, { patch: { maxNew: 9 } }, { today: T }).ok, false, 'out-of-range values are refused')
  assert.equal(L.updateSettings(store, { say: '随便改改' }, { today: T }).ok, false)
})

test('defaults are offered as one package that can be accepted in one step', () => {
  const text = L.defaultPackageText()
  for (const item of ['时间：每天 21:00', '频率：', '渠道：就在这个对话里', '数量：新点最多 3 个', '格式：', '记录：', '复习：定期复习']) assert.ok(text.includes(item), item)
  assert.match(text, /回一句「好」/)
})

// ---------------------------------------------------------------- 7. recording boundary

test('recording: nothing is written before the user accepts', () => {
  const store = freshStore({ accept: false })
  const r = L.addCard(store, card('点'), { today: T })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'consent-required')
  assert.match(r.defaults, /默认套餐/)
  assert.equal(existsSync(store.path), false, 'no file is created')
  assert.equal(L.digest(store, { today: T }).reason, 'not-set-up')
})

test('recording: only the seven card fields are stored — never the chat', () => {
  const store = freshStore()
  const transcript = '用户：……\n助手：……'.repeat(200)
  const r = L.addCard(store, {
    ...card('只记卡片'),
    quote: `这是一段很长的原话${'啊'.repeat(300)}`,
    transcript, messages: [{ role: 'user', content: transcript }], apiKey: 'sk-should-not-be-stored', userName: '某人',
  }, { today: T })
  assert.equal(r.ok, true)
  assert.deepEqual(r.dropped.sort(), ['apiKey', 'messages', 'transcript', 'userName'])
  const raw = readFileSync(store.path, 'utf8')
  for (const leaked of ['用户：', 'sk-should-not-be-stored', '某人', 'messages']) assert.ok(!raw.includes(leaked), leaked)
  const saved = JSON.parse(raw).cards[0]
  assert.deepEqual(Object.keys(saved).filter(k => k !== 'id' && k !== 'meta').sort(), ['date', 'point', 'quote', 'sayItLike', 'task', 'why'].sort())
  assert.ok(Array.from(saved.quote).length <= 80, 'quotes are capped to a short phrase')
  assert.deepEqual(Object.keys(saved.meta).sort(), ['anchor', 'askedOn', 'digestedOn', 'due', 'impact', 'lapses', 'lastResult', 'lastReviewed', 'mastered', 'stage', 'streak'].sort(), 'meta holds scheduling data only')
})

test('recording: after "关闭记录" no new card is written; existing cards still review; "恢复记录" resumes', () => {
  const store = freshStore()
  seed(store, card('昨天的点'), day(-1))
  L.updateSettings(store, { say: '关闭记录' }, { today: T })
  const before = readFileSync(store.path, 'utf8')
  const r = L.addCard(store, card('新点'), { today: T })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'recording-off')
  assert.equal(readFileSync(store.path, 'utf8'), before, 'file untouched')
  assert.equal(L.digest(store, { today: T }).reviews.length, 1)
  L.updateSettings(store, { say: '恢复记录' }, { today: T })
  assert.equal(L.addCard(store, card('新点'), { today: T }).ok, true)
})

test('cards: required fields, no duplicates of an active point, and the original words are optional', () => {
  const store = freshStore()
  assert.match(L.addCard(store, { point: '只有知识点' }, { today: T }).message, /缺少字段/)
  const a = L.addCard(store, card('GitHub 是代码仓库，不是应用商店'), { today: T })
  assert.equal(a.card.quote, undefined, 'no quote is invented when the user did not say one')
  const b = L.addCard(store, card('GitHub 是代码仓库, 不是应用商店。'), { today: T })
  assert.equal(b.duplicate, true)
  assert.equal(b.id, a.id)
  assert.equal(L.listCards(store).length, 1)
})

test('review answers: 记得/忘了 aliases, unknown ids, and clear can wipe everything', () => {
  const store = freshStore()
  const id = seed(store, card('点'), day(-1))
  assert.equal(L.review(store, { id, result: '记得' }, { today: T }).nextReview, day(2))
  assert.equal(L.review(store, { id, result: '忘了' }, { today: day(2) }).nextReview, day(3))
  assert.equal(L.review(store, { id: 'c99', result: '记得' }, { today: T }).ok, false)
  assert.equal(L.review(store, { id, result: '也许' }, { today: T }).ok, false)
  store.clear()
  assert.equal(existsSync(store.path), false)
})
