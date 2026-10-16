/**
 * E2E-ish activation test: a REAL MCP stdio server (the official SDK
 * server in test/fixtures/echo-mcp-server.mjs) driven through the fork's
 * real server runtime, the real hide-list maintainer and the real (b2
 * patched) dsh-tools renderer — the full schemaDelivery:"message" path
 * minus a live LLM agent.
 *
 * Proves, in one flow:
 *  1. activation connects and registers the server's tool (run_code can
 *     call it — the executor round-trips through the real MCP server);
 *  2. the tool name lands in the hide list BEFORE the registration
 *     callback runs (no leak window);
 *  3. the tools:sdk render does not contain the mcp__* schema while the
 *     tool is registered and callable;
 *  4. the activation message carries the TS SDK snapshot.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { createServerRuntime } from '../lib/server-runtime.js'
import {
  createHideListMaintainer,
  createHidingRegisterTool,
  formatSchemaDeliveryMessage
} from '../lib/schema-delivery.js'

const SERVER_NAME = 'dshb3e2e'
const OWNED_PREFIX = `mcp__${SERVER_NAME}__`
const TOOL_NAME = `${OWNED_PREFIX}echo`
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-mcp-server.mjs')
const NODE = process.execPath

function makeFakeAdapter(events) {
  const registered = new Map()
  return {
    registered,
    registerTool: (definition) => {
      events.push(`register:${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    on: () => () => {},
    effect: () => () => {},
    log: (level, message) => events.push(`log:${level}:${message}`)
  }
}

test('activation: registers + hides the real server tool, renders clean sdk, snapshot delivered', { timeout: 60000 }, async (t) => {
  const events = []
  // The REAL production hide list — the b2-patched renderer re-reads it on
  // every render, and the maintainer must drive THAT file. Backed up and
  // restored byte-exact; the probe server name never matches a real tool.
  const hidePath = join(homedir(), '.dsh/profiles/dsh-tui/spot/hide.json')
  const originalHide = existsSync(hidePath) ? readFileSync(hidePath, 'utf8') : null
  t.after(() => { if (originalHide !== null) writeFileSync(hidePath, originalHide) })

  const realMaintainer = createHideListMaintainer({ path: hidePath, ownedPrefix: OWNED_PREFIX })
  // Wrap the real maintainer with an events tap so the test can assert the
  // hide-before-register ordering.
  const maintainer = {
    hide: (names) => {
      events.push(`hide:${names[0]}`)
      realMaintainer.hide(names)
    }
  }
  const baseAdapter = makeFakeAdapter(events)
  // The exact composition apply() installs in "message" mode.
  const adapter = {
    ...baseAdapter,
    registerTool: createHidingRegisterTool(baseAdapter.registerTool, maintainer)
  }

  const runtime = createServerRuntime({
    adapter,
    config: { releaseOnTurnEnd: true, warmIdleMs: 0, serverName: SERVER_NAME },
    label: `mcp-lazy(${SERVER_NAME})`,
    reconnectAttempts: 0,
    createConnectedClient: async (_signal, callbacks) => {
      const client = new Client({ name: 'dsh-mcp-lazy-test', version: '0.0.0' }, { capabilities: {} })
      client.onclose = () => callbacks.onClose(client)
      await client.connect(new StdioClientTransport({ command: NODE, args: [FIXTURE] }))
      return client
    },
    discoverDefinitions: async (client, signal) => {
      const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema, { signal, timeout: 10000 })
      assert.equal(result.tools.length, 1)
      const tool = result.tools[0]
      const definitions = new Map()
      definitions.set(TOOL_NAME, {
        fingerprint: 'test',
        summary: { name: TOOL_NAME, description: tool.description ?? '' },
        definition: {
          name: TOOL_NAME,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          output: {
            schema: {
              type: 'object',
              properties: { content: { type: 'array', items: {} } },
              required: ['content'],
              additionalProperties: false
            },
            render: (_args, value) => [{ type: 'text', text: String(value) }]
          },
          execute: async (args) => {
            // Raw call result, like the plugin's own RawCallToolResultSchema.
            const call = await client.request(
              { method: 'tools/call', params: { name: tool.name, arguments: args } },
              zod.record(zod.string(), zod.unknown()),
              { timeout: 10000 }
            )
            return call
          }
        }
      })
      return definitions
    }
  })
  t.after(() => runtime.dispose())

  // --- activate (the same entry-point the activate tool / router use) ---
  // A real agent object is required: runtime.addUser(agent) gates
  // wantsConnection(); without a user the activation aborts itself.
  const agent = { id: 'test-agent' }
  const message = await runtime.activate(agent, false)

  // 1. Registration happened and the tool is callable (run_code path).
  const hideIndex = events.findIndex((e) => e.startsWith('hide:'))
  const registerIndex = events.findIndex((e) => e === `register:${TOOL_NAME}`)
  assert.ok(registerIndex >= 0, 'tool registered on activation')
  assert.ok(hideIndex >= 0 && hideIndex < registerIndex, 'hide entry written before registration')

  const definition = adapter.registered.get(TOOL_NAME)
  assert.ok(definition, 'definition visible to the tools runtime (run_code resolvable)')
  const callResult = await definition.execute({ text: 'hello cache' }, { signal: undefined })
  assert.deepEqual(
    callResult.content,
    [{ type: 'text', text: 'echo: hello cache' }],
    'real MCP round-trip through the registered executor'
  )

  // 2. Hide list contains the tool name.
  assert.ok(JSON.parse(readFileSync(hidePath, 'utf8')).includes(TOOL_NAME))

  // 3. The REAL renderer (b2-patched production copy) does not render it.
  //    Feed it the schemas exactly like dsh-tools sdkSchemas() would.
  const schemas = [...adapter.registered.values()].map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    output: d.output.schema
  }))
  const rendered = renderToolsSdk(schemas)
  assert.ok(!rendered.includes(TOOL_NAME), 'tools:sdk render excludes the activated mcp__* schema')

  // 4. The activation message carries the SDK snapshot (message delivery).
  const delivery = formatSchemaDeliveryMessage(SERVER_NAME, runtime.getSdkDefinitions())
  const fullMessage = `${message}\n${delivery}`
  assert.ok(fullMessage.includes('interface ToolArgsMap {'), 'snapshot in activation result')
  assert.ok(fullMessage.includes(TOOL_NAME), 'snapshot declares the tool name')
  assert.ok(fullMessage.includes('await tools.mcp__dshb3e2e__<tool>(args)'), 'call guidance present')

  // 5. Deactivation unregisters but the hide entry stays (cache stability).
  await runtime.deactivate()
  assert.equal(adapter.registered.size, 0, 'tools unregistered on deactivate')
  assert.ok(JSON.parse(readFileSync(hidePath, 'utf8')).includes(TOOL_NAME), 'hide entry retained after release')
})
