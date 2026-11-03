import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, guidance, inject } from '../index.js'

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
