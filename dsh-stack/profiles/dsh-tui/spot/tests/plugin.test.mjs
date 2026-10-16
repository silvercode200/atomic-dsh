/**
 * Unit tests for the gate tools (spot_search/spot_load), the
 * post-compaction hint and the plugin wiring, against fake Cordis
 * contexts (no network, no dsh runtime).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerGateTools } from '../lib/gate-tools.mjs'
import { registerCompactionHint } from '../lib/compaction-hint.mjs'
import { GUIDANCE_TEXT, GUIDANCE_MAX_CHARS, loadPluginData } from '../lib/plugin-data.mjs'

/** Build a fake Cordis context capturing registrations and events. */
function fakeCtx() {
  const tools = new Map()
  const handlers = new Map() // event name -> [handlers]
  const injected = []
  return {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: () => undefined,
    },
    skills: {
      list: async () => [
        { name: 'pdf-convert', description: 'Convert PDF files to markdown', whenToUse: 'PDFs' },
      ],
      get: async (name) => name === 'pdf-convert'
        ? { name, content: '# pdf-convert instructions\nDo the thing.' }
        : undefined,
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    effect(fn) {
      fn()
      return () => {}
    },
    systemPrompt: {
      sections: [],
      section(section) {
        this.sections.push(section)
        return () => {}
      },
    },
    __tools: tools,
    __handlers: handlers,
    __injected: injected,
  }
}

/** A fake exec context with an agent (session header + inject inbox). */
function fakeExec(ctx) {
  const agent = {
    session: { header: { cwd: '/tmp' }, id: 'sess-1', events: [] },
    inject: (message) => ctx.__injected.push(message),
  }
  return { agent, signal: undefined }
}

const pluginData = loadPluginData(new URL('../plugin.mjs', import.meta.url))

test('guidance text is non-empty and within the ≤500 char budget', () => {
  assert.ok(GUIDANCE_TEXT.length > 100)
  assert.ok(GUIDANCE_TEXT.length <= GUIDANCE_MAX_CHARS, `${GUIDANCE_TEXT.length} chars`)
  assert.ok(GUIDANCE_TEXT.includes('spot_search'))
  assert.ok(GUIDANCE_TEXT.includes('spot_load'))
})

test('registerGateTools registers exactly spot_search and spot_load', () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  assert.deepEqual([...ctx.__tools.keys()].sort(), ['spot_load', 'spot_search'])
})

test('spot_search finds the goal tool by russian intent', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_search').execute({ intent: 'найти тул для задач/целей' }, fakeExec(ctx))
  assert.ok(result.text.includes('goal'), result.text)
})

test('spot_search merges live skills into the corpus', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_search').execute({ intent: 'pdf конвертация markdown' }, fakeExec(ctx))
  assert.ok(result.text.includes('pdf-convert'), result.text)
})

test('spot_search unknown answer lists categories', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_search').execute({ intent: 'абракадабра' }, fakeExec(ctx))
  assert.ok(result.text.includes('tool'), result.text)
  assert.ok(result.text.includes('skill'), result.text)
  assert.ok(result.text.includes('mcp'), result.text)
})

test('spot_load returns the ToolArgsMap member for a cold tool', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_load').execute({ name: 'ralph' }, fakeExec(ctx))
  assert.ok(result.text.includes('interface ToolArgsMap'), result.text)
  assert.ok(result.text.includes('ralph'), result.text)
  assert.ok(result.text.includes('await tools.ralph'), result.text)
})

test('spot_load of a skill injects its body for the next request', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_load').execute({ name: 'pdf-convert' }, fakeExec(ctx))
  assert.ok(result.text.includes('loaded'), result.text)
  assert.equal(ctx.__injected.length, 1)
  assert.ok(ctx.__injected[0].content[0].text.includes('pdf-convert instructions'))
})

test('spot_load of an MCP server points at the router, never activates', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_load').execute({ name: 'tavily' }, fakeExec(ctx))
  assert.ok(result.text.includes('mcp__router__search_and_activate'), result.text)
  assert.equal(ctx.__injected.length, 0)
})

test('spot_load of an unknown name suggests spot_search', async () => {
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_load').execute({ name: 'no_such_thing' }, fakeExec(ctx))
  assert.ok(result.text.includes('spot_search'), result.text)
})

test('compaction hint: fires once after compaction/end, not before, not twice', async () => {
  const ctx = fakeCtx()
  registerCompactionHint(ctx)
  const sessionEvent = ctx.__handlers.get('session/event')
  const preStep = ctx.__handlers.get('agent/pre-step')
  assert.ok(sessionEvent && preStep)

  const session = { id: 's1', events: [{ type: 'session/start', seq: 0 }] }
  const agent = { session }
  const baseDecision = { messages: [{ id: 'm0', role: 'user', content: [] }] }
  const next = async () => ({ ...baseDecision, messages: [...baseDecision.messages] })

  // No compaction yet: no hint
  let decision = await preStep[0]({ agent }, next)
  assert.equal(decision.messages.length, 1)

  // Compaction ends: hint appears on the next step
  sessionEvent[0](session, { type: 'compaction/end', seq: 5 })
  decision = await preStep[0]({ agent }, next)
  assert.equal(decision.messages.length, 2)
  assert.ok(decision.messages[1].content[0].text.includes('spot_load'), decision.messages[1].content[0].text)
  assert.equal(decision.messages[1].source.kind, 'spot-compaction-hint')

  // Same boundary again: no duplicate
  decision = await preStep[0]({ agent }, next)
  assert.equal(decision.messages.length, 1)

  // A second compaction: hint fires again
  sessionEvent[0](session, { type: 'compaction/end', seq: 12 })
  decision = await preStep[0]({ agent }, next)
  assert.equal(decision.messages.length, 2)
})

test('compaction hint: a resumed session with an old compaction gets one hint', async () => {
  const ctx = fakeCtx()
  registerCompactionHint(ctx)
  const preStep = ctx.__handlers.get('agent/pre-step')
  const session = { id: 's2', events: [{ type: 'compaction/end', seq: 7 }] }
  const agent = { session }
  const next = async () => ({ messages: [] })
  const decision = await preStep[0]({ agent }, next)
  assert.equal(decision.messages.length, 1)
  const again = await preStep[0]({ agent }, next)
  assert.equal(again.messages.length, 0)
})

test('plugin.mjs applies cleanly against a fake context (boot smoke)', async () => {
  const plugin = await import('../plugin.mjs')
  const ctx = fakeCtx()
  plugin.apply(ctx)
  assert.ok(ctx.__tools.has('spot_search'))
  assert.ok(ctx.__tools.has('spot_load'))
  assert.equal(ctx.systemPrompt.sections.length, 1)
  assert.equal(ctx.systemPrompt.sections[0].name, 'tools:spot-guidance')
  assert.equal(ctx.systemPrompt.sections[0].text, GUIDANCE_TEXT)
  assert.ok(Number.isFinite(ctx.systemPrompt.sections[0].order))
})

test('spot_load resolves a skill given in registry-id form "skill:<name>"', async () => {
  // MINOR#A regression: entry matched by id keeps wanted = "skill:pdf-convert";
  // ctx.skills.get resolves by bare name — the prefix must be stripped.
  const ctx = fakeCtx()
  registerGateTools(ctx, pluginData)
  const result = await ctx.__tools.get('spot_load').execute({ name: 'skill:pdf-convert' }, fakeExec(ctx))
  assert.ok(result.text.includes('loaded'), result.text)
  assert.ok(result.text.includes('pdf-convert'), result.text)
  assert.ok(ctx.__injected.length > 0, 'skill body injected for the next request')
})
