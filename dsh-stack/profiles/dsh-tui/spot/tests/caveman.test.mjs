/**
 * Unit tests for the caveman system-prompt diet table
 * (~/.dsh/patches/caveman-system.json, applied by the dsh-patch-caveman
 * wrapper in dsh-system-prompt/lib/index.js — patch id "caveman" in
 * ~/.dsh/patches/apply-dsh-tools-patches.sh).
 *
 * Guards:
 * - table structure: array of {id, from, to}, from !== to, non-empty to
 * - no entry's `to` contains another entry's `from` (no replacement chains)
 * - the compressor's semantic invariants: compressed texts keep the
 *   load-bearing markers (trigger words, safety constraints, response
 *   formats) for a sample of tools
 * - the replace loop itself: applying the table behaves like the runtime
 *   helper (missing entries no-op, applied text idempotent)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TABLE_PATH = join(homedir(), '.dsh/patches/caveman-system.json')
const entries = JSON.parse(readFileSync(TABLE_PATH, 'utf8'))
const byId = new Map(entries.map((e) => [e.id, e]))

/** Mirror of the runtime dshPatchCaveman loop (dsh-system-prompt patch). */
function applyTable(text, table) {
  for (const entry of table) {
    if (typeof entry?.from !== 'string' || typeof entry.to !== 'string') continue
    if (entry.from === entry.to || entry.to.length === 0 || !text.includes(entry.from)) continue
    text = text.split(entry.from).join(entry.to)
  }
  return text
}

