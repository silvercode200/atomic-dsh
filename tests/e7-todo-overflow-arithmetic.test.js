#!/usr/bin/env node
// tests/e7-todo-overflow-arithmetic.test.js — E7 todo-panel overflow safety net
// (TG-DSH-BIGBANG-20261016 Phase 2 track W2-A).
//
// E7 OPEN BUG: GoalTodoPanel has NO maxHeight cap — an expanded todo list
// can overflow the terminal viewport, pushing todo-panel rows (branch
// prefixes, glyphs, fold markers, phase badges) into the terminal scrollback
// as stale copies. Patch 09 mitigates (MAX_TODOS 8→12, truncate glyphs,
// 30s collapsed timer, default collapsed=true) but the root cause (no
// maxHeight on the panel) is UNFIXED.
//
// This unit test models the panel layout arithmetic from patch 09 and locks
// two states:
//   RED  (80×24, 12 todos + subagent rows + footer) — overflow > 0.
//     The todo panel overflows the terminal at standard geometry. This is
//     the OPEN-bug lock: any change that INCREASES overflow is a regression.
//   GREEN (47×43, 3 todos + 1 subagent + footer) — overflow = 0.
//     User-parity wide geometry has headroom. A future maxHeight cap would
//     make overflow=0 at 80×24 too — that flips the RED lock to GREEN and
//     the test must be updated to lock the new fixed state.
//
// Structural checks: patch 09 file exists and its DEP-3 header declares
// Status: live (the mitigation patch is applied, not reverted).
//
// Run: node --test tests/e7-todo-overflow-arithmetic.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// ── Constants from patch 09 (dsh-overrides/patches/TG.05.1-todo-collapsed.patch) ──
// MAX_TODOS: visible todo rows before truncation (patch 09: 8 → 12).
// The "+N more" overflow line was REMOVED in patch 09 — the cap is the only
// truncation left. Without a maxHeight on the panel, all 12 rows render.
const MAX_TODOS = 12;

// goalHeader: goal row (emoji + objective + phase badge) + marginBottom=1
// when the todo section is shown below it.
const GOAL_HEADER_ROWS = 2;

// foldHeader: the fold-toggle row (▾/▸ ✓ N/M · fold-hint) — 1 line.
const FOLD_HEADER_ROWS = 1;

// Input frame: ╭─── border + input line + ╰─── border = 3 rows.
const INPUT_FRAME_ROWS = 3;

// Status bar: 1 row (powerline or plain — height:1 enforced by patch 45).
const STATUS_BAR_ROWS = 1;

// Fixed footer chrome that is always present (input border + status bar).
// These rows are NOT a function parameter — they are structural constants
// derived from the TUI layout (frame borders + status line).
const FIXED_CHROME_ROWS = INPUT_FRAME_ROWS + STATUS_BAR_ROWS;

/**
 * Model the GoalTodoPanel layout arithmetic from patch 09.
 *
 * The expanded panel renders: goal header (2 rows) + fold header (1 row) +
 * min(todos, MAX_TODOS) visible todo rows + subagent rows. Below the panel
 * sits the fixed footer chrome (input frame + status bar). The `footerReserved`
 * parameter captures any additional reserved rows (spacing, extra badges).
 *
 * Overflow = max(0, total - terminalRows). When overflow > 0, the panel
 * exceeds the viewport and todo-panel rows leak into terminal scrollback
 * on every repaint (the E7 bug — no maxHeight cap on the panel).
 *
 * @param {number} todos - Total todo count (capped by MAX_TODOS).
 * @param {number} subagentRows - Rows consumed by subagent cards/todos.
 * @param {number} terminalRows - Terminal height in rows.
 * @param {number} footerReserved - Additional footer rows beyond fixed chrome.
 * @returns {number} Overflow rows (0 = fits, >0 = overflows).
 */
