#!/usr/bin/env node
// tests/spinner-verbs.test.js — unit-тесты патча 35 «tools-verbs» (узел 1
// TG-DSH-TUI-LIVE-20260917): кастомизация глаголов спиннера через
// settings.yaml dsh-tui.spinnerVerbs {mode: replace|append, verbs[]}.
//
// Контракт (TDD red, ДО реализации):
//   resolveSpinnerVerbs(builtin, custom):
//     - custom undefined/пустой → builtin как есть;
//     - mode 'replace' → только валидные verbs юзера;
//     - mode 'append' (дефолт) → verbs юзера ДО builtin (юзерские важнее в
//       выборке — они в начале, дедуп без потери порядка);
//     - невалидные entries (не-строки, пустые/пустые-after-trim) дропаются;
//     - mode-невалид → трактуется как 'append';
//   normalizeSpinnerVerbs(value): объект → {mode, verbs} с теми же правилами,
//     мусор → undefined (ключ не применяется).
// Запуск: node --test tests/spinner-verbs.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const verbs = await importTuiModule('lib/types/spinnerVerbsPrefs.js');

const BUILTIN = ['Accomplishing', 'Baking', 'Cooking'];

test('resolveSpinnerVerbs: без кастома — builtin как есть', () => {
    assert.deepStrictEqual(verbs.resolveSpinnerVerbs(BUILTIN, undefined), BUILTIN);
    assert.deepStrictEqual(verbs.resolveSpinnerVerbs(BUILTIN, null), BUILTIN);
    assert.deepStrictEqual(verbs.resolveSpinnerVerbs(BUILTIN, {}), BUILTIN);
    assert.deepStrictEqual(verbs.resolveSpinnerVerbs(BUILTIN, { mode: 'replace' }), BUILTIN);
    assert.deepStrictEqual(verbs.resolveSpinnerVerbs(BUILTIN, { verbs: [] }), BUILTIN);
});

test('resolveSpinnerVerbs: replace — только юзерские глаголы', () => {
    const out = verbs.resolveSpinnerVerbs(BUILTIN, { mode: 'replace', verbs: ['Forjing', 'Verjing'] });
    assert.deepStrictEqual(out, ['Forjing', 'Verjing']);
});

test('resolveSpinnerVerbs: append — юзерские ПЕРВЫМИ, builtin после, дедуп', () => {
    const out = verbs.resolveSpinnerVerbs(BUILTIN, { mode: 'append', verbs: ['Forjing', 'Baking'] });
    assert.deepStrictEqual(out, ['Forjing', 'Baking', 'Accomplishing', 'Cooking']);
});

test('resolveSpinnerVerbs: append — дефолтный mode', () => {
    const out = verbs.resolveSpinnerVerbs(BUILTIN, { verbs: ['Verjing'] });
    assert.deepStrictEqual(out, ['Verjing', ...BUILTIN]);
});

test('resolveSpinnerVerbs: невалидный mode = append', () => {
    const out = verbs.resolveSpinnerVerbs(BUILTIN, { mode: 'REPLACE', verbs: ['Forjing'] });
    assert.deepStrictEqual(out, ['Forjing', ...BUILTIN]);
});

test('resolveSpinnerVerbs: мусорные entries дропаются, порядок сохраняется', () => {
    const out = verbs.resolveSpinnerVerbs(BUILTIN, {
        mode: 'replace',
        verbs: ['  Forjing  ', '', '   ', 42, null, 'Verjing', ['x'], { a: 1 }],
    });
    assert.deepStrictEqual(out, ['Forjing', 'Verjing']);
});

test('resolveSpinnerVerbs: пустой список после чистки → builtin', () => {
    const out = verbs.resolveSpinnerVerbs(BUILTIN, { mode: 'replace', verbs: ['', '   ', 7] });
    assert.deepStrictEqual(out, BUILTIN);
});

test('normalizeSpinnerVerbs: объект → {mode, verbs} нормализован', () => {
    const n = verbs.normalizeSpinnerVerbs({ mode: 'replace', verbs: [' Forjing ', ''] });
    assert.deepStrictEqual(n, { mode: 'replace', verbs: ['Forjing'] });
    const d = verbs.normalizeSpinnerVerbs({ verbs: ['Verjing'] });
    assert.deepStrictEqual(d, { mode: 'append', verbs: ['Verjing'] });
});

test('normalizeSpinnerVerbs: мусор → undefined (ключ мёртв)', () => {
    assert.strictEqual(verbs.normalizeSpinnerVerbs(undefined), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs(null), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs('x'), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs(5), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs([]), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs({}), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs({ mode: 'replace' }), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs({ verbs: [] }), undefined);
    assert.strictEqual(verbs.normalizeSpinnerVerbs({ verbs: ['', 3] }), undefined);
});