test('caveman table: structure is valid', () => {
  assert.ok(Array.isArray(entries), 'table must be a JSON array')
  assert.ok(entries.length > 50, `expected a real diet table, got ${entries.length} entries`)
  const ids = new Set()
  for (const e of entries) {
    assert.equal(typeof e.id, 'string', 'entry.id must be a string')
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`)
    ids.add(e.id)
    assert.equal(typeof e.from, 'string', `${e.id}: from must be a string`)
    assert.equal(typeof e.to, 'string', `${e.id}: to must be a string`)
    assert.ok(e.from.length > 0, `${e.id}: from must be non-empty`)
    assert.ok(e.to.length > 0, `${e.id}: to must be non-empty (empty would leave blank section gaps)`)
    assert.notEqual(e.from, e.to, `${e.id}: from === to is a no-op entry`)
  }
})

test('caveman table: no replacement chains (no to contains another from)', () => {
  for (const a of entries) {
    for (const b of entries) {
      if (a === b) continue
      assert.ok(
        !a.to.includes(b.from),
        `to[${a.id}] contains from[${b.id}] — the second entry would fire on already-replaced text`,
      )
    }
  }
})

test('caveman table: every to is shorter than its from', () => {
  for (const e of entries) {
    assert.ok(
      e.to.length < e.from.length,
      `${e.id}: to (${e.to.length}) must be shorter than from (${e.from.length})`,
    )
  }
})

// ---------------------------------------------------------------------------
// semantic markers: compressed texts must keep trigger words, safety
// constraints and response formats for the highest-stakes tools
// ---------------------------------------------------------------------------
const MARKERS = {
  'doc-bash': [
    'bash -c', 'fresh shell', '`workdir`', '[exit code: N]', '$DSH_*',
    '[sandbox: file access denied under <mode> mode]',
    '`run_in_background: true`', '`job_output`', '`job_kill`',
    '`sandbox_permissions`', '`justification`', 'approval prompt',
    'do not ask in chat', 'approval prompts are disabled',
    'never set `sandbox_permissions`', 'speculatively',
    'rejected escalation is final', 'stop and explain',
  ],
  'doc-subagent': [
    'standalone prompt', 'does not see this conversation',
    'durable subagent id', '`send_message`', '`run_in_background: false`',
  ],
  'doc-submit-partial': [
    'code_refs', 'files_changed', 'evidence_refs', 'screenshot_refs',
    'expected_visual_details', 'backend-only', 'chunk_code',
    'CODE_EVIDENCE_MISSING', 'project_root',
  ],
  'doc-register-task': ['BEFORE starting work', 'atomic', 'project_root', 'planning_guard', 'backend-only'],
  'doc-spot-load': [
    'exact name', 'spot_search', 'ToolArgsMap', 'ToolOutputMap', 'run_code',
    'await tools.<name>(args)', 'mcp__router__search_and_activate',
  ],
  'doc-spot-search': ['NOT in tools:sdk', 'spot_load(name)', 'Do NOT assume cold tool names'],
  'doc-skill-search': ['NO skill catalog', 'FIRST', 'skill_load', 'Never assume skill names'],
  'doc-glob': ['never directories', 'hidden/ignored', 'VCS metadata', '100', 'mtime'],
  'doc-grep': ['ripgrep', 'line numbers', '250'],
  'doc-job-output': ['[status: ...]', '`wait: true`'],
  'edit': ['old_string', 'new_string', 'replace_all', 'fs-observation-policy'],
  'goals': [
    'create_goal', 'get_goal', 'update_goal', 'goal_id', 'revision',
    'resume', 'blocked_reason', '≥3', 'single-turn',
  ],
  'web_search': ['queries', '1–4', 'one-item array', 'markdown links'],
  'jobs': ['job_output', 'job_kill', '`wait: true`', 'busy-poll'],
  'workflow': ['ONLY', 'explicit user request', 'JS script'],
  'ralph': ['ONLY', 'direct human request', 'Ralph loop', 'fresh-agent', 'worker reports', 'goal tools'],
  'subagent': ['background by default', 'one message', '`run_in_background: false`'],
  'subagent_fork': ['background by default', 'one message', '`run_in_background: false`'],
  'status-line': ['⏵', '20-word', 'ONE standalone line', 'every step or subtask', 'update when the task changes'],
  'sdk-args': ['`code`', '`description`', 'erasable', '`enum`', 'type-stripped'],
  'sdk-call': ['await tools.name(args)', 'tools["my-tool"]', 'lossless JSON'],
  'sdk-fail': ['ToolCallError', '`toolName`', 'try/catch'],
  'sdk-parallel': ['Promise.all', 'submission order', '`await`'],
  'sdk-emit': ['`return`', 'console.log', 'image', 'conversation'],
}

test('caveman table: semantic markers survive compression', () => {
  for (const [id, markers] of Object.entries(MARKERS)) {
    const e = byId.get(id)
    assert.ok(e, `entry ${id} missing from table`)
    for (const m of markers) {
      assert.ok(e.to.includes(m), `${id}: marker ${JSON.stringify(m)} lost in compression`)
    }
  }
})

test('caveman table: doc entries keep the JSDoc line shape', () => {
  for (const e of entries) {
    if (!e.id.startsWith('doc-')) continue
    const shape = (s) => {
      const stripped = s.trim()
      return stripped.startsWith('/**') && stripped.endsWith(' */')
    }
    assert.ok(shape(e.from), `${e.id}: from is not a doc line`)
    assert.ok(shape(e.to), `${e.id}: to must stay a single-line JSDoc comment`)
    // indentation preserved (the type skeleton's nesting must not change)
    assert.equal(e.to.slice(0, e.to.length - e.to.trimStart().length),
      e.from.slice(0, e.from.length - e.from.trimStart().length),
      `${e.id}: indentation changed`)
  }
})

test('applyTable: behaves like the runtime helper', () => {
  // full application replaces every from present in its own from-text
  const sample = entries.slice(0, 10)
  const text = sample.map((e) => e.from).join('\n\n')
  const applied = applyTable(text, entries)
  for (const e of sample) {
    assert.ok(!applied.includes(e.from), `from ${e.id} still present after apply`)
    assert.ok(applied.includes(e.to), `to ${e.id} missing after apply`)
  }
  // idempotent: second pass is a no-op
  assert.equal(applyTable(applied, entries), applied, 'second pass must not change anything')
  // missing/broken entries are skipped without throwing
  const broken = [
    { id: 'x', from: 'not-present-anywhere', to: 'xyz' }, // from absent -> no-op
    { id: 'y', to: 'zzz' }, // missing from -> skipped
    null,
  ]
  assert.equal(applyTable('abc def', broken), 'abc def')
})
