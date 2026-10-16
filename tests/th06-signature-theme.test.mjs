#!/usr/bin/env node
// tests/th06-signature-theme.test.mjs — TH.06 signature theme WCAG validation
// (TG-DSH-REBUILD-20260921 node 7)
//
// Signature theme = modified tokyonight-moon with #000000 appBackground and
// WCAG-corrected colors. All text colors must reach >= 4.5:1 contrast ratio
// on #000000 (WCAG AA normal text). Structural colors (borders, subtle,
// inactive) must reach >= 3.0:1 (WCAG AA large text / UI components).
//
// Exceptions: surface/background colors that are NOT rendered as text on
// the app background — documented below, excluded from contrast checks.
//
// Run: node --test tests/th06-signature-theme.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_PATH = join(
  __dirname, '..', 'dsh-overrides', 'themes', 'generated', 'signature.json',
);

// ── WCAG color contrast functions ─────────────────────────────────────

/**
 * WCAG 2.1 relative luminance of a hex color.
 * Formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * @param {string} hex - #rrggbb (alpha suffix stripped if present)
 * @returns {number} luminance in range 0..1
 */
function relativeLuminance(hex) {
  const clean = hex.replace(/^#/, '').slice(0, 6);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * WCAG 2.1 contrast ratio between two hex colors.
 * Formula: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 * @param {string} hex1
 * @param {string} hex2
 * @returns {number} ratio in range 1..21
 */
function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ── Theme loading ─────────────────────────────────────────────────────

/** @returns {{name: string, displayName: string, base: string, colors: Record<string, string>}} */
function loadSignatureTheme() {
  const raw = readFileSync(THEME_PATH, 'utf8');
  return JSON.parse(raw);
}

// ── Key categorization ────────────────────────────────────────────────

// Text keys: rendered as text/content on the #000000 app background.
// Must reach >= 4.5:1 (WCAG AA normal text).
const TEXT_KEYS = [
  'text', 'success', 'error', 'warning', 'warningShimmer',
  'permission', 'permissionShimmer', 'suggestion', 'remember',
  'claude', 'claudeShimmer', 'claudeBlue_FOR_SYSTEM_SPINNER',
  'claudeBlueShimmer_FOR_SYSTEM_SPINNER',
  'autoAccept', 'merged', 'bashBorder', 'planMode',
  'ide', 'professionalBlue', 'chromeYellow',
  'toolDotExec', 'toolDotRead', 'toolDotWrite', 'toolDotWeb', 'toolDotTask',
  'toolNameExec', 'toolNameMutate',
  'syntaxKeyword', 'syntaxString', 'syntaxNumber',
  'syntaxFunction', 'syntaxType', 'syntaxVariable', 'syntaxConstant',
  'red_FOR_SUBAGENTS_ONLY', 'blue_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY', 'yellow_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY', 'pink_FOR_SUBAGENTS_ONLY',
  'orange_FOR_SUBAGENTS_ONLY', 'cyan_FOR_SUBAGENTS_ONLY',
  'subagentBullet', 'subagentDescription', 'subagentToolName',
  'subagentStatusRunning', 'subagentStatusCompleted', 'subagentStatusFailed',
  'rate_limit_fill', 'fastMode', 'fastModeShimmer',
  'briefLabelYou', 'briefLabelClaude',
  'rainbow_red', 'rainbow_orange', 'rainbow_yellow', 'rainbow_green',
  'rainbow_blue', 'rainbow_indigo', 'rainbow_violet',
  'rainbow_red_shimmer', 'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer', 'rainbow_green_shimmer',
  'rainbow_blue_shimmer', 'rainbow_indigo_shimmer', 'rainbow_violet_shimmer',
  'clawd_body', 'diffAddedWord', 'diffRemovedWord',
  'promptBorderShimmer', 'inactiveShimmer',
];

// Structural keys: borders, separators, subtle/inactive text.
// Must reach >= 3.0:1 (WCAG AA large text / UI component boundary).
const STRUCTURAL_KEYS = [
  'inactive', 'subtle', 'promptBorder',
  'syntaxComment', 'syntaxOperator', 'syntaxPunctuation',
  'subagentModel', 'subagentElapsed', 'rate_limit_empty',
];

// Exceptions: NOT rendered as text on #000000 app background.
// These are surface fills, badge backgrounds, or alpha-blended colors.
// Documented here so the test verifies they exist but does NOT check
// their contrast against #000000.
const EXCEPTION_KEYS = [
  'appBackground',         // the background itself (#000000)
  'background',            // badge fill color (text sits ON this, not on app bg)
  'inverseText',           // text on badge fill (light-on-dark badge), not on app bg
  'toolCardBackground',    // card surface fill
  'toolCardBackgroundDim', // dimmed card surface fill
  'messageActionsBackground',     // action bar surface fill
  'bashMessageBackgroundColor',   // bash message surface fill
  'memoryBackgroundColor',        // memory card surface fill
  'userMessageBackground',        // user message surface fill
  'userMessageBackgroundHover',   // user message hover surface fill
  'selectionBg',           // selection highlight (has alpha component #rrggbbaa)
  'diffAdded',             // diff added-line background fill
  'diffRemoved',           // diff removed-line background fill
  'diffAddedDimmed',       // dimmed diff added-line background fill
  'diffRemovedDimmed',     // dimmed diff removed-line background fill
  'clawd_background',      // mascot background fill
];

const APP_BG = '#000000';

// ── Tests ─────────────────────────────────────────────────────────────

describe('WCAG functions', () => {
  test('relativeLuminance: black = 0, white = 1', () => {
    assert.ok(relativeLuminance('#000000') < 0.001, 'black luminance should be ~0');
    assert.ok(relativeLuminance('#ffffff') > 0.999, 'white luminance should be ~1');
  });

  test('contrastRatio: identical colors = 1', () => {
    const ratio = contrastRatio('#888888', '#888888');
    assert.ok(Math.abs(ratio - 1) < 0.01);
  });

  test('contrastRatio: black vs white = 21', () => {
    const ratio = contrastRatio('#000000', '#ffffff');
    assert.ok(ratio > 20, `expected ~21, got ${ratio.toFixed(2)}`);
  });
});

describe('signature theme structure', () => {
  test('signature.json loads and has required fields', () => {
    const theme = loadSignatureTheme();
    assert.equal(theme.name, 'signature');
    assert.equal(theme.base, 'dark');
    assert.ok(typeof theme.colors === 'object');
    assert.ok(Object.keys(theme.colors).length >= 90, 'should have ~97 color keys');
  });

  test('appBackground is #000000 (true black)', () => {
    const theme = loadSignatureTheme();
    assert.equal(theme.colors.appBackground, APP_BG);
  });

  test('all keys in TEXT_KEYS + STRUCTURAL_KEYS + EXCEPTION_KEYS are present', () => {
    const theme = loadSignatureTheme();
    const allExpected = [...TEXT_KEYS, ...STRUCTURAL_KEYS, ...EXCEPTION_KEYS];
    const missing = allExpected.filter((k) => !(k in theme.colors));
    if (missing.length > 0) {
      assert.fail(`missing keys: ${missing.join(', ')}`);
    }
  });
});

describe('signature theme WCAG: text keys >= 4.5:1 on #000000', () => {
  const theme = loadSignatureTheme();
  for (const key of TEXT_KEYS) {
    test(`${key} (${theme.colors[key]}) >= 4.5:1`, () => {
      const val = theme.colors[key];
      assert.ok(val, `key "${key}" missing`);
      const hex = val.length === 9 ? val.slice(0, 7) : val;
      const ratio = contrastRatio(hex, APP_BG);
      assert.ok(
        ratio >= 4.5,
        `${key} ${val} = ${ratio.toFixed(2)}:1 (need >= 4.5)`,
      );
    });
  }
});

describe('signature theme WCAG: structural keys >= 3.0:1 on #000000', () => {
  const theme = loadSignatureTheme();
  for (const key of STRUCTURAL_KEYS) {
    test(`${key} (${theme.colors[key]}) >= 3.0:1`, () => {
      const val = theme.colors[key];
      assert.ok(val, `key "${key}" missing`);
      const hex = val.length === 9 ? val.slice(0, 7) : val;
      const ratio = contrastRatio(hex, APP_BG);
      assert.ok(
        ratio >= 3.0,
        `${key} ${val} = ${ratio.toFixed(2)}:1 (need >= 3.0)`,
      );
    });
  }
});

describe('signature theme WCAG: exceptions documented', () => {
  test('all exception keys exist in theme', () => {
    const theme = loadSignatureTheme();
    for (const key of EXCEPTION_KEYS) {
      assert.ok(key in theme.colors, `exception key "${key}" should exist`);
    }
  });

  test('exception keys are NOT checked for contrast (by design)', () => {
    // This test documents WHY each exception is excluded.
    // Surface fills, badge backgrounds, alpha colors — not text on #000000.
    const reasons = {
      appBackground: 'the background itself',
      background: 'badge fill — text sits ON this, not on app bg',
      inverseText: 'text on badge fill (dark on light badge)',
      toolCardBackground: 'card surface fill',
      toolCardBackgroundDim: 'dimmed card surface fill',
      messageActionsBackground: 'action bar surface fill',
      bashMessageBackgroundColor: 'bash message surface fill',
      memoryBackgroundColor: 'memory card surface fill',
      userMessageBackground: 'user message surface fill',
      userMessageBackgroundHover: 'user message hover surface fill',
      selectionBg: 'selection highlight (alpha #rrggbbaa)',
      diffAdded: 'diff added-line background fill',
      diffRemoved: 'diff removed-line background fill',
      diffAddedDimmed: 'dimmed diff added-line background fill',
      diffRemovedDimmed: 'dimmed diff removed-line background fill',
      clawd_background: 'mascot background fill',
    };
    for (const key of EXCEPTION_KEYS) {
      assert.ok(reasons[key], `missing reason for ${key}`);
    }
  });
});
