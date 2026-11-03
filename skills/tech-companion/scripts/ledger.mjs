// Tech Companion learning ledger: knowledge-point cards, daily digest, and
// spaced review. Zero dependencies; shared by the Harness plugin
// (harness/ledger.js) and the Hermes skill CLI (companion.mjs).
//
// About the review schedule: the "forgetting curve" (Ebbinghaus) is a
// description of how recall tends to fade over time. It is not an algorithm
// and not a measurement of anyone's brain. What actually schedules reviews here
// is a fixed-step, Leitner-style spaced-repetition heuristic: a card is first
// seen on day 0 and comes back on day +1, +3, +7, +15 and +30. "Remembered"
// moves it to the next, longer step; "forgot" sends it back to +1. The steps
// are empirical defaults, not a promise that anyone will remember on schedule.
//
// Privacy boundary: only the seven card fields below plus scheduling metadata
// are stored. No chat transcript, no extra model call, no network access.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Review days counted from day 0 (the day the card first appears). */
export const REVIEW_OFFSETS = Object.freeze([1, 3, 7, 15, 30])

/** The only content a card may hold, in display order. */
export const CARD_FIELDS = Object.freeze(['date', 'quote', 'point', 'why', 'task', 'sayItLike', 'pitfall'])
export const FIELD_LABELS = Object.freeze({
  date: '日期',
  quote: '原话',
  point: '知识点',
  why: '为什么是这样',
  task: '今天在哪个任务里遇到的',
  sayItLike: '能这样说',
  pitfall: '易错点',
})
const REQUIRED_FIELDS = ['point', 'why', 'task', 'sayItLike']
const FIELD_MAX = { quote: 80, point: 120, why: 240, task: 120, sayItLike: 160, pitfall: 160 }
const IMPACT_RANK = { high: 3, medium: 2, low: 1 }

export const DEFAULT_SETTINGS = Object.freeze({
  // null = the user has not accepted yet; nothing is written until they do.
  recording: null,
  digestTime: '21:00',
  // auto: at digestTime, send only when there is a new or due point.
  // manual: never on a timer; only when the user asks ("今天汇总").
  frequency: 'auto',
  channel: 'conversation',
  maxNew: 3,
  // null = mode default (scheduled: 3, daily: 5)
  maxReview: null,
  reviewMode: 'scheduled',
  reviewQuestion: true,
  showPitfall: false,
  // null = the host's local time zone
  timezone: null,
})
const MODE_REVIEW_CAP = { scheduled: 3, daily: 5 }
const COUNT_MIN = 1
const COUNT_MAX = 5
const DAILY_WINDOW_DAYS = 7
// Daily mode keeps asking a recent card until the user remembers it this many
// times in a row; "forgot" resets the count.
const DAILY_SETTLED_STREAK = 2

// ---------------------------------------------------------------- dates

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function diffDays(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000)
}

function zoneParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const get = type => parts.find(p => p.type === type)?.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

export function localDate(now = new Date(), timeZone = null) {
  return zoneParts(now, timeZone).date
}

export function localTime(now = new Date(), timeZone = null) {
  return zoneParts(now, timeZone).time
}

// ---------------------------------------------------------------- storage

export function defaultHome(env = process.env) {
  return env.TECH_COMPANION_HOME || join(homedir(), '.tech-companion')
}

function emptyLedger() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, state: { nextId: 1, lastScheduledDigest: null }, cards: [] }
}

/**
 * A JSON file store. Each operation loads, changes and atomically rewrites the
 * file. The file is created only on the first write, which can only happen
 * after the user accepts recording (or changes a setting).
 */
export function openStore({ home, file } = {}) {
  const path = file || join(home || defaultHome(), 'ledger.json')
  return {
    path,
    exists: () => existsSync(path),
    load() {
      if (!existsSync(path)) return emptyLedger()
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const base = emptyLedger()
      return {
        version: 1,
        settings: { ...base.settings, ...(raw.settings || {}) },
        state: { ...base.state, ...(raw.state || {}) },
        cards: Array.isArray(raw.cards) ? raw.cards : [],
      }
    },
    save(ledger) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, path)
    },
    clear() {
      rmSync(path, { force: true })
    },
  }
}

