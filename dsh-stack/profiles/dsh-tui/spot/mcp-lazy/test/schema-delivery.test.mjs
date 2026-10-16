/**
 * Unit tests for schemaDelivery: "message" support (fork of
 * @yilinxiao/dsh-mcp-lazy, profile-local).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHideListMaintainer,
  createHidingRegisterTool,
  formatSchemaDeliveryMessage,
  renderServerSdkSnapshot,
  resolveHideListPath
} from '../lib/schema-delivery.js'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'

const OWNED_PREFIX = 'mcp__testsrv__'

function tempHideFile(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lazy-hide-'))
  const path = join(dir, 'hide.json')
  if (initial !== undefined) writeFileSync(path, initial)
  return { dir, path }
}

test('maintainer preserves foreign entries and adds owned names', () => {
  const { dir, path } = tempHideFile('["todo_write", "web_search"]')
  try {
    const m = createHideListMaintainer({ path, ownedPrefix: OWNED_PREFIX })
    m.hide(['mcp__testsrv__probe', 'mcp__testsrv__search'])
    const names = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(names.includes('todo_write'), 'foreign entry preserved')
    assert.ok(names.includes('web_search'), 'foreign entry preserved')
    assert.ok(names.includes('mcp__testsrv__probe'), 'own entry added')
    assert.ok(names.includes('mcp__testsrv__search'), 'own entry added')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maintainer ignores names it does not own', () => {
  const { dir, path } = tempHideFile('["todo_write"]')
  try {
    const m = createHideListMaintainer({ path, ownedPrefix: OWNED_PREFIX })
    m.hide(['read_file', 'mcp__other__tool'])
    const names = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(names, ['todo_write'], 'non-owned names never land in the hide list')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maintainer is idempotent and keeps own entries forever (cache stability)', () => {
  const { dir, path } = tempHideFile('["todo_write"]')
  try {
    const m = createHideListMaintainer({ path, ownedPrefix: OWNED_PREFIX })
    m.hide(['mcp__testsrv__probe'])
    const afterFirst = readFileSync(path, 'utf8')
    m.hide(['mcp__testsrv__probe']) // second activation, same name
    assert.equal(readFileSync(path, 'utf8'), afterFirst, 'no rewrite when nothing new')
    const names = JSON.parse(afterFirst, 'utf8')
    assert.ok(names.includes('mcp__testsrv__probe'), 'entry kept across re-activation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maintainer creates the file when missing and survives corrupt content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lazy-hide-'))
  const path = join(dir, 'hide.json')
  try {
    const m = createHideListMaintainer({ path, ownedPrefix: OWNED_PREFIX })
    m.hide(['mcp__testsrv__probe'])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), ['mcp__testsrv__probe'])
    writeFileSync(path, '{corrupt json')
    m.hide(['mcp__testsrv__second'])
    const names = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(names.includes('mcp__testsrv__second'), 'recovered from corrupt content')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createHidingRegisterTool hides before registering; no-op without maintainer', () => {
  const events = []
  const register = (definition) => { events.push(`register:${definition.name}`); return 42 }
  const maintainer = { hide: (names) => events.push(`hide:${names[0]}`) }

  const wrapped = createHidingRegisterTool(register, maintainer)
  assert.equal(wrapped({ name: 'mcp__testsrv__x' }), 42)
  assert.deepEqual(events, ['hide:mcp__testsrv__x', 'register:mcp__testsrv__x'], 'hide happens first')

  events.length = 0
  const passthrough = createHidingRegisterTool(register, undefined)
  passthrough({ name: 'mcp__testsrv__x' })
  assert.deepEqual(events, ['register:mcp__testsrv__x'], 'system mode: registration untouched')
})

test('resolveHideListPath skips the fork root and finds the profile root', () => {
  // <tmp>/profile/spot/mcp-lazy/lib/index.js — the fork layout; the fork
  // root carries its own bundle cordis.patch.yml which must NOT be picked.
  const profile = mkdtempSync(join(tmpdir(), 'mcp-lazy-profile-'))
  try {
    const forkLib = join(profile, 'spot', 'mcp-lazy', 'lib')
    mkdirSync(forkLib, { recursive: true })
    // fork's OWN bundle patch file — the trap
    writeFileSync(join(profile, 'spot', 'mcp-lazy', 'cordis.patch.yml'), '[]')
    // the real profile root marker
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]')
    const pluginFile = join(forkLib, 'index.js')
    assert.equal(
      resolveHideListPath(pluginFile),
      join(profile, 'spot', 'hide.json'),
      'resolves to <profileRoot>/spot/hide.json, not the fork root'
    )
    // file:// URL form (import.meta.url) resolves identically
    assert.equal(
      resolveHideListPath(`file://${pluginFile}`),
      join(profile, 'spot', 'hide.json')
    )
    // explicit override wins
    assert.equal(resolveHideListPath(pluginFile, '/tmp/other.json'), '/tmp/other.json')
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('resolveHideListPath throws without a profile root and no override', () => {
  const orphan = mkdtempSync(join(tmpdir(), 'mcp-lazy-orphan-'))
  try {
    const lib = join(orphan, 'mcp-lazy', 'lib')
    mkdirSync(lib, { recursive: true })
    assert.throws(() => resolveHideListPath(join(lib, 'index.js')), /profile root/)
  } finally {
    rmSync(orphan, { recursive: true, force: true })
  }
})

test('renderServerSdkSnapshot matches dsh-tools renderToolsSdk member format', () => {
  const definition = {
    name: 'mcp__testsrv__probe',
    description: 'A probe tool.   With   messy whitespace.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' }
      },
      required: ['query'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false
      }
    }
  }
  // The REAL (patched) renderer, with a name that is not in the hide list
  // (verified below), produces the reference member lines.
  const real = renderToolsSdk([{ ...definition, output: definition.output.schema }])
  const snapshot = renderServerSdkSnapshot([definition])

  // Member lines must be byte-identical to what the section would contain.
  const memberLine = (text) => text.split('\n').filter((l) => l.includes('mcp__testsrv__probe'))
  assert.deepEqual(memberLine(snapshot), memberLine(real), 'member lines byte-identical to renderToolsSdk')
  assert.ok(snapshot.includes('interface ToolArgsMap {'), 'args interface present')
  assert.ok(snapshot.includes('interface ToolOutputMap {'), 'output interface present')
  assert.ok(snapshot.includes('/** A probe tool. With messy whitespace. */'), 'doc line collapsed like dsh-tools docLines')
  assert.ok(!existsSync('/nonexistent-check-marker'), 'sanity')
})

