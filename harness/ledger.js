// Harness plugin: learning ledger tools for Tech Companion.
//
// A second, separate Cordis plugin row. It needs the `tools` service; where a
// profile has no tool registry this row simply does not load and the static
// guidance plugin (index.js) keeps working alone.
//
// What it adds: four model-callable tools that read and write one local JSON
// file (default ~/.tech-companion/ledger.json, override with the
// TECH_COMPANION_HOME environment variable or the `home` config option). No
// network access, no extra model call, no chat transcript.
//
// What it cannot do by itself: wake a conversation on a timer. A daily digest
// at a fixed time needs the Host Schedule service (schedule_create), which the
// guidance below asks the model to set up only after the user agrees.

import * as ledger from '../skills/tech-companion/scripts/ledger.mjs'

export const name = 'tech-companion-ledger'
export const inject = ['tools', 'systemPrompt']

export const ledgerGuidance = `
Learning ledger (tech_companion_* tools). Use these tools only to support the
reminder rules above, and always finish the user's task first.

Cards. Each time you give a “吱吱老师提醒你：” reminder, also record that point once
with tech_companion_card: point (知识点), why (为什么是这样), task (今天在哪个任务里遇到的:
a few words naming the task, not its content), sayItLike (能这样说), and when they
exist quote (原话: at most one short phrase the user actually wrote; leave it out
rather than paraphrase or invent it) and pitfall (易错点). Set impact to how much
the point matters for the task: high, medium or low. Never put chat transcripts,
file contents, secrets, API keys, names or personal data in any field. Do not
record anything when there was no reminder.

First use. If tech_companion_card returns reason "consent-required", do not retry
it. After the task and the reminder, show the returned default package once and
let the user answer in one sentence; never ask a series of setup questions. If
the user accepts (for example “好” or “按默认”), call tech_companion_settings with
accept=true and then record the card. If the same sentence changes an item, also
pass it as say. If the user declines, call tech_companion_settings with
patch {"recording": false} and do not ask again.

Timer. Only after the user accepts, and only if schedule_create is available,
create one reminder named “吱吱老师每日汇总” that repeats every day at the
digestTime from the settings, in the user's time zone, delivered to this
conversation, with the instruction:
“【吱吱老师每日汇总】调用 tech_companion_digest（trigger=schedule）。send=false 时只回一句：今天没有新点，汇总跳过。”
Tell the user it fires only while Harness is running. If schedule_create is not
available, say plainly that there is no timer here and that the digest appears
when they say “今天汇总”. Whenever tech_companion_settings returns
hostScheduleNeedsUpdate=true, change that reminder with schedule_edit to match
(frequency "manual" means pause it; "auto" means resume it).

Digest. When the user asks (“今天汇总”, “复习一下”), call tech_companion_digest with
trigger "user"; for the scheduled instruction use trigger "schedule". If send is
false, say so in at most one short line. Otherwise show the returned text, with
one change: when reviewQuestionIsTemplate is true, replace the 复盘小问题 line with
one question that names the real common thread of today's new points. A review
point gets exactly one quick question; do not explain it again.

Answers. When the user answers a quick question (“c3 记得”, “c3 忘了”, or by
answering it), call tech_companion_review with remembered or forgot. Judge
generously. Forgetting is normal; this is not a test and nothing is lost.

Settings. When the user changes the time, frequency, channel, count, format,
recording or review mode in a sentence (“改成 22 点”, “以后只发 1 个”, “改成每天复习”,
“改回定期复习”, “关闭记录”), pass the sentence as say to tech_companion_settings and
confirm the change in one line. When recording is off, do not call
tech_companion_card. If asked about review modes: daily review keeps the habit
going but can feel heavy when points pile up; scheduled review is lighter and
appears only when a point is due, but relies on the intervals.

Honesty. The intervals (+1, +3, +7, +15, +30 days) are a spaced-repetition
heuristic; never promise the user will remember. Never say a digest will arrive
automatically unless the reminder was actually created.
`

