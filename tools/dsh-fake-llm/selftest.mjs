#!/usr/bin/env node
/**
 * Автопроверка dsh-fake-llm: поднимает сервер на случайном свободном порту
 * 127.0.0.1 и гоняет реальные HTTP-запросы (без моков собственного кода):
 *
 *   (a) non-stream запрос -> валидный anthropic-messages JSON с usage
 *   (б) stream запрос -> корректная последовательность SSE-событий
 *       с финальным message_stop
 *   (в) tools-сценарий -> полный цикл 3 tool_use (Bash -> Read -> Write)
 *       с валидным input-JSON и переходами по tool_result
 *   (г) health -> {"ok":true,...}
 *   (д) ctx90 -> usage заполняет ~90% окна 262144
 *   (е) long -> стрим длится >= STREAM_TOTAL_MS и циклит пул текста
 *   (ж) waves -> реальный спавн субагента: tool_use name="subagent" с
 *       валидным input (description+prompt+run_in_background:false),
 *       continuation по tool_result отдаёт финальный текст; запрос без
 *       маркера (промпт субагента) получает дефолтный short
 *   (з) subagents -> ДВЕ последовательные волны tool_use subagent
 *       (continuation по tool_result дважды), финальный текст end_turn
 *   (и) usage -> точные usage-числа сценария в ответе + tps в тексте
 *   (к) thinking -> delayMs (пауза до первого события) + длительный
 *       thinking-блок, затем текст
 *   (л) compact -> delayMs + repeatMs COMPACT_TOTAL_MS: длительность
 *       ответа покрывает окно компакции; конец message_stop
 *   (м) post-compact -> маркер SCENARIO:maxtokens детектится сквозь
 *       инжектированный runtime-context-снимок (хвост запроса после
 *       компакции = [суммари, интент юзера, снимок]): первый ответ
 *       MAXTOKENS_CUT + stop_reason max_tokens, авто-continue "continue"
 *       доигрывает MAXTOKENS_TAIL end_turn
 *   (н) replay -> конвертер session.jsonl (мини-сессия с time-разбросом
 *       чанков, батчи *-chunks + raw-дельты, tool-цикл, max-tokens ход)
 *       в replay-сценарий --speed 0.5 --max-delay 40; вложенный сервер:
 *       (а) конкатенация text-delta == тексту исходного хода, (б) межчанковые
 *       задержки == time-дельтам оригинала (при speed-факторе, допуск ±),
 *       (в) stop_reason хода: end_turn / tool_use / max_tokens CUT +
 *       resume-хвост end_turn; N-е маркерное сообщение -> N-й записанный ход
 *   (о) glyphs -> box-drawing │┌└├┼, braille ⠁⠇⣿, powerline U+E0B0,
 *       fullwidth （）Ａ, em dash —, middot ·, ambiguous ±°µ в ответе;
 *       thinking-блок присутствует
 *
 * Выход: PASSED/FAILED по пунктам, итог и exit code (0 = всё прошло).
 * Запуск: node tools/dsh-fake-llm/selftest.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_WINDOW = 262144;

/** Занять свободный порт и освободить его для дочернего процесса. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Дождаться готовности сервера (poll /health).
 *
 * @param {string} base
 * @param {number} [timeoutMs]
 */
