#!/usr/bin/env node
// tests/settings-hub.test.js — unit-тесты патча 46 «settings-hub» (узел 1
// TG-DSH-HUB-SETTINGS-20260918): хаб кастомизации живёт ВНУТРИ нативного
// /settings (секции через tuiSettingsSections-seam, seam расширен custom
// demo-рядами), мёртвые ключи заwiredены (тема → theme-цепочка /theme,
// спиннеры → channel.setSpinnerPrefs, ctxBarMode → statusBar.ctxBarMode),
// /effects — алиас, открывающий /settings на группе Эффекты.
//
// КОНТРАКТ (TDD red):
//   1. hubSections: каждая секция хаба {id, title, group} → группа /settings
//      (effects→hub-effects, statusrow→status-bar, appearance→hub-appearance,
//      theme→hub-theme, border→hub-border, spinner→hub-spinner,
//      progress→hub-progress);
//   2. hubSettings.js: hubSettingsSectionParts() (группы+поля секции),
//      HubCustomRow, HUB_FIELD_DEMOS, writeDshSettings (host-write с retry
//      на SETTINGS_CONFLICT), cycleStyle;
//   3. plugin.js: регистрация dsh-tui растянута хаб-частями; applyAppearance
//      больше НЕ читает appearance.json-слой хаба (effects.json остаётся);
//   4. Chat.js: /effects открывает /settings (алиас + прыжки по секциям),
//      оверлей kind 'effects' и CustomizationHub удалены;
//   5. ThemeProvider: useTheme() возвращает [theme, setTheme, previewTheme,
//      revertTheme] — 4 элемента (латентный баг патча 37: Chat
//      деструктурировал 4 из 2-элементного массива);
//   6. EffectsPanel: EffectDemo экспортирован (демо эффектов переиспользуются);
//   7. Settings.js: custom-поля рендерятся HubCustomRow (form их не видит),
//      demo-ряды под сфокусированным полем, initialGroup-проп;
//   8. CustomizationHub.js удалён (модуль больше не существует).
// Запуск: node --test tests/settings-hub.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';

import { importTuiModule, TUI_BASE } from './tui-base.mjs';

const live = (rel) => readFileSync(realpathSync(`${TUI_BASE}/${rel}`), 'utf8');

// --- 1. реестр секций → группы /settings ---------------------------------------
test('HUB_SECTIONS: каждая секция несёт группу /settings ({id, title, group})', async () => {
    const hub = await importTuiModule('lib/types/hubSections.js');
    assert.ok(Array.isArray(hub.HUB_SECTIONS));
    assert.ok(hub.HUB_SECTIONS.length >= 6, `${hub.HUB_SECTIONS.length}`);
    const expected = {
        appearance: 'hub-appearance',
        effects: 'hub-effects',
        theme: 'hub-theme',
        border: 'hub-border',
        spinner: 'hub-spinner',
        statusrow: 'status-bar',
        progress: 'hub-progress',
    };
    for (const section of hub.HUB_SECTIONS) {
        assert.ok(typeof section.id === 'string' && section.id.length > 0, 'id');
        assert.ok(typeof section.title === 'string' && section.title.length > 0, `title ${section.id}`);
        assert.ok(typeof section.group === 'string' && section.group.length > 0, `group ${section.id}`);
    }
    for (const [id, group] of Object.entries(expected)) {
        const hit = hub.HUB_SECTIONS.find(s => s.id === id);
        assert.ok(hit !== undefined, `нет секции ${id}`);
        assert.strictEqual(hit.group, group, `${id}.group`);
    }
    assert.ok(typeof hub.hubSectionById === 'function');
    assert.strictEqual(hub.hubSectionById('effects')?.group, 'hub-effects');
});

// --- 2. hubSettings.js: модуль, экспорты, поведение ----------------------------
test('hubSettings.js: модуль существует с контрактом (parts/rows/demos/write/cycle)', async () => {
    const hubSettings = await importTuiModule('lib/types/components/hubSettings.js');
    assert.ok(typeof hubSettings.hubSettingsSectionParts === 'function', 'hubSettingsSectionParts');
    assert.ok(typeof hubSettings.HubCustomEntry === 'function', 'HubCustomEntry (ряд + демо одним компонентом)');
    assert.ok(hubSettings.HUB_FIELD_DEMOS !== null && typeof hubSettings.HUB_FIELD_DEMOS === 'object', 'HUB_FIELD_DEMOS');
    assert.ok(typeof hubSettings.writeDshSettings === 'function', 'writeDshSettings');
    assert.ok(typeof hubSettings.cycleStyle === 'function', 'cycleStyle');
});

