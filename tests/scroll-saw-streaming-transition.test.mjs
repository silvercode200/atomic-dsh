#!/usr/bin/env node
// tests/scroll-saw-streaming-transition.test.mjs — unit-тест логики патча 77
// «scroll-extent-streaming-clamp» (TG-DSH-MKS4-20260928 узел 5, absorbed в MS.01.1).
//
// ROOT CAUSE: после C-c / turn end контент замирает → нет signature
// changes → patch 54 retention НЕ удаляет stale heightsRef (запись
// существует, устаревшая — замерена mid-reveal до роста ряда). Сдвиг окна
// скролла ремоунтит ряд → extent осциллирует ±1 (80↔81).
//
// FIX: prevStreamingRef Set отслеживает streaming row IDs. На переход
// row.streaming true→false → heightsRef.delete(row.id) — независимо от
// signature change. Срабатывает один раз на переход.
//
// Запуск: node --test tests/scroll-saw-streaming-transition.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(
  __dirname, '..', 'dsh-overrides', 'patches', 'MS.01.1-scroll-menu-nogap.patch',
);

// ── Pure function extraction from MS.01.1 ────────────────────────────
// Эмулирует signature-блок MessageList.js: для каждого visible row
// проверяет streaming→false transition и удаляет stale heightsRef entry.
//
// Args:
//   visibleRows   — array of { id, streaming } objects
//   prevStreaming — Set of row IDs that were streaming in previous frame
//   heightsRef    — Map acting as heightsRef.current (mutated in place)
//
// Returns:
//   { nextStreaming: Set, changed: boolean }
//   nextStreaming — Set of IDs currently streaming (for next frame's prev)
//   changed       — whether any heightsRef deletion occurred
function applyStreamingTransition(visibleRows, prevStreaming, heightsRef) {
  const nextStreaming = new Set();
  let changed = false;

  for (const row of visibleRows) {
    // DSH-P77: invalidate stale heightsRef when row transitions
    // from streaming to non-streaming (C-c / turn end / stream complete).
    // Patch 54 retains streaming heights across sig changes, but after
    // the stream stops no more sig changes occur → stale entry persists.
    if (row.streaming !== true && prevStreaming.has(row.id)) {
      heightsRef.delete(row.id);
      changed = true;
    }
    if (row.streaming === true) {
      nextStreaming.add(row.id);
    }
  }

  return { nextStreaming, changed };
}

// ── Structural check ──────────────────────────────────────────────────
describe('MS.01.1 structural check', () => {
  test('patch file exists at dsh-overrides/patches/', () => {
    assert.ok(fs.existsSync(PATCH_FILE), `Expected: ${PATCH_FILE}`);
  });

  test('patch contains DEP-3 header (Goal + Family fields)', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(content.includes('# Goal:'), 'Patch must contain DEP-3 # Goal: header');
    assert.ok(content.includes('# Family:'), 'Patch must contain DEP-3 # Family: header');
  });

  test('patch contains prevStreamingRef and heightsRef.delete on transition', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(
      content.includes('prevStreamingRef'),
      'Patch must add prevStreamingRef tracking',
    );
    assert.ok(
      content.includes('heightsRef.current.delete(row.id)'),
      'Patch must delete stale heightsRef on streaming→false transition',
    );
  });
});

