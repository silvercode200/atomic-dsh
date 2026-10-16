#!/usr/bin/env node
// tests/intro-align-repro.mjs — репро кривого первого рендера intro-блока
// «▶ （Ctrl+P to expand） Context loaded · …» (TG-DSH-TUI-STYLE2-20260917,
// node intro-align-bug; ДИАГНОСТИКА, read-only по TUI).
//
// Монтирует НАСТОЯЩИЙ Chat (screens/Chat.js) со стабом канала в конфигурации
// юзера — inline (fullscreen=false), minimal=true, tokyonight-moon — и гоняет
// стартовую последовательность:
//   A: mount без loadedContext (панели нет)
//   B: channel.loadedContext приезжает (панель монтируется) — как в живом dsh
//   C: покой (pin-эффект Chat.js:427-474 закрепил кадр)
//   D: stdin '/'  — slash-меню открылось (OverlayAbove, layout-инертно)
//   E: stdin ESC  — меню закрылось (PromptInput «single Esc closes the menu»)
//
// stdout = PassThrough с isTTY=true → живой TTY-путь рендера (побайтовый diff
// log-update.js). Сырые байты этапов скармливаются VirtualScreen
// (tests/golden/drive_session.py) → ФИЗИЧЕСКИЙ экран этапа. Эталон = non-TTY
// рендер того же состояния (renderFullFrame → полный логический кадр).
//
// Проверки (RED = paint-артефакт воспроизведён):
//   1. «Context loaded» виден на экране C.
//   2. На C/D/E ровно ОДНА строка «Context loaded» (нет призрачной копии).
//   3. Экран E == экран C (меню layout-инертно; «ряд поднимается после Esc» —
//      не задуманный layout-переход; расхождение позиций = артефакт).
//   4. Y-позиция ряда панели на C == Y в эталонном полном кадре.
//   5. Между рядом панели и рамкой инпута ровно 1 пустая строка (marginTop
//      LoadedContextPanel.js:31), лишних пустых строк нет.
//
// Запуск: node tests/intro-align-repro.mjs   (exit 0 = GREEN, 1 = RED)

import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { realpathSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TUI_BASE } from './tui-base.mjs';

const LIB = realpathSync(TUI_BASE + '/lib/types');
process.env.FORCE_COLOR = '3';
delete process.env.MKS_SYNC_TOKEN;
delete process.env.SWITCHER_SYNC_TOKEN;

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(REPO, 'reports/intro-align-frames');
mkdirSync(OUT_DIR, { recursive: true });

const require = createRequire(realpathSync(LIB + '/components/GoalTodoPanel.js'));
const React = require('react');
const { renderSync } = await import(LIB + '/ink/root.js');
const { setLang } = await import(LIB + '/i18n.js');
const { ThemeProvider } = await import(LIB + '/ui.js');
const { Chat } = await import(LIB + '/screens/Chat.js');
const { setMinimalMode } = await import(LIB + '/minimalMode.js');
const { QuestionStore } = await import(LIB + '/dsh-adapter/questions.js');
setLang('en');
setMinimalMode(true);

const ROWS = 40, COLS = 120;
const ACTIVE_THEME = 'tokyonight-moon';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Стаб канала: поля, читаемые рендер-путём Chat/PromptInput/MessageList/
// StatusLine/GoalTodoPanel. Методы — no-op (обработчики событий не нужны).
const USER_STATUS_BAR = {
  tokens: true, compact: false, contextBar: true, mode: true, tps: true,
  trajectory: false, shortcutHint: true, activity: true, cache: true,
  gitBranch: true, spending: true, compactProgress: true,
  compactThresholdRatio: 0.4768,
};

function makeLoadedContext() {
  return {
    sections: Array.from({ length: 23 }, (_, i) => ({
      name: `system-section-${i + 1}`,
      text: `section ${i + 1} body text sample`,
    })),
    files: [],
    contexts: [
      { name: 'runtime-item-1', text: 'runtime context item one' },
      { name: 'runtime-item-2', text: 'runtime context item two' },
    ],
    skills: [],
    tools: [{ name: 'tool-one', description: 'the single tool' }],
  };
}