async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy in ${timeoutMs}ms: ${lastError}`);
}

/**
 * POST /v1/messages со stream:true, полный SSE-текст -> список событий.
 *
 * @param {string} base
 * @param {object} body
 * @returns {Promise<{status: number, events: Array<{event: string, data: object}>}>}
 */
async function postStream(base, body) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const raw = await res.text();
  const events = [];
  for (const rawEvent of raw.split('\n\n')) {
    let event = null;
    const dataLines = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (event && dataLines.length > 0) {
      events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return { status: res.status, events };
}

/** Собрать SSE-события по типу. */
const ofType = (events, name) => events.filter((e) => e.event === name);

/** Склеить текст text_delta-событий. */
const streamText = (events) =>
  ofType(events, 'content_block_delta')
    .filter((e) => e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');

/** Собрать блок tool_use из стрима (start + накопленный input_json_delta). */
function streamToolUse(events) {
  const start = ofType(events, 'content_block_start').find(
    (e) => e.data.content_block?.type === 'tool_use',
  );
  if (!start) return null;
  const json = ofType(events, 'content_block_delta')
    .filter((e) => e.data.delta?.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json)
    .join('');
  return { block: start.data.content_block, input: JSON.parse(json) };
}

/**
 * POST /v1/messages со stream:true, чтение SSE ИНКРЕМЕНТАЛЬНО с фиксацией
 * времени прибытия каждого события (Date.now на момент чтения) — для
 * проверки межчанковых таймингов реплея.
 *
 * @param {string} base
 * @param {object} body
 * @returns {Promise<{status: number, events: Array<{event: string, data: object, t: number}>}>}
 */
async function postStreamTimed(base, body) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const t = Date.now();
      let event = null;
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (event && dataLines.length > 0) {
        events.push({ event, data: JSON.parse(dataLines.join('\n')), t });
      }
    }
  }
  return { status: res.status, events };
}

/**
 * Мини-сессия session.jsonl в фактическом формате dsh: батчи *-chunks
 * (seq0/time0/dt/texts) вперемешку с raw assistant/chunk-дельтами,
 * tool-цикл с двумя шагами, ход с обрывом max-tokens и продолжением.
 * Тайминги чанков подобраны с гарантированным разбросом (dt 16-90 мс).
 *
 * @param {number} E - базовый epoch (мс)
 * @returns {object[]} строки session.jsonl
 */
function miniSession(E) {
  const lines = [
    { type: 'session', version: 0, id: 'aa11bb22-0000-4000-8000-000000000001', createdAt: E, cwd: '/tmp', delegationDepth: 0, agentPreset: 'standard' },
    { type: 'permission/preset', seq: 0, time: E + 10, data: { preset: 'workspace-write-noask' } },
    { type: 'sandbox/mode', seq: 1, time: E + 11, data: { mode: 'workspace-write' } },
    { type: 'turn/start', seq: 2, time: E + 100, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 3, time: E + 14, data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: 'привет, ответь по делу' }], source: { kind: 'user' }, role: 'user', id: 'u1' }] } },
    { type: 'step/start', seq: 4, time: E + 101, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 7, time: E + 102, data: { content: [{ type: 'text', text: 'привет, ответь по делу' }], source: { kind: 'user' }, role: 'user', id: 'u1' }, surfaceOp: 'append' },
    { type: 'user/message', seq: 8, time: E + 103, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }], source: { kind: 'user' }, role: 'user', id: 'u2' }, surfaceOp: 'append' },
    { type: 'session/title-llm-request', seq: 12, time: E + 120, data: { titleProvider: 'session-title-first-prompt-llm', messageSeqs: [7], route: { provider: 'fake', model: 'fake-sonnet' }, system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.' } },
    // ход 1: reasoning-блок (батч) + text-блок (батч + raw-хвост)
    { type: 'assistant/chunk', seq: 13, time: E + 150, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } },
    { type: 'reasoning-chunks', seq0: 14, time0: E + 160, data: { turn: 1, step: 1, index: 0, dt: [30, 26, 34], texts: ['Дум', 'аю: ', 'всё ', 'ясно'] } },
    { type: 'assistant/chunk', seq: 18, time: E + 260, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Думаю: всё ясно' } } } },
    { type: 'assistant/chunk', seq: 19, time: E + 262, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'text' } } },
    { type: 'text-chunks', seq0: 20, time0: E + 270, data: { turn: 1, step: 1, index: 1, dt: [20, 40, 90], texts: ['Отв', 'ет г', 'отов', ' част'] } },
    { type: 'assistant/chunk', seq: 24, time: E + 450, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'ично.' } } },
    { type: 'assistant/chunk', seq: 25, time: E + 460, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'Ответ готов частично.' } } } },
    { type: 'assistant/chunk', seq: 26, time: E + 465, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 50 } } } },
    { type: 'assistant/chunk', seq: 27, time: E + 470, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { stopReason: 'stop' } } } } },
    { type: 'step/end', seq: 28, time: E + 472, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 29, time: E + 475, data: { turn: 1, reason: { kind: 'completed' } } },
    // ход 2: tool-цикл — шаг 1 (текст + tool-call), шаг 2 (финальный текст)
    { type: 'turn/start', seq: 30, time: E + 600, data: { turn: 2 } },
    { type: 'step/start', seq: 32, time: E + 601, data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: 33, time: E + 602, data: { content: [{ type: 'text', text: 'запусти тулзу и подведи итог' }], source: { kind: 'user' }, role: 'user', id: 'u3' }, surfaceOp: 'append' },
    { type: 'assistant/chunk', seq: 34, time: E + 650, data: { turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'text-chunks', seq0: 35, time0: E + 660, data: { turn: 2, step: 1, index: 0, dt: [16, 16], texts: ['Запус', 'каю.'] } },
    { type: 'assistant/chunk', seq: 37, time: E + 690, data: { turn: 2, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Запускаю.' } } } },
    { type: 'assistant/chunk', seq: 38, time: E + 700, data: { turn: 2, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } } },
    { type: 'tool-call-chunks', seq0: 39, time0: E + 710, data: { turn: 2, step: 1, index: 1, dt: [10, 12], id: 'toolu_MINI00000000000000001', name: 'Bash', args: ['{"com', 'mand":"', 'ls"}'] } },
    { type: 'assistant/chunk', seq: 42, time: E + 760, data: { turn: 2, step: 1, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu_MINI00000000000000001', name: 'Bash', arguments: '{"command":"ls"}' } } } },
    { type: 'assistant/chunk', seq: 43, time: E + 765, data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1300, outputTokens: 80, cacheReadTokens: 100, cacheWriteTokens: 50 } } } },
    { type: 'assistant/chunk', seq: 44, time: E + 770, data: { turn: 2, step: 1, chunk: { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { stopReason: 'toolUse' } } } } },
    { type: 'step/end', seq: 45, time: E + 772, data: { turn: 2, step: 1 } },
    { type: 'tool/result', seq: 46, time: E + 900, data: { turn: 2, step: 1, message: { source: { kind: 'tool', callId: 'toolu_MINI00000000000000001' }, content: [{ type: 'tool-result', toolCallId: 'toolu_MINI00000000000000001', content: [{ type: 'text', text: 'ok' }] }] } } },
    { type: 'step/start', seq: 47, time: E + 950, data: { turn: 2, step: 2 } },
    { type: 'assistant/chunk', seq: 48, time: E + 1000, data: { turn: 2, step: 2, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'text-chunks', seq0: 49, time0: E + 1010, data: { turn: 2, step: 2, index: 0, dt: [20, 20], texts: ['Итог:', ' готово'] } },
    { type: 'assistant/chunk', seq: 51, time: E + 1060, data: { turn: 2, step: 2, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Итог: готово' } } } },
    { type: 'assistant/chunk', seq: 52, time: E + 1065, data: { turn: 2, step: 2, chunk: { type: 'usage', usage: { inputTokens: 2100, outputTokens: 40 } } } },
    { type: 'assistant/chunk', seq: 53, time: E + 1070, data: { turn: 2, step: 2, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { stopReason: 'stop' } } } } },
    { type: 'step/end', seq: 54, time: E + 1072, data: { turn: 2, step: 2 } },
    { type: 'turn/end', seq: 55, time: E + 1075, data: { turn: 2, reason: { kind: 'completed' } } },
    // ход 3: обрыв max-tokens (CUT) + продолжение (TAIL)
    { type: 'turn/start', seq: 56, time: E + 2000, data: { turn: 3 } },
    { type: 'step/start', seq: 58, time: E + 2001, data: { turn: 3, step: 1 } },
    { type: 'user/message', seq: 59, time: E + 2002, data: { content: [{ type: 'text', text: 'проверь продолжение после лимита' }], source: { kind: 'user' }, role: 'user', id: 'u4' }, surfaceOp: 'append' },
    { type: 'assistant/chunk', seq: 60, time: E + 2050, data: { turn: 3, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'text-chunks', seq0: 61, time0: E + 2060, data: { turn: 3, step: 1, index: 0, dt: [20, 30, 30], texts: ['ОБРЫ', 'В_ПО_', 'ЛИМИ', 'ТУ.'] } },
    { type: 'assistant/chunk', seq: 65, time: E + 2170, data: { turn: 3, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'ОБРЫВ_ПО_ЛИМИТУ.' } } } },
    { type: 'assistant/chunk', seq: 66, time: E + 2175, data: { turn: 3, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1500, outputTokens: 60 } } } },
    { type: 'assistant/chunk', seq: 67, time: E + 2180, data: { turn: 3, step: 1, chunk: { type: 'finish', reason: { kind: 'max-tokens' }, replayState: { response: { stopReason: 'length' } } } } },
    { type: 'step/end', seq: 68, time: E + 2182, data: { turn: 3, step: 1 } },
    { type: 'agent/max-tokens-continue', seq: 69, time: E + 2190, data: { turn: 3, step: 1, attempt: 1 } },
    { type: 'step/start', seq: 70, time: E + 2200, data: { turn: 3, step: 2 } },
    { type: 'assistant/chunk', seq: 71, time: E + 2210, data: { turn: 3, step: 2, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'text-chunks', seq0: 72, time0: E + 2220, data: { turn: 3, step: 2, index: 0, dt: [16, 16, 16], texts: ['ХВОС', 'Т_до', 'ехал', '.'] } },
    { type: 'assistant/chunk', seq: 76, time: E + 2290, data: { turn: 3, step: 2, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'ХВОСТ_доехал.' } } } },
    { type: 'assistant/chunk', seq: 77, time: E + 2295, data: { turn: 3, step: 2, chunk: { type: 'usage', usage: { inputTokens: 1600, outputTokens: 30 } } } },
    { type: 'assistant/chunk', seq: 78, time: E + 2300, data: { turn: 3, step: 2, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { stopReason: 'stop' } } } } },
    { type: 'step/end', seq: 79, time: E + 2302, data: { turn: 3, step: 2 } },
    { type: 'turn/end', seq: 80, time: E + 2305, data: { turn: 3, reason: { kind: 'completed' } } },
  ];
  return lines;
}

/** Одна строка сообщения пользователя. */
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Проверки (a)..(е); каждая независима и падает своим сообщением. */
const tests = [
  {
    name: '(a) non-stream: валидный anthropic-messages JSON с usage',
    async run(base) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-sonnet',
          max_tokens: 1024,
          messages: [userMsg('Привет, кто ты?')],
        }),
      });
      assert(res.status === 200, `status ${res.status}`);
      const j = await res.json();
      assert(j.type === 'message', `type=${j.type}`);
      assert(j.role === 'assistant', `role=${j.role}`);
      assert(j.stop_reason === 'end_turn', `stop_reason=${j.stop_reason}`);
      assert(j.id?.startsWith('msg_'), `id=${j.id}`);
      assert(Array.isArray(j.content) && j.content.length > 0, 'content empty');
      assert(
        j.content.some((b) => b.type === 'text' && b.text.length > 0),
        'no non-empty text block',
      );
      assert(j.usage.input_tokens > 0, `input_tokens=${j.usage.input_tokens}`);
      assert(j.usage.output_tokens > 0, `output_tokens=${j.usage.output_tokens}`);
      for (const field of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
        assert(Number.isFinite(j.usage[field]), `usage.${field} missing`);
      }
      return `usage in=${j.usage.input_tokens} out=${j.usage.output_tokens}`;
    },
  },
  {
    name: '(б) stream: корректная последовательность SSE-событий + message_stop',
    async run(base) {
      const { status, events } = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 1024,
        messages: [userMsg('SCENARIO:short привет')],
      });
      assert(status === 200, `status ${status}`);
      assert(events.length > 0, 'no events parsed');
      const names = events.map((e) => e.event);
      assert(names[0] === 'message_start', `first=${names[0]}`);
      assert(names[names.length - 1] === 'message_stop', `last=${names[names.length - 1]}`);
      const start = events[0].data.message;
      assert(start.usage.input_tokens > 0, 'message_start usage.input_tokens = 0');
      assert(start.role === 'assistant', `role=${start.role}`);
      assert(
        ofType(events, 'content_block_start').some(
          (e) => e.data.content_block?.type === 'thinking',
        ),
        'no thinking block (short scenario must carry one)',
      );
      const textStarts = ofType(events, 'content_block_start').filter(
        (e) => e.data.content_block?.type === 'text',
      );
      assert(textStarts.length === 1, `text blocks=${textStarts.length}`);
      const deltas = ofType(events, 'content_block_delta').filter(
        (e) => e.data.delta?.type === 'text_delta',
      );
      assert(deltas.length > 0, 'no text_delta events');
      assert(streamText(events).length > 0, 'empty streamed text');
      assert(
        ofType(events, 'content_block_stop').length >= textStarts.length,
        'content_block_stop count mismatch',
      );
      const md = ofType(events, 'message_delta').at(-1);
      assert(md?.data.delta?.stop_reason === 'end_turn', 'no end_turn in message_delta');
      assert(md?.data.usage?.output_tokens > 0, 'final usage.output_tokens = 0');
      // Порядок: старт блока до дельт, message_delta/message_stop после блоков.
      const idx = (name) => names.indexOf(name);
      assert(idx('content_block_start') < idx('content_block_delta'), 'block start after delta');
      assert(idx('content_block_stop') < idx('message_delta'), 'block stop after message_delta');
      assert(idx('message_delta') < names.lastIndexOf('message_stop'), 'message_delta after stop');
      return `${events.length} events, text ${streamText(events).length} chars`;
    },
  },
  {
    name: '(в) tools: цикл 3 tool_use (Bash->Read->Write) с валидным input-JSON',
    async run(base) {
      const history = [userMsg('SCENARIO:tools запусти цикл инструментов')];
      const toolNames = [];
      const toolInputs = [];
      let finalText = '';
      for (let step = 0; step < 4; step++) {
        const { events } = await postStream(base, {
          model: 'fake-sonnet',
          max_tokens: 2048,
          messages: [...history],
        });
        const md = ofType(events, 'message_delta').at(-1);
        const tool = streamToolUse(events);
        if (tool) {
          assert(md?.data.delta?.stop_reason === 'tool_use', 'tool step without stop_reason=tool_use');
          toolNames.push(tool.block.name);
          toolInputs.push(tool.input);
          history.push({
            role: 'assistant',
            content: [
              { type: 'tool_use', id: tool.block.id, name: tool.block.name, input: tool.input },
            ],
          });
          history.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: tool.block.id, content: 'ok' }],
          });
        } else {
          assert(md?.data.delta?.stop_reason === 'end_turn', 'final step is not end_turn');
          finalText = streamText(events);
          assert(finalText.length > 0, 'empty final text');
        }
      }
      assert(
        JSON.stringify(toolNames) === JSON.stringify(['Bash', 'Read', 'Write']),
        `tool sequence: ${toolNames.join(',')}`,
      );
      assert(typeof toolInputs[0].command === 'string', 'Bash input has no command');
      assert(typeof toolInputs[1].file_path === 'string', 'Read input has no file_path');
      assert(
        typeof toolInputs[2].file_path === 'string' && typeof toolInputs[2].content === 'string',
        'Write input has no file_path/content',
      );
      return `Bash->Read->Write + final text ${finalText.length} chars`;
    },
  },
  {
    name: '(г) health: {"ok":true,...}',
    async run(base) {
      const res = await fetch(`${base}/health`);
      assert(res.status === 200, `status ${res.status}`);
      const j = await res.json();
      assert(j.ok === true, `ok=${j.ok}`);
      assert(Number.isFinite(j.uptime_s) && j.uptime_s >= 0, `uptime_s=${j.uptime_s}`);
      return `uptime_s=${j.uptime_s}`;
    },
  },
  {
    name: '(д) ctx90: usage заполняет ~90% окна 262144',
    async run(base) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-sonnet',
          max_tokens: 4096,
          messages: [userMsg('SCENARIO:ctx90 проверь контекст')],
        }),
      });
      const j = await res.json();
      const inputTotal =
        j.usage.input_tokens +
        j.usage.cache_read_input_tokens +
        j.usage.cache_creation_input_tokens;
      const ratio = inputTotal / CONTEXT_WINDOW;
      assert(ratio > 0.85 && ratio < 0.95, `ctx ratio ${ratio.toFixed(3)}`);
      return `input ${inputTotal} / ${CONTEXT_WINDOW} = ${(ratio * 100).toFixed(1)}%`;
    },
  },
  {
    name: '(е) long: стрим длится >= STREAM_TOTAL_MS и циклит пул текста',
    async run(base) {
      const t0 = Date.now();
      const { events } = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 65536,
        messages: [userMsg('SCENARIO:long длинная генерация')],
      });
      const durationMs = Date.now() - t0;
      const text = streamText(events);
      assert(durationMs >= 1200, `duration ${durationMs}ms < 1200ms`);
      assert(text.length > 5000, `cycled text only ${text.length} chars`);
      assert(
        events.at(-1)?.event === 'message_stop',
        `last event ${events.at(-1)?.event}`,
      );
      return `${durationMs}ms, ${text.length} chars`;
    },
  },
  {
    name: '(ж) waves: tool_use subagent с валидным input; follow-up без маркера -> short',
    async run(base) {
      // Шаг 1: родительский запрос с маркером waves -> thinking+text, затем
      // tool_use name="subagent" (stop_reason tool_use).
      const history = [userMsg('SCENARIO:waves запусти волну субагентов')];
      const first = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 4096,
        messages: [...history],
      });
      const tool = streamToolUse(first.events);
      assert(tool !== null, 'первый ответ waves не содержит tool_use');
      assert(tool.block.name === 'subagent', `tool name=${tool.block.name}, expected subagent`);
      assert(
        typeof tool.input.description === 'string' && tool.input.description.length > 0,
        'subagent input.description отсутствует/пуст',
      );
      assert(
        typeof tool.input.prompt === 'string' && tool.input.prompt.length > 0,
        'subagent input.prompt отсутствует/пуст',
      );
      assert(
        tool.input.run_in_background === false,
        `run_in_background=${tool.input.run_in_background}, expected false`,
      );
      const md = ofType(first.events, 'message_delta').at(-1);
      assert(md?.data.delta?.stop_reason === 'tool_use', 'waves должен останавливаться на tool_use');
      assert(streamText(first.events).length > 0, 'нет плана волн до tool_use');

      // Шаг 2: tool_result -> сценарий продолжает хвостовым текстом.
      history.push({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool.block.id, name: tool.block.name, input: tool.input },
        ],
      });
      history.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: tool.block.id, content: 'ок' }],
      });
      const second = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 4096,
        messages: [...history],
      });
      const md2 = ofType(second.events, 'message_delta').at(-1);
      assert(md2?.data.delta?.stop_reason === 'end_turn', 'continuation waves должен закончиться end_turn');
      const finalText = streamText(second.events);
      assert(finalText.length > 0, 'пустой финальный текст после tool_result');

      // Шаг 3: model-call самого субагента — его промпт БЕЗ маркера SCENARIO:
      // (другая сессия, другой якорь) -> сервер обязан отдать дефолтный short.
      const noMarker = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 1024,
        messages: [userMsg('Собери 3 факта о тестовой задаче и верни списком.')],
      });
      const nmText = streamText(noMarker.events);
      assert(
        nmText.includes('фиктивная локальная модель'),
        'запрос без маркера не получил дефолтный short',
      );
      return `subagent input ok, final text ${finalText.length} chars, субагент -> short`;
    },
  },
  {
    name: '(з) subagents: две волны tool_use subagent, финал end_turn',
    async run(base) {
      const history = [userMsg('SCENARIO:subagents запусти две волны субагентов')];
      const spawned = [];
      // Две волны: волна1 (tool_use) -> continuation -> волна2 (tool_use)
      // -> continuation -> финальный текст. Максимум 4 запроса.
      for (let step = 0; step < 4; step++) {
        const { events } = await postStream(base, {
          model: 'fake-sonnet',
          max_tokens: 4096,
          messages: [...history],
        });
        const md = ofType(events, 'message_delta').at(-1);
        const tool = streamToolUse(events);
        if (tool) {
          assert(md?.data.delta?.stop_reason === 'tool_use', 'волна без stop_reason=tool_use');
          assert(tool.block.name === 'subagent', `tool name=${tool.block.name}`);
          assert(
            typeof tool.input.description === 'string' && tool.input.description.length > 0,
            'subagent input.description отсутствует/пуст',
          );
          assert(
            tool.input.run_in_background === false,
            `run_in_background=${tool.input.run_in_background}`,
          );
          spawned.push(tool.input.description);
          history.push({
            role: 'assistant',
            content: [
              { type: 'tool_use', id: tool.block.id, name: tool.block.name, input: tool.input },
            ],
          });
          history.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: tool.block.id, content: 'ок' }],
          });
        } else {
          assert(md?.data.delta?.stop_reason === 'end_turn', 'финал не end_turn');
          const finalText = streamText(events);
          assert(finalText.length > 0, 'пустой финальный текст');
          assert(spawned.length === 2, `волн ${spawned.length}, ожидается 2`);
          return `волны: ${spawned.join(' / ')}, финал ${finalText.length} chars`;
        }
      }
      throw new Error('сценарий не завершился за 4 запроса (две волны + финал)');
    },
  },
  {
    name: '(и) usage: точные usage-числа сценария + tps в тексте',
    async run(base) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-sonnet',
          max_tokens: 4096,
          messages: [userMsg('SCENARIO:usage покажи usage')],
        }),
      });
      assert(res.status === 200, `status ${res.status}`);
      const j = await res.json();
      assert(j.usage.input_tokens === 42000, `input_tokens=${j.usage.input_tokens}`);
      assert(j.usage.output_tokens === 3800, `output_tokens=${j.usage.output_tokens}`);
      assert(j.usage.cache_read_input_tokens === 48000, `cache_read=${j.usage.cache_read_input_tokens}`);
      assert(j.usage.cache_creation_input_tokens === 2200, `cache_creation=${j.usage.cache_creation_input_tokens}`);
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      assert(/tps:\s+47\.2/.test(text), 'в тексте нет tps: 47.2');
      assert(/92200/.test(text), 'в тексте нет итога 92200');
      return `in=42000 out=3800 cache=48000/2200, tps в тексте ok`;
    },
  },
  {
    name: '(к) thinking: delayMs до первого события + длительный thinking-блок',
    async run(base) {
      const t0 = Date.now();
      const { events } = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 4096,
        messages: [userMsg('SCENARIO:thinking подумай основательно')],
      });
      const durationMs = Date.now() - t0;
      // delayMs=3000: до первого события пауза; repeatMs=6000: thinking стримится.
      assert(durationMs >= 8_000, `duration ${durationMs}ms < 8000ms (delay+thinking)`);
      assert(events[0]?.event === 'message_start', `first=${events[0]?.event}`);
      const thinkingStarts = ofType(events, 'content_block_start').filter(
        (e) => e.data.content_block?.type === 'thinking',
      );
      assert(thinkingStarts.length === 1, `thinking blocks=${thinkingStarts.length}`);
      const thinkingDeltas = ofType(events, 'content_block_delta').filter(
        (e) => e.data.delta?.type === 'thinking_delta',
      );
      assert(thinkingDeltas.length > 10, `thinking deltas=${thinkingDeltas.length}`);
      const thinkingText = thinkingDeltas.map((e) => e.data.delta.thinking).join('');
      // Циклический повтор кусков: текст длиннее пула сценария.
      assert(thinkingText.length > 200, `thinking text ${thinkingText.length} chars`);
      assert(
        ofType(events, 'content_block_delta').some((e) => e.data.delta?.type === 'signature_delta'),
        'нет signature_delta у thinking-блока',
      );
      assert(streamText(events).length > 0, 'нет текста после thinking');
      return `${durationMs}ms, thinking ${thinkingText.length} chars, дельт ${thinkingDeltas.length}`;
    },
  },
  {
    name: '(л) compact: delayMs + repeatMs COMPACT_TOTAL_MS покрывают окно',
    async run(base) {
      const t0 = Date.now();
      const { events } = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 8192,
        messages: [userMsg('SCENARIO:compact своди разговор')],
      });
      const durationMs = Date.now() - t0;
      // delayMs=4000 + COMPACT_TOTAL_MS=1200 (env selftest) -> ~5.2s.
      assert(durationMs >= 4_500, `duration ${durationMs}ms < 4500ms (delay не отработал)`);
      assert(events.at(-1)?.event === 'message_stop', `last event ${events.at(-1)?.event}`);
      const md = ofType(events, 'message_delta').at(-1);
      assert(md?.data.delta?.stop_reason === 'end_turn', 'compact должен завершаться end_turn');
      const text = streamText(events);
      assert(/Сводка диалога/.test(text), 'текст не похож на сводку компакции');
      // Повтор кусков: текст длиннее однократного прогона сценария.
      assert(text.length > 600, `cycled text only ${text.length} chars`);
      return `${durationMs}ms, ${text.length} chars`;
    },
  },
  {
    name: '(м) post-compact: маркер сквозь runtime-context-снимок, CUT+TAIL',
    async run(base) {
      // Реплицирует хвост реального запроса dsh ПОСЛЕ /compact (w4green3):
      // компакт-суммари, интент юзера, свежий runtime-context-снимок. Снимок
      // инжектится ПОСЛЕ интента, но юзерским вводом не является — маркер
      // SCENARIO:maxtokens обязан детектиться (иначе сценарий = short).
      const history = [
        userMsg(
          'This is an automatically generated checkpoint condensing an earlier ' +
            'span of the conversation (SCENARIO:usage покажи usage) to free up context.',
        ),
        userMsg('SCENARIO:maxtokens проверь продолжение после лимита токенов'),
        userMsg(
          'Current runtime context. This snapshot supersedes earlier runtime-context ' +
            'snapshots.\n\nCurrent DSH file policy: workspace-write.',
        ),
      ];
      const first = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 4096,
        messages: [...history],
      });
      const md1 = ofType(first.events, 'message_delta').at(-1);
      assert(
        md1?.data.delta?.stop_reason === 'max_tokens',
        `stop_reason=${md1?.data.delta?.stop_reason}, expected max_tokens (CUT)`,
      );
      assert(
        streamText(first.events).includes('MAXTOKENS_CUT'),
        'первый ответ не содержит MAXTOKENS_CUT (маркер потерян -> short?)',
      );

      // Авто-continue core-патча 07: синтетический "continue" без маркера
      // (снимок опять в хвосте) — сервер продолжает сценарий по state.
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: streamText(first.events) }],
      });
      history.push(userMsg('continue'));
      history.push(
        userMsg(
          'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
        ),
      );
      const second = await postStream(base, {
        model: 'fake-sonnet',
        max_tokens: 4096,
        messages: [...history],
      });
      const md2 = ofType(second.events, 'message_delta').at(-1);
      assert(
        md2?.data.delta?.stop_reason === 'end_turn',
        `tail stop_reason=${md2?.data.delta?.stop_reason}, expected end_turn`,
      );
      assert(
        streamText(second.events).includes('MAXTOKENS_TAIL'),
        'хвост не содержит MAXTOKENS_TAIL (resume по state не сработал)',
      );
      return 'CUT (max_tokens) + TAIL (end_turn) сквозь runtime-context';
    },
  },
  {
    name: '(н) replay: конвертер session.jsonl → сценарий → тайминги/контент/stop_reason',
    async run(base) {
      const workDir = mkdtempSync(path.join(tmpdir(), 'dsh-fake-llm-replay-'));
      let child = null;
      let nestedStderr = '';
      try {
        // 1. Мини-сессия в фактическом формате session.jsonl (тайминги с разбросом).
        const E = 1790000000000;
        const sessionPath = path.join(workDir, 'mini-session.jsonl');
        writeFileSync(sessionPath, `${miniSession(E).map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

        // 2. Конвертер: --speed 0.5 (паузы пополам) + --max-delay 40 (кламп 90*0.5=45).
        const outPath = path.join(workDir, 'minireplay.json');
        const conv = spawnSync(process.execPath, [
          path.join(HERE, 'session-to-replay.mjs'),
          sessionPath,
          '--name', 'minireplay',
          '--speed', '0.5',
          '--max-delay', '40',
          '--out', outPath,
        ], { encoding: 'utf8' });
        assert(conv.status === 0, `конвертер exit=${conv.status}: ${conv.stderr || conv.stdout}`);
        const scenario = JSON.parse(readFileSync(outPath, 'utf8'));

        // 3. Контракт сценария: ходы, чанки {text, afterMs}, задержки = time-дельты * speed (кламп).
        assert(scenario.name === 'minireplay', `name=${scenario.name}`);
        assert(scenario.replay?.kind === 'session-replay', 'нет replay.kind=session-replay');
        assert(scenario.replay.turns.length === 3, `ходов ${scenario.replay.turns.length}`);
        const t1 = scenario.replay.turns[0];
        assert(t1.userText === 'привет, ответь по делу', `userText=${t1.userText}`);
        assert(t1.delayMs === 30, `delayMs=${t1.delayMs}, ожидание 30 (59*0.5: step/start E+101 → первый reasoning-чанк E+160)`);
        assert(
          t1.segments[0].thinking.map((c) => c.text).join('') === 'Думаю: всё ясно',
          'thinking-конкатенация != тексту хода',
        );
        assert(
          JSON.stringify(t1.segments[0].thinking.map((c) => c.afterMs)) === JSON.stringify([15, 13, 17, 10]),
          `thinking afterMs=${JSON.stringify(t1.segments[0].thinking.map((c) => c.afterMs))}`,
        );
        assert(
          t1.segments[1].text.map((c) => c.text).join('') === 'Ответ готов частично.',
          'text-конкатенация != тексту хода',
        );
        assert(
          JSON.stringify(t1.segments[1].text.map((c) => c.afterMs)) === JSON.stringify([10, 20, 40, 15, 5]),
          `text afterMs=${JSON.stringify(t1.segments[1].text.map((c) => c.afterMs))} (90*0.5=45 -> кламп 40)`,
        );
        const t2 = scenario.replay.turns[1];
        const tu = t2.segments[1].tool_use;
        assert(tu.name === 'Bash' && tu.input.command === 'ls', 'ход 2: tool_use не восстановлен из блоков');
        assert(tu.id === 'toolu_MINI00000000000000001', `tool id=${tu.id} (id тулзы должен реплеиться)`);
        assert(
          JSON.stringify(tu.jsonPieces) === JSON.stringify(['{"com', 'mand":"', 'ls"}']),
          'ход 2: jsonPieces != записанным аргументам',
        );
        assert(
          JSON.stringify(tu.afterMs) === JSON.stringify([5, 6, 14]),
          `tool afterMs=${JSON.stringify(tu.afterMs)}`,
        );
        const t3 = scenario.replay.turns[2];
        assert(t3.segments.length === 2, `ход 3 сегментов ${t3.segments.length}, ожидание 2 (CUT+TAIL)`);
        assert(t3.segments[0].stopReason === 'max_tokens', 'ход 3: CUT-сегмент без stopReason max_tokens');

        // 4. Вложенный сервер: short (обязательный фоллбек) + minireplay.
        const scenariosDir = path.join(workDir, 'scenarios');
        mkdirSync(scenariosDir);
        copyFileSync(path.join(HERE, 'scenarios', 'short.json'), path.join(scenariosDir, 'short.json'));
        copyFileSync(outPath, path.join(scenariosDir, 'minireplay.json'));
        const port2 = await freePort();
        const base2 = `http://127.0.0.1:${port2}`;
        child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
          cwd: HERE,
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port2),
            DELTA_MS: '1',
            CHUNK_CHARS: '64',
            SCENARIOS_DIR: scenariosDir,
            LOG_DIR: workDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stderr.on('data', (chunk) => {
          nestedStderr += chunk.toString();
        });
        try {
          await waitForHealth(base2);
        } catch (err) {
          throw new Error(`вложенный сервер не поднялся: ${err.message}\n${nestedStderr.slice(-2000)}`);
        }

        // 5. Ход 1 (N-е маркерное сообщение -> N-й ход): контент + тайминги дельт.
        const history = [userMsg('SCENARIO:minireplay привет, ответь по делу')];
        const r1 = await postStreamTimed(base2, { model: 'fake-sonnet', max_tokens: 4096, messages: [...history] });
        const md1 = ofType(r1.events, 'message_delta').at(-1);
        assert(md1?.data.delta?.stop_reason === 'end_turn', `ход 1 stop_reason=${md1?.data.delta?.stop_reason}`);
        assert(md1?.data.usage?.input_tokens === 900, `ход 1 usage.input=${md1?.data.usage?.input_tokens}, ожидание 900 (запись хода)`);
        assert(streamText(r1.events) === 'Ответ готов частично.', 'ход 1: текст реплея != исходному');
        const thinkDeltas = r1.events.filter(
          (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta',
        );
        assert(thinkDeltas.map((e) => e.data.delta.thinking).join('') === 'Думаю: всё ясно', 'ход 1: thinking != исходному');
        const textDeltas = r1.events.filter(
          (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta',
        );
        const expText = [10, 20, 40, 15];
        const gaps = [];
        for (let i = 1; i < textDeltas.length; i++) gaps.push(textDeltas[i].t - textDeltas[i - 1].t);
        assert(gaps.length === expText.length, `ход 1: text-дельт ${textDeltas.length}, интервалов ${gaps.length}`);
        for (const [i, g] of gaps.entries()) {
          assert(g >= expText[i] - 6 && g <= expText[i] + 45, `text gap[${i}]=${g}мс, ожидание ${expText[i]}мс`);
        }
        const expThink = [15, 13, 17, 10];
        const thinkGaps = [];
        for (let i = 1; i < thinkDeltas.length; i++) thinkGaps.push(thinkDeltas[i].t - thinkDeltas[i - 1].t);
        for (const [i, g] of thinkGaps.entries()) {
          assert(g >= expThink[i] - 6 && g <= expThink[i] + 45, `thinking gap[${i}]=${g}мс, ожидание ${expThink[i]}мс`);
        }

        // 6. Ход 2: маркер -> tool_use (id/input реплеятся); tool_result -> финальный текст.
        history.push({ role: 'assistant', content: [{ type: 'text', text: 'Ответ готов частично.' }] });
        history.push(userMsg('SCENARIO:minireplay запусти тулзу и подведи итог'));
        const r2 = await postStreamTimed(base2, { model: 'fake-sonnet', max_tokens: 4096, messages: [...history] });
        const md2 = ofType(r2.events, 'message_delta').at(-1);
        assert(md2?.data.delta?.stop_reason === 'tool_use', `ход 2 stop_reason=${md2?.data.delta?.stop_reason}`);
        assert(streamText(r2.events) === 'Запускаю.', 'ход 2: текст до tool_use != исходному');
        const tool = streamToolUse(r2.events);
        assert(tool !== null, 'ход 2: нет tool_use в стриме');
        assert(tool.block.name === 'Bash', `tool name=${tool.block.name}`);
        assert(tool.input.command === 'ls', `tool input=${JSON.stringify(tool.input)}`);
        assert(tool.block.id === 'toolu_MINI00000000000000001', `tool id=${tool.block.id} не реплеится`);
        history.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: tool.block.id, name: tool.block.name, input: tool.input }],
        });
        history.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tool.block.id, content: 'ok' }],
        });
        const r3 = await postStreamTimed(base2, { model: 'fake-sonnet', max_tokens: 4096, messages: [...history] });
        const md3 = ofType(r3.events, 'message_delta').at(-1);
        assert(md3?.data.delta?.stop_reason === 'end_turn', `continuation stop_reason=${md3?.data.delta?.stop_reason}`);
        assert(streamText(r3.events) === 'Итог: готово', 'ход 2: финальный текст != исходному');

        // 7. Ход 3: маркер -> CUT (stop_reason max_tokens); "continue" -> TAIL end_turn.
        history.push({ role: 'assistant', content: [{ type: 'text', text: 'Итог: готово' }] });
        history.push(userMsg('SCENARIO:minireplay проверь продолжение после лимита'));
        const r4 = await postStreamTimed(base2, { model: 'fake-sonnet', max_tokens: 4096, messages: [...history] });
        const md4 = ofType(r4.events, 'message_delta').at(-1);
        assert(md4?.data.delta?.stop_reason === 'max_tokens', `ход 3 CUT stop_reason=${md4?.data.delta?.stop_reason}`);
        assert(streamText(r4.events) === 'ОБРЫВ_ПО_ЛИМИТУ.', 'ход 3: CUT-текст != исходному');
        history.push({ role: 'assistant', content: [{ type: 'text', text: 'ОБРЫВ_ПО_ЛИМИТУ.' }] });
        history.push(userMsg('continue'));
        const r5 = await postStreamTimed(base2, { model: 'fake-sonnet', max_tokens: 4096, messages: [...history] });
        const md5 = ofType(r5.events, 'message_delta').at(-1);
        assert(md5?.data.delta?.stop_reason === 'end_turn', `ход 3 TAIL stop_reason=${md5?.data.delta?.stop_reason}`);
        assert(streamText(r5.events) === 'ХВОСТ_доехал.', 'ход 3: TAIL не доигран (resume по state не сработал)');

        return `text gaps [${gaps.join(',')}] ~ [${expText.join(',')}], tool id реплей, CUT max_tokens + TAIL end_turn`;
      } finally {
        if (child) {
          child.kill('SIGTERM');
          await new Promise((resolve) => {
            child.on('exit', resolve);
            setTimeout(resolve, 2000);
          });
        }
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '(о) glyphs: box-drawing, braille, powerline, fullwidth глифы в ответе',
    async run(base) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-sonnet',
          max_tokens: 4096,
          messages: [userMsg('SCENARIO:glyphs проверь глифы')],
        }),
      });
      assert(res.status === 200, `status ${res.status}`);
      const j = await res.json();
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      // Box-drawing
      assert(text.includes('│'), 'нет box-drawing │');
      assert(text.includes('┌'), 'нет box-drawing ┌');
      assert(text.includes('└'), 'нет box-drawing └');
      assert(text.includes('├'), 'нет box-drawing ├');
      assert(text.includes('┼'), 'нет box-drawing ┼');
      // Braille
      assert(text.includes('⠁'), 'нет braille ⠁');
      assert(text.includes('⠇'), 'нет braille ⠇');
      assert(text.includes('⣿'), 'нет braille ⣿');
      // Powerline U+E0B0
      assert(text.includes(''), 'нет powerline U+E0B0');
      // Fullwidth
      assert(text.includes('（）'), 'нет fullwidth （）');
      assert(text.includes('Ａ'), 'нет fullwidth Ａ');
      // Em dash + middot
      assert(text.includes('—'), 'нет em dash —');
      assert(text.includes('·'), 'нет middot ·');
      // Ambiguous-width
      assert(text.includes('±'), 'нет ±');
      assert(text.includes('°'), 'нет degree °');
      assert(text.includes('µ'), 'нет µ');
      // Thinking block present
      assert(
        (j.content || []).some((b) => b.type === 'thinking'),
        'нет thinking-блока',
      );
      return `box+braille+powerline+fullwidth+dash+middot+ambiguous ok (${text.length} chars)`;
    },
  },
];

