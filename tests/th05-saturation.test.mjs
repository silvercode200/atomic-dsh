#!/usr/bin/env node
// tests/th05-saturation.test.mjs — unit-тест логики патча TH.05.1
// «saturation-option» (TG-DSH-REBUILD-20260921, node 7, TH.05).
//
// Тестирует: rgbToHsl, hslToRgb, adjustSaturation — чистые функции
// преобразования цвета (RGB↔HSL + регулировка насыщенности).
// Запуск: node tests/th05-saturation.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { importTuiModule } from './tui-base.mjs';

const mod = await importTuiModule('lib/types/components/Spinner/spinnerUtils.js');
const { rgbToHsl, hslToRgb, adjustSaturation } = mod;

describe('rgbToHsl → hslToRgb round-trip', () => {
    test('round-trip {r:200,g:100,b:50} — ±2 per channel', () => {
        const orig = { r: 200, g: 100, b: 50 };
        const hsl = rgbToHsl(orig.r, orig.g, orig.b);
        const back = hslToRgb(hsl.h, hsl.s, hsl.l);
        assert.ok(Math.abs(back.r - orig.r) <= 2, `r: ${back.r} vs ${orig.r}`);
        assert.ok(Math.abs(back.g - orig.g) <= 2, `g: ${back.g} vs ${orig.g}`);
        assert.ok(Math.abs(back.b - orig.b) <= 2, `b: ${back.b} vs ${orig.b}`);
    });

    test('round-trip {r:50,g:200,b:100} — ±2 per channel', () => {
        const orig = { r: 50, g: 200, b: 100 };
        const hsl = rgbToHsl(orig.r, orig.g, orig.b);
        const back = hslToRgb(hsl.h, hsl.s, hsl.l);
        assert.ok(Math.abs(back.r - orig.r) <= 2, `r: ${back.r} vs ${orig.r}`);
        assert.ok(Math.abs(back.g - orig.g) <= 2, `g: ${back.g} vs ${orig.g}`);
        assert.ok(Math.abs(back.b - orig.b) <= 2, `b: ${back.b} vs ${orig.b}`);
    });
});

describe('adjustSaturation', () => {
    test('multiplier 0.6 — chroma decreased (s_after < s_before)', () => {
        const orig = { r: 200, g: 100, b: 50 };
        const before = rgbToHsl(orig.r, orig.g, orig.b);
        const result = adjustSaturation(orig, 0.6);
        const after = rgbToHsl(result.r, result.g, result.b);
        assert.ok(after.s < before.s, `s: ${after.s} should be < ${before.s}`);
    });

    test('multiplier 1.4 — chroma increased (s_after > s_before)', () => {
        const orig = { r: 200, g: 100, b: 50 };
        const before = rgbToHsl(orig.r, orig.g, orig.b);
        const result = adjustSaturation(orig, 1.4);
        const after = rgbToHsl(result.r, result.g, result.b);
        assert.ok(after.s > before.s, `s: ${after.s} should be > ${before.s}`);
    });

    test('gray {r:128,g:128,b:128} multiplier 1.4 — identity (s=0 stays 0)', () => {
        const orig = { r: 128, g: 128, b: 128 };
        const result = adjustSaturation(orig, 1.4);
        assert.equal(result.r, orig.r);
        assert.equal(result.g, orig.g);
        assert.equal(result.b, orig.b);
    });

    test('multiplier 1.0 — identity (no change)', () => {
        const orig = { r: 200, g: 100, b: 50 };
        const result = adjustSaturation(orig, 1.0);
        assert.equal(result.r, orig.r);
        assert.equal(result.g, orig.g);
        assert.equal(result.b, orig.b);
    });
});