test('hubSettingsSectionParts: 6 хаб-групп + поля (powerline/animations/theme/inputBorder/spinner/effects/ctxBarMode)', async () => {
    const hubSettings = await importTuiModule('lib/types/components/hubSettings.js');
    const parts = hubSettings.hubSettingsSectionParts();
    const groupIds = parts.groups.map(g => g.id);
    for (const id of ['hub-appearance', 'hub-effects', 'hub-theme', 'hub-border', 'hub-spinner', 'hub-progress']) {
        assert.ok(groupIds.includes(id), `группа ${id}`);
    }
    const paths = parts.fields.map(f => f.path.join('.'));
    // Оформление: powerline/background/animations (настройки, live через watch).
    for (const p of ['appearance.powerline', 'appearance.background', 'appearance.animations']) {
        assert.ok(paths.includes(p), `поле ${p}`);
    }
    // Рамка: inputBorder.
    assert.ok(paths.includes('appearance.inputBorder'), 'поле appearance.inputBorder');
    // Статус-ряд (группа status-bar): ctxBarMode (мёртвый ключ → statusBar),
    // cwdMode, спарклайны (переиспользуют effectEnabled, НЕ дубли гейтов).
    for (const p of ['statusBar.ctxBarMode', 'appearance.cwdMode']) {
        assert.ok(paths.includes(p), `поле ${p}`);
    }
    // Спиннеры и тема — custom-ряды (live-применение вне формы).
    const customFields = parts.fields.filter(f => f.kind === 'custom');
    const customPaths = customFields.map(f => f.path.join('.'));
    assert.ok(customPaths.includes('spinner.main'), 'custom spinner.main');
    assert.ok(customPaths.includes('spinner.subagent'), 'custom spinner.subagent');
    assert.ok(customPaths.includes('spinner.toolCard'), 'custom spinner.toolCard');
    assert.ok(customPaths.includes('hub.theme'), 'custom hub.theme');
    // Эффекты — custom-ряды по ключам реестра (тумблер пишет effects.<key> +
    // animations=custom одним write — семантика effectEnabled не меняется).
    const { EFFECT_KEYS } = await importTuiModule('lib/types/animationsMode.js');
    for (const key of EFFECT_KEYS) {
        assert.ok(customPaths.includes(`hub.effect.${key}`), `custom эффект ${key}`);
    }
    // Демо: у каждого оформительского поля есть demo-ид (live-демо в /settings).
    for (const field of parts.fields) {
        if (field.kind === 'custom') {
            assert.ok(field.custom !== null && typeof field.custom === 'object', `custom-описатель ${field.path.join('.')}`);
            assert.ok(typeof field.custom.type === 'string', `custom.type ${field.path.join('.')}`);
        }
        else {
            assert.ok(typeof field.demo === 'string' && field.demo.length > 0, `demo ${field.path.join('.')}`);
        }
    }
    // ctxBarMode — select с тремя режимами (ключ statusBar, не appearance).
    const ctxBar = parts.fields.find(f => f.path.join('.') === 'statusBar.ctxBarMode');
    assert.strictEqual(ctxBar.kind, 'select');
    assert.deepEqual(ctxBar.options.map(o => o.value), ['full', 'narrow', 'percent-only']);
});

test('writeDshSettings: пишет ops; на SETTINGS_CONFLICT — один retry со свежей ревизией', async () => {
    const hubSettings = await importTuiModule('lib/types/components/hubSettings.js');
    const written = [];
    let conflictOnce = true;
    const revisions = [{ ns: 'dsh-tui', revision: 7 }];
    const host = {
        listNamespaces: () => revisions,
        write: async (ns, ops, revision) => {
            if (conflictOnce) {
                conflictOnce = false;
                const err = new Error('conflict');
                err.code = 'SETTINGS_CONFLICT';
                throw err;
            }
            written.push({ ns, ops, revision });
        },
    };
    const channel = { settingsHost: () => host };
    const ok = await hubSettings.writeDshSettings(channel, [{ op: 'set', path: ['spinner', 'main'], value: 'dots' }]);
    assert.strictEqual(ok, true);
    assert.strictEqual(written.length, 1, 'после конфликта — retry');
    assert.strictEqual(written[0].revision, 7, 'retry со свежей ревизией');
    assert.deepEqual(written[0].ops, [{ op: 'set', path: ['spinner', 'main'], value: 'dots' }]);
    // Полный отказ (не-конфликтная ошибка) — false, без retry.
    const host2 = {
        listNamespaces: () => revisions,
        write: async () => { throw new Error('boom'); },
    };
    const ok2 = await hubSettings.writeDshSettings({ settingsHost: () => host2 }, [{ op: 'set', path: ['x'], value: 1 }]);
    assert.strictEqual(ok2, false);
});

test('cycleStyle: цикл по каталогу с пустым стилем (встроенный) в списке', async () => {
    const hubSettings = await importTuiModule('lib/types/components/hubSettings.js');
    const { SPINNER_NAMES } = await importTuiModule('lib/types/spinnerCatalog.js');
    const list = ['', ...SPINNER_NAMES];
    assert.strictEqual(hubSettings.cycleStyle('dots', 1, list), 'dots2');
    assert.strictEqual(hubSettings.cycleStyle(list[list.length - 1], 1, list), '');
    assert.strictEqual(hubSettings.cycleStyle('', -1, list), list[list.length - 1]);
    // Неизвестное текущее значение → первый элемент.
    assert.strictEqual(hubSettings.cycleStyle('nope', 1, list), list[1]);
});

