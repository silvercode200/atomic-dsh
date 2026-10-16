#!/usr/bin/env node
// tests/scroll-height-stabilize.test.js — тесты патча 67 «scroll-height-
// stabilize» (TG-DSH-VISUAL-20260925, узел 2): пила высоты при ручном
// скролле на дне гасится гейтом wheel-at-bottom в ScrollBox.scrollBy.
//
// ROOT CAUSE (по трейсу юзера 24.09 20:56 UTC, пила 39↔42↔39, 20 флипов/15с,
// sticky=false, innerHeight=39): ГИПОТЕЗА MessageList/smoothReveal
// (reveal→delete→переоценка→floor-walk) ОПРОВЕРГНУТА — innerHeight и
// scrollHeight флипаются ВЗАИМНО СИНХРОННО (42/42 ↔ 39/39, maxScroll=0 в
// обоих), base = ih−total неизменен: контент не менялся, осциллировал
// вьюпорт-chrome. Реальная механика: wheel на дне → scrollBy безусловно
// ломал stickyScroll → Chat монтировал StickyPromptHeader (1 строка) +
// NewMessagesPill (2 строки) = +3 строки в фиксированном pinned-фрейме →
// ScrollBox (flexShrink:1) терял 3 строки; следующий кадр позиционный
// at-bottom restore возвращал sticky → chrome размонтировался → −3 строки.
// Фикс = стабилизация при sticky=false превентивно: колесо, которое не может
// увести вид от дна, не ломает sticky вовсе (пила не возникает).
//
// КОНТРАКТ (TDD red → green):
//   1. Патч в реестре: dsh-overrides/patches/MS.01.3-scroll-height-stabilize.patch
//      существует, DEP-3 шапка (Goal/Family/Status/Files/Evidence), маркер
//      «dsh-overrides 67», пути a/… b/… ScrollBox.js;
//   2. Round-trip: патч применяется к pristine post65 (TUI_BASE) побайтово
//      воспроизводя целевое состояние снимается и применяется обратно в pristine без остатка;
//   3. wheelCannotLeaveBottom экспортирован из ScrollBox.js и решает кейсы,
//      выведенные из трейса юзера (20:56 UTC 24.09: ih 42↔42↔39, maxScroll=0,
//      пила 20 флипов амплитуды 3);
//   4. scrollBy гейтится ДО break sticky (wycall wheelCannotLeaveBottom
//      стоит выше el.stickyScroll = false).
// Запуск: node --test tests/scroll-height-stabilize.test.js
//   RED:  TUI_BASE=<pristine post65> node --test …
//   GREEN: TUI_BASE=<patched copy> node --test …   (после деплоя — live)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TUI_BASE } from './tui-base.mjs';

const live = (rel) => readFileSync(realpathSync(`${TUI_BASE}/${rel}`), 'utf8');
const repo = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const SCROLLBOX = 'lib/types/ink/components/ScrollBox.js';
const PATCH = 'dsh-overrides/patches/MS.01.3-scroll-height-stabilize.patch';
const MARKER67 = 'dsh-overrides 67';

// ── (1) Патч в реестре ──────────────────────────────────────────────────────

test('патч-файл 67 существует, DEP-3 шапка + маркер', () => {
    assert.ok(existsSync(new URL(`../${PATCH}`, import.meta.url)), 'файл патча есть');
    const patch = repo(PATCH);
    assert.match(patch, /^--- a\/lib\/types\/ink\/components\/ScrollBox\.js$/m, 'заголовок a/ScrollBox.js');
    assert.match(patch, /^\+\+\+ b\/lib\/types\/ink\/components\/ScrollBox\.js$/m, 'заголовок b/ScrollBox.js');
    assert.ok((patch.match(new RegExp(MARKER67, 'g')) ?? []).length >= 3, 'маркер в шапке и коде (>=3)');
    // DEP-3 поля
    for (const field of ['# Goal:', '# Family:', '# Status:', '# Files:', '# Evidence:']) {
        assert.ok(patch.includes(field), `DEP-3 поле ${field}`);
    }
    // суть фикса: гейт-функция добавлена и вызывается до break sticky
    assert.ok(patch.includes('+export function wheelCannotLeaveBottom'), 'чистая функция-гейт экспортирована');
    assert.ok(patch.includes('+                if (wheelCannotLeaveBottom(dy, el.scrollTop, el.scrollHeight, el.scrollViewportHeight))'),
        'scrollBy вызывает гейт');
});

// ── (2) Round-trip патча на копии TUI_BASE ─────────────────────────────────

