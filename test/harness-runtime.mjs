// Real Harness runtime check (not part of `npm test`; needs Harness installed).
//
// Either run with the Electron binary bundled with DeepSeek Harness
// (ELECTRON_RUN_AS_NODE=1), or point DSH_MODULES at an npm install of
// @deepseek-ai/dsh, e.g.:
//   npm i @deepseek-ai/dsh@0.2.1-rc.5 --prefix /tmp/dsh
//   DSH_MODULES=/tmp/dsh/node_modules/@deepseek-ai node test/harness-runtime.mjs
//
// It builds an isolated in-memory host, writes only to a temporary ledger
// directory, and never accesses chat or credentials.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'
import * as ledgerPlugin from '../harness/ledger.js'

const base = process.env.DSH_MODULES
  ? `${process.env.DSH_MODULES.replace(/\/$/, '')}/`
  : process.resourcesPath
    ? `${process.resourcesPath}/app.asar/dsh/node_modules/@deepseek-ai/`
    : null
if (!base) throw new Error('Run with the DeepSeek Harness Electron binary or set DSH_MODULES')
const { Context } = await import(`${base}cordis/lib/index.js`)
const { default: SystemPrompt, renderPrompt } = await import(`${base}dsh-system-prompt/lib/index.js`)
const { default: ToolRuntime } = await import(`${base}dsh-tools/lib/index.js`)

const home = mkdtempSync(join(tmpdir(), 'tech-companion-runtime-'))
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, {})
  const fiber = await ctx.plugin(plugin, {})
  let active = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(active.includes(plugin.guidance.trim()), 'guidance must be in the actual assembled prompt')
  assert.ok(!active.includes(ledgerPlugin.ledgerGuidance.trim()), 'ledger text must not appear without the ledger row')

  // The ledger row requires the tool registry; without it the row stays pending.
  const ledgerFiber = await ctx.plugin(ledgerPlugin, { home })
  active = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(!active.includes(ledgerPlugin.ledgerGuidance.trim()), 'ledger must wait for the tools service')

  const toolsFiber = await ctx.plugin(ToolRuntime, {})
  await new Promise(resolve => setTimeout(resolve, 50))
  active = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(active.includes(plugin.guidance.trim()), 'guidance still present with tools')
  assert.ok(active.includes(ledgerPlugin.ledgerGuidance.trim()), 'ledger guidance assembled once tools exist')
  const names = ctx.tools.schemas().map(s => s.name).sort()
  assert.deepEqual(names, ['tech_companion_card', 'tech_companion_digest', 'tech_companion_review', 'tech_companion_settings'])

  const call = async (name, args) => {
    const result = await ctx.tools.execute({ callId: `t-${name}-${Math.random()}`, name, arguments: args, signal: new AbortController().signal })
    assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`)
    return result
  }
  const blocked = await call('tech_companion_card', { point: 'GitHub 是代码仓库，不是应用商店', why: '它托管源代码和协作记录', task: '找一个开源工具', sayItLike: '这个工具的源码在 GitHub 上。' })
  assert.match(JSON.stringify(blocked.content), /consent-required|默认套餐/)
  await call('tech_companion_settings', { accept: true })
  await call('tech_companion_card', { point: 'GitHub 是代码仓库，不是应用商店', why: '它托管源代码和协作记录', task: '找一个开源工具', sayItLike: '这个工具的源码在 GitHub 上。', impact: 'high' })
  const digest = await call('tech_companion_digest', { trigger: 'user' })
  assert.match(JSON.stringify(digest.content), /吱吱老师今日汇总/)
  const saved = JSON.parse(readFileSync(join(home, 'ledger.json'), 'utf8'))
  assert.equal(saved.cards.length, 1)

  await ledgerFiber.dispose()
  active = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(!active.includes(ledgerPlugin.ledgerGuidance.trim()), 'unloading the ledger removes its text')
  assert.equal(ctx.tools.get('tech_companion_card'), undefined, 'unloading the ledger unregisters its tools')
  await fiber.dispose()
  const disabled = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(!disabled.includes(plugin.guidance.trim()), 'unloading must remove the contribution')
  await toolsFiber.dispose()
  console.log('PASS: real Harness runtime loads guidance + ledger, runs the ledger tools, and removes both')
} finally {
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
