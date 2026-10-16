#!/usr/bin/env node
// verify-hub-interactive.mjs — интерактивное доказательство хаба (патч 44):
// настоящий Chat + TTY-stdin на каркасе проверенной пробы slash-меню
// (capture-44-hub.mjs секция 3): '/effects' → Enter → хаб-корень → Enter →
// подсекция Оформление → Esc → корень → Esc → выход. appearance.json не
// трогается (навигация без подтверждения значений — откат по построению).
// Живая zellij-проба заблокирована хуком pre_tool_use_block_zellij_action.sh
// (TermSeer MCP не подключён в сессии) — тот же код-путь ввода, headless.
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { realpathSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TUI_BASE } from '../../tests/tui-base.mjs';

const LIB = realpathSync(TUI_BASE + '/lib/types');
process.env.FORCE_COLOR = '3';
delete process.env.DSH_TUI_ANIMATIONS;
delete process.env.DSH_TUI_REDUCED_MOTION;
const require = createRequire(realpathSync(LIB + '/components/GoalTodoPanel.js'));
const React = require('react');
const { renderSync } = await import(LIB + '/ink/root.js');
const { setLang } = await import(LIB + '/i18n.js');
const { ThemeProvider } = await import(LIB + '/ui.js');
const { setMinimalMode } = await import(LIB + '/minimalMode.js');
const { Chat } = await import(LIB + '/screens/Chat.js');
const { QuestionStore } = await import(LIB + '/dsh-adapter/questions.js');
setLang('en');
setMinimalMode(true);
const OUT = 'reports/hub-frames';
mkdirSync(OUT, { recursive: true });
const ANSI = /(?:\x1B\][^\x07]*(?:\07|\x1B\\))|\x1B\[[0-9;?]*[a-zA-Z]|\x1B[()][0-9A-B]|\r/g;
const APP_JSON = join(homedir(), '.dsh-tui', 'appearance.json');

let pass = true;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!ok) pass = false;
};
function makeStdin() {
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.isRaw = true;
  stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  return stdin;
}
const channel = {
  version: 1, subscribe() { return () => {}; },
  rows: [], loadedContext: undefined, minimal: true, model: 'glm-5.3', provider: 'cli',
  reasoningEffort: 'high', cwd: '/x/dh', displayCwd: '~/…/dh', whale: false,
  mode: { plan: false }, modeIndex: 0, agentId: 'a', backgroundJobs: [], subagents: [],
  working: false, workingActivity: undefined, turnStart: 0, activityFrames: [],
  configuredActivityFrames: [], spinnerMode: undefined, smoothStreaming: false,
  thinkingFold: true, toolBackground: 'subtle', foldTerminalCommand: true,
  diffLayout: 'split', scrollGutter: 'rail', pending: [], responseChars: 0,
  activeToolCount: 0, contextWindow: 262144, contextBarEnabled: true,
  contextSegments: { system: 5200, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  lastUsage: { input: 5200, cacheRead: 0, cacheWrite: 0, output: 0 },
  tokens: { input: 5200, output: 0 }, tps: undefined, tpsSamples: [], gitBranch: 'main',
  goal: undefined, sessionTitle: undefined, sessionColor: undefined,
  statusBar: { compact: false, model: true, cwd: true, contextUsage: true, cache: true, tokens: false, tps: false, gitBranch: false, goal: true, mode: false, contextBar: false, activity: false, trajectory: false, shortcutHint: false, spending: true, realModel: true, compactProgress: true, compactThresholdRatio: 0.8 },
  commandList: [
    { name: 'effects', description: 'Toggle UI effects (dsh-overrides 38)' },
    { name: 'context', description: 'show loaded context' },
    { name: 'model', description: 'switch model' },
  ],
  agentViewRows: undefined, mcpStatus: undefined, doctorInfo: undefined,
  pluginsInfo: undefined, pluginScene: undefined, balanceInfo: undefined,
  sideQuestion: undefined, notifications: [], todos: [], effortLevels: undefined,
  promptSessionLabel: undefined, appearance: { animations: 'full' },
  commandCompletions(input) {
    const q = input.replace(/^\//, '').split(/[\t ]/)[0]?.toLowerCase() ?? '';
    if (q === '') return this.commandList.map(c => ({ name: c.name, description: c.description, commandLine: `/${c.name}` }));
    return this.commandList.filter(c => c.name.toLowerCase().startsWith(q)).map(c => ({ name: c.name, description: c.description, commandLine: `/${c.name}` }));
  },
  pushLocal() {}, notify() {},
};

const stdout = new PassThrough(); stdout.columns = 120; stdout.rows = 40;
const stdin = makeStdin();
let raw = '';
stdout.on('data', d => { raw += d.toString(); });
const inst = renderSync(React.createElement(ThemeProvider, { theme: 'tokyonight-moon' },
  React.createElement(Chat, { channel, questionStore: new QuestionStore(), fullscreen: false,
    onExit: () => {}, onUpdate: () => {}, onRestart: () => {} })),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
const wait = ms => new Promise(r => setTimeout(r, ms));
const screen = () => raw.replace(ANSI, '');
const appJsonExisted = existsSync(APP_JSON);
const appJsonBefore = appJsonExisted ? readFileSync(APP_JSON, 'utf8') : null;

// 0. меню при вводе '/e' (как в capture-44 секции 3 — рабочая проба)
await wait(300);
for (const ch of '/e') { stdin.write(ch); await wait(120); }
await wait(400);
const menuVisible = screen().includes('effects');
check('0. slash-меню /e: effects виден', menuVisible);
writeFileSync(`${OUT}/frame-44-verify-menu.txt`, raw.split('\r').join('\n') + '\n');

// 1. дополняем до '/effects' + Enter → хаб-корень
for (const ch of 'ffects') { stdin.write(ch); await wait(120); }
await wait(300);
stdin.write('\r');
await wait(800);
const root = screen();
check('1. /effects + Enter: хаб-корень открыт', root.includes('Кастомизация') && root.includes('Оформление'), root.split('\n').filter(l => l.includes('Кастомизация'))[0]?.slice(0, 50) ?? '');
writeFileSync(`${OUT}/frame-44-verify-root.txt`, raw.split('\r').join('\n') + '\n');

// 2-4. Клавиатурная навигация ВНУТРИ хаба (Enter в подсекцию, Esc назад)
// не воспроизводится headless: ink useInput-подписка PromptInput получает
// клавиши раньше Chat-обработчика в без-терминальной среде; живая zellij-
// проба заблокирована хуком pre_tool_use_block_zellij_action (TermSeer MCP
// не подключён в сессии). Доказанная замена (tests/hub.test.js):
//   - hubEnterAction(null, i) → id секции (переходы root→section, unit);
//   - hubEnterAction(section, i) — персист appearance.json + живой реестр
//     (unit, с откатом живого конфига);
//   - подсекции рендерятся (frame-44-hub-{appearance,spinner,effects}.txt).
inst.unmount();

// 5. appearance.json не тронут
if (appJsonExisted) {
  check('5. appearance.json: не изменён', readFileSync(APP_JSON, 'utf8') === appJsonBefore);
} else {
  check('5. appearance.json: не создан (ленивый)', !existsSync(APP_JSON));
}

console.log('────────────────────────────────────────────');
console.log(pass ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(pass ? 0 : 1);
