// tests/kitty-csiu-leak.test.js — unit-тест логики патча 62 (C4 CLOSED bug).
// «kitty-csiu-leak» (TG-DSH-BIGBANG-20261016 Phase 2 track W2-B).
//
// C4 ROOT CAUSE: kitty keyboard protocol CSI-u sequences (WezTerm env has
// disambiguate mode ON) — Shift+Enter arrives as ESC[13;2u, the parser's
// CSI-u branch mapped name 'return' to literal input "return" (word leaked
// as text). The /theme catch-all appended it to the filter query → 0 matches
// → arrows dead (move count=0 early return) → first Esc only cleared the
// filter (picker «вклеен + ❯ фриз»).
//
// PATCH 62 FIX: в обеих ветках (CSI-u + modifyOtherKeys) правило словаря
// вместо двух спец-кейсов ('space'→' ' + 'escape'→''):
//   - 'space' → ' ' (space is NOT in nonAlphanumericKeys — text flows)
//   - любое другое nonAlphanumeric-имя → '' (flags carry semantics)
//   - буквы/цифры (односимвольные имена) → текут текстом как раньше
//
// Этот тест — pure function extraction БЕЗ React/Yoga/DOM. Запуск:
//   node --test tests/kitty-csiu-leak.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Pure function: resolveInput (extracted from patch 62) ──────────────
// Логика обеих веток (CSI-u строка ~93, modifyOtherKeys строка ~127)
// input-event.js после патча 62:
//   input = keypress.name === 'space'
//       ? ' '
//       : nonAlphanumericKeys.includes(keypress.name)
//           ? ''
//           : keypress.name;
//
// nonAlphanumericKeys определяется в parse-keypress.js:989-1000 (upstream,
// не патчится) — все многобуквенные имена keyName: 'escape', 'return',
// 'tab', 'delete', 'backspace', 'up', 'down', 'left', 'right', 'home',
// 'end', 'pageup', 'pagedown', 'insert', 'f1'..'f12', 'wheelup'/'wheeldown'
// и др. 'space' НЕ входит — space должен течь текстом.

const nonAlphanumericKeys = [
  'escape', 'return', 'tab', 'delete', 'backspace',
  'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'insert',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6',
  'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'wheelup', 'wheeldown', 'wheelleft', 'wheelright',
];

/**
 * resolveInput — pure extraction of patch 62's input resolution logic.
 *
 * Replaces the pre-fix two special-case rule ('space'→' ', 'escape'→'')
 * with a vocabulary rule: 'space' stays text, every other
 * non-alphanumeric name is cleared (flags carry semantics), letters and
 * digits (length-1 names) keep flowing as text.
 *
 * @param {string} keyName - keypress.name from the terminal parser
 * @param {string[]} nonAlpha - nonAlphanumericKeys list (from parse-keypress.js)
 * @returns {string} - the input text to deliver to the text layer
 */
function resolveInput(keyName, nonAlpha) {
  if (keyName === 'space') return ' ';
  if (nonAlpha.includes(keyName)) return '';
  return keyName;
}

// ── Path resolution for structural checks ──────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const patchPath = join(
  projectRoot,
  'dsh-overrides',
  'patches',
  'TR.05.1-theme-picker-kitty-input.patch',
);

// ── Tests ──────────────────────────────────────────────────────────────

// C4 THE BUG: kitty sends 'return' as a word — pre-fix it leaked into
// the /theme filter as literal text "return". Post-fix (patch 62) it
// must be cleared to '' because key.return flag carries the semantics.
test('C4 bug: kitty "return" → "" (not leaked as literal text)', () => {
  assert.equal(
    resolveInput('return', nonAlphanumericKeys),
    '',
    'kitty Shift+Enter (CSI 13;2u) sends name="return" — must NOT leak as text',
  );
});

test('kitty "tab" → "" (Shift+Tab CSI 9;2u)', () => {
  assert.equal(resolveInput('tab', nonAlphanumericKeys), '');
});

test('kitty "delete" → ""', () => {
  assert.equal(resolveInput('delete', nonAlphanumericKeys), '');
});

test('kitty "escape" → "" (key.escape carries semantics)', () => {
  assert.equal(resolveInput('escape', nonAlphanumericKeys), '');
});

test('kitty "backspace" → ""', () => {
  assert.equal(resolveInput('backspace', nonAlphanumericKeys), '');
});

// 'space' is the EXCEPTION: NOT in nonAlphanumericKeys — must keep
// reaching text input. Pre-fix this was already correct ('space'→' ');
// patch 62 preserves it while extending the clear rule to all other
// non-alphanumeric names.
test('space → " " (text flows — space NOT in nonAlphanumericKeys)', () => {
  assert.equal(resolveInput('space', nonAlphanumericKeys), ' ');
  // Verify space is genuinely absent from the list
  assert.ok(
    !nonAlphanumericKeys.includes('space'),
    'space must NOT be in nonAlphanumericKeys — it must reach text input',
  );
});

// Letters and digits (length-1 names) must flow as text unchanged.
test('letter "a" → "a" (text flows)', () => {
  assert.equal(resolveInput('a', nonAlphanumericKeys), 'a');
});

test('digit "1" → "1" (text flows)', () => {
  assert.equal(resolveInput('1', nonAlphanumericKeys), '1');
});

// Additional coverage: all nonAlphanumericKeys must clear to ''.
test('all nonAlphanumericKeys clear to ""', () => {
  for (const keyName of nonAlphanumericKeys) {
    assert.equal(
      resolveInput(keyName, nonAlphanumericKeys),
      '',
      `nonAlphanumeric key "${keyName}" must clear to ""`,
    );
  }
});

// Structural check: patch 62 exists and has DEP-3 header with Status: live.
test('structural: patch 62 file exists', () => {
  assert.ok(
    existsSync(patchPath),
    `patch file must exist: ${patchPath}`,
  );
});

test('structural: patch 62 DEP-3 header has "# Status: live"', () => {
  assert.ok(existsSync(patchPath), 'patch file must exist for header check');
  const content = readFileSync(patchPath, 'utf8');
  assert.ok(
    content.includes('# Status:    live'),
    'DEP-3 header must contain "# Status:    live"',
  );
});
