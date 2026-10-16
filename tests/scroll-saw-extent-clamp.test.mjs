#!/usr/bin/env node
// tests/scroll-saw-extent-clamp.test.mjs — unit-тест логики патча 78
// «scroll-saw-basis-clamp» (TG-DSH-MKS4-20260928 узел 5, absorbed в MS.01.4).
//
// ROOT CAUSE: render-node-to-output.js extent floor —
//   scrollHeight = max(wrapperHeight, max(childBottoms)).
//   wrapperHeight = contentYoga.getComputedHeight() — из MEASURE-пасса
//   (flex-basis). maxChildBottom = max(top+height) — из LAYOUT-пасса.
//   Floor ловил UNDERESTIMATION (basis < final) но НЕ ловил
//   OVERESTIMATION (basis > final → wrapperHeight > childBottoms →
//   max() берёт завышенный wrapperHeight → scrollHeight 423↔422).
//
// FIX: maxChildBottom (layout-пасс, authoritative) используется как
//   scrollHeight exclusively when children exist. wrapperHeight — только
//   fallback для пустого враппера (нет childYoga).
//
// Запуск: node --test tests/scroll-saw-extent-clamp.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(
  __dirname, '..', 'dsh-overrides', 'patches', 'MS.01.4-yoga-insert-invalidate.patch',
);

// ── Pure function extraction from MS.01.4 (absorbed in MS.01.4) ──────
// Эмулирует render-node-to-output.js:655-676 extent computation.
//
// PATCHED (MS.01.4): scrollHeight = maxChildBottom exclusively when
//   children exist; wrapperHeight is only a fallback for empty wrapper.
//   Works in BOTH directions: floors underestimation AND caps overestimation.
//
// Args:
//   wrapperHeight — contentYoga.getComputedHeight() (measure-pass, flex-basis)
//   childBottoms  — array of getComputedTop()+getComputedHeight() for each child
//
// Returns: scrollHeight (number)
function computeScrollHeight(wrapperHeight, childBottoms) {
  if (childBottoms.length > 0) {
    return Math.max(...childBottoms);
  }
  return wrapperHeight;
}

// PRE-FIX (original behavior): scrollHeight = max(wrapperHeight, maxChildBottom).
// Catches underestimation but NOT overestimation (buggy).
function computeScrollHeightOriginal(wrapperHeight, childBottoms) {
  if (childBottoms.length > 0) {
    return Math.max(wrapperHeight, ...childBottoms);
  }
  return wrapperHeight;
}

// ── Structural check ──────────────────────────────────────────────────
describe('MS.01.4 structural check', () => {
  test('patch file exists at dsh-overrides/patches/', () => {
    assert.ok(fs.existsSync(PATCH_FILE), `Expected: ${PATCH_FILE}`);
  });

  test('patch contains DEP-3 header (Goal + Family fields)', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(content.includes('# Goal:'), 'Patch must contain DEP-3 # Goal: header');
    assert.ok(content.includes('# Family:'), 'Patch must contain DEP-3 # Family: header');
  });

  test('patch uses maxChildBottom exclusively (not max wrapper, child)', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(
      content.includes('if (hasChildYoga)'),
      'Patch must gate scrollHeight on hasChildYoga',
    );
    assert.ok(
      content.includes('scrollHeight = maxChildBottom'),
      'Patch must set scrollHeight = maxChildBottom (not max of wrapper+child)',
    );
  });
});

// ── Logic tests ───────────────────────────────────────────────────────
describe('MS.01.4 logic: maxChildBottom authoritative in both directions', () => {
  test('underestimation: wrapper 286, child 287 → 287 (both fix and original)', () => {
    // Documented case: "wrapper 286 while the last row's bottom sat at 287"
    const patched = computeScrollHeight(286, [287]);
    const original = computeScrollHeightOriginal(286, [287]);
    assert.equal(patched, 287, 'Patched: maxChildBottom wins (287)');
    assert.equal(original, 287, 'Original: max() also picks 287 (caught underestimation)');
  });

  test('overestimation: wrapper 423, child 422 → 422 (NEW behavior, root cause fix)', () => {
    // The ±1 saw: basis overestimates → wrapperHeight=423 > childBottom=422
    // Pre-fix: max(423, 422) = 423 (buggy inflation)
    // Patched: maxChildBottom = 422 (caps inflation)
    const patched = computeScrollHeight(423, [422]);
    const original = computeScrollHeightOriginal(423, [422]);
    assert.equal(patched, 422, 'Patched: maxChildBottom caps overestimation (422)');
    assert.equal(original, 423, 'Original: max() picks inflated wrapper (423 = root cause)');
  });

  test('overestimation is the root cause: original oscillates, patched stable', () => {
    // Simulate scroll: row with overestimating basis enters/leaves mount window
    // Mounted: wrapperHeight=423 (basis > final), childBottom=422
    // Unmounted: bottomPad spacer (accurate height), childBottom=422
    const mountedChild = [422];
    const unmountedChild = [422]; // same real extent

    // Original: mounted → max(423, 422) = 423; unmounted → max(422, 422) = 422
    const origMounted = computeScrollHeightOriginal(423, mountedChild);
    const origUnmounted = computeScrollHeightOriginal(422, unmountedChild);
    assert.notEqual(origMounted, origUnmounted,
      `Original: oscillates ${origMounted}↔${origUnmounted} (root cause)`);

    // Patched: mounted → 422; unmounted → 422 (stable!)
    const patchedMounted = computeScrollHeight(423, mountedChild);
    const patchedUnmounted = computeScrollHeight(422, unmountedChild);
    assert.equal(patchedMounted, patchedUnmounted,
      `Patched: stable ${patchedMounted} (overestimation capped)`);
  });

  test('empty wrapper (no children) → wrapperHeight fallback', () => {
    const result = computeScrollHeight(300, []);
    assert.equal(result, 300, 'Empty wrapper → fallback to wrapperHeight');
  });

  test('multiple children → max of all bottoms', () => {
    const result = computeScrollHeight(500, [100, 250, 400, 350]);
    assert.equal(result, 400, 'maxChildBottom = max of all child bottoms');
  });

  test('multiple children with overestimation → capped', () => {
    // wrapperHeight=500, but max child bottom=400 → 400 (not 500)
    const patched = computeScrollHeight(500, [100, 250, 400, 350]);
    const original = computeScrollHeightOriginal(500, [100, 250, 400, 350]);
    assert.equal(patched, 400, 'Patched: caps to maxChildBottom (400)');
    assert.equal(original, 500, 'Original: inflated by wrapperHeight (500)');
  });

  test('single child, wrapper matches → same result both paths', () => {
    const patched = computeScrollHeight(300, [300]);
    const original = computeScrollHeightOriginal(300, [300]);
    assert.equal(patched, 300);
    assert.equal(original, 300);
  });
});