// ---------------------------------------------------------------- cards

function clip(text, max) {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * Keep only the seven card fields (plus `impact` for ordering), trimmed and
 * length-capped. Anything else — transcripts, file contents, names — is dropped.
 */
export function normalizeCardInput(input, today) {
  if (input === null || typeof input !== 'object') return { error: '卡片内容必须是一个对象' }
  const card = {}
  for (const field of CARD_FIELDS) {
    const value = input[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return { error: `字段「${FIELD_LABELS[field]}」必须是文字` }
    const text = value.replace(/\s+/g, ' ').trim()
    if (text) card[field] = field === 'date' ? text : clip(text, FIELD_MAX[field])
  }
  card.date ??= today
  if (!isDate(card.date)) return { error: '日期必须是 YYYY-MM-DD' }
  const missing = REQUIRED_FIELDS.filter(f => !card[f])
  if (missing.length) return { error: `缺少字段：${missing.map(f => FIELD_LABELS[f]).join('、')}` }
  const impact = input.impact ?? 'medium'
  if (!(impact in IMPACT_RANK)) return { error: 'impact 只能是 high / medium / low' }
  const dropped = Object.keys(input).filter(k => !CARD_FIELDS.includes(k) && k !== 'impact')
  return { card, impact, dropped }
}

function sameText(a, b) {
  return a.replace(/[\s，。,.！!？?“”"'「」]/g, '').toLowerCase() === b.replace(/[\s，。,.！!？?“”"'「」]/g, '').toLowerCase()
}

/** Returns the scheduling metadata for a card first seen on `date`. */
export function newSchedule(date) {
  return { anchor: date, stage: 0, due: addDays(date, REVIEW_OFFSETS[0]), mastered: false, lastResult: null, lastReviewed: null, lapses: 0, streak: 0 }
}

/**
 * Apply one review answer.
 * - forgot: back to +1 from today (no penalty beyond restarting the steps).
 * - remembered while due (or overdue): next, longer step, measured from today;
 *   remembering at the +30 step graduates the card.
 * - remembered before it is due (daily mode): counted in the streak only.
 * Repeating the same answer on the same day changes nothing.
 */
export function applyReview(schedule, result, today) {
  if (schedule.lastReviewed === today && schedule.lastResult === result) return { ...schedule }
  const next = { ...schedule, lastResult: result, lastReviewed: today }
  if (schedule.mastered) return next
  if (result === 'forgot') {
    return { ...next, anchor: today, stage: 0, due: addDays(today, REVIEW_OFFSETS[0]), lapses: (schedule.lapses || 0) + 1, streak: 0 }
  }
  next.streak = (schedule.streak || 0) + 1
  if (today < schedule.due) return next
  return advance(next, today)
}

function advance(schedule, from) {
  if (schedule.stage >= REVIEW_OFFSETS.length - 1) return { ...schedule, mastered: true, due: null }
  const gap = REVIEW_OFFSETS[schedule.stage + 1] - REVIEW_OFFSETS[schedule.stage]
  return { ...schedule, stage: schedule.stage + 1, due: addDays(from, gap) }
}

/**
 * A quick question the user saw in a digest but never answered counts as
 * "seen": the digest showed the question and its answer, so the card moves to
 * its next interval instead of being asked again every day. It never counts
 * toward the daily-mode streak, and "忘了" at any time still resets the card.
 */
export function settleUnanswered(schedule, askedOn, today) {
  if (!askedOn || askedOn >= today || schedule.mastered) return schedule
  if (schedule.lastReviewed && schedule.lastReviewed >= askedOn) return schedule
  const seen = { ...schedule, lastResult: 'seen', lastReviewed: askedOn }
  return askedOn >= schedule.due ? advance(seen, askedOn) : seen
}

// ---------------------------------------------------------------- settings

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const NUM = '(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})'

function toInt(text) {
  if (/^\d+$/.test(text)) return Number(text)
  if (text in CN_DIGIT) return CN_DIGIT[text]
  const m = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0)
  return Number.NaN
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * Turn one plain sentence into a settings patch, e.g. "改成 22 点",
 * "以后只发 1 个", "改成每天复习", "关闭记录". Returns null when nothing is recognised.
 */
export function parseSettingSentence(sentence) {
  const s = String(sentence || '').trim()
  if (!s) return null
  const patch = {}

  const time = s.match(new RegExp(`(改成|改到|换成|换到|设成|设为|调到|调成|定在|放在|放到|挪到|每天)?\\s*(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\\s*${NUM}\\s*(点|:|：)\\s*(半|${NUM}\\s*分?)?`))
  if (time && (time[1] || time[2] || time[4] !== '点')) {
    let hour = toInt(time[3])
    const minute = time[5] === '半' ? 30 : time[6] ? toInt(time[6]) : 0
    if (['下午', '傍晚', '晚上', '夜里'].includes(time[2]) && hour < 12) hour += 12
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) patch.digestTime = `${pad2(hour)}:${pad2(minute)}`
  }

  const mentionsReview = /(复习|快问|到期|旧点)/.test(s)
  const count = s.match(new RegExp(`(?:只发|只要|最多|改成|只出|只问|每天)\\s*${NUM}\\s*(?:个|道)`))
  if (count) {
    const n = toInt(count[1])
    if (mentionsReview) patch.maxReview = n
    else patch.maxNew = n
  }

  if (/(每天复习|天天复习|改成每天|换成每天)/.test(s) && mentionsReview) patch.reviewMode = 'daily'
  if (/(定期复习|到期复习|按间隔复习|间隔复习)/.test(s)) patch.reviewMode = 'scheduled'

  if (/(关闭|关掉|停止|暂停|不要|别|不用)(再)?(记录|记卡|记卡片|记了)/.test(s)) patch.recording = false
  else if (/(打开|开启|恢复|继续|重新)(记录|记卡)/.test(s)) patch.recording = true

  if (/(只在我说|我说了?才|手动汇总|不要定时|别定时|关闭定时|停止定时|暂停汇总|停掉汇总|关闭汇总)/.test(s)) patch.frequency = 'manual'
  else if (/(恢复定时|自动汇总|恢复汇总|打开定时|开启定时|恢复每天)/.test(s)) patch.frequency = 'auto'

  if (/(不要|去掉|关掉|取消|不用)复盘/.test(s)) patch.reviewQuestion = false
  else if (/(加上|加回|恢复|保留|要)复盘/.test(s)) patch.reviewQuestion = true
  if (/(不要|去掉|关掉|取消)易错点/.test(s)) patch.showPitfall = false
  else if (/(加上|显示|带上|也要)易错点/.test(s)) patch.showPitfall = true

  if (/(就在|发在|发到|放在)(这个)?(对话|聊天)/.test(s)) patch.channel = 'conversation'
  else {
    const ch = s.match(/(?:改成|改为|以后)?发(?:到|在)\s*([A-Za-z一-龥][\w一-龥:-]{0,30}?)(?:里|上|吧)?[。！!]*$/)
    if (ch && !/(对话|聊天)/.test(ch[1])) patch.channel = ch[1]
  }

  return Object.keys(patch).length ? patch : null
}

export function validateSettingsPatch(patch) {
  const errors = []
  const clean = {}
  for (const [key, value] of Object.entries(patch || {})) {
    switch (key) {
      case 'recording':
      case 'reviewQuestion':
      case 'showPitfall':
        if (typeof value === 'boolean') clean[key] = value
        else errors.push(`${key} 必须是 true/false`)
        break
      case 'digestTime':
        if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) clean[key] = value
        else errors.push('时间格式应为 HH:MM，例如 21:00')
        break
      case 'frequency':
        if (value === 'auto' || value === 'manual') clean[key] = value
        else errors.push('频率只能是 auto（有新点或到期点才发）或 manual（只在你说时发）')
        break
      case 'reviewMode':
        if (value === 'scheduled' || value === 'daily') clean[key] = value
        else errors.push('复习模式只能是 scheduled（定期）或 daily（每天）')
        break
      case 'maxNew':
        if (Number.isInteger(value) && value >= COUNT_MIN && value <= COUNT_MAX) clean[key] = value
        else errors.push(`新点数量应在 ${COUNT_MIN}-${COUNT_MAX} 之间`)
        break
      case 'maxReview':
        if (value === null || (Number.isInteger(value) && value >= COUNT_MIN && value <= COUNT_MAX)) clean[key] = value
        else errors.push(`复习数量应在 ${COUNT_MIN}-${COUNT_MAX} 之间`)
        break
      case 'channel':
        if (typeof value === 'string' && value.trim() && value.length <= 40) clean[key] = value.trim()
        else errors.push('渠道名称不能为空')
        break
      case 'timezone':
        try {
          if (value !== null) new Intl.DateTimeFormat('en', { timeZone: value })
          clean[key] = value
        } catch {
          errors.push('时区应为 IANA 名称，例如 Asia/Shanghai')
        }
        break
      default:
        errors.push(`不认识的设置项：${key}`)
    }
  }
  return { clean, errors }
}

export function effectiveMaxReview(settings) {
  return settings.maxReview ?? MODE_REVIEW_CAP[settings.reviewMode] ?? 3
}

export function describeSettings(settings) {
  const recording = settings.recording === true ? '开：只记知识点卡片（7 个字段），不记聊天全文'
    : settings.recording === false ? '关：不再写新卡片' : '未确认（确认前不写任何东西）'
  const frequency = settings.frequency === 'manual' ? '只在你说「今天汇总」时发' : '有新点或到期复习点才发，空日不发'
  const mode = settings.reviewMode === 'daily'
    ? '每天复习：昨天和过去 7 天的点每天问一次，直到你连续两次说「记得」；到期的旧点照常出现'
    : '定期复习：只在到期日出现（+1/+3/+7/+15/+30 天）'
  const format = `每个点＝知识点 / 为什么 / 任务场景 / 能这样说${settings.showPitfall ? ' / 易错点' : ''}${settings.reviewQuestion ? '，最后 1 道复盘小问题' : ''}`
  return [
    `时间：每天 ${settings.digestTime}${settings.timezone ? `（${settings.timezone}）` : ''}`,
    `频率：${frequency}`,
    `渠道：${settings.channel === 'conversation' ? '就在这个对话里' : settings.channel}`,
    `数量：新点最多 ${settings.maxNew} 个，按对任务的影响排序；复习快问最多 ${effectiveMaxReview(settings)} 个`,
    `格式：${format}`,
    `记录：${recording}`,
    `复习：${mode}`,
  ]
}

export function defaultPackageText() {
  const lines = describeSettings({ ...DEFAULT_SETTINGS, recording: true })
  return [
    '吱吱老师的默认套餐（回一句「好」就按这个来；想改哪项，直接说一句，比如「改成 22 点」「以后只发 1 个」）：',
    ...lines.map(l => `· ${l}`),
    '随时可以说「关闭记录」「改成每天复习」「改回定期复习」「暂停汇总」。',
  ].join('\n')
}

// ---------------------------------------------------------------- digest

function rank(card) {
  return IMPACT_RANK[card.meta?.impact] ?? 2
}

function shortTitle(text, max = 14) {
  return clip(text, max)
}

function quickQuestion(card) {
  if (card.quote) return `你当时说「${card.quote}」——现在换你跟别人讲，会怎么说？`
  return `还记得在「${card.task}」时补的那个点吗？用一句话说给别人听。`
}

function selectNew(cards, today, max) {
  return cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card.date === today && !card.meta.digestedOn)
    .sort((a, b) => rank(b.card) - rank(a.card) || a.index - b.index)
    .slice(0, max)
    .map(({ card }) => card)
}

function isDue(card, today) {
  return !card.meta.mastered && card.meta.due !== null && card.meta.due <= today
}

/**
 * Pick review points for today.
 * - scheduled: cards whose next review date has arrived (most overdue first).
 * - daily: cards first seen yesterday … 7 days ago that are not yet settled
 *   (fewer than DAILY_SETTLED_STREAK "remembered" answers in a row), newest
 *   first, then any other due cards, so older cards are not lost while daily
 *   mode is on.
 * Cards first seen today and cards already asked today are never included.
 */
export function selectReview(cards, today, mode, max) {
  const eligible = cards.filter(c => c.date < today && !c.meta.mastered && c.meta.askedOn !== today)
  const due = eligible
    .filter(c => isDue(c, today))
    .sort((a, b) => a.meta.due.localeCompare(b.meta.due) || rank(b) - rank(a))
  if (mode !== 'daily') return due.slice(0, max)
  const windowStart = addDays(today, -DAILY_WINDOW_DAYS)
  const recent = eligible
    .filter(c => c.date >= windowStart && (c.meta.streak || 0) < DAILY_SETTLED_STREAK)
    .sort((a, b) => b.date.localeCompare(a.date) || rank(b) - rank(a))
  const picked = []
  for (const card of [...recent, ...due]) {
    if (!picked.includes(card)) picked.push(card)
  }
  return picked.slice(0, max)
}

function templateReviewQuestion(newCards) {
  if (newCards.length === 1) {
    return `不看上面，你能用自己的话说出「${shortTitle(newCards[0].point, 20)}」背后的「为什么」吗？`
  }
  const titles = newCards.map(c => `「${shortTitle(c.point)}」`).join('、')
  return `今天这 ${newCards.length} 个点（${titles}）有什么共同点？提示：看看每个点里被当成一回事的两样东西，或被省掉的那个前提。`
}

export function formatDigest({ date, newCards, reviewCards, settings, reviewQuestion }) {
  const out = [`吱吱老师今日汇总 · ${date}`]
  if (newCards.length) {
    out.push('', `今天的新点（${newCards.length}）`)
    newCards.forEach((c, i) => {
      out.push(`${i + 1}. 知识点：${c.point}`)
      out.push(`   为什么：${c.why}`)
      out.push(`   任务场景：${c.task}`)
      out.push(`   能这样说：${c.sayItLike}`)
      if (settings.showPitfall && c.pitfall) out.push(`   易错点：${c.pitfall}`)
    })
  }
  if (reviewCards.length) {
    out.push('', `复习快问（${reviewCards.length}）——想起来回「${reviewCards[0].id} 记得」，想不起来回「${reviewCards[0].id} 忘了」，不扣分`)
    reviewCards.forEach(c => out.push(`· [${c.id}] ${quickQuestion(c)}`))
  }
  if (reviewQuestion) out.push('', `复盘小问题：${reviewQuestion}`)
  if (reviewCards.length) {
    out.push('', '—— 快问参考答案（先想一想再看）——')
    reviewCards.forEach(c => out.push(`[${c.id}] ${c.sayItLike}`))
  }
  return out.join('\n')
}

function publicCard(card) {
  const out = { id: card.id }
  for (const f of CARD_FIELDS) if (card[f] !== undefined) out[f] = card[f]
  out.impact = card.meta.impact
  out.nextReview = card.meta.due
  out.stage = card.meta.stage
  out.mastered = card.meta.mastered
  return out
}

function jsonClean(value) {
  return JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------- operations

function context(store, opts = {}) {
  const ledger = store.load()
  const now = opts.now ?? new Date()
  const today = opts.today ?? localDate(now, ledger.settings.timezone)
  return { ledger, now, today }
}

/** Record one knowledge-point card (after the user has accepted recording). */
export function addCard(store, input, opts = {}) {
  const { ledger, today } = context(store, opts)
  if (ledger.settings.recording === null) {
    return jsonClean({ ok: false, reason: 'consent-required', message: '还没确认记录方式，先给用户看默认套餐，用户说「好」后再记。', defaults: defaultPackageText() })
  }
  if (ledger.settings.recording === false) {
    return { ok: false, reason: 'recording-off', message: '用户已关闭记录，不写新卡片。' }
  }
  const parsed = normalizeCardInput(input, today)
  if (parsed.error) return { ok: false, reason: 'invalid', message: parsed.error }
  const existing = ledger.cards.find(c => !c.meta.mastered && sameText(c.point, parsed.card.point))
  if (existing) {
    return jsonClean({ ok: true, duplicate: true, id: existing.id, message: `这个点已经在卡片 ${existing.id} 里了，没有重复记录。` })
  }
  const id = `c${ledger.state.nextId}`
  ledger.state.nextId += 1
  const card = { id, ...parsed.card, meta: { impact: parsed.impact, ...newSchedule(parsed.card.date), digestedOn: null, askedOn: null } }
  ledger.cards.push(card)
  store.save(ledger)
  return jsonClean({ ok: true, id, card: publicCard(card), dropped: parsed.dropped, message: `已记成卡片 ${id}，第一次复习在 ${card.meta.due}。` })
}

/**
 * Build today's digest.
 * trigger "user": the user asked ("今天汇总"); always answers.
 * trigger "schedule": a timer fired; respects frequency=manual, and (with
 *   checkTime) waits until digestTime and runs at most once per day.
 * mark: record what was shown so it is not repeated (default true).
 */
export function digest(store, opts = {}) {
  const { ledger, now, today } = context(store, opts)
  const { settings, state } = ledger
  const trigger = opts.trigger ?? 'user'
  const mark = opts.mark ?? true
  if (trigger === 'schedule') {
    if (settings.frequency === 'manual') return { send: false, reason: 'manual', date: today }
    if (opts.checkTime && localTime(now, settings.timezone) < settings.digestTime) return { send: false, reason: 'not-yet', date: today }
    if (state.lastScheduledDigest === today) return { send: false, reason: 'already-checked', date: today }
  }
  if (settings.recording === null && ledger.cards.length === 0) {
    return jsonClean({ send: false, reason: 'not-set-up', date: today, defaults: defaultPackageText() })
  }
  let dirty = false
  if (mark) {
    for (const c of ledger.cards) {
      const settled = settleUnanswered(c.meta, c.meta.askedOn, today)
      if (settled !== c.meta) {
        c.meta = { ...c.meta, ...settled }
        dirty = true
      }
    }
  }
  const newCards = selectNew(ledger.cards, today, settings.maxNew)
  const reviewCards = selectReview(ledger.cards, today, settings.reviewMode, effectiveMaxReview(settings))
  if (trigger === 'schedule' && mark) {
    state.lastScheduledDigest = today
    dirty = true
  }
  if (!newCards.length && !reviewCards.length) {
    if (dirty) store.save(ledger)
    return { send: false, reason: 'empty', date: today }
  }
  const reviewQuestion = settings.reviewQuestion && newCards.length ? templateReviewQuestion(newCards) : null
  const text = formatDigest({ date: today, newCards, reviewCards, settings, reviewQuestion })
  if (mark) {
    for (const c of newCards) c.meta.digestedOn = today
    for (const c of reviewCards) c.meta.askedOn = today
    store.save(ledger)
  }
  return jsonClean({
    send: true,
    date: today,
    reviewMode: settings.reviewMode,
    newPoints: newCards.map(c => ({ id: c.id, point: c.point, why: c.why, task: c.task, sayItLike: c.sayItLike, ...(settings.showPitfall && c.pitfall ? { pitfall: c.pitfall } : {}) })),
    reviews: reviewCards.map(c => ({ id: c.id, question: quickQuestion(c), answer: c.sayItLike })),
    reviewQuestion,
    reviewQuestionIsTemplate: reviewQuestion !== null,
    text,
  })
}

const RESULT_ALIASES = { remembered: 'remembered', remember: 'remembered', yes: 'remembered', 记得: 'remembered', 记住了: 'remembered', forgot: 'forgot', forget: 'forgot', no: 'forgot', 忘了: 'forgot', 不记得: 'forgot' }

/** Record whether the user remembered a review point. */
export function review(store, { id, result }, opts = {}) {
  const { ledger, today } = context(store, opts)
  const normalized = RESULT_ALIASES[String(result || '').trim()]
  if (!normalized) return { ok: false, message: '结果只能是「记得」或「忘了」' }
  const card = ledger.cards.find(c => c.id === id)
  if (!card) return { ok: false, message: `没有找到卡片 ${id}` }
  const before = card.meta
  card.meta = { ...before, ...applyReview(before, normalized, today) }
  store.save(ledger)
  const message = card.meta.mastered ? `卡片 ${id} 已掌握，不再安排复习。`
    : normalized === 'forgot' ? `没关系，卡片 ${id} 明天（${card.meta.due}）再见一次。`
      : card.meta.due === before.due ? `好，卡片 ${id} 还没到期，记下这次记得，下次复习仍是 ${card.meta.due}。`
        : `好，卡片 ${id} 下次复习在 ${card.meta.due}。`
  return jsonClean({ ok: true, id, result: normalized, nextReview: card.meta.due, mastered: card.meta.mastered, message })
}

/**
 * Change settings. Accepts { accept: true } (take the default package),
 * { say: "改成 22 点" } (one sentence), and/or { patch: {...} }.
 */
export function updateSettings(store, { accept, say, patch } = {}, opts = {}) {
  const { ledger } = context(store, opts)
  const combined = {}
  if (accept) combined.recording = true
  let parsedFrom = null
  if (say) {
    parsedFrom = parseSettingSentence(say)
    if (!parsedFrom && !patch && !accept) {
      return { ok: false, message: '没听懂要改哪一项。可以说：「改成 22 点」「以后只发 1 个」「改成每天复习」「改回定期复习」「关闭记录」「暂停汇总」。' }
    }
    Object.assign(combined, parsedFrom)
  }
  Object.assign(combined, patch || {})
  const { clean, errors } = validateSettingsPatch(combined)
  if (errors.length) return { ok: false, message: errors.join('；') }
  const before = { ...ledger.settings }
  Object.assign(ledger.settings, clean)
  store.save(ledger)
  const changed = Object.keys(clean).filter(k => before[k] !== ledger.settings[k])
  const hostScheduleNeedsUpdate = changed.some(k => k === 'digestTime' || k === 'frequency' || k === 'channel' || k === 'timezone')
  return jsonClean({ ok: true, changed, hostScheduleNeedsUpdate, settings: ledger.settings, summary: describeSettings(ledger.settings) })
}

export function status(store, opts = {}) {
  const { ledger, today } = context(store, opts)
  const active = ledger.cards.filter(c => !c.meta.mastered)
  return jsonClean({
    file: store.path,
    fileExists: store.exists(),
    today,
    settings: ledger.settings,
    summary: describeSettings(ledger.settings),
    cards: ledger.cards.length,
    mastered: ledger.cards.length - active.length,
    dueToday: active.filter(c => c.date < today && isDue(c, today)).length,
    newToday: ledger.cards.filter(c => c.date === today).length,
  })
}

export function listCards(store) {
  return store.load().cards.map(publicCard)
}