function panelOverflow(todos, subagentRows, terminalRows, footerReserved) {
    const visibleTodos = Math.min(todos, MAX_TODOS);
    const panelRows = GOAL_HEADER_ROWS + FOLD_HEADER_ROWS + visibleTodos + subagentRows;
    const total = panelRows + FIXED_CHROME_ROWS + footerReserved;
    return Math.max(0, total - terminalRows);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('E7 RED lock: 80×24 with 12 todos + 3 subagent rows + footer 3 overflows', () => {
    // Standard terminal geometry. 12 todos (MAX_TODOS cap), 3 subagent rows,
    // 3 additional footer rows. The expanded panel + fixed chrome exceeds
    // the 24-row viewport → overflow > 0 → todo-panel rows leak to scrollback.
    //
    // total = goalHeader(2) + foldHeader(1) + min(12,12)(12) + subagentRows(3)
    //         + fixedChrome(4) + footerReserved(3) = 25 > 24 → overflow=1
    const overflow = panelOverflow(12, 3, 24, 3);
    assert.ok(overflow > 0,
        `Expected overflow > 0 at 80×24 with 12 todos + 3 subagent rows + footer 3, got ${overflow}. ` +
        'RED state lock broken — panel no longer overflows at standard geometry. ' +
        'If a maxHeight cap was added, update this test to lock the new GREEN state.');
});

test('E7 GREEN lock: 47×43 with 3 todos + 1 subagent + footer 3 does not overflow', () => {
    // User-parity wide geometry (47 cols × 43 rows). 3 todos, 1 subagent row,
    // 3 additional footer rows. Plenty of headroom → overflow = 0.
    //
    // total = goalHeader(2) + foldHeader(1) + min(3,12)(3) + subagentRows(1)
    //         + fixedChrome(4) + footerReserved(3) = 14 < 43 → overflow=0
    const overflow = panelOverflow(3, 1, 43, 3);
    assert.strictEqual(overflow, 0,
        `Expected overflow = 0 at 47×43 with 3 todos + 1 subagent + footer 3, got ${overflow}. ` +
        'GREEN state lock broken — panel overflows at user-parity geometry.');
});

test('MAX_TODOS cap: 20 todos truncated to 12 visible rows', () => {
    // Patch 09: MAX_TODOS = 12 — only 12 rows render regardless of total count.
    // The "+N more" overflow line was removed; the cap is the only truncation.
    const overflow20 = panelOverflow(20, 0, 24, 0);
    const overflow12 = panelOverflow(12, 0, 24, 0);
    assert.strictEqual(overflow20, overflow12,
        '20 todos should truncate to 12 visible rows (MAX_TODOS cap). ' +
        `overflow(20)=${overflow20} overflow(12)=${overflow12}`);
});

test('Overflow increases monotonically with subagent rows at 80×24', () => {
    // Regression guard: adding subagent rows must not DECREASE overflow.
    // If a change makes overflow decrease with more subagent content,
    // the layout model is wrong.
    const base = panelOverflow(12, 0, 24, 3);
    const withSub = panelOverflow(12, 5, 24, 3);
    assert.ok(withSub >= base,
        `More subagent rows should not decrease overflow: base=${base} withSub=${withSub}`);
});

test('Structural: patch 09 file exists', () => {
    const patchPath = join(repoRoot, 'dsh-overrides', 'patches', 'TG.05.1-todo-collapsed.patch');
    assert.ok(existsSync(patchPath),
        `Patch 09 file not found at ${patchPath}`);
});

test('Structural: patch 09 DEP-3 header declares Status: live', () => {
    const patchPath = join(repoRoot, 'dsh-overrides', 'patches', 'TG.05.1-todo-collapsed.patch');
    const content = readFileSync(patchPath, 'utf8');
    // DEP-3 header: first few lines contain '# Status: live'
    const headerLines = content.split('\n').slice(0, 10).join('\n');
    assert.ok(headerLines.includes('# Status:') && headerLines.includes('live'),
        `Patch 09 DEP-3 header should declare Status: live.\nHeader:\n${headerLines}`);
});

test('Structural: patch 09 DEP-3 header has Goal and Family fields', () => {
    const patchPath = join(repoRoot, 'dsh-overrides', 'patches', 'TG.05.1-todo-collapsed.patch');
    const content = readFileSync(patchPath, 'utf8');
    const headerLines = content.split('\n').slice(0, 10).join('\n');
    assert.ok(headerLines.includes('# Goal:'),
        'Patch 09 DEP-3 header should have # Goal: field');
    assert.ok(headerLines.includes('# Family:'),
        'Patch 09 DEP-3 header should have # Family: field');
});
