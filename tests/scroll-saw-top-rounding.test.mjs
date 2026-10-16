#!/usr/bin/env node
// tests/scroll-saw-top-rounding.test.mjs — unit-тест логики патча 80
// «scroll-saw-top-clamp» (TG-DSH-MKS4-20260928 узел 5, absorbed в MS.01.4, rev7).
//
// ROOT CAUSE: yoga's roundLayout() rounds accumulated child positions
// differently across consecutive calculateLayout() passes during
// structural transitions. The bottomPad spacer's getComputedTop()
// oscillates 69↔68 while height stays constant (1) → bottom = top+height
// oscillates 70↔69 → scrollHeight saw.
//
// FIX (rev7): hysteresis clamp with threshold=2, gW-only gate.
//   - |delta| <= 2 AND same gW → hold stable (blocks ±1, ±2 rounding)
//   - |delta| >= 3 → update stable (legitimate content change)
//   - gW (terminal width) change → reset stable (sweep/resize, no drift)
//   - No feedback: stable stores original yoga output, NOT clamped value
//
// Запуск: node --test tests/scroll-saw-top-rounding.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(
  __dirname, '..', 'dsh-overrides', 'patches', 'MS.01.4-yoga-insert-invalidate.patch',
);

// ── Pure function extraction from MS.01.4 (rev7) ─────────────────────
// Эмулирует hysteresis clamp в render-node-to-output.js maxChildBottom loop.
//
// Args:
//   current    — maxChildBottom from current frame's yoga layout (original output)
//   sawClamp   — previous frame's { stable, gW } or undefined (first frame)
//   currentGW  — terminal width (yogaNode.getComputedWidth())
//
// Returns:
//   { stable, clamped, nextSawClamp }
//   stable       — value to remember for next frame (original yoga output, NOT clamped)
//   clamped      — value to use as scrollHeight in current frame
//   nextSawClamp — state to persist: { stable, gW }
function clampMaxChildBottom(current, sawClamp, currentGW) {
  // First frame: initialize
  if (sawClamp === undefined) {
    return {
      stable: current,
      clamped: current,
      nextSawClamp: { stable: current, gW: currentGW },
    };
  }

  // Geometry change (gW differs): reset stable to current
  if (currentGW !== sawClamp.gW) {
    return {
      stable: current,
      clamped: current,
      nextSawClamp: { stable: current, gW: currentGW },
    };
  }

  // Same gW: check hysteresis threshold
  if (Math.abs(current - sawClamp.stable) <= 2) {
    // Hold stable — blocks yoga rounding oscillation (±1, ±2)
    return {
      stable: sawClamp.stable,
      clamped: sawClamp.stable,
      nextSawClamp: { stable: sawClamp.stable, gW: currentGW },
    };
  }

  // |delta| >= 3: legitimate content change → update stable
  return {
    stable: current,
    clamped: current,
    nextSawClamp: { stable: current, gW: currentGW },
  };
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

  test('patch contains hysteresis threshold=2 and gW-only gate (rev7)', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(
      content.includes('_sawClamp'),
      'Patch must add _sawClamp stable cache',
    );
    assert.ok(
      content.includes('Math.abs(maxChildBottom - _c.stable) <= 2'),
      'Patch must use threshold=2 hysteresis (rev7)',
    );
    assert.ok(
      content.includes('getComputedWidth()'),
      'Patch must gate on terminal width (gW)',
    );
  });
});