// ── Logic tests ───────────────────────────────────────────────────────
describe('MS.01.1 logic: streaming→false invalidates stale heightsRef', () => {
  test('row A streaming=true (in prev) → retained, NOT deleted', () => {
    const heightsRef = new Map([['A', 10]]);
    const prevStreaming = new Set(['A']);
    const rows = [{ id: 'A', streaming: true }];

    const { nextStreaming, changed } = applyStreamingTransition(
      rows, prevStreaming, heightsRef,
    );

    assert.equal(changed, false, 'No deletion for still-streaming row');
    assert.ok(nextStreaming.has('A'), 'A should be in nextStreaming');
    assert.equal(heightsRef.get('A'), 10, 'A heightsRef entry preserved');
  });

  test('row B streaming=false (was in prev) → deleted from heightsRef', () => {
    const heightsRef = new Map([['B', 20]]);
    const prevStreaming = new Set(['B']);
    const rows = [{ id: 'B', streaming: false }];

    const { nextStreaming, changed } = applyStreamingTransition(
      rows, prevStreaming, heightsRef,
    );

    assert.equal(changed, true, 'Deletion should occur on true→false transition');
    assert.ok(!nextStreaming.has('B'), 'B should NOT be in nextStreaming');
    assert.equal(heightsRef.has('B'), false, 'B heightsRef entry deleted (stale removed)');
  });

  test('row C streaming=false (NOT in prev) → no change', () => {
    const heightsRef = new Map([['C', 5]]);
    const prevStreaming = new Set(); // C was never streaming
    const rows = [{ id: 'C', streaming: false }];

    const { nextStreaming, changed } = applyStreamingTransition(
      rows, prevStreaming, heightsRef,
    );

    assert.equal(changed, false, 'No deletion for row that was never streaming');
    assert.ok(!nextStreaming.has('C'), 'C should NOT be in nextStreaming');
    assert.equal(heightsRef.get('C'), 5, 'C heightsRef entry preserved');
  });

  test('C-c: all rows streaming→false (all in prev) → ALL deleted', () => {
    const heightsRef = new Map([['A', 10], ['B', 20], ['C', 5]]);
    const prevStreaming = new Set(['A', 'B', 'C']);
    // C-c: all rows now non-streaming
    const rows = [
      { id: 'A', streaming: false },
      { id: 'B', streaming: false },
      { id: 'C', streaming: false },
    ];

    const { nextStreaming, changed } = applyStreamingTransition(
      rows, prevStreaming, heightsRef,
    );

    assert.equal(changed, true, 'Deletion should occur');
    assert.equal(nextStreaming.size, 0, 'nextStreaming should be empty');
    assert.equal(heightsRef.size, 0, 'All stale entries deleted');
  });

  test('mixed: one stays streaming, one transitions, one new', () => {
    const heightsRef = new Map([['A', 10], ['B', 20]]);
    const prevStreaming = new Set(['A', 'B']);
    const rows = [
      { id: 'A', streaming: true },   // stays streaming → retained
      { id: 'B', streaming: false },  // transitions → deleted
      { id: 'C', streaming: true },   // new streaming → added to next
    ];

    const { nextStreaming, changed } = applyStreamingTransition(
      rows, prevStreaming, heightsRef,
    );

    assert.equal(changed, true, 'B transition causes deletion');
    assert.ok(nextStreaming.has('A'), 'A still streaming');
    assert.ok(nextStreaming.has('C'), 'C new streaming');
    assert.ok(!nextStreaming.has('B'), 'B no longer streaming');
    assert.equal(heightsRef.has('A'), true, 'A preserved');
    assert.equal(heightsRef.has('B'), false, 'B deleted (stale)');
  });

  test('fires once per transition — second frame no re-delete', () => {
    const heightsRef = new Map([['X', 15]]);
    const prevStreaming = new Set(['X']);

    // Frame 1: X transitions true→false
    const r1 = applyStreamingTransition(
      [{ id: 'X', streaming: false }], prevStreaming, heightsRef,
    );
    assert.equal(r1.changed, true, 'First frame: deletion occurs');
    assert.equal(heightsRef.has('X'), false, 'X deleted');

    // Frame 2: X still false, prevStreaming now empty (committed)
    const r2 = applyStreamingTransition(
      [{ id: 'X', streaming: false }], r1.nextStreaming, heightsRef,
    );
    assert.equal(r2.changed, false, 'Second frame: no re-deletion (fires once)');
  });

  test('empty visibleRows → no changes', () => {
    const heightsRef = new Map([['A', 10]]);
    const prevStreaming = new Set(['A']);
    const { nextStreaming, changed } = applyStreamingTransition(
      [], prevStreaming, heightsRef,
    );
    assert.equal(changed, false, 'Empty rows → no deletion');
    assert.equal(nextStreaming.size, 0, 'Empty nextStreaming');
    assert.equal(heightsRef.get('A'), 10, 'heightsRef unchanged');
  });
});