test('патч 67 применяется к post65, revert возвращает pristine без остатка (побайтово)', () => {
    const tmp = join(tmpdir(), `dsh67-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, 'lib/types/ink/components'), { recursive: true });
    const target = join(tmp, SCROLLBOX);
    cpSync(realpathSync(`${TUI_BASE}/${SCROLLBOX}`), target);
    const before = readFileSync(target, 'utf8');
    const wasPatched = before.includes(MARKER67);
    const patchPath = realpathSync(new URL(`../${PATCH}`, import.meta.url).pathname);
    try {
        let pristineContent = before;
        if (wasPatched) {
            // пост-деплой-режим: снять патч, захватить pristine
            execFileSync('patch', ['-p1', '-R', '--forward', '-i', patchPath], { cwd: tmp, stdio: 'pipe' });
            pristineContent = readFileSync(target, 'utf8');
            assert.ok(!pristineContent.includes(MARKER67), 'после снятия маркера нет');
        }
        // apply к pristine
        execFileSync('patch', ['-p1', '--forward', '-i', patchPath], { cwd: tmp, stdio: 'pipe' });
        const after = readFileSync(target, 'utf8');
        assert.ok(after.includes(MARKER67), 'маркер после apply');
        if (wasPatched) {
            // apply вернул ровно состояние TUI_BASE (побайтово)
            assert.strictEqual(after, before, 'apply воспроизводит TUI_BASE побайтово');
        }
        // revert → pristine без остатка
        execFileSync('patch', ['-p1', '-R', '--forward', '-i', patchPath], { cwd: tmp, stdio: 'pipe' });
        const reverted = readFileSync(target, 'utf8');
        assert.strictEqual(reverted, pristineContent, 'revert возвращает pristine побайтово');
        assert.ok(!reverted.includes(MARKER67), 'маркер исчез после revert');
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

// ── (3) Гейт-функция: функциональные кейсы из трейса ────────────────────────

test('wheelCannotLeaveBottom: кейсы трейса 20:56 UTC (пила 42↔39, maxScroll=0)', () => {
    const src = live(SCROLLBOX);
    const m = src.match(/export function wheelCannotLeaveBottom[\s\S]*?\n\}/);
    assert.ok(m, 'export wheelCannotLeaveBottom присутствует в ScrollBox.js (RED: патч не применён)');
    // чистая функция без зависимостей — eval реального исходника
    const fn = new Function(`${m[0].replace('export ', '')}; return wheelCannotLeaveBottom;`)();
    assert.strictEqual(typeof fn, 'function', 'вытягивается и исполняется');
    const cases = [
        // [dy, scrollTop, scrollHeight, viewportHeight, expected, name]
        [3, 0, 42, 42, true, 'wheel-down на дне, контент влезает (maxScroll=0) — трейс 17.102 st=+3'],
        [-3, 0, 42, 42, true, 'wheel-up на дне, контент влезает (maxScroll=0) — трейс 20.625 st=-3'],
        [3, 58, 100, 42, true, 'wheel-down на дне, высокий контент (cur=maxScroll)'],
        [3, 57, 100, 42, false, 'wheel-down в середине (57<58) — реальное движение'],
        [-3, 58, 100, 42, false, 'wheel-up от дна, высокий контент — чтение истории (фича)'],
        [3, 3, 42.0000001, 39, true, 'дробная пыль Yoga: cur=3, maxScroll=3.0000001 — на дне'],
        [3, 2, 42, 39, false, '1 строка до дна — реальное движение'],
        [3, 0, undefined, undefined, true, 'метрик нет (до первого кадра) — no-op'],
    ];
    for (const [dy, st, sh, vh, exp, name] of cases) {
        assert.strictEqual(fn(dy, st, sh, vh), exp, name);
    }
    // Симуляция пилы: 20 нотчей на дне (состояние окна 20:56:17–22) — ноль break'ов
    const el = { scrollTop: 0, scrollHeight: 42, scrollViewportHeight: 42 };
    let breaks = 0;
    for (let i = 0; i < 20; i++) {
        const dy = i % 2 === 0 ? 3 : -3;
        if (!fn(dy, el.scrollTop, el.scrollHeight, el.scrollViewportHeight)) breaks++;
    }
    assert.strictEqual(breaks, 0, '20 нотчей на дне → 0 break sticky (пила погашена)');
});

// ── (4) Wiring: гейт стоит ДО break sticky в scrollBy ──────────────────────

test('scrollBy: гейт вызывается ДО el.stickyScroll = false', () => {
    const src = live(SCROLLBOX);
    const gateCall = 'if (wheelCannotLeaveBottom(dy, el.scrollTop, el.scrollHeight, el.scrollViewportHeight))';
    assert.ok(src.includes(gateCall), 'гейт-вызов в scrollBy');
    const byScrollBy = src.indexOf('scrollBy(dy) {');
    assert.ok(byScrollBy >= 0, 'тело scrollBy найдено');
    const gatePos = src.indexOf(gateCall, byScrollBy);
    const breakPos = src.indexOf('el.stickyScroll = false;', byScrollBy);
    assert.ok(gatePos >= 0 && breakPos >= 0, 'гейт и break в scrollBy');
    assert.ok(gatePos < breakPos, 'гейт выше break sticky');
    // гейт не глушит накопитель в рабочей ветке (pure accumulator не тронут)
    assert.ok(src.includes('el.pendingScrollDelta = (el.pendingScrollDelta ?? 0) + Math.floor(dy);'),
        'аккумулятор pendingScrollDelta сохранён в рабочей ветке');
});
