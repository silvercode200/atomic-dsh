#!/usr/bin/env node
// tests/hub-theme-demo.test.js — unit-тесты патча 72 «hub-theme-demo»
// (TG-DSH-HUBTHEME-20260926, node 2): полноформатная живая демо-зона
// ThemePreview (патч 64 v2, переиспользование) в строке Theme хаба /settings.
//
// RCA (узел 1): юзер листает темы в ХАБЕ /settings (строка Theme,
// HubCustomEntry → ThemeEntry), не в /theme-икере; демо в хабе было
// 1 строкой из 8 свотчей '██' («квадратики» из жалобы). Фикс: при фокусе
// строки Theme — ThemePreview({palette: theme RAW, displayName, rows:
// budget, columns}) по паттерну EffectEntry (патч 65, одобрен юзером),
// бюджет от геометрии: 22 строки терминала → ≥5 рядов; ≥43 → ≥10; кап 14
// (тир-карта ThemePreview). Свотчи '██' убрать; хинт «←/→ live preview ·
// enter commits» остаётся компактной строкой.
//
// Контракт (TDD red, ДО правки live):
//   1. фокус строки Theme → на экране header демо-зоны «Live preview»;
//   2. НЕТ свотч-строки: 8+ подряд '█' (свотч-ряд = 16; гейдж демо = 6);
//   3. rows=22 (TerminalSizeContext из stdout) → ≥5 маркерных рядов демо
//      (header + powerline + рамка ввода + транскрипт);
//   4. rows=43 → ≥10 маркерных рядов демо (бюджет 10);
//   5. хинт аффорданса остаётся строкой (регресс: строка была до патча);
//   6. без фокуса демо-зоны нет (только ряд — существующее поведение);
//   7. демо-зона не ломает render: unmount чист, exited=false.
// Смена кандидата ←/→ — НЕ юнит-путь (live previewTheme hot-swap):
// покрывается boot-пробой reports/demo-evidence/hub-theme-demo-probe.mjs.
// Запуск: node --test tests/hub-theme-demo.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

import { importTuiModule, TUI_BASE } from './tui-base.mjs';

const LIB = realpathSync(TUI_BASE + '/lib/types');
const require = createRequire(realpathSync(LIB + '/components/GoalTodoPanel.js'));
const React = require('react');
const { renderSync } = await import(LIB + '/ink/root.js');
const { ThemeProvider } = await import(LIB + '/ui.js');
const hub = await importTuiModule('lib/types/components/hubSettings.js');

// Демо-зона ThemePreview рисуется сырыми цветами КАНДИДАТА на реальных
// примерах; маркеры взяты из theme-preview-пробы (в хабе нет статус-ряда
// и ввода приложения — маркеры встречаются ТОЛЬКО внутри демо-зоны).
const DEMO_MARKERS = [
    'Live preview',      // header
    ' ~/dsh ',           // powerline cwd-сегмент (дисплей-путь приложения другой)
    'Write a message',   // рамка ввода: контент-ряд (у живого ввода нет placeholder)
    'How does this theme look?', // транскрипт: юзер
    'Reads nicely',      // транскрипт: ассистент
    'const accent',      // код-блок: строка
    '─ js ',             // код-блок: верхняя рамка с меткой
    'Analyze the preview', // todo-ряд
    '"underline"',       // стили текста
    '▸ plan',            // цветовые роли
    'ctx 86k',           // dim-метрики
];

const ANSI = /(?:\x1B\][^\x07]*(?:\07|\x1B\\))|\x1B\[[0-9;?]*[a-zA-Z]|\x1B[()][0-9A-B]|\r/g;

const THEME_FIELD = {
    path: ['hub', 'theme'],
    label: 'Theme',
    kind: 'custom',
    group: 'hub-theme',
    custom: { type: 'theme', demoLines: 1 },
};

function makeStdin() {
    const stdin = new PassThrough();
    stdin.isTTY = true; stdin.isRaw = true;
    stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
    return stdin;
}

/** Рендер HubCustomEntry (custom.type='theme') при заданной геометрии. */
async function renderEntry({ rows, columns, focused = true, ms = 250 }) {
    const stdout = new PassThrough();
    stdout.columns = columns; stdout.rows = rows;
    const stdin = makeStdin();
    let raw = '';
    stdout.on('data', d => { raw += d.toString(); });
    const inst = renderSync(
        React.createElement(ThemeProvider, { theme: 'tokyonight-moon' },
            React.createElement(hub.HubCustomEntry, {
                field: THEME_FIELD,
                focused,
                bump: () => {},
                rowSlot: children => children,
            })),
        { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
    await new Promise(r => setTimeout(r, ms));
    inst.unmount();
    return { raw, screen: raw.replace(ANSI, '') };
}

const demoMarkerLines = (screen) => screen.split('\n')
    .filter(line => DEMO_MARKERS.some(m => line.includes(m))).length;
const blocksPresent = (screen) => DEMO_MARKERS.filter(m => screen.includes(m)).length;

test('хаб: фокус строки Theme → header демо-зоны «Live preview» на экране', async () => {
    const { screen } = await renderEntry({ rows: 43, columns: 120 });
    assert.ok(screen.includes('Live preview'),
        'header ThemePreview не найден — демо-зоны нет в строке Theme хаба');
});

test('хаб: нет свотч-строки из 8+ подряд █ (квадратики)', async () => {
    const { screen } = await renderEntry({ rows: 43, columns: 120 });
    assert.ok(!screen.includes('████████'),
        `свотч-ряд остался: ${(screen.match(/████████+/g) || []).length} шт.`);
});

test('хаб: 22 строки терминала → ≥5 маркерных рядов демо-зоны', async () => {
    const { screen } = await renderEntry({ rows: 22, columns: 59 });
    const ml = demoMarkerLines(screen);
    assert.ok(ml >= 5 && screen.includes('Live preview') && screen.includes(' ~/dsh ')
        && screen.includes('Write a message'),
        `22-row бюджет: marker-lines=${ml} blocks=${blocksPresent(screen)} — нужно ≥5 (header+powerline+рамка)`);
});

test('хаб: 43 строки терминала → ≥10 маркерных рядов демо-зоны', async () => {
    const { screen } = await renderEntry({ rows: 43, columns: 120 });
    const ml = demoMarkerLines(screen);
    assert.ok(ml >= 10,
        `43-row бюджет: marker-lines=${ml} blocks=${blocksPresent(screen)} — нужно ≥10`);
});

test('хаб: хинт «←/→ live preview · enter commits» остаётся строкой', async () => {
    const { screen } = await renderEntry({ rows: 22, columns: 59 });
    assert.ok(screen.includes('←/→ live preview · enter commits'),
        'хинт аффорданса пропал из фокусной строки Theme');
});

test('хаб: без фокуса строки Theme демо-зоны нет (только ряд)', async () => {
    const { screen } = await renderEntry({ rows: 43, columns: 120, focused: false });
    assert.ok(!screen.includes('Live preview'),
        'демо-зона рендерится без фокуса — регресс поведения строк хаба');
    assert.ok(screen.includes('Theme'), 'сама строка Theme пропала');
});
