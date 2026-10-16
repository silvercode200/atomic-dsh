#!/usr/bin/env node
/**
 * Генератор кастомных тем dsh-tui из палитр iTerm2-Color-Schemes.
 *
 * Пайплайн: themes.yaml (манифест 50 схем) + sources/*.itermcolors (plist)
 *   → derived/generated/<id>.json (оверлей-темы для ~/.dsh-tui/themes/).
 *
 * Модель маппинга — base16-детерминированная:
 *   - dark-база: роли/акценты берут BRIGHT ANSI (8-15), фон/текст — Background/Foreground;
 *   - light-база: те же роли берут NORMAL ANSI (0-7), т.к. bright на светлом бледный;
 *   - поверхности (toolCardBackground и пр.) = mix(Background, Foreground, 3-9%);
 *   - selectionBg = bright black + alpha 55% (#rrggbbaa);
 *   - shimmer-варианты = mix(цвет, Foreground, 0.35).
 *
 * Отступление от ТЗ (осознанное): токен `background` в dsh-tui — это заливка
 * бейджей (см. darkTheme: background = Accent Blue), а НЕ терминальный фон.
 * Поэтому `background` ← brand-акцент (magenta/blue), а `inverseText` ←
 * Background (терминальный фон даёт контраст текста на заливке). Литеральное
 * «background←Background» дало бы невидимый текст бейджей.
 *
 * Валидация: список токенов извлекается программно из реального theme.js
 * установленного пакета dsh-tui (import getTheme('dark')); цвета проверяются
 * копией регексов isValidThemeColor из customTheme.js.
 *
 * Режимы:
 *   node generate-themes.mjs          — сгенерировать generated/*.json + сводка
 *   node generate-themes.mjs --check  — то же + таблица покрытия токенов,
 *                                       exit 1 если <50 тем, есть invalid
 *                                       цвета или покрытие <40 токенов.
 *
 * Зависимостей нет: только node:*. Переопределение пути theme.js:
 *   DSH_TUI_THEME_JS=/path/to/theme.js
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THEMES_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(THEMES_ROOT, 'sources');
const GENERATED_DIR = join(THEMES_ROOT, 'generated');
const MANIFEST_PATH = join(THEMES_ROOT, 'themes.yaml');
const DEFAULT_THEME_JS = join(
  homedir(),
  '.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/theme.js',
);

/** Минимальное покрытие токенов на тему (порог --check). */
const MIN_TOKENS = 40;

/* ------------------------------------------------------------------ *
 * Плаг-парсинг .itermcolors                                           *
 * ------------------------------------------------------------------ */

/**
 * Разобрать .itermcolors (XML plist) в карту имя-цвета → #rrggbb.
 * Каждый цвет — <dict> с Red/Green/Blue Component в диапазоне 0-1
 * (значения <real>/<integer>/<string>; вне диапазона клампятся).
 * @param {string} text Сырой текст plist.
 * @returns {Record<string, string>} Имя ключа plist (напр. "Ansi 0 Color") → hex.
 */
function parseItermPlist(text) {
  /** @type {Record<string, string>} */
  const result = {};
  const colorDictRe = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  for (const dictMatch of text.matchAll(colorDictRe)) {
    const name = dictMatch[1];
    const body = dictMatch[2];
    /** @type {number[]} */
    const channels = [];
    for (const channel of ['Red', 'Green', 'Blue']) {
      const m = new RegExp(
        `<key>${channel} Component</key>\\s*<(?:real|integer|string)>([^<]+)<`,
      ).exec(body);
      if (m === null) break;
      // Диапазон plist 0-1; клампим на случай мусора.
      channels.push(Math.min(1, Math.max(0, Number(m[1]))));
    }
    if (channels.length === 3) {
      result[name] = rgbToHex(channels[0], channels[1], channels[2]);
    }
  }
  return result;
}

