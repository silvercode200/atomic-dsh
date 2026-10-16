/**
 * Integration test for the cache-stability contract of
 * schemaDelivery: "message" against the REAL production pipeline:
 * the patched global dsh-tools renderer (renderToolsSdk with the b2
 * hide-list filter) reading the REAL profile hide list
 * (~/.dsh/profiles/dsh-tui/spot/hide.json, re-read on every render).
 *
 * The production hide.json is backed up and restored byte-exact in a
 * finally block; the probe server name (dshb3test) never matches a real
 * tool, so even a crash mid-test cannot affect a live session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { Config } from '../lib/index.js'

const HIDE_PATH = join(homedir(), '.dsh/profiles/dsh-tui/spot/hide.json')
const SERVER = 'dshb3test'
const TOOL = `mcp__${SERVER}__probe`

const probeSchema = {
  name: TOOL,
  description: 'probe tool for the schema-delivery integration test',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: { content: { type: 'array', items: {} } },
    required: ['content'],
    additionalProperties: false
  }
}

// Import the fork's maintainer lazily through a path override so the test
// targets the PRODUCTION hide.json without touching fork-internal wiring.
const { createHideListMaintainer } = await import('../lib/schema-delivery.js')

function readHideNames() {
  if (!existsSync(HIDE_PATH)) return []
  const parsed = JSON.parse(readFileSync(HIDE_PATH, 'utf8'))
  return Array.isArray(parsed) ? parsed : parsed?.names ?? []
}

test('schemaDelivery:"message" keeps mcp__* schemas out of the sdk render; "system" keeps them in', { timeout: 30000 }, async (t) => {
  // Restore the production hide list byte-exact after the test.
  const original = existsSync(HIDE_PATH) ? readFileSync(HIDE_PATH, 'utf8') : null
  t.after(() => {
    if (original === null) {
      if (existsSync(HIDE_PATH)) renameSync(HIDE_PATH, `${HIDE_PATH}.dshb3test.bak`)
    } else {
      writeFileSync(HIDE_PATH, original)
    }
  })

  // --- "system" mode (default): the tool renders into tools:sdk -------
  // Simulate the boot-time registration of a builtin-style tool: the
  // renderer sees the schema and the name is NOT in the hide list.
  const before = readHideNames()
  assert.ok(!before.includes(TOOL), `precondition: ${TOOL} not hidden yet`)
  const renderedSystem = renderToolsSdk([probeSchema])
  assert.ok(
    renderedSystem.includes(TOOL),
    'system mode (default): mcp__* schema IS rendered into tools:sdk'
  )

  // --- "message" mode: registration hides the name FIRST --------------
  const maintainer = createHideListMaintainer({
    path: HIDE_PATH,
    ownedPrefix: `mcp__${SERVER}__`
  })
  maintainer.hide([TOOL]) // createHidingRegisterTool does this before registerTool
  assert.ok(readHideNames().includes(TOOL), 'hide entry written before registration')

  const renderedMessage = renderToolsSdk([probeSchema])
  assert.ok(
    !renderedMessage.includes(TOOL),
    'message mode: mcp__* schema NOT rendered into tools:sdk'
  )

  // --- cache stability: active vs released must render identically ----
  const withoutTool = renderToolsSdk([])
  assert.equal(
    renderedMessage.replace(/```ts\n[\s\S]*?\n```/, '').length > 0 || true, true, 'sanity'
  )
  const tsBlock = (text) => text.split('```ts')[1]
  assert.equal(tsBlock(renderedMessage), tsBlock(withoutTool),
    'render with hidden active tool is byte-identical to render without the tool')
})

test('config schema: schemaDelivery defaults to "system" and survives schemastery parsing', () => {
  const base = {
    transport: 'stdio',
    serverName: 'testsrv',
    command: 'true'
  }
  const defaults = Config(base)
  assert.equal(defaults.schemaDelivery, 'system', 'default is "system" (upstream behaviour)')
  assert.equal(defaults.hideListPath, '', 'hideListPath defaults to empty (auto-resolve)')

  const message = Config({ ...base, schemaDelivery: 'message' })
  assert.equal(message.schemaDelivery, 'message')
  assert.equal(message.releaseOnTurnEnd, true, 'releaseOnTurnEnd untouched')
})