/**
 * Точка входа: спавн сервера -> прогон проверок -> отчёт -> exit code.
 */
async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logDir = mkdtempSync(path.join(tmpdir(), 'dsh-fake-llm-selftest-'));
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    cwd: HERE,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DELTA_MS: '1',
      CHUNK_CHARS: '64',
      STREAM_TOTAL_MS: '1500',
      // Окно compact-сценария для selftest (на деплое не задан -> fallback
      // STREAM_TOTAL_MS=45000 — длинное окно для детектора C5).
      COMPACT_TOTAL_MS: '1200',
      LOG_DIR: logDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverStderr = '';
  child.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString();
  });
  let failed = 0;
  const details = [];
  try {
    const health = await waitForHealth(base);
    details.push(`server up: ${JSON.stringify(health)}`);
    for (const test of tests) {
      try {
        const info = await test.run(base);
        console.log(`PASSED  ${test.name}${info ? ` — ${info}` : ''}`);
      } catch (err) {
        failed++;
        console.log(`FAILED  ${test.name} — ${err.message}`);
      }
    }
  } catch (err) {
    failed = tests.length;
    console.log(`FAILED  server startup — ${err.message}`);
    if (serverStderr) console.log(`server stderr:\n${serverStderr.trim()}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 2000);
    });
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* временный каталог — не критично */
    }
  }
  console.log(`\nSELFTEST ${failed === 0 ? 'PASSED' : 'FAILED'}: ${tests.length - failed}/${tests.length}`);
  for (const line of details) console.log(line);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`selftest crashed: ${err.message}`);
  process.exit(1);
});