const objectSchema = { type: 'object', additionalProperties: true }
const str = description => ({ type: 'string', description })

function textOf(value) {
  if (typeof value.text === 'string' && value.text) return value.text
  if (typeof value.message === 'string' && value.message) {
    return value.defaults ? `${value.message}\n\n${value.defaults}` : value.message
  }
  return JSON.stringify(value)
}

function tool(definition) {
  return {
    ...definition,
    output: { schema: objectSchema, render: (_args, value) => [{ type: 'text', text: textOf(value) }] },
  }
}

function asObject(args) {
  return args !== null && typeof args === 'object' ? args : {}
}

/**
 * Build the raw tool definitions over a ledger store.
 * @param {ReturnType<typeof ledger.openStore>} store
 * @param {{ now?: () => Date }} [clock] - injectable clock for tests.
 */
export function createTools(store, clock = {}) {
  const at = () => (clock.now ? { now: clock.now() } : {})
  return [
    tool({
      name: 'tech_companion_card',
      description: 'Record one 吱吱老师 knowledge-point card after a reminder. Stores only the card fields, never the chat.',
      parameters: {
        type: 'object',
        properties: {
          point: str('知识点: the corrected or more precise statement'),
          why: str('为什么是这样: the reason in plain words'),
          task: str('今天在哪个任务里遇到的: a few words naming the task'),
          sayItLike: str('能这样说: one sentence the user can say to someone else'),
          quote: str('原话: optional, at most one short phrase the user actually wrote'),
          pitfall: str('易错点: optional, the likely mistake'),
          impact: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How much the point matters for the task' },
          date: str('Optional YYYY-MM-DD; defaults to today'),
        },
        required: ['point', 'why', 'task', 'sayItLike'],
        additionalProperties: false,
      },
      async execute(args) {
        return ledger.addCard(store, asObject(args), at())
      },
    }),
    tool({
      name: 'tech_companion_digest',
      description: 'Build today\'s 吱吱老师 digest: new points plus review quick questions. send=false means there is nothing to send.',
      parameters: {
        type: 'object',
        properties: {
          trigger: { type: 'string', enum: ['user', 'schedule'], description: 'user: the user asked; schedule: the daily reminder fired' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const { trigger = 'user' } = asObject(args)
        return ledger.digest(store, { ...at(), trigger: trigger === 'schedule' ? 'schedule' : 'user' })
      },
    }),
    tool({
      name: 'tech_companion_review',
      description: 'Record whether the user remembered a review point (card id like c3).',
      parameters: {
        type: 'object',
        properties: {
          id: str('Card id, e.g. c3'),
          result: { type: 'string', enum: ['remembered', 'forgot'] },
        },
        required: ['id', 'result'],
        additionalProperties: false,
      },
      async execute(args) {
        const { id, result } = asObject(args)
        return ledger.review(store, { id: String(id ?? ''), result }, at())
      },
    }),
    tool({
      name: 'tech_companion_settings',
      description: 'Accept the default package, or change one setting from a plain sentence (e.g. 改成 22 点, 改成每天复习, 关闭记录). Omit all arguments to read the current settings.',
      parameters: {
        type: 'object',
        properties: {
          accept: { type: 'boolean', description: 'true when the user accepts the default package' },
          say: str('The user\'s sentence that changes a setting'),
          patch: { type: 'object', additionalProperties: true, description: 'Explicit settings: digestTime, frequency, channel, maxNew, maxReview, reviewMode, recording, reviewQuestion, showPitfall, timezone' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const { accept, say, patch } = asObject(args)
        if (!accept && !say && !patch) return ledger.status(store, at())
        return ledger.updateSettings(store, { accept: accept === true, say, patch }, at())
      },
    }),
  ]
}

export function apply(ctx, config = {}) {
  const store = ledger.openStore({ home: config?.home })
  ctx.systemPrompt.section({
    name: 'tech-companion:ledger',
    order: 10001,
    interpolate: false,
    text: ledgerGuidance.trim(),
  })
  for (const definition of createTools(store)) ctx.tools.register(definition)
}