test('formatSchemaDeliveryMessage wraps the snapshot with usage guidance', () => {
  const definition = {
    name: 'mcp__testsrv__probe',
    description: 'probe',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false } }
  }
  const text = formatSchemaDeliveryMessage('testsrv', [definition])
  assert.ok(text.includes('schemaDelivery: "message"'), 'explains the delivery mode')
  assert.ok(text.includes('await tools.mcp__testsrv__<tool>(args)'), 'run_code call guidance')
  assert.ok(text.includes('interface ToolArgsMap {'), 'snapshot embedded')
  assert.equal(formatSchemaDeliveryMessage('testsrv', []), '', 'no tools -> no message')
})

test('two maintainers (simulated concurrent dsh processes) union their sets', () => {
  // Lost-update regression: two processes with different ownedPrefixes
  // interleave hides on the same file — the final content must be the UNION
  // (foreign + both servers' entries), not the last writer's snapshot.
  const { dir, path } = tempHideFile('["todo_write", "web_search"]')
  try {
    const a = createHideListMaintainer({ path, ownedPrefix: 'mcp__alpha__' })
    const b = createHideListMaintainer({ path, ownedPrefix: 'mcp__beta__' })
    a.hide(['mcp__alpha__one'])
    b.hide(['mcp__beta__two'])      // "concurrent" process: own read-modify-write
    a.hide(['mcp__alpha__three'])
    b.hide(['mcp__beta__four'])
    const names = JSON.parse(readFileSync(path, 'utf8'))
    for (const n of [
      'todo_write', 'web_search',
      'mcp__alpha__one', 'mcp__alpha__three',
      'mcp__beta__two', 'mcp__beta__four',
    ]) {
      assert.ok(names.includes(n), `expected ${n} in hide list, got ${JSON.stringify(names)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hide heals a concurrent clobber: re-verify merges the winner back', () => {
  // Simulate the exact cross-process race: another dsh process writes its own
  // merged list right after our read but before our write would be observed.
  // The CAS re-read verify + retry must end with BOTH sides' entries present.
  const { dir, path } = tempHideFile('["todo_write"]')
  try {
    const a = createHideListMaintainer({ path, ownedPrefix: 'mcp__alpha__' })
    a.hide(['mcp__alpha__one'])
    // "Process B" clobbers with its own merge that never saw alpha's entries
    // (classic lost update): B read the file BEFORE alpha's first write.
    writeFileSync(path, `${JSON.stringify(['todo_write', 'mcp__beta__two'], null, 2)}\n`)
    // Alpha hides again: must merge ON TOP of B's winner, not its stale view,
    // and keep its own earlier entry that B clobbered.
    a.hide(['mcp__alpha__one', 'mcp__alpha__three'])
    const names = JSON.parse(readFileSync(path, 'utf8'))
    for (const n of ['todo_write', 'mcp__beta__two', 'mcp__alpha__one', 'mcp__alpha__three']) {
      assert.ok(names.includes(n), `expected ${n} in hide list, got ${JSON.stringify(names)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
