#!/usr/bin/env node
// verify-effects-toggle.mjs — доказательство тумблера /effects (патч 38,
// TG-DSH-TUI-LIVE-20260917, гэп-запрос координатора): ИНТЕРАКТИВНЫЙ путь
// «открыть /effects → Enter (тумблер) → Esc» на настоящем Chat с фейковым
// TTY-stdin создаёт ~/.dsh-tui/effects.json с переключённым ключом; после
// доказательства файл УДАЛЯЕТСЯ (живой конфиг юзера возвращается в исходное
// «файла нет» состояние — тумблеры по умолчанию не тронуты).
//
// Проверки:
//   1. ДО: ~/.dsh-tui/effects.json отсутствует (иначе ABORT — не трогаем
//      чужой конфиг);
//   2. '/effects' + Enter → overlay открыт (на экране заголовок дашборда);
//   3. Enter → тумблер EFFECT_KEYS[0] (inputBorderBreath): файл создан,
//      содержит {"effects":{"inputBorderBreath":false}}, in-process
//      effectEnabled('inputBorderBreath') === false, режим = custom;
//   4. Esc → overlay закрыт;
//   5. ОТКАТ: файл удалён, existsSync = false, effectEnabled вернулся в
//      true (после сброса реестра) — исходное состояние юзера.
// Выход: exit 0 только если все проверки прошли.
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { realpathSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { TUI_BASE } from '../../tests/tui-base.mjs';

const LIB = realpathSync(TUI_BASE + '/lib/types');
process.env.FORCE_COLOR = '3';
delete process.env.MKS_SYNC_TOKEN;
delete process.env.SWITCHER_SYNC_TOKEN;
delete process.env.DSH_TUI_ANIMATIONS;
delete process.env.DSH_TUI_REDUCED_MOTION;

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ROWS = 40, COLS = 120;
const EFFECTS_JSON = join(homedir(), '.dsh-tui', 'effects.json');

const require = createRequire(realpathSync(LIB + '/components/GoalTodoPanel.js'));
const React = require('react');
const { renderSync } = await import(LIB + '/ink/root.js');
const { setLang } = await import(LIB + '/i18n.js');
const { ThemeProvider } = await import(LIB + '/ui.js');
const { Chat } = await import(LIB + '/screens/Chat.js');
const { setMinimalMode } = await import(LIB + '/minimalMode.js');
const { QuestionStore } = await import(LIB + '/dsh-adapter/questions.js');
const { effectEnabled, setAnimationsMode, setEffectsMode, animationsMode, EFFECT_KEYS } = await import(LIB + '/animationsMode.js');
setLang('en');
setMinimalMode(false);

let pass = true;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!ok) pass = false;
};

// ── 1. ДО: файла нет (guard чужого конфига) ────────────────────────────────
if (existsSync(EFFECTS_JSON)) {
  console.error(`ABORT: ${EFFECTS_JSON} уже существует — не трогаю живой конфиг юзера.`);
  process.exit(1);
}
check('1. ДО: ~/.dsh-tui/effects.json отсутствует (ленивое создание)', true);

// ── Стаб канала (intro-align-repro паттерн) + effects в commandList ─────────
function makeStdout() {
  const out = new PassThrough();
  out.isTTY = true; out.columns = COLS; out.rows = ROWS;
  out.setRawMode = () => {};
  return out;
}
function makeStdin() {
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.isRaw = true;
  stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  return stdin;
}

