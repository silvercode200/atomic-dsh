/**
 * Unit tests for the spot scoring engine (Spot MCP v1.2 §9.2 semantics:
 * lowercase, ru+en stopword removal, punctuation tokenization, Jaccard).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenize, jaccard, coverage, scoreEntry, search,
  STOPWORDS, STATUS_FOUND, STATUS_CLARIFICATION, STATUS_UNKNOWN,
} from '../lib/search.mjs'

const ENTRY = (id, name, text, extra = {}) => ({ id, kind: 'tool', name, text, meta: {}, ...extra })

test('tokenize lowercases and splits on punctuation, keeps cyrillic', () => {
  // JS sort() orders by UTF-16 code units: latin before cyrillic.
  assert.deepEqual(
    [...tokenize('Web-Search, поиск! (глубокий)')].sort(),
    ['search', 'web', 'глубок', 'поиск'],
  )
})

test('tokenize removes ru+en stopwords', () => {
  const tokens = tokenize('the a is в и на для найти tool нужен')
  assert.ok(!tokens.has('the'))
  assert.ok(!tokens.has('в'))
  assert.ok(!tokens.has('для'))
  assert.ok(!tokens.has('найти'))
  assert.ok(!tokens.has('tool'))
  assert.ok(tokens.size === 0, `expected empty, got ${[...tokens]}`)
})

test('stemming folds russian inflections (цель/цели/целей, задача/задачи)', () => {
  const t1 = tokenize('цель')
  const t2 = tokenize('цели')
  const t3 = tokenize('целей')
  assert.equal([...t1][0], [...t2][0])
  assert.equal([...t2][0], [...t3][0])
  assert.deepEqual([...tokenize('задача')], [...tokenize('задачи')])
  assert.deepEqual([...tokenize('задач')], [...tokenize('задачи')])
})

test('stemming folds english plurals (goals → goal)', () => {
  assert.deepEqual([...tokenize('goals')], [...tokenize('goal')])
})

test('jaccard is 1 for identical sets and 0 for disjoint', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0)
  // {a} vs {a,b}: 1/2
  assert.equal(jaccard(new Set(['a']), new Set(['a', 'b'])), 0.5)
})

test('coverage is intersection over query size', () => {
  assert.equal(coverage(new Set(['a', 'b']), new Set(['a', 'b', 'c'])), 1)
  assert.equal(coverage(new Set(['a', 'b']), new Set(['a'])), 0.5)
  assert.equal(coverage(new Set(), new Set(['a'])), 0)
})

test('cyrillic query «найти тул для задач/целей» finds the goal tool', () => {
  const registry = [
    ENTRY('tool:create_goal', 'create_goal', 'goal цель цели задача задачи создать цель постановка objective long-running'),
    ENTRY('tool:update_goal', 'update_goal', 'goal цель обновить изменить edit pause resume ревизия revision'),
    ENTRY('tool:get_goal', 'get_goal', 'goal цель прочитать посмотреть состояние статус phase'),
    ENTRY('tool:todo_write', 'todo_write', 'todo список задач таск-лист план record task list'),
    ENTRY('mcp:tavily', 'tavily', 'web search поиск в интернете tavily research статьи'),
  ]
  const result = search(registry, 'найти тул для задач/целей')
  assert.equal(result.status, STATUS_FOUND)
  assert.ok(['create_goal', 'update_goal', 'get_goal'].includes(result.top.entry.name),
    `top was ${result.top?.name}`)
  assert.ok(result.top.score >= 0.7)
})

test('explicit name match returns found with score 1', () => {
  const registry = [
    ENTRY('tool:ralph', 'ralph', 'ralph режим автономных раундов autonomous rounds'),
    ENTRY('tool:web_search', 'web_search', 'веб поиск интернет search'),
  ]
  const result = search(registry, 'ralph')
  assert.equal(result.status, STATUS_FOUND)
  assert.equal(result.top.entry.name, 'ralph')
  assert.equal(result.top.score, 1)
})

test('mid-range scores produce clarification with candidates', () => {
  const registry = [
    ENTRY('tool:ask_user_question', 'ask_user_question', 'спросить пользователя вопрос уточнение ask user question confirm'),
    ENTRY('tool:send_message', 'send_message', 'отправить сообщение субагенту message subagent'),
  ]
  // «вопрос пользователю» hits ask_user_question at 2/3 coverage — mid range
  const result = search(registry, 'задать вопрос пользователю')
  assert.equal(result.status, STATUS_CLARIFICATION)
  assert.ok(result.candidates.length >= 1)
  assert.ok(result.top.score >= 0.4 && result.top.score < 0.7)
})

test('unknown for gibberish', () => {
  const registry = [
    ENTRY('tool:ralph', 'ralph', 'ralph автономные раунды'),
  ]
  const result = search(registry, 'qqq zzzyyy xxx')
  assert.equal(result.status, STATUS_UNKNOWN)
  assert.equal(result.top, undefined)
  assert.ok(Array.isArray(result.categories))
})

test('unknown result lists registry categories', () => {
  const registry = [
    ENTRY('a', 'a', 'x', { kind: 'tool' }),
    ENTRY('b', 'b', 'x', { kind: 'skill' }),
    ENTRY('c', 'c', 'x', { kind: 'mcp' }),
  ]
  const result = search(registry, 'абракадабра неизвестное')
  assert.ok(result.categories.includes('tool'))
  assert.ok(result.categories.includes('skill'))
  assert.ok(result.categories.includes('mcp'))
})

test('search merges entries and prefers focused entries on ties', () => {
  const registry = [
    ENTRY('tool:get_goal', 'get_goal', 'goal цель статус состояние'),
    ENTRY('tool:update_goal', 'update_goal', 'goal цель обновить edit pause resume revision ревизия'),
  ]
  // «статус цели» — both contain цель; get_goal also has статус → higher coverage
  const result = search(registry, 'статус цели')
  assert.equal(result.top.entry.name, 'get_goal')
})

test('mcp entry found by routing hints', () => {
  const registry = [
    ENTRY('mcp:deep-research', 'deep-research', 'deep research рисёч диприсёч глубокое исследование multi-source', { kind: 'mcp' }),
  ]
  const result = search(registry, 'нужен глубокий research')
  assert.equal(result.status, STATUS_FOUND)
  assert.equal(result.top.entry.name, 'deep-research')
})

test('empty query token set yields unknown', () => {
  const registry = [ENTRY('tool:ralph', 'ralph', 'ralph автономные раунды')]
  const result = search(registry, 'в и на the a')
  assert.equal(result.status, STATUS_UNKNOWN)
})

test('scoreEntry exposes jaccard and coverage components', () => {
  const s = scoreEntry(tokenize('goal цель'), ENTRY('g', 'g', 'goal цель задача'))
  assert.ok(s.jaccard > 0 && s.jaccard < 1)
  assert.equal(s.coverage, 1)
})

test('explicitNameMatch survives regex-metachar names (c++, task(1), a*b)', () => {
  const registry = [
    ENTRY('tool:cpp', 'c++', 'cpp compiler toolchain plus plus'),
    ENTRY('tool:task1', 'task(1)', 'first task helper задача один'),
    ENTRY('tool:star', 'a*b', 'glob star pattern matcher'),
  ]
  // No SyntaxError from unescaped metacharacters; exact-name queries match.
  const r1 = search(registry, 'task(1)')
  assert.equal(r1.status, STATUS_FOUND)
  assert.equal(r1.top.entry.name, 'task(1)')
  // whole-word occurrence inside a longer query, metachar name
  const r2 = search(registry, 'use c++ please')
  assert.equal(r2.status, STATUS_FOUND)
  assert.equal(r2.top.entry.name, 'c++')
  // metachar-only queries must not throw on any entry
  assert.doesNotThrow(() => {
    search(registry, 'a*b')
    search(registry, 'find [x] now')
    search(registry, 'x + y')
  })
})