/** @param {number} r @param {number} g @param {number} b — компоненты 0-1. */
function rgbToHex(r, g, b) {
  const byte = (x) =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * Извлечь из plist-карты базовую палитру: ANSI 0-15, background, foreground.
 * @param {Record<string, string>} colorsMap Результат parseItermPlist.
 * @returns {{ ansi: string[], background: string, foreground: string }}
 */
function extractPalette(colorsMap) {
  const ansi = [];
  for (let i = 0; i < 16; i++) {
    const hex = colorsMap[`Ansi ${i} Color`];
    if (hex === undefined) {
      throw new Error(`missing Ansi ${i} Color`);
    }
    ansi.push(hex);
  }
  const background = colorsMap['Background Color'];
  const foreground = colorsMap['Foreground Color'];
  if (background === undefined || foreground === undefined) {
    throw new Error('missing Background/Foreground Color');
  }
  return { ansi, background, foreground };
}

/* ------------------------------------------------------------------ *
 * Цветовая арифметика                                                 *
 * ------------------------------------------------------------------ */

/**
 * Линейное смешение двух hex-цветов (фиксированная формула генератора).
 * @param {string} aHex Цвет-основа (#rrggbb).
 * @param {string} bHex Цвет-примесь (#rrggbb).
 * @param {number} t Доля b в результате (0..1).
 * @returns {string} #rrggbb
 */
function mix(aHex, bHex, t) {
  const channel = (a, b) => Math.round(a + (b - a) * t);
  const r = channel(parseInt(aHex.slice(1, 3), 16), parseInt(bHex.slice(1, 3), 16));
  const g = channel(parseInt(aHex.slice(3, 5), 16), parseInt(bHex.slice(3, 5), 16));
  const b = channel(parseInt(aHex.slice(5, 7), 16), parseInt(bHex.slice(5, 7), 16));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Относительная яркость (0-1) hex-цвета по формуле luma. */
function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/* ------------------------------------------------------------------ *
 * Валидация (копия регексов customTheme.js dsh-tui)                   *
 * ------------------------------------------------------------------ */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const ANSI256_RE = /^ansi256\(\s*(\d{1,3})\s*\)$/;
const ANSI_NAMES = new Set([
  'ansi:black', 'ansi:red', 'ansi:green', 'ansi:yellow',
  'ansi:blue', 'ansi:magenta', 'ansi:cyan', 'ansi:white',
  'ansi:blackBright', 'ansi:redBright', 'ansi:greenBright', 'ansi:yellowBright',
  'ansi:blueBright', 'ansi:magentaBright', 'ansi:cyanBright', 'ansi:whiteBright',
]);

/**
 * Копия isValidThemeColor из customTheme.js dsh-tui (движок валидации тем).
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidThemeColor(value) {
  if (typeof value !== 'string') return false;
  if (HEX_RE.test(value)) return true;
  const rgb = RGB_RE.exec(value);
  if (rgb !== null) {
    return rgb.slice(1).every((channel) => Number(channel) <= 255);
  }
  const ansi = ANSI256_RE.exec(value);
  if (ansi !== null) return Number(ansi[1]) <= 255;
  return ANSI_NAMES.has(value);
}

/* ------------------------------------------------------------------ *
 * Токены dsh-tui (извлечение из реального theme.js)                   *
 * ------------------------------------------------------------------ */

/**
 * Список легальных semantic-токенов из установленного theme.js.
 * Импортирует модуль и берёт Object.keys(getTheme('dark')); при недоступности
 * модуля — regex-фолбэк по исходнику (ключи объекта darkTheme).
 * @returns {Promise<string[]>}
 */
async function loadThemeKeys() {
  const themeJsPath = process.env.DSH_TUI_THEME_JS || DEFAULT_THEME_JS;
  if (!existsSync(themeJsPath)) {
    throw new Error(`theme.js не найден: ${themeJsPath} (переопредели DSH_TUI_THEME_JS)`);
  }
  try {
    const mod = await import(pathToFileURL(themeJsPath).href);
    return Object.keys(mod.getTheme('dark'));
  } catch (err) {
    // Фолбэк: статический разбор исходника (ключи объекта darkTheme).
    const src = readFileSync(themeJsPath, 'utf8');
    const block = /const darkTheme = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
    const keys = [...block.matchAll(/^ {4}([A-Za-z_][\w]*):/gm)].map((m) => m[1]);
    if (keys.length === 0) throw err;
    return keys;
  }
}

/* ------------------------------------------------------------------ *
 * Манифест themes.yaml (line-based парсер)                            *
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} ManifestEntry
 * @property {string} id
 * @property {string} displayName
 * @property {string} base
 * @property {string} sourceFile
 * @property {string} family
 */

/**
 * Разобрать themes.yaml (плоский формат: `- id:` + вложенные `key: value`).
 * @param {string} text
 * @returns {ManifestEntry[]}
 */
function parseManifest(text) {
  /** @type {ManifestEntry[]} */
  const themes = [];
  /** @type {ManifestEntry|null} */
  let current = null;
  for (const line of text.split('\n')) {
    const entry = /^\s*-\s+id:\s*(.+)$/.exec(line);
    if (entry !== null) {
      current = { id: entry[1].trim(), displayName: '', base: '', sourceFile: '', family: '' };
      themes.push(current);
      continue;
    }
    const field = /^\s+(id|displayName|base|sourceFile|family):\s*(.*)$/.exec(line);
    if (field !== null && current !== null) {
      current[field[1]] = field[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return themes.filter((t) => t.id !== '' && t.sourceFile !== '');
}

/* ------------------------------------------------------------------ *
 * Маппинг палитры → semantic-токены dsh-tui                           *
 * ------------------------------------------------------------------ */

/**
 * Построить оверлей colors для одной темы (детерминированно).
 * @param {{ ansi: string[], background: string, foreground: string }} pal
 * @param {boolean} isLight База — light.
 * @returns {Record<string, string>}
 */
function buildColors(pal, isLight) {
  const { ansi, background: bg, foreground: fg } = pal;
  // Роли: dark-база берёт bright ANSI (8-15), light-база — normal (0-7).
  const pick = (i) => ansi[isLight ? i : i + 8];
  const brightBlack = ansi[8];
  const [red, green, yellow, blue, magenta, cyan] = [1, 2, 3, 4, 5, 6].map(pick);
  // brand/claude: magenta на dark, blue на light (по ТЗ).
  const brand = isLight ? blue : magenta;
  const orange = mix(red, yellow, 0.5);
  const indigo = mix(blue, magenta, 0.5);
  const shimmer = (c) => mix(c, fg, 0.35);

  /** @type {Record<string, string>} */
  const colors = {
    // Identity
    text: fg,
    inverseText: bg,
    inactive: brightBlack,
    inactiveShimmer: mix(brightBlack, fg, 0.4),
    subtle: mix(bg, brightBlack, 0.6),
    // Accents / статусы
    success: green,
    error: red,
    warning: yellow,
    warningShimmer: shimmer(yellow),
    permission: yellow,
    permissionShimmer: shimmer(yellow),
    suggestion: cyan,
    remember: cyan,
    claude: brand,
    claudeShimmer: shimmer(brand),
    claudeBlue_FOR_SYSTEM_SPINNER: brand,
    claudeBlueShimmer_FOR_SYSTEM_SPINNER: shimmer(brand),
    // `background` — заливка бейджей (не терминальный фон!) → brand-акцент
    background: brand,
    autoAccept: magenta,
    merged: magenta,
    bashBorder: red,
    planMode: green,
    ide: blue,
    professionalBlue: blue,
    chromeYellow: yellow,
    promptBorder: mix(bg, fg, 0.25),
    promptBorderShimmer: brand,
    // Tool dots/names — цикл ANSI 1-6
    toolDotExec: green,
    toolDotRead: cyan,
    toolDotWrite: magenta,
    toolDotWeb: blue,
    toolDotTask: red,
    toolNameExec: cyan,
    toolNameMutate: yellow,
    // Поверхности: mix(bg, fg, 3-9%)
    toolCardBackground: mix(bg, fg, 0.06),
    toolCardBackgroundDim: mix(bg, fg, 0.03),
    messageActionsBackground: mix(bg, fg, 0.07),
    bashMessageBackgroundColor: mix(bg, fg, 0.05),
    memoryBackgroundColor: mix(bg, fg, 0.06),
    userMessageBackground: mix(bg, fg, 0.04),
    userMessageBackgroundHover: mix(bg, fg, 0.09),
    selectionBg: `${brightBlack}8c`, // alpha 0x8c ≈ 55%
    // Diff
    diffAdded: mix(bg, green, 0.22),
    diffRemoved: mix(bg, red, 0.22),
    diffAddedDimmed: mix(bg, green, 0.13),
    diffRemovedDimmed: mix(bg, red, 0.13),
    diffAddedWord: green,
    diffRemovedWord: red,
    // Syntax
    syntaxKeyword: red,
    syntaxString: green,
    syntaxComment: brightBlack,
    syntaxNumber: yellow,
    syntaxFunction: blue,
    syntaxType: cyan,
    syntaxVariable: fg,
    syntaxOperator: brightBlack,
    syntaxPunctuation: brightBlack,
    syntaxConstant: magenta,
    // Subagent-метрики
    red_FOR_SUBAGENTS_ONLY: red,
    blue_FOR_SUBAGENTS_ONLY: blue,
    green_FOR_SUBAGENTS_ONLY: green,
    yellow_FOR_SUBAGENTS_ONLY: yellow,
    purple_FOR_SUBAGENTS_ONLY: magenta,
    pink_FOR_SUBAGENTS_ONLY: mix(magenta, red, 0.45),
    orange_FOR_SUBAGENTS_ONLY: orange,
    cyan_FOR_SUBAGENTS_ONLY: cyan,
    subagentBullet: red,
    subagentDescription: fg,
    subagentModel: brightBlack,
    subagentElapsed: brightBlack,
    subagentToolName: blue,
    subagentStatusRunning: blue,
    subagentStatusCompleted: green,
    subagentStatusFailed: red,
    // Rate limit / effort
    rate_limit_fill: blue,
    rate_limit_empty: mix(bg, fg, 0.15),
    fastMode: orange,
    fastModeShimmer: shimmer(orange),
    briefLabelYou: yellow,
    briefLabelClaude: brand,
    // Rainbow — ANSI 1-6 (+ производные orange/indigo/violet)
    rainbow_red: red,
    rainbow_orange: orange,
    rainbow_yellow: yellow,
    rainbow_green: green,
    rainbow_blue: blue,
    rainbow_indigo: indigo,
    rainbow_violet: magenta,
    rainbow_red_shimmer: shimmer(red),
    rainbow_orange_shimmer: shimmer(orange),
    rainbow_yellow_shimmer: shimmer(yellow),
    rainbow_green_shimmer: shimmer(green),
    rainbow_blue_shimmer: shimmer(blue),
    rainbow_indigo_shimmer: shimmer(indigo),
    rainbow_violet_shimmer: shimmer(magenta),
    // Mascot
    clawd_body: mix(red, yellow, 0.35),
    clawd_background: bg,
  };
  return colors;
}

/* ------------------------------------------------------------------ *
 * Генерация + отчёт                                                   *
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} ThemeReport
 * @property {string} id
 * @property {string} base
 * @property {number} tokens
 * @property {number} invalidColors
 * @property {string[]} problems
 */

/**
 * Прогнать весь пайплайн: манифест + sources → generated/*.json.
 * @param {string[]} themeKeys Легальные токены dsh-tui.
 * @param {boolean} checkMode Запущен ли --check.
 * @returns {Promise<{ reports: ThemeReport[], exitCode: number }>}
 */
async function generate(themeKeys, checkMode) {
  const keySet = new Set(themeKeys);
  const manifest = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
  /** @type {ThemeReport[]} */
  const reports = [];
  let exitCode = 0;

  mkdirSync(GENERATED_DIR, { recursive: true });
  for (const entry of manifest) {
    /** @type {string[]} */
    const problems = [];
    let palette;
    try {
      palette = extractPalette(
        parseItermPlist(readFileSync(join(SOURCES_DIR, entry.sourceFile), 'utf8')),
      );
    } catch (err) {
      reports.push({
        id: entry.id, base: entry.base, tokens: 0, invalidColors: 0,
        problems: [`source parse failed: ${String(err)}`],
      });
      continue;
    }

    // Санити: base манифеста vs яркость фона палитры.
    const bgIsLight = luminance(palette.background) > 0.5;
    if (bgIsLight !== (entry.base === 'light')) {
      problems.push(
        `base=${entry.base} contradicts background luminance (${bgIsLight ? 'light' : 'dark'} bg)`,
      );
    }

    const colors = buildColors(palette, entry.base === 'light');
    // Валидация: ключи из реального списка токенов, значения — валидные цвета.
    /** @type {Record<string, string>} */
    const clean = {};
    let invalid = 0;
    for (const [key, value] of Object.entries(colors)) {
      if (!keySet.has(key)) {
        invalid += 1;
        problems.push(`unknown token "${key}"`);
        continue;
      }
      if (!isValidThemeColor(value)) {
        invalid += 1;
        problems.push(`invalid color for "${key}": ${value}`);
        continue;
      }
      clean[key] = value;
    }

    const theme = {
      name: entry.id,
      displayName: entry.displayName,
      base: entry.base,
      colors: clean,
    };
    writeFileSync(
      join(GENERATED_DIR, `${entry.id}.json`),
      `${JSON.stringify(theme, null, 2)}\n`,
    );
    reports.push({
      id: entry.id,
      base: entry.base,
      tokens: Object.keys(clean).length,
      invalidColors: invalid,
      problems,
    });
  }

  // Сводка (всегда) и таблица покрытия (--check).
  const total = reports.length;
  const invalidTotal = reports.reduce((sum, r) => sum + r.invalidColors, 0);
  const minTokens = reports.reduce((m, r) => Math.min(m, r.tokens), Infinity);
  console.log(`themes: ${total} (dark: ${reports.filter((r) => r.base === 'dark').length}, light: ${reports.filter((r) => r.base === 'light').length})`);
  console.log(`invalid colors: ${invalidTotal}`);
  console.log(`token coverage: min=${minTokens} avg=${(reports.reduce((s, r) => s + r.tokens, 0) / total).toFixed(1)} of ${themeKeys.length} dsh-tui tokens`);

  if (checkMode) {
    console.log('\nid                        base  tokens  invalid');
    console.log('------------------------- -----  ------  -------');
    for (const r of reports) {
      console.log(
        `${r.id.padEnd(25)} ${r.base.padEnd(5)}  ${String(r.tokens).padEnd(6)}  ${r.invalidColors}${r.problems.length > 0 ? `  ! ${r.problems.join('; ')}` : ''}`,
      );
    }
  }

  for (const r of reports) {
    if (r.invalidColors > 0 || r.tokens < MIN_TOKENS || r.problems.length > 0) exitCode = 1;
  }
  if (total < 50) {
    console.error(`expected 50 themes, got ${total}`);
    exitCode = 1;
  }
  return { reports, exitCode };
}

const checkMode = process.argv.includes('--check');
const themeKeys = await loadThemeKeys();
const { exitCode } = await generate(themeKeys, checkMode);
process.exit(exitCode);