const channel = {
  version: 1,
  subscribe() { return () => {}; },
  emit() { this.version += 1; },
  rows: [], loadedContext: undefined, minimal: false,
  model: 'glm-5.3', provider: 'cli', reasoningEffort: 'high',
  cwd: '/home/user/xeon-Programms/deepseek_harness', displayCwd: '~/…/dh',
  whale: false, mode: { plan: false }, modeIndex: 0,
  agentId: '1a2b3c4d-0000', backgroundJobs: [], subagents: [],
  working: false, workingActivity: undefined, turnStart: 0,
  activityFrames: [], configuredActivityFrames: [], spinnerMode: undefined,
  smoothStreaming: false, thinkingFold: true, toolBackground: 'subtle',
  foldTerminalCommand: true, diffLayout: 'split', scrollGutter: 'rail',
  pending: [], responseChars: 0, activeToolCount: 0,
  contextWindow: 262144, contextBarEnabled: true,
  contextSegments: { system: 5200, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  lastUsage: { input: 5200, cacheRead: 0, cacheWrite: 0, output: 0 },
  tokens: { input: 5200, output: 0 }, tps: undefined, tpsSamples: [],
  gitBranch: 'main', goal: undefined, sessionTitle: undefined, sessionColor: undefined,
  statusBar: { compact: false, model: true, cwd: true, contextUsage: true, cache: true, tokens: true, tps: true, gitBranch: true, goal: true, mode: true, contextBar: true, activity: true, trajectory: false, shortcutHint: true, spending: true, realModel: true, compactProgress: true, compactThresholdRatio: 0.4768 },
  appearance: { powerline: 'full', theme: 'tokyonight-moon', inputBorder: '#7aa2f7', animations: 'full' },
  commandList: [
    { name: 'effects', description: 'Toggle UI effects (dsh-overrides 38)' },
    { name: 'context', description: 'show loaded context' },
  ],
  commandCompletions(input) {
    const q = input.replace(/^\//, '').split(/[\t ]/)[0]?.toLowerCase() ?? '';
    return this.commandList
      .filter(c => c.name.startsWith(q))
      .map(c => ({ name: c.name, description: c.description, commandLine: `/${c.name}` }));
  },
  agentViewRows: undefined, mcpStatus: undefined, doctorInfo: undefined,
  pluginsInfo: undefined, pluginScene: undefined, balanceInfo: undefined,
  sideQuestion: undefined, notifications: [], todos: [], effortLevels: undefined,
  promptSessionLabel: undefined,
  pushLocal() {},
  notify() {},
  setActivityFrames() { return true; },
};

const stdout = makeStdout();
const stdin = makeStdin();
let raw = '';
stdout.on('data', d => { raw += d.toString('binary'); });

const inst = renderSync(React.createElement(ThemeProvider, { theme: 'tokyonight-moon' },
  React.createElement(Chat, {
    channel,
    questionStore: new QuestionStore(),
    fullscreen: false,
    onExit: () => {},
    onUpdate: () => {},
    onRestart: () => {},
  })), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });

const wait = ms => new Promise(r => setTimeout(r, ms));
const ANSI = /(?:\x1B\][^\x07]*(?:\07|\x1B\\))|\x1B\[[0-9;?]*[a-zA-Z]|\x1B[()][0-9A-B]|\r/g;
const screen = () => raw.replace(ANSI, '');

// ── 2. '/effects' + Enter → дашборд открыт ────────────────────────────────
await wait(250);
stdin.write('/effects');
await wait(150);
stdin.write('\r');          // submit the command
await wait(400);
const opened = screen().includes('Effects dashboard');
check('2. /effects + Enter: дашборд открыт (заголовок на экране)', opened);
if (!opened) {
  // диагностика: что на экране
  console.log('   screen tail:', JSON.stringify(screen().split('\n').filter(l => l.trim() !== '').slice(-4)));
}

// ── 3. Enter → тумблер EFFECT_KEYS[0] ──────────────────────────────────────
stdin.write('\r');          // toggle the focused effect (inputBorderBreath)
await wait(400);
const fileCreated = existsSync(EFFECTS_JSON);
check('3. Enter: ~/.dsh-tui/effects.json СОЗДАН', fileCreated);
let content = '';
if (fileCreated) {
  content = readFileSync(EFFECTS_JSON, 'utf8');
  const parsed = JSON.parse(content);
  check('3. содержимое: {"effects":{"inputBorderBreath":false}}',
    parsed?.effects?.inputBorderBreath === false,
    JSON.stringify(parsed));
  check('3. in-process: effectEnabled(inputBorderBreath) === false (тумблер применён живьём)',
    effectEnabled('inputBorderBreath') === false);
  check('3. режим переключён на custom', animationsMode() === 'custom', animationsMode());
} else {
  check('3. содержимое файла', false, 'файл не создан');
}

// ── 4. Esc → overlay закрыт ────────────────────────────────────────────────
stdin.write('\x1b');
await wait(300);
// Проверка по ПОСЛЕДНЕМУ кадру (raw накапливает историю — заголовок был
// на экране ранее; текущее состояние = сегмент после последнего
// кадрового маркера log-update CSI ?2026h).
const frameMarker = '\x1b[?2026h';
const lastFrame = raw.slice(raw.lastIndexOf(frameMarker));
const closed = !lastFrame.includes('Effects dashboard');
check('4. Esc: дашборд закрыт (последний кадр без заголовка)', closed, `кадров≈${raw.split(frameMarker).length - 1}`);

inst.unmount();

// ── 5. ОТКАТ: вернуть живой конфиг юзера в исходное состояние ─────────────
if (existsSync(EFFECTS_JSON)) {
  rmSync(EFFECTS_JSON);
}
check('5. ОТКАТ: effects.json удалён (исходное состояние юзера)', !existsSync(EFFECTS_JSON));
// сброс реестра в дефолт (процесс завершится, но покажем восстановление)
setEffectsMode(undefined);
setAnimationsMode(undefined);
check('5. реестр сброшен: effectEnabled(inputBorderBreath) === true', effectEnabled('inputBorderBreath') === true);
check('5. все 8 эффектов снова on', EFFECT_KEYS.every(k => effectEnabled(k)));

// артефакт-доказательство (содержимое созданного файла + факт отката)
const REPORT = join(REPO, 'reports/live42-frames/effects-toggle-proof.txt');
const { writeFileSync } = await import('node:fs');
writeFileSync(REPORT, [
  'Доказательство тумблера /effects (интерактивный путь, настоящий Chat + TTY-stdin):',
  '',
  `Создан файл: ${EFFECTS_JSON}`,
  'Содержимое в момент тумблера:',
  content || '(не создан)',
  '',
  'Шаги: /effects → Enter (открыть) → Enter (тумблер inputBorderBreath → off) → Esc (закрыть).',
  'ОТКАТ после доказательства: файл удалён (existsSync=false), реестр сброшен в дефолт full.',
  '',
  `Живой вывод экрана (последний кадр, хвост):`,
  ...lastFrame.replace(ANSI, '').split('\n').filter(l => l.trim() !== '').slice(-6),
].join('\n') + '\n');
console.log(`артефакт: reports/live42-frames/effects-toggle-proof.txt`);

console.log('────────────────────────────────────────────');
console.log(pass ? 'VERDICT: PASS (тумблер /effects → effects.json доказан, откат выполнен)' : 'VERDICT: FAIL');
process.exit(pass ? 0 : 1);