// ── Logic tests ───────────────────────────────────────────────────────
describe('MS.01.4 logic: hysteresis clamp blocks rounding oscillation', () => {
  test('first frame: initialize stable to current', () => {
    const { stable, clamped } = clampMaxChildBottom(70, undefined, 80);
    assert.equal(stable, 70, 'First frame: stable = current');
    assert.equal(clamped, 70, 'First frame: clamped = current');
  });

  test('oscillation 70→69→70 same gW → clamped stays 70 (rounding blocked)', () => {
    const GW = 80;
    // Frame 1: current=70, no prev
    const f1 = clampMaxChildBottom(70, undefined, GW);
    assert.equal(f1.clamped, 70, 'Frame 1: clamped=70');

    // Frame 2: current=69 (yoga rounded down), delta=1<=2 → hold stable
    const f2 = clampMaxChildBottom(69, f1.nextSawClamp, GW);
    assert.equal(f2.clamped, 70, 'Frame 2: clamped=70 (held stable, rounding blocked)');

    // Frame 3: current=70 (yoga rounded back up), delta=0<=2 → hold stable
    const f3 = clampMaxChildBottom(70, f2.nextSawClamp, GW);
    assert.equal(f3.clamped, 70, 'Frame 3: clamped=70 (still held)');

    // Verify no oscillation in clamped output
    const clampedValues = [f1.clamped, f2.clamped, f3.clamped];
    const unique = new Set(clampedValues);
    assert.equal(unique.size, 1, `Clamped values stable: [${clampedValues}]`);
  });

  test('delta=2 same gW → still held (threshold=2 blocks ±2)', () => {
    // rev6 (threshold=1) let delta=2 through → saw_flips=1.
    // rev7 (threshold=2) blocks it.
    const GW = 80;
    const f1 = clampMaxChildBottom(417, undefined, GW);
    // delta=2: 417→415
    const f2 = clampMaxChildBottom(415, f1.nextSawClamp, GW);
    assert.equal(f2.clamped, 417, 'Delta=2 held (threshold=2 blocks ±2)');
    assert.equal(f2.stable, 417, 'Stable unchanged');
  });

  test('delta=3 same gW → update stable (legitimate content change)', () => {
    // New/deleted message: ±rowHeight ~20px → >=3 → legitimate
    const GW = 80;
    const f1 = clampMaxChildBottom(70, undefined, GW);
    // delta=3: 70→73
    const f2 = clampMaxChildBottom(73, f1.nextSawClamp, GW);
    assert.equal(f2.clamped, 73, 'Delta=3: clamped=current (legitimate change)');
    assert.equal(f2.stable, 73, 'Delta=3: stable updated to current');
  });

  test('gW change → reset stable (sweep/resize, no drift)', () => {
    // Terminal width change during sweep: clamp must reset to prevent
    // drift accumulation (rev3 regression: sweep_statusbar FAIL)
    const f1 = clampMaxChildBottom(70, undefined, 80);
    // Width changed from 80 to 90, current=72
    const f2 = clampMaxChildBottom(72, f1.nextSawClamp, 90);
    assert.equal(f2.clamped, 72, 'gW change: clamped=current (reset)');
    assert.equal(f2.stable, 72, 'gW change: stable reset to current');
  });

  test('no feedback: stable stores original yoga output, NOT clamped value', () => {
    // Critical invariant: when holding (delta<=2), nextSawClamp.stable
    // must be the PREVIOUS stable (an original yoga output), NOT the
    // current clamped value. This prevents feedback loops where clamped
    // value stored as previous causes cascading errors (rev4 regression).
    const GW = 80;
    const f1 = clampMaxChildBottom(70, undefined, GW);
    const f2 = clampMaxChildBottom(69, f1.nextSawClamp, GW);

    // f2.clamped = 70 (held stable), but f2.stable = 70 (previous stable)
    // NOT 69 (current original). If stable were 69 (current), next frame
    // with current=70 would see delta=1 from 69 → hold at 69 → WRONG.
    assert.equal(f2.clamped, 70, 'Clamped = held stable (70)');
    assert.equal(f2.nextSawClamp.stable, 70,
      'nextSawClamp.stable = previous stable (70), NOT current (69)');

    // Verify: frame 3 with current=70 sees delta from stable=70, not 69
    const f3 = clampMaxChildBottom(70, f2.nextSawClamp, GW);
    assert.equal(f3.clamped, 70,
      'Frame 3: clamped=70 (stable was 70, not 69 → no feedback drift)');
  });

  test('multi-frame oscillation: 70→69→70→69 → all clamped=70', () => {
    const GW = 80;
    let state = undefined;
    const clampedValues = [];

    for (const current of [70, 69, 70, 69, 70, 69]) {
      const result = clampMaxChildBottom(current, state, GW);
      clampedValues.push(result.clamped);
      state = result.nextSawClamp;
    }

    const unique = new Set(clampedValues);
    assert.equal(unique.size, 1,
      `All clamped values identical: [${clampedValues}] (no oscillation)`);
    assert.equal(clampedValues[0], 70, 'All clamped = 70');
  });

  test('legitimate growth sequence: 70→90→110 (delta>=3 each) → updates', () => {
    // Real content growth (messages arriving): each step >=3 → stable tracks
    const GW = 80;
    let state = undefined;
    const clampedValues = [];

    for (const current of [70, 90, 110]) {
      const result = clampMaxChildBottom(current, state, GW);
      clampedValues.push(result.clamped);
      state = result.nextSawClamp;
    }

    assert.deepEqual(clampedValues, [70, 90, 110],
      'Legitimate growth: clamped tracks current (not blocked)');
  });

  test('sweep then settle: gW change resets, then clamp activates', () => {
    // Simulate: content at 70, width changes (sweep), then settles at new width
    // with ±1 rounding oscillation
    const f1 = clampMaxChildBottom(70, undefined, 80);
    // Sweep: width 80→90, content shifted to 72
    const f2 = clampMaxChildBottom(72, f1.nextSawClamp, 90);
    assert.equal(f2.clamped, 72, 'Sweep: reset to 72');
    // Settle: oscillation 72→71→72 at new width 90
    const f3 = clampMaxChildBottom(71, f2.nextSawClamp, 90);
    assert.equal(f3.clamped, 72, 'Settle frame 1: held at 72 (rounding blocked)');
    const f4 = clampMaxChildBottom(72, f3.nextSawClamp, 90);
    assert.equal(f4.clamped, 72, 'Settle frame 2: still 72');
  });
});
