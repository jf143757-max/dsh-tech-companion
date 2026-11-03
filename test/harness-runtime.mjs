// Run with the Electron binary bundled with DeepSeek Harness (ELECTRON_RUN_AS_NODE=1).
// This test builds an isolated in-memory host and never accesses chat or credentials.
import assert from 'node:assert/strict'
import * as plugin from '../index.js'

if (!process.resourcesPath) throw new Error('Run with the DeepSeek Harness Electron binary')
const base = `${process.resourcesPath}/app.asar/dsh/node_modules/@deepseek-ai/`
const { Context } = await import(`${base}cordis/lib/index.js`)
const { default: SystemPrompt, renderPrompt } = await import(`${base}dsh-system-prompt/lib/index.js`)
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, {})
  const fiber = await ctx.plugin(plugin, {})
  const active = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(active.includes(plugin.guidance.trim()), 'guidance must be in the actual assembled prompt')
  await fiber.dispose()
  const disabled = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(!disabled.includes(plugin.guidance.trim()), 'unloading must remove the contribution')
  console.log('PASS: real Harness runtime loads, assembles, and removes the plugin')
} finally {
  await ctx.fiber.dispose()
}