const listeners = new Set();
function makeChannel() {
  return {
    // version/subscribe — рендер-триггер (useExternalVersion)
    version: 1,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { this.version += 1; for (const fn of listeners) fn(); },
    // поля рендера
    rows: [],
    loadedContext: undefined,
    minimal: true,
    model: 'glm-5.3',
    provider: 'cli',
    reasoningEffort: 'high',
    cwd: '/home/user/xeon-Programms/deepseek_harness',
    displayCwd: '~/…/deepseek_harness',
    whale: false,
    mode: { plan: false },
    modeIndex: 0,
    agentId: '1a2b3c4d-0000-0000-0000-000000000000',
    backgroundJobs: [],
    subagents: [],
    backgroundCurrent: undefined,
    working: false,
    workingActivity: undefined,
    turnStart: 0,
    activityFrames: [],
    activityEnabled: true,
    configuredActivityFrames: [],
    spinnerMode: undefined,
    smoothStreaming: false,
    thinkingFold: true,
    toolBackground: 'subtle',
    foldTerminalCommand: true,
    diffLayout: 'split',
    scrollGutter: 'rail',
    pending: [],
    responseChars: 0,
    activeToolCount: 0,
    contextWindow: 262144,
    contextBarEnabled: true,
    contextSegments: { system: 5200, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    lastUsage: { input: 5200, cacheRead: 0, cacheWrite: 0, output: 0 },
    tokens: { input: 5200, output: 0 },
    tps: undefined,
    tpsSamples: [],
    gitBranch: 'main',
    goal: undefined,
    sessionTitle: undefined,
    sessionColor: undefined,
    statusBar: USER_STATUS_BAR,
    commandList: [
      { name: 'context', description: 'show loaded context' },
      { name: 'model', description: 'switch model' },
      { name: 'preset', description: 'switch preset' },
    ],
    agentViewRows: undefined,
    mcpStatus: undefined,
    doctorInfo: undefined,
    pluginsInfo: undefined,
    pluginScene: undefined,
    balanceInfo: undefined,
    sideQuestion: undefined,
    notifications: [],
    todos: [],
    effortLevels: undefined,
    promptSessionLabel: undefined,
    commandCompletions(input) {
      const q = input.replace(/^\//, '').split(/[\t ]/)[0]?.toLowerCase() ?? '';
      if (q === '') return this.commandList.map(c => ({ name: c.name, description: c.description }));
      return this.commandList
        .filter(c => c.name.toLowerCase().startsWith(q))
        .map(c => ({ name: c.name, description: c.description }));
    },
    // методы-заглушки (обработчики ввода/оверлеев)
    notify() {},
    submit() {},
    loadOlder() {},
    renameSession() {},
    interruptAndDeliver() { return 0; },
    cancel() {},
    clear() {},
    compact() {},
    listModels() { return []; },
    listEfforts() { return []; },
  };
}

// ── Fake-TTY стримы ─────────────────────────────────────────────────────────
// stdout: isTTY=true включает TTY-путь LogUpdate (побайтовый diff) — то, что
// рисует реальный терминал. resize-события не эмулируем (окно стабильно).
function makeStdout() {
  const out = new PassThrough();
  out.isTTY = true;
  out.columns = COLS;
  out.rows = ROWS;
  out.setRawMode = () => {};
  return out;
}
function makeStdin() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

// ── Терминальная предыстория: юзер запускает dsh из shell-промпта СЕРЕДИНЫ
// терминала (3 строки истории). Физический курсор на row 3 — как в жизни.
const SHELL_HISTORY = 'last shell command output\r\nuser@host:~/repo$ dsh\r\n';

// ── Драйвер VirtualScreen (python, tests/golden/drive_session.py) ───────────
const PY_DRIVER = `
import sys
sys.path.insert(0, sys.argv[1])
from drive_session import VirtualScreen
vs = VirtualScreen(cols=int(sys.argv[2]), rows=int(sys.argv[3]))
vs.feed(open(sys.argv[4], 'rb').read())
sys.stdout.write(vs.text())
`;

function emulateStage(stage) {
  const res = spawnSync('python3', [
    '-c', PY_DRIVER,
    join(REPO, 'tests/golden'),
    String(COLS), String(ROWS),
    join(OUT_DIR, `stage-${stage}-raw.bin`),
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error('VirtualScreen failed: ' + res.stderr);
  return res.stdout;
}

// ── Поиск ряда панели на экране/в эталоне ──────────────────────────────────
const ANCHOR = 'Context loaded';
function findAnchorRows(screenText) {
  const lines = screenText.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(ANCHOR)) rows.push(i);
  }
  return { rows, lines };
}

// ── Основной прогон ─────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const channel = makeChannel();
const stdout = makeStdout();
const stdin = makeStdin();
let rawTotal = '';
stdout.on('data', d => { rawTotal += d.toString('binary'); });

function buildTree() {
  return React.createElement(ThemeProvider, { theme: ACTIVE_THEME },
    React.createElement(Chat, {
      channel,
      questionStore: new QuestionStore(),
      fullscreen: false,
      onExit: () => {},
      onUpdate: () => {},
      onRestart: () => {},
    }));
}

const inst = renderSync(buildTree(), {
  stdout, stdin, exitOnCtrlC: false, patchConsole: false,
});

// предыстория shell: физический терминал до первого байта TUI
writeFileSync(join(OUT_DIR, 'shell-history.bin'), Buffer.from(SHELL_HISTORY, 'binary'));
await wait(400); // A: mount без панели (pin-эффект успевает отработать)
writeFileSync(join(OUT_DIR, 'stage-a-raw.bin'),
  Buffer.from(SHELL_HISTORY + rawTotal, 'binary'));

// B: loadedContext приезжает асинхронно (как живой канал)
channel.loadedContext = makeLoadedContext();
channel.emit();
await wait(400);
writeFileSync(join(OUT_DIR, 'stage-b-raw.bin'),
  Buffer.from(SHELL_HISTORY + rawTotal, 'binary'));

// C: покой
await wait(400);
writeFileSync(join(OUT_DIR, 'stage-c-raw.bin'),
  Buffer.from(SHELL_HISTORY + rawTotal, 'binary'));

// D: юзер печатает '/' → slash-меню
stdin.write('/');
await wait(500);
writeFileSync(join(OUT_DIR, 'stage-d-raw.bin'),
  Buffer.from(SHELL_HISTORY + rawTotal, 'binary'));

// E: Esc → меню закрывается (setInput('') — layout-инертно)
stdin.write('\x1b');
await wait(500);
writeFileSync(join(OUT_DIR, 'stage-e-raw.bin'),
  Buffer.from(SHELL_HISTORY + rawTotal, 'binary'));

inst.unmount();

// ── Эталон: non-TTY полный рендер финального состояния (логический кадр) ───
// channel.rows по-прежнему пуст, loadedContext на месте → тот же layout, что
// и на этапах C/E (меню закрыто). renderFullFrame даёт эталонный кадр.
const refStdout = new PassThrough();
refStdout.columns = COLS;
refStdout.rows = ROWS;
let refRaw = '';
refStdout.on('data', d => { refRaw += d.toString('binary'); });
const refInst = renderSync(buildTree(), {
  stdout: refStdout, stdin: makeStdin(),
  exitOnCtrlC: false, patchConsole: false,
});
await wait(400);
refInst.unmount();
writeFileSync(join(OUT_DIR, 'reference-full-frame.bin'), Buffer.from(refRaw, 'binary'));

const ANSI = /(?:\x1B\][^\x07]*(?:\x07|\x1B\\))|\x1B\[[0-9;?]*[a-zA-Z]|\x1B[()][0-9A-B]|\r/g;
const refLines = refRaw.replace(ANSI, '').split('\n');
const refAnchorIdx = refLines.findIndex(l => l.includes(ANCHOR));
if (refAnchorIdx === -1) throw new Error('anchor missing in reference render');

// ── Кадры: экраны этапов через VirtualScreen ────────────────────────────────
const screens = {};
for (const stage of ['a', 'b', 'c', 'd', 'e']) {
  screens[stage] = emulateStage(stage);
  writeFileSync(join(OUT_DIR, `stage-${stage}-screen.txt`), screens[stage]);
}
writeFileSync(join(OUT_DIR, 'reference-frame.txt'), refLines.join('\n'));

// ── Проверки ────────────────────────────────────────────────────────────────
// 1. панель видна на C
const cInfo = findAnchorRows(screens.c);
check('1. panel visible on stage C', cInfo.rows.length >= 1,
  `rows=${JSON.stringify(cInfo.rows)}`);

// 2. ровно одна строка «Context loaded» на C/E (нет призрачных копий);
//    на D панель ЛЕГИТИМНО скрыта slash-меню (OverlayAbove absolute —
//    закрывает собой ряд панели), поэтому проверяем открытое меню.
for (const stage of ['c', 'e']) {
  const info = findAnchorRows(screens[stage]);
  check(`2. single panel row on stage ${stage.toUpperCase()}`, info.rows.length === 1,
    `rows=${JSON.stringify(info.rows)}`);
}
{
  const dLines = screens.d.split('\n');
  const menuOpen = dLines.some(l => l.includes('commands'));
  const dAnchor = dLines.filter(l => l.includes(ANCHOR)).length;
  check('2d. slash menu covers panel on stage D (overlay, no panel row)',
    menuOpen && dAnchor === 0, `menu=${menuOpen}, panelRows=${dAnchor}`);
}

// 3. экран E == экран C (меню layout-инертно: Esc-«подъём» ряда = артефакт)
const eInfo = findAnchorRows(screens.e);
const sameScreen = screens.c === screens.e;
check('3. stage E screen == stage C screen (menu cycle layout-neutral)',
  sameScreen,
  sameScreen ? '' : `panelY C=${cInfo.rows[0]} E=${eInfo.rows[0]}`);

// 4. Y ряда панели на C == Y в эталонном кадре. Эталон non-TTY пишет КАЖДЫЙ
// рендер полным кадром подряд; последний кадр = последние ROWS строк raw.
// Сравниваем расстояние якоря от низа кадра/экрана.
const refLast = refLines.slice(-ROWS);
const refAnchorY = refLast.findIndex(l => l.includes(ANCHOR));
const refDist = refAnchorY === -1 ? -1 : (ROWS - 1) - refAnchorY;
const cDist = (ROWS - 1) - cInfo.rows[0];
check('4. panel row Y on C matches reference frame (distance from bottom)',
  cDist === refDist, `C dist-from-bottom=${cDist}, reference=${refDist}`);

// 5. структура блока: под рядом панели СРАЗУ рамка инпута (MessageList пуст =
//    0 строк; «лишних пустых строк» между панелью и инпутом нет). Над панелью —
//    marginTop:1 + slack (patch 23/25, неотличимы при пустом транскрипте).
{
  const cLines = cInfo.lines;
  const panelY = cInfo.rows[0];
  const below = cLines[panelY + 1] ?? '';
  const isInputBorder = below.includes('╭');
  // панель — верхняя контентная строка (над ней только пустые)
  let y = panelY - 1, onlyBlanksAbove = true;
  while (y >= 0) { if (cLines[y].trim() !== '') { onlyBlanksAbove = false; break; } y--; }
  check('5. panel block structure: input border directly below, panel is topmost content row',
    isInputBorder && onlyBlanksAbove,
    `below="${below.slice(0, 30)}", topmost=${onlyBlanksAbove}`);
}

// ── Сводка ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
console.log('─'.repeat(60));
console.log(`VERDICT: ${failed.length === 0 ? 'GREEN (артефакт НЕ воспроизведён программно)' : 'RED (артефакт воспроизведён)'} — ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
