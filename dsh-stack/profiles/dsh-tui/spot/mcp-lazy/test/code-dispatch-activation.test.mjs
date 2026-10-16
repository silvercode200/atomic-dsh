/**
 * Code-runtime activation regression test (TG-DSH-CACHE-20260912 fix).
 *
 * The golden b-scenario leaked +18.6 KB of `mcp__context-mode__*` schemas
 * into the system prompt when activation ran through run_code
 * (tool/code-dispatch). Root cause was NOT the code-dispatch path itself:
 * the b2-patched renderer's hide helper (dshPatchHiddenTools) read
 * `~/.dsh/profiles/dsh-tui/spot/hide.json` via homedir() and IGNORED
 * $DSH_HOME — under any DSH_HOME deployment (golden suite) the reader lost
 * the file while the fork's writer (resolveHideListPath) correctly wrote
 * the DSH_HOME-relative one. Fixed in patch `hide` v2: the reader resolves
 * the active dsh-home ($DSH_HOME, fallback ~/.dsh) and scans
 * profiles/<profile>/spot/hide.json.
 *
 * This test reproduces the full production composition: plugin apply()
 * (router + activate tool + hiding registerTool) with the fixture MCP
 * server, activation through the activate tool's execute() — the exact
 * entry point a run_code code-dispatch hits — and rendering through the
 * REAL patched global dsh-tools renderToolsSdk under a temp $DSH_HOME.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'

const SERVER_NAME = 'coderun'
const OWNED_PREFIX = `mcp__${SERVER_NAME}__`
const TOOL_NAME = `${OWNED_PREFIX}echo`
const FIXTURE = new URL('./fixtures/echo-mcp-server.mjs', import.meta.url).pathname
const NODE = process.execPath

test('code-dispatch activation: hide.json honored under $DSH_HOME, sdk render stays clean', { timeout: 60000 }, async (t) => {
  // The renderer under test must be the patched global copy — if the hide
  // patch is missing there, the render below cannot filter and this test
  // fails loudly instead of silently passing.
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const dshToolsPath = require.resolve('@deepseek-ai/dsh-tools')
  const source = readFileSync(dshToolsPath, 'utf8')
  assert.ok(
    source.includes('dshPatchHiddenTools') && source.includes('DSH_HOME'),
    `hide patch v2 missing in ${dshToolsPath} — run: bash ~/.dsh/patches/apply-dsh-tools-patches.sh`
  )

  // Temp dsh-home exactly like the golden suite layout: the fork's writer
  // gets hideListPath there (production uses the same path via
  // resolveHideListPath walk-up), the renderer gets $DSH_HOME.
  const root = join(tmpdir(), `dsh-cachefix-${process.pid}`)
  const dshHome = join(root, 'dsh-home')
  const hidePath = join(dshHome, 'profiles', 'dsh-tui', 'spot', 'hide.json')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(dshHome, 'profiles', 'dsh-tui', 'spot'), { recursive: true })
  writeFileSync(hidePath, JSON.stringify(['ask_user_question', 'todo_write']))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const config = {
    transport: 'stdio',
    serverName: SERVER_NAME,
    command: NODE,
    args: [FIXTURE],
    autoActivate: false,
    releaseOnTurnEnd: true,
    schemaDelivery: 'message',
    hideListPath: hidePath
  }

  const registered = new Map()
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    tools: {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      }
    },
    on: () => () => {},
    effect: (factory) => factory()
  }

  await apply(ctx, config)
  const activate = registered.get(`mcp__${SERVER_NAME}__activate`)
  assert.ok(activate, 'activate tool registered (visible in tools:sdk)')

  // --- the run_code / tool/code-dispatch entry point ---
  // run_code builds `tools` bindings from registry.schemas() and dispatches
  // by name; the dispatch lands in this exact execute().
  process.env.DSH_HOME = dshHome
  t.after(() => { delete process.env.DSH_HOME })
  const result = await activate.execute({}, { agent: { id: 'coderun-agent' }, signal: undefined })
  const text = String(result.content[0].text)
  assert.ok(text.includes('已激活'), `activation succeeded, got: ${text.slice(0, 120)}`)
  assert.ok(text.includes('Schema delivery for MCP server'), 'schema snapshot delivered in the tool result')

  // The server tool is registered and callable (real MCP round-trip).
  const echo = registered.get(TOOL_NAME)
  assert.ok(echo, 'server tool registered')
  const roundTrip = await echo.execute({ text: 'cache-fix' }, { signal: undefined })
  assert.deepEqual(roundTrip.content, [{ type: 'text', text: 'echo: cache-fix' }])

  // The writer put the tool name into the DSH_HOME hide list.
  assert.ok(JSON.parse(readFileSync(hidePath, 'utf8')).includes(TOOL_NAME), 'hide.json carries the mcp tool name')

  // The REAL patched renderer, under $DSH_HOME, produces a clean tools:sdk:
  // neither the activated mcp tool nor the cold builtins leak; the visible
  // activate tool stays.
  const schemas = [...registered.values()].map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    output: d.output.schema
  }))
  schemas.push({ name: 'ask_user_question', description: 'cold builtin', parameters: { type: 'object', properties: {} }, output: { type: 'object', properties: {} } })
  const rendered = renderToolsSdk(schemas)
  assert.ok(!rendered.includes(TOOL_NAME), 'tools:sdk render excludes the activated mcp__* schema')
  assert.ok(!rendered.includes('ask_user_question'), 'tools:sdk render excludes the cold builtin')
  assert.ok(rendered.includes(`${OWNED_PREFIX}activate`), 'activate tool stays visible')

  // Negative control (the v1 bug shape): point $DSH_HOME at a home without
  // the hide list and the same render DOES contain the schema — proves the
  // assertions above are not vacuous.
  const emptyHome = join(root, 'empty-home')
  mkdirSync(join(emptyHome, 'profiles'), { recursive: true })
  process.env.DSH_HOME = emptyHome
  const leaked = renderToolsSdk(schemas)
  assert.ok(leaked.includes(TOOL_NAME), 'negative control: without the hide list the schema renders')
  process.env.DSH_HOME = dshHome

  // Cleanup the runtime the same way dsh would (turn end / dispose).
  await registered.get(`mcp__${SERVER_NAME}__deactivate`).execute()
  assert.ok(existsSync(hidePath), 'hide list survives deactivation (cache stability)')
})
