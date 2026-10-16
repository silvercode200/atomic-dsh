/**
 * Unit tests for registry loading/validation, skill merging, hide.json
 * consistency and the registry linter (SP001–SP007, adapted from Spot
 * MCP v1.2 §14 OP001–OP010).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegistry, validateRegistry, mergeSkillEntries, REGISTRY_KINDS } from '../lib/registry.mjs'
import { lintRegistry } from '../lint.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'spot-test-'))
test.after(() => rmSync(TMP, { recursive: true, force: true }))

const write = (name, data) => {
  const path = join(TMP, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
  return path
}

/** A minimal valid registry fixture. */
function fixture() {
  return {
    version: 1,
    entries: [
      { id: 'tool:ralph', kind: 'tool', name: 'ralph', text: 'ralph автономные раунды', meta: { tsArgs: '  ralph: {};', tsOutput: '  ralph: {};' } },
      { id: 'mcp:tavily', kind: 'mcp', name: 'tavily', text: 'web search поиск', meta: { serverName: 'tavily' } },
    ],
  }
}

test('loadRegistry reads the real registry.json and validates it', () => {
  const entries = loadRegistry(new URL('../registry.json', import.meta.url))
  assert.ok(entries.length >= 20, `expected >=20 entries, got ${entries.length}`)
  const kinds = new Set(entries.map((e) => e.kind))
  assert.ok(kinds.has('tool'))
  assert.ok(kinds.has('mcp'))
  for (const entry of entries) {
    assert.ok(typeof entry.id === 'string' && entry.id.length > 0)
    assert.ok(REGISTRY_KINDS.has(entry.kind))
    assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
    assert.ok(typeof entry.text === 'string' && entry.text.length > 0)
  }
})

test('validateRegistry rejects a duplicate id', () => {
  const bad = fixture()
  bad.entries.push({ ...bad.entries[0] })
  const errors = validateRegistry(bad)
  assert.ok(errors.some((e) => e.id === 'SP002'))
})

test('validateRegistry rejects an invalid kind', () => {
  const bad = fixture()
  bad.entries[0].kind = 'banana'
  const errors = validateRegistry(bad)
  assert.ok(errors.some((e) => e.id === 'SP003'))
})

test('validateRegistry rejects empty routing text', () => {
  const bad = fixture()
  bad.entries[0].text = '   '
  const errors = validateRegistry(bad)
  assert.ok(errors.some((e) => e.id === 'SP004'))
})

test('validateRegistry rejects a tool entry without a TS snapshot', () => {
  const bad = fixture()
  delete bad.entries[0].meta.tsArgs
  const errors = validateRegistry(bad)
  assert.ok(errors.some((e) => e.id === 'SP005'))
})

test('validateRegistry rejects an mcp entry without serverName', () => {
  const bad = fixture()
  delete bad.entries[1].meta.serverName
  const errors = validateRegistry(bad)
  assert.ok(errors.some((e) => e.id === 'SP006'))
})

test('validateRegistry accepts the fixture', () => {
  assert.deepEqual(validateRegistry(fixture()), [])
})

test('mergeSkillEntries turns skill catalog rows into skill entries', () => {
  const skills = [
    { name: 'pdf-convert', description: 'Convert PDF files to markdown', whenToUse: 'When the user mentions PDFs' },
    { name: 'empty-skill', description: '', whenToUse: '' },
    { name: '', description: 'no name' },
    undefined,
  ]
  const merged = mergeSkillEntries(skills)
  // empty-skill survives: its name alone is searchable routing text
  assert.equal(merged.length, 2)
  assert.equal(merged[0].kind, 'skill')
  assert.equal(merged[0].name, 'pdf-convert')
  assert.ok(merged[0].text.includes('pdf-convert'))
  assert.ok(merged[0].text.includes('pdf'))
  assert.ok(merged[0].text.includes('markdown'))
  assert.equal(merged[1].name, 'empty-skill')
})

test('hide.json: array of unique strings, every name has a tool registry entry', async () => {
  const { readFileSync } = await import('node:fs')
  const hide = JSON.parse(readFileSync(new URL('../hide.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(hide))
  assert.ok(hide.every((n) => typeof n === 'string'))
  assert.equal(new Set(hide).size, hide.length, 'duplicate names in hide.json')
  const entries = loadRegistry(new URL('../registry.json', import.meta.url))
  const toolNames = new Set(entries.filter((e) => e.kind === 'tool').map((e) => e.name))
  for (const name of hide) {
    assert.ok(toolNames.has(name), `hide.json name "${name}" has no registry tool entry`)
  }
  // and vice versa: every registry tool is hidden
  for (const name of toolNames) {
    assert.ok(hide.includes(name), `registry tool "${name}" missing from hide.json`)
  }
  // hot tools must NOT be hidden
  for (const hot of ['run_code', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'subagent', 'skill_search', 'skill_load']) {
    assert.ok(!hide.includes(hot), `hot tool "${hot}" must not be in hide.json`)
  }
})

test('lint.mjs: real registry passes with 0 errors', () => {
  const report = lintRegistry(new URL('../registry.json', import.meta.url), new URL('../hide.json', import.meta.url))
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
})

test('lint.mjs: flags a hide.json name missing from the registry', () => {
  const regPath = write('reg.json', fixture())
  const hidePath = write('hide.json', ['ralph', 'nonexistent_tool'])
  const report = lintRegistry(regPath, hidePath)
  assert.ok(report.errors.some((e) => e.id === 'SP007'))
})

test('lint.mjs: flags a registry tool missing from hide.json', () => {
  const regPath = write('reg2.json', fixture())
  const hidePath = write('hide2.json', [])
  const report = lintRegistry(regPath, hidePath)
  assert.ok(report.errors.some((e) => e.id === 'SP008'))
})

test('lint.mjs: reports errors for a malformed JSON file', () => {
  const badPath = write('bad.json', '{ not json')
  const report = lintRegistry(badPath, badPath)
  assert.ok(report.errors.length > 0)
})
