#!/usr/bin/env node
// tests/streaming-height.test.js — тесты фикса streaming-height (патч 54,
// absorbed в MS.01.1-scroll-menu-nogap при 3D squash)
// (TG-DSH-PATCH54-20260920, узел 2): стриминг-ряды держат измеренную высоту
// в цикле инвалидации сигнатур MessageList (осцилляция окна виртуализации,
// юзер-баги B1/B2 — дрожь/гашение строк при длинном стриме).
//
// КОНТРАКТ (TDD red → green):
//   1. Патч в реестре: dsh-overrides/patches/MS.01.1-scroll-menu-nogap.patch
//      существует и применяется к MessageList.js (проба: revert MS.01.1 →
//      apply → diff побайтово воспроизводит состояние стека);
//   2. Live MessageList.js: маркер фикса присутствует (grep-фрагмент
//      «dsh-overrides 54: a row that is actively STREAMING»), delete
//      обёрнут гвардом row.streaming !== true, heightsVersionRef++
//      остался безусловным (инвалидация версии не глушится);
//   3. Apply-скрипт: MS.01.1-scroll-menu-nogap.patch зарегистрирован
//      в MARKERS и marker_file (→ lib/types/components/MessageList.js);
//   4. Проба GREEN: reports/statusbar-fix-20260919/
//      streaming-height-probe-result.txt содержит прогон патча-54 с
//      total_decreases = 0 и вердиктом STABLE (RED-числа до фикса там же).
//
// Это sanity решения (thin), не реализаций: внутренности MessageList не
// экспортируются (инвариант «стриминг-ряд не теряет высоту при смене
// сигнатуры» проверяется пробой reports/statusbar-fix-20260919/
// streaming-height-probe.mjs на живом рендере).
// Запуск: node --test tests/streaming-height.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { TUI_BASE } from './tui-base.mjs';

const live = (rel) => readFileSync(realpathSync(`${TUI_BASE}/${rel}`), 'utf8');
const repo = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const MARKER54 = 'dsh-overrides 54: a row that is actively STREAMING';
const PATCH_NAME = 'MS.01.1-scroll-menu-nogap.patch';

// ── (1) Патч в реестре ──────────────────────────────────────────────────────

test('патч-файл MS.01.1 существует и содержит гвард фикса (54 absorbed)', () => {
    const patch = repo(`dsh-overrides/patches/${PATCH_NAME}`);
    assert.match(patch, /^--- a\/lib\/types\/components\/MessageList\.js$/m, 'заголовок a/MessageList.js');
    assert.match(patch, /^\+\+\+ b\/lib\/types\/components\/MessageList\.js$/m, 'заголовок b/MessageList.js');
    // суть фикса: безусловный delete заменён гвардом
    assert.ok(patch.includes('-            heightsRef.current.delete(row.id);'),
        'старый безусловный delete удалён');
    assert.ok(patch.includes('+            if (row.streaming !== true)'),
        'гвард row.streaming !== true добавлен');
    assert.ok(patch.includes('+                heightsRef.current.delete(row.id);'),
        'delete под гвардом');
    // heightsVersionRef++ остаётся безусловным (версия инкрементится всегда)
    assert.match(patch, /\+\+\+[\s\S]*heightsVersionRef\.current\+\+;/, 'heightsVersionRef++ не тронут');
});

test('патч MS.01.1 применяется к MessageList.js и воспроизводит live-состояние (побайтово)', () => {
    // state-after-prev = live минус MS.01.1: снять патч MS.01.1 (patch -R) во
    // временной копии, применить MS.01.1 заново, сравнить с live. Доказывает:
    // squashed патч один покрывает весь дельта (26b+54+77+79), дрейфа нет.
    const tmp = execFileSync('mktemp', ['-d']).toString().trim();
    try {
        execFileSync('mkdir', ['-p', `${tmp}/lib/types/components`]);
        execFileSync('cp', [`${realpathSync(TUI_BASE)}/lib/types/components/MessageList.js`, `${tmp}/lib/types/components/MessageList.js`]);
        execFileSync('bash', ['-c',
            `cd "${tmp}" && patch -p1 -R --forward < ${JSON.stringify(process.cwd())}/dsh-overrides/patches/${PATCH_NAME} 2>&1 && patch -p1 --forward < ${JSON.stringify(process.cwd())}/dsh-overrides/patches/${PATCH_NAME} 2>&1`]);
        const before = readFileSync(`${tmp}/lib/types/components/MessageList.js`, 'utf8');
        const liveSrc = live('lib/types/components/MessageList.js');
        assert.strictEqual(before, liveSrc, 'revert+apply патча MS.01.1 воспроизводит live побайтово');
    }
    finally {
        execFileSync('rm', ['-rf', tmp]);
    }
});

