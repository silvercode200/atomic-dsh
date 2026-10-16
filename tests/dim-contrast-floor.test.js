#!/usr/bin/env node
// tests/dim-contrast-floor.test.js — unit-тест логики патча 74
// «dim-contrast-floor» (TG-DSH-MKS4-20260928 узел 4, TH.04).
//
// ROOT CAUSE: theme.inactive — ЦВЕТ, не SGR-2 dim. Тема юзера tokyonight-moon:
// inactive #444a73 на appBackground #000000 = 2.4:1 (после квантования chalk
// в 256-палитру — 3.47:1), ниже WCAG AA 4.5:1 — пункты «невидимы».
//
// FIX: flooredInactive(theme) поднимает inactive к theme.text бинпоиском
// (24 итер., lerp, минимальный t) до ≥5.0:1 — запас 0.5 над AA.
// Дефолтная тема inactive #8D95A6 = 6.98:1 → пол не срабатывает.
// Непарсибельные цвета проходят как есть. WeakMap memoized per theme.
//
// Запуск: node --test tests/dim-contrast-floor.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(
  __dirname, '..', 'dsh-overrides', 'patches', 'TH.04-dim-contrast-floor.patch',
);

// ── Pure function extraction from patch 74 ────────────────────────────
// Copied verbatim from ThemedText.js patch (dsh-overrides 74).

const INACTIVE_CONTRAST_FLOOR = 5.0;
const inactiveFloorCache = new WeakMap();