// --- 3. plugin.js: регистрация + applyAppearance --------------------------------
test('plugin.js: хаб-части в регистрации dsh-tui; appearance.json-слой убран, effects.json жив', async () => {
    const src = live('lib/types/dsh-adapter/plugin.js');
    assert.ok(src.includes('hubSettingsSectionParts'), 'регистрация растянута хаб-частями');
    assert.ok(src.includes('...hubParts.groups,'), 'группы хаба спредятся в регистрацию');
    assert.ok(src.includes('...hubParts.fields,'), 'поля хаба спредятся в регистрацию');
    // Мёртвый appearance.json-слой (патч 44) убран из applyAppearance...
    assert.ok(!src.includes('mergeAppearanceOver(settingsAppearance'), 'appearance.json не мерджится поверх settings');
    // ...но effects.json (патч 38) продолжает жить поверх appearance.effects.
    assert.ok(src.includes('readEffectsPref()'), 'effects.json-слой сохранён');
});

// --- 4. Chat.js: /effects — алиас в /settings ------------------------------------
test('Chat.js: /effects открывает /settings на группе; оверлей effects и CustomizationHub удалены', async () => {
    const src = live('lib/types/screens/Chat.js');
    assert.ok(!src.includes("overlay: { kind: 'effects'"), 'нет dispatch effects-оверлея');
    assert.ok(!src.includes("from '../components/CustomizationHub.js'"), 'CustomizationHub не импортируется');
    assert.ok(!src.includes('jsx(CustomizationHub'), 'CustomizationHub не рендерится');
    // Код-использование удалено (в комментариях имена могут упоминаться).
    assert.ok(!src.includes('hubEnterAction('), 'hubEnterAction не вызывается');
    assert.ok(!/\bHUB_SECTION_COUNT\b(?!,)/.test(src.split('// dsh-overrides 46:')[0]) || !/\bconst HUB_SECTION_COUNT\b/.test(src), 'HUB_SECTION_COUNT не определяется и не читается в коде');
    // Алиас: /effects → setSettingsOpen + группа Эффекты.
    const effectsCase = src.slice(src.indexOf("case 'effects':"), src.indexOf("case 'color':"));
    assert.ok(effectsCase.includes('setSettingsOpen(true)'), 'алиас открывает /settings');
    assert.ok(effectsCase.includes('hub-effects') || effectsCase.includes('hubSectionById'), 'прыжок через реестр секций');
    // Настройки: Settings получает initialGroup.
    assert.ok(src.includes('initialGroup'), 'Settings маунтится с initialGroup');
});

// --- 5. ThemeProvider: useTheme отдаёт 4 элемента --------------------------------
test('ThemeProvider: useTheme возвращает [theme, setTheme, previewTheme, revertTheme]', async () => {
    const src = live('lib/types/components/design-system/ThemeProvider.js');
    assert.ok(src.includes('return [theme, setTheme, previewTheme, revertTheme];'), 'useTheme — 4 элемента (фикс патча 37)');
});

// --- 6. EffectsPanel: EffectDemo экспортирован -----------------------------------
test('EffectsPanel: EffectDemo экспортирован для переиспользования в /settings', async () => {
    const panel = await importTuiModule('lib/types/components/EffectsPanel.js');
    assert.ok(typeof panel.EffectDemo === 'function', 'EffectDemo export');
});

// --- 7. Settings.js: custom-поля + demo-ряды + initialGroup ----------------------
test('Settings.js: seam расширен — custom-ряды, demo-ряды, initialGroup', async () => {
    const src = live('lib/types/screens/Settings.js');
    assert.ok(src.includes("kind !== 'custom'"), 'форма не получает custom-поля');
    assert.ok(src.includes('HubCustomEntry'), 'custom-поля рендерятся HubCustomEntry');
    assert.ok(src.includes('HUB_FIELD_DEMOS'), 'demo-реестр подключён');
    assert.ok(src.includes('initialGroup'), 'initialGroup-проп');
    assert.ok(src.includes("field.kind === 'custom'"), 'activateEntry игнорирует custom (клавиши — внутри ряда)');
});

// --- 8. CustomizationHub.js удалён ------------------------------------------------
test('CustomizationHub.js: модль удалён (хаб переехал в /settings)', async () => {
    await assert.rejects(() => importTuiModule('lib/types/components/CustomizationHub.js'), /Cannot find|ERR_MODULE/, 'файл должен быть удалён');
});

// --- 9. Мёртвый ключ appearance.ctxBarMode больше не пишется ----------------------
test('хаб больше не пишет мёртвый appearance.ctxBarMode (только statusBar.ctxBarMode)', async () => {
    const hubSettings = await importTuiModule('lib/types/components/hubSettings.js');
    const parts = hubSettings.hubSettingsSectionParts();
    const paths = parts.fields.map(f => f.path.join('.'));
    assert.ok(!paths.includes('appearance.ctxBarMode'), 'мёртвого ключа нет');
    assert.ok(paths.includes('statusBar.ctxBarMode'), 'живой ключ statusBar.ctxBarMode');
});