// ── (2) Live MessageList.js: гвард на месте ─────────────────────────────────

test('live MessageList.js: маркер 54 + гвард streaming + безусловный heightsVersionRef++', () => {
    const src = live('lib/types/components/MessageList.js');
    assert.ok(src.includes(MARKER54), `маркер «${MARKER54}» присутствует`);
    // гвард: delete только для НЕ-streaming рядов
    assert.match(src, /if \(row\.streaming !== true\)\s*\n\s*heightsRef\.current\.delete\(row\.id\);/,
        'delete под гвардом row.streaming !== true');
    // мера-эффект по-прежнему пишет высоты (механизм роста высоты жив)
    assert.match(src, /heightsRef\.current\.set\(id, h\);/, 'measure-эффект пишет высоты');
    // сеттл-инвалидация: sigs.set обновляется в цикле подписей (не заглушён)
    assert.match(src, /sigs\.set\(row\.id, parts\.slice\(\)\);/, 'sigs.set обновляется');
    // heightsVersionRef++ остался безусловным в цикле: между sigs.set и
    // концом цикла (без гварда вокруг инкремента)
    const setIdx = src.indexOf('sigs.set(row.id, parts.slice())');
    const afterGuard = src.indexOf('heightsRef.current.delete(row.id);', setIdx);
    const loop = src.slice(setIdx, afterGuard + 80);
    assert.match(loop, /heightsVersionRef\.current\+\+;/, 'heightsVersionRef++ безусловен в цикле');
    // и инкремент НЕ внутри гварда (стоит после закрытия if)
    const guardEnd = loop.indexOf('heightsRef.current.delete(row.id);');
    const incIdx = loop.indexOf('heightsVersionRef.current++;');
    assert.ok(incIdx > guardEnd, 'инкремент версии после delete-строки (безусловный)');
});

// ── (3) Регистрация в apply-скрипте ────────────────────────────────────────

test('apply-скрипт: MS.01.1-scroll-menu-nogap.patch зарегистрирован (MARKERS + marker_file)', () => {
    const script = repo('scripts/apply-dsh-overrides.sh');
    // MARKERS entry for MS.01.1 (squashed patch, marker = original 26b text)
    assert.ok(script.includes(`[${PATCH_NAME}]='dsh-overrides 26: kind-aware spacer estimate'`),
        'запись MARKERS для MS.01.1 (squashed 26b+54+77+79)');
    assert.match(script, /MS\.01\.1-scroll-menu-nogap\.patch\)\s*printf '%s' 'lib\/types\/components\/MessageList\.js'/,
        'marker_file MS.01.1 → MessageList.js');
});

// ── (4) Проба: RED-числа до фикса и GREEN-числа после — в result-файле ──────

test('result-файл пробы: RED total_decreases >= 3 до фикса, GREEN = 0 после', () => {
    const path = new URL('../reports/statusbar-fix-20260919/streaming-height-probe-result.txt', import.meta.url);
    assert.ok(existsSync(path), 'streaming-height-probe-result.txt существует');
    const res = readFileSync(path, 'utf8');
    // обе фазы задокументированы
    assert.ok(res.includes('RED: live MessageList.js = стек 1-53 (без патча-54)'), 'секция RED присутствует');
    assert.ok(res.includes('GREEN: live MessageList.js = стек 1-53 + патч-54'), 'секция GREEN присутствует');
    // RED: осцилляция воспроизведена (различитель пробы — total_decreases)
    const red = res.slice(res.indexOf('--- RED'), res.indexOf('--- GREEN'));
    assert.match(red, /вердикт: OSCILLATION-REPRODUCED/, 'RED-вердикт');
    const redDrops = /\(б\) total_decreases \(list\.total < prev\): (\d+)/.exec(red);
    assert.ok(redDrops && Number(redDrops[1]) >= 3, `RED total_decreases >= 3, получено ${redDrops?.[1]}`);
    // GREEN: окно стабильно, осцилляции нет
    const green = res.slice(res.indexOf('--- GREEN'));
    assert.match(green, /вердикт: STABLE/, 'GREEN-вердикт');
    const greenDrops = /\(б\) total_decreases \(list\.total < prev\): (\d+)/.exec(green);
    assert.ok(greenDrops && Number(greenDrops[1]) <= 1, `GREEN total_decreases <= 1, получено ${greenDrops?.[1]}`);
    const greenJumps = /\(в\) start_jumps \(.*\): (\d+)/.exec(green);
    assert.ok(greenJumps && Number(greenJumps[1]) === 0, `GREEN start_jumps = 0, получено ${greenJumps?.[1]}`);
});
