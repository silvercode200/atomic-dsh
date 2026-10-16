#!/usr/bin/env node
// tests/hub.test.js — unit-тесты хаб-волны (патч 44 → 46):
// TG-DSH-TUI-HUB-20260918 узел 5 создал /effects-хаб; узел 1
// TG-DSH-HUB-SETTINGS-20260918 ПЕРЕНЁС хаб внутрь нативного /settings
// (CustomizationHub удалён, секции живут группами dsh-tui-регистрации,
// /effects — алиас). Тесты обновлены под новую архитектуру (было: хаб-
// оверлей + hubEnterAction).
//
// КОНТРАКТ:
//   1. HUB_SECTIONS: ≥6 секций {id, title, group}; Оформление/Эффекты/Тема/
//      Рамка/Спиннеры/Статус-ряд/Прогресс; ids уникальны;
//   2. appearancePrefs (патч 44): readAppearancePref/writeAppearancePref
//      {appearance, effects}; mergeAppearanceOver — файл побеждает по ключу
//      (модуль сохранён; applyAppearance больше его не читает — см.
//      settings-hub.test.js);
//   3. slash-меню: '/e' → 'effects' зарегистрирован (команда остаётся,
//      теперь это алиас в /settings);
//   4. hubSections: секция statusrow указывает на нативную группу
//      status-bar (не создаёт дублей);
//   5. /effects <section> прыжки: все 7 секций маппятся на группы.
// Запуск: node --test tests/hub.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';

import { importTuiModule, TUI_BASE } from './tui-base.mjs';

const hub = await importTuiModule('lib/types/hubSections.js');
const prefsLayer = await importTuiModule('lib/types/appearancePrefs.js');

// --- 1. реестр секций ----------------------------------------------------------
test('HUB_SECTIONS: ≥6 секций с уникальными id, заголовками и группами', () => {
    assert.ok(Array.isArray(hub.HUB_SECTIONS));
    assert.ok(hub.HUB_SECTIONS.length >= 6, `${hub.HUB_SECTIONS.length}`);
    const ids = hub.HUB_SECTIONS.map(s => s.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const s of hub.HUB_SECTIONS) {
        assert.ok(typeof s.id === 'string' && s.id.length > 0, 'id');
        assert.ok(typeof s.title === 'string' && s.title.length > 0, `title ${s.id}`);
        assert.ok(typeof s.group === 'string' && s.group.length > 0, `group ${s.id}`);
    }
    for (const id of ['appearance', 'effects', 'theme', 'spinner', 'statusrow', 'progress']) {
        assert.ok(ids.includes(id), `нет секции ${id}`);
    }
});

test('HUB_SECTIONS: группы-цели уникальны (никакая секция не дублирует группу)', () => {
    const groups = hub.HUB_SECTIONS.map(s => s.group);
    assert.strictEqual(new Set(groups).size, groups.length, 'группы уникальны');
});

// --- 2. prefs-слой appearance.json (модуль патча 44 сохранён) --------------------
test('writeAppearancePref/readAppearancePref: round-trip в temp dir', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const d = mkdtempSync(join(tmpdir(), 'hub-'));
    const ok = prefsLayer.writeAppearancePref({ appearance: { powerline: 'plain' }, effects: { sparkTps: true } }, d);
    assert.strictEqual(ok, true);
    const back = prefsLayer.readAppearancePref(d);
    assert.deepStrictEqual(back, { appearance: { powerline: 'plain' }, effects: { sparkTps: true } });
    rmSync(d, { recursive: true });
});

test('mergeAppearanceOver: файл побеждает по ключу, прочие сохраняются', () => {
    const settings = { powerline: 'full', theme: 'tokyonight-moon', inputBorder: '#7aa2f7' };
    const file = { powerline: 'plain', cwdMode: 'compact' };
    const merged = prefsLayer.mergeAppearanceOver(settings, file);
    assert.strictEqual(merged.powerline, 'plain'); // файл побеждает
    assert.strictEqual(merged.theme, 'tokyonight-moon'); // settings сохранён
    assert.strictEqual(merged.cwdMode, 'compact'); // новый из файла
});

// --- 3. slash-меню видит /effects --------------------------------------------------
test('slash-меню: команда effects зарегистрирована (алиас в /settings)', async () => {
    const { readFileSync: rs, realpathSync: rp } = await import('node:fs');
    const src = rs(rp(TUI_BASE + '/lib/types/dsh-adapter/channel.js'), 'utf8');
    assert.ok(src.includes("name: 'effects'"), 'команда effects зарегистрирована');
    assert.ok(src.includes('commandCompletions'), 'completions есть');
});

// --- 4. statusrow → нативная группа status-bar -------------------------------------
test('секция statusrow указывает на нативную группу status-bar (без дублей)', () => {
    const statusrow = hub.hubSectionById('statusrow');
    assert.ok(statusrow !== undefined);
    assert.strictEqual(statusrow.group, 'status-bar');
});

// --- 5. прыжки /effects <section> маппятся на группы -------------------------------
test('hubSectionById: все 7 секций резолвятся', () => {
    for (const id of ['appearance', 'effects', 'theme', 'border', 'spinner', 'statusrow', 'progress']) {
        assert.ok(hub.hubSectionById(id) !== undefined, id);
    }
    assert.strictEqual(hub.hubSectionById('nope'), undefined);
});
