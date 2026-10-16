// Wave C tests (dsh-overrides 17): compact-progress reading + compact ctx format.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importTuiModule } from './tui-base.mjs';

const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');

describe('compactProgressReading', () => {
    it('mirrors the compaction-basic threshold: floor(window * ratio)', () => {
        // 262144 * 0.4768 = 124,990.6... → 124990 (~125k, the live code-lazy preset)
        const r = prefs.compactProgressReading(55000, 262144, 0.4768);
        assert.strictEqual(r.threshold, 124990);
        assert.strictEqual(r.left, 69990);
        assert.strictEqual(r.pct, 44);
    });

    it('clamps pct to 100 and left to 0 past the threshold', () => {
        const r = prefs.compactProgressReading(300000, 262144, 0.4768);
        assert.strictEqual(r.left, 0);
        assert.strictEqual(r.pct, 100);
    });

    it('is undefined for invalid inputs (field stays hidden)', () => {
        assert.strictEqual(prefs.compactProgressReading(undefined, 262144, 0.8), undefined);
        assert.strictEqual(prefs.compactProgressReading(100, undefined, 0.8), undefined);
        assert.strictEqual(prefs.compactProgressReading(100, 0, 0.8), undefined);
        assert.strictEqual(prefs.compactProgressReading(100, -5, 0.8), undefined);
        assert.strictEqual(prefs.compactProgressReading(NaN, 262144, 0.8), undefined);
    });

    it('falls back to the upstream default ratio 0.8 on a bad ratio', () => {
        const r = prefs.compactProgressReading(0, 1000, 'x');
        assert.strictEqual(r.threshold, 800);
    });
});

describe('normalizeStatusBar (numeric settings support)', () => {
    it('accepts a finite number for compactThresholdRatio', () => {
        const sb = prefs.normalizeStatusBar({ compactThresholdRatio: 0.4768 });
        assert.strictEqual(sb.compactThresholdRatio, 0.4768);
    });

    it('keeps the default on a non-number ratio and non-boolean flags', () => {
        const sb = prefs.normalizeStatusBar({ compactThresholdRatio: 'x', compactProgress: 'yes' });
        assert.strictEqual(sb.compactThresholdRatio, 0.8);
        assert.strictEqual(sb.compactProgress, true);
    });

    it('exposes the new Wave C flags with enabled defaults', () => {
        const sb = prefs.normalizeStatusBar(undefined);
        assert.strictEqual(sb.spending, true);
        assert.strictEqual(sb.realModel, true);
        assert.strictEqual(sb.compactProgress, true);
    });
});

describe('formatContextUsage (compact mode hides the window ceiling)', () => {
    it('drops the "/262k" ceiling in compact mode', () => {
        assert.strictEqual(prefs.formatContextUsage(122000, 262144, true), '122k');
    });

    it('keeps the full counts when not compact', () => {
        assert.strictEqual(prefs.formatContextUsage(122000, 262144, false), '122k/262k');
    });

    it('is undefined on invalid input (unchanged contract)', () => {
        assert.strictEqual(prefs.formatContextUsage(undefined, 262144, true), undefined);
        assert.strictEqual(prefs.formatContextUsage(0, undefined, true), undefined);
    });
});
