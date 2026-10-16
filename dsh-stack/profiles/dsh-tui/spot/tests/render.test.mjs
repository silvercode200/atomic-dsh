/**
 * Unit tests for the minimal JSON-schema → TS renderer and the
 * spot_load result formatting.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonSchemaToTsType, formatToolLoad } from '../lib/render.mjs'

test('jsonSchemaToTsType renders primitives', () => {
  assert.equal(jsonSchemaToTsType({ type: 'string' }, 0), 'string')
  assert.equal(jsonSchemaToTsType({ type: 'number' }, 0), 'number')
  assert.equal(jsonSchemaToTsType({ type: 'boolean' }, 0), 'boolean')
})

test('jsonSchemaToTsType renders required/optional object members', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, note: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  }
  const ts = jsonSchemaToTsType(schema, 0)
  assert.ok(ts.includes('path: string;'), ts)
  assert.ok(ts.includes('note?: string;'), ts)
})

test('jsonSchemaToTsType renders arrays and enums', () => {
  const ts = jsonSchemaToTsType({
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['fast', 'slow'] },
    },
    required: ['items', 'mode'],
    additionalProperties: false,
  }, 0)
  assert.ok(ts.includes('items: string[];'), ts)
  assert.ok(ts.includes('mode: "fast" | "slow";'), ts)
})

test('jsonSchemaToTsType renders nested objects', () => {
  const ts = jsonSchemaToTsType({
    type: 'object',
    properties: {
      outer: {
        type: 'object',
        properties: { inner: { type: 'number' } },
        required: ['inner'],
        additionalProperties: false,
      },
    },
    required: ['outer'],
    additionalProperties: false,
  }, 0)
  assert.ok(ts.includes('outer: {'), ts)
  assert.ok(ts.includes('inner: number;'), ts)
})

test('jsonSchemaToTsType degrades unknown shapes to JsonValue', () => {
  assert.equal(jsonSchemaToTsType({}, 0), 'JsonValue')
  assert.equal(jsonSchemaToTsType(undefined, 0), 'JsonValue')
})

test('formatToolLoad returns the ToolArgsMap/ToolOutputMap member format', () => {
  const entry = {
    id: 'tool:ralph',
    kind: 'tool',
    name: 'ralph',
    text: 'ralph автономные раунды',
    meta: {
      description: 'Run a foreground fresh-agent Ralph loop.',
      tsArgs: '  /** Run a loop */\n  ralph: {\n    objective: string;\n  };',
      tsOutput: '  ralph: {\n    runId: string;\n  };',
    },
  }
  const text = formatToolLoad(entry)
  assert.ok(text.includes('ralph'), text)
  assert.ok(text.includes('interface ToolArgsMap'), text)
  assert.ok(text.includes('interface ToolOutputMap'), text)
  assert.ok(text.includes('objective: string;'), text)
  assert.ok(text.includes('await tools.ralph'), text)
})

test('formatToolLoad falls back to a live schema render when no snapshot exists', () => {
  const entry = {
    id: 'tool:new_tool',
    kind: 'tool',
    name: 'new_tool',
    text: 'new',
    meta: { description: 'A tool added after the registry snapshot.' },
  }
  const live = {
    name: 'new_tool',
    description: 'A tool added after the registry snapshot.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
    output: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  }
  const text = formatToolLoad(entry, live)
  assert.ok(text.includes('target: string;'), text)
  assert.ok(text.includes('ok: boolean;'), text)
})