/** Parse #rgb/#rrggbb/#rrggbbaa (alpha ignored) or rgb(r,g,b) into [r,g,b]. */
function parseThemeColor(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  let m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
  if (m !== null) {
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    return r > 255 || g > 255 || b > 255 ? undefined : [r, g, b];
  }
  m = /^#(?:([0-9a-fA-F]{3})|([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?)$/.exec(value);
  if (m === null) {
    return undefined;
  }
  const hex = m[1] !== undefined ? m[1].replace(/./g, (c) => c + c) : m[2];
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of an [r,g,b] triple. */
function wcagLuminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two [r,g,b] triples. */
function contrastRatio(a, b) {
  const la = wcagLuminance(a), lb = wcagLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * theme.inactive lifted to at least INACTIVE_CONTRAST_FLOOR against the app
 * background (defaults to #000000). Already-readable palettes return their
 * inactive unchanged; when even theme.text cannot reach the floor, text is
 * the best the palette can do; otherwise a 24-iteration binary search finds
 * the smallest blend toward text that clears it. Unparsable values pass
 * through as-is. Memoized per theme object (WeakMap).
 */
function flooredInactive(theme) {
  const inc = theme.inactive;
  if (typeof inc !== 'string') {
    return inc;
  }
  const cached = inactiveFloorCache.get(theme);
  if (cached !== undefined) {
    return cached;
  }
  let result = inc;
  const incRgb = parseThemeColor(inc);
  if (incRgb !== undefined) {
    const bg = parseThemeColor(theme.appBackground) ?? [0, 0, 0];
    const tgt = parseThemeColor(theme.text);
    if (contrastRatio(incRgb, bg) < INACTIVE_CONTRAST_FLOOR && tgt !== undefined) {
      if (contrastRatio(tgt, bg) < INACTIVE_CONTRAST_FLOOR) {
        result = theme.text;
      } else {
        const mixAt = (t) => {
          const mix = [0, 1, 2].map((k) => Math.round(incRgb[k] + (tgt[k] - incRgb[k]) * t));
          return { mix, ok: contrastRatio(mix, bg) >= INACTIVE_CONTRAST_FLOOR };
        };
        let lo = 0, hi = 1;
        for (let i = 0; i < 24; i++) {
          const t = (lo + hi) / 2;
          if (mixAt(t).ok) {
            hi = t;
          } else {
            lo = t;
          }
        }
        const { mix } = mixAt(hi);
        result = `rgb(${mix[0]},${mix[1]},${mix[2]})`;
      }
    }
  }
  inactiveFloorCache.set(theme, result);
  return result;
}

// ── Structural check ──────────────────────────────────────────────────
describe('Patch 74 structural check', () => {
  test('patch file exists at dsh-overrides/patches/', () => {
    assert.ok(fs.existsSync(PATCH_FILE), `Expected: ${PATCH_FILE}`);
  });

  test('patch contains header metadata (Goal/Family/Status/Files)', () => {
    // Patch 74 predates the DEP-3 migration (unlike 76/77/78/80 which have
    // DEP-3 headers). Verify the equivalent structural metadata instead.
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(content.includes('# Goal:'), 'Patch must have Goal header');
    assert.ok(content.includes('# Family:'), 'Patch must have Family header');
    assert.ok(content.includes('# Status:'), 'Patch must have Status header');
    assert.ok(content.includes('# Files:'), 'Patch must have Files header');
  });

  test('patch defines flooredInactive and INACTIVE_CONTRAST_FLOOR=5.0', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(content.includes('flooredInactive'),
      'Patch must define flooredInactive function');
    assert.ok(content.includes('INACTIVE_CONTRAST_FLOOR = 5.0'),
      'Patch must set contrast floor to 5.0');
  });

  test('patch hooks flooredInactive into resolveColor and dimColor path', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(
      content.includes("color === 'inactive'"),
      'Patch must hook inactive key in resolveColor',
    );
    assert.ok(
      content.includes('flooredInactive(theme)'),
      'Patch must use flooredInactive in dimColor path',
    );
  });
});

// ── parseThemeColor tests ─────────────────────────────────────────────
describe('parseThemeColor', () => {
  test('#fff → [255,255,255]', () => {
    assert.deepEqual(parseThemeColor('#fff'), [255, 255, 255]);
  });

  test('#444a73 → [68,74,115]', () => {
    assert.deepEqual(parseThemeColor('#444a73'), [68, 74, 115]);
  });

  test('#000000 → [0,0,0]', () => {
    assert.deepEqual(parseThemeColor('#000000'), [0, 0, 0]);
  });

  test('#rrggbbaa (alpha ignored) → parsed without alpha', () => {
    assert.deepEqual(parseThemeColor('#ffcc0080'), [255, 204, 0]);
  });

  test('rgb(r,g,b) → [r,g,b]', () => {
    assert.deepEqual(parseThemeColor('rgb(1,2,3)'), [1, 2, 3]);
  });

  test('non-string → undefined', () => {
    assert.equal(parseThemeColor(42), undefined);
    assert.equal(parseThemeColor(null), undefined);
    assert.equal(parseThemeColor(undefined), undefined);
  });

  test('unparsable formats → undefined', () => {
    assert.equal(parseThemeColor('ansi:red'), undefined);
    assert.equal(parseThemeColor('ansi256(42)'), undefined);
    assert.equal(parseThemeColor(''), undefined);
    assert.equal(parseThemeColor('red'), undefined);
  });

  test('rgb out of range → undefined', () => {
    assert.equal(parseThemeColor('rgb(256,0,0)'), undefined);
    assert.equal(parseThemeColor('rgb(0,300,0)'), undefined);
  });
});

// ── wcagLuminance tests ───────────────────────────────────────────────
describe('wcagLuminance', () => {
  test('[0,0,0] → 0 (pure black)', () => {
    assert.equal(wcagLuminance([0, 0, 0]), 0);
  });

  test('[255,255,255] → 1.0 (pure white)', () => {
    assert.ok(
      Math.abs(wcagLuminance([255, 255, 255]) - 1.0) < 1e-10,
      'Pure white luminance should be 1.0',
    );
  });

  test('value in range [0, 1]', () => {
    const lum = wcagLuminance([68, 74, 115]);
    assert.ok(lum >= 0 && lum <= 1, `Luminance ${lum} should be in [0,1]`);
  });
});

// ── contrastRatio tests ───────────────────────────────────────────────
describe('contrastRatio', () => {
  test('[0,0,0] vs [255,255,255] → 21.0 (maximum)', () => {
    const ratio = contrastRatio([0, 0, 0], [255, 255, 255]);
    assert.ok(
      Math.abs(ratio - 21.0) < 0.01,
      `Black vs white should be ~21.0 (got ${ratio})`,
    );
  });

  test('[0,0,0] vs [68,74,115] → ~2.4 (below AA 4.5)', () => {
    // tokyonight-moon inactive on black: raw contrast < AA
    const ratio = contrastRatio([0, 0, 0], [68, 74, 115]);
    assert.ok(
      ratio < 4.5,
      `Contrast ${ratio.toFixed(2)} should be below AA 4.5 (root cause)`,
    );
    assert.ok(
      Math.abs(ratio - 2.4) < 0.5,
      `Contrast ${ratio.toFixed(2)} should be approximately 2.4`,
    );
  });

  test('symmetric: ratio(a,b) === ratio(b,a)', () => {
    const a = [68, 74, 115];
    const b = [192, 202, 245];
    assert.equal(
      contrastRatio(a, b),
      contrastRatio(b, a),
      'Contrast ratio should be symmetric',
    );
  });
});

// ── flooredInactive tests ─────────────────────────────────────────────
describe('flooredInactive', () => {
  test('tokyonight-moon: inactive lifted to >= 5.0:1 against bg', () => {
    // User theme: inactive #444a73 (2.4:1 on black) → must be lifted
    const theme = {
      inactive: '#444a73',
      text: '#c0caf5',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    // Result should be a parsable color (rgb(...) format)
    const resultRgb = parseThemeColor(result);
    assert.ok(resultRgb !== undefined,
      `Floored result "${result}" must be parsable`);
    const bg = parseThemeColor(theme.appBackground);
    const ratio = contrastRatio(resultRgb, bg);
    assert.ok(
      ratio >= INACTIVE_CONTRAST_FLOOR,
      `Floored contrast ${ratio.toFixed(2)} must be >= ${INACTIVE_CONTRAST_FLOOR}`,
    );
  });

  test('default theme: inactive already >= 5.0:1 → unchanged', () => {
    // Default inactive #8D95A6 = 6.98:1 on #000000 — above floor, no change
    const theme = {
      inactive: '#8D95A6',
      text: '#c0caf5',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    assert.equal(
      result, '#8D95A6',
      'Default theme inactive already readable → returned unchanged',
    );
  });

  test('unparsable inactive (ansi:) → passthrough', () => {
    const theme = {
      inactive: 'ansi:brightBlack',
      text: '#ffffff',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    assert.equal(result, 'ansi:brightBlack',
      'Unparsable inactive should pass through as-is');
  });

  test('empty string inactive → passthrough', () => {
    const theme = {
      inactive: '',
      text: '#ffffff',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    assert.equal(result, '',
      'Empty inactive should pass through as-is');
  });

  test('non-string inactive (number) → passthrough', () => {
    const theme = {
      inactive: 0,
      text: '#ffffff',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    assert.equal(result, 0,
      'Non-string inactive should pass through as-is');
  });

  test('memoized: second call returns cached result (same object)', () => {
    const theme = {
      inactive: '#444a73',
      text: '#c0caf5',
      appBackground: '#000000',
    };
    const first = flooredInactive(theme);
    const second = flooredInactive(theme);
    assert.equal(
      first, second,
      'Same theme object → cached result (WeakMap memoization)',
    );
  });

  test('text itself below floor → returns theme.text (best available)', () => {
    // Edge case: even text can't reach 5.0:1 → return text as best effort
    const theme = {
      inactive: '#111111',
      text: '#222222',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    assert.equal(
      result, '#222222',
      'When text itself is below floor → return theme.text (best available)',
    );
  });

  test('no appBackground → defaults to #000000', () => {
    // Theme without appBackground should use #000000 as bg
    const theme = {
      inactive: '#444a73',
      text: '#c0caf5',
      // no appBackground key
    };
    const result = flooredInactive(theme);
    const resultRgb = parseThemeColor(result);
    assert.ok(resultRgb !== undefined, 'Result must be parsable');
    // Against #000000 (default), should reach 5.0:1
    const ratio = contrastRatio(resultRgb, [0, 0, 0]);
    assert.ok(
      ratio >= INACTIVE_CONTRAST_FLOOR,
      `Default bg #000000: floored contrast ${ratio.toFixed(2)} >= ${INACTIVE_CONTRAST_FLOOR}`,
    );
  });

  test('floored result is closer to inactive than to text (minimal blend)', () => {
    // Binary search finds SMALLEST t → result should be closer to inactive
    // than to text (minimal visual change to pass the floor)
    const inactiveRgb = parseThemeColor('#444a73'); // [68, 74, 115]
    const textRgb = parseThemeColor('#c0caf5');     // [192, 202, 245]
    const theme = {
      inactive: '#444a73',
      text: '#c0caf5',
      appBackground: '#000000',
    };
    const result = flooredInactive(theme);
    const resultRgb = parseThemeColor(result);

    // Distance from inactive vs distance from text
    const distFromInactive = Math.sqrt(
      resultRgb.reduce((acc, c, i) => acc + (c - inactiveRgb[i]) ** 2, 0),
    );
    const distFromText = Math.sqrt(
      resultRgb.reduce((acc, c, i) => acc + (c - textRgb[i]) ** 2, 0),
    );
    assert.ok(
      distFromInactive <= distFromText,
      `Result should be closer to inactive (${distFromInactive.toFixed(1)}) ` +
      `than to text (${distFromText.toFixed(1)}) — minimal blend`,
    );
  });
});
