#!/usr/bin/env node
/**
 * dsh-fake-llm — фиктивная локальная LLM для dsh (HTTP-сервер, ноль зависимостей).
 *
 * Говорит по протоколу anthropic-messages (POST /v1/messages): non-stream JSON
 * и SSE-стрим. dsh подключает его как обычный провайдер через
 * @deepseek-ai/dsh-llm-pi-ai (api: anthropic-messages, baseURL: http://127.0.0.1:8787),
 * и TUI полностью оживает — стрим, тулз-карты, tps, ctx-бар, comp-поле — без
 * траты реальных токенов.
 *
 * Ответы управляются сценариями (scenarios/*.json). Сценарий выбирается маркером
 * SCENARIO:<name> в тексте пользователя, ключевыми словами либо по умолчанию
 * 'short'. Состояние диалога хранится per-сессия (отпечаток первого сообщения);
 * после tool_use сервер ждёт tool_result в следующем запросе и продолжает
 * сценарий со следующего сегмента. После обрыва по stop_reason max_tokens
 * (эмуляция лимита токенов) следующий запрос БЕЗ явного маркера продолжает
 * сценарий со следующего сегмента (синтетическое "continue" от core-патча 07
 * auto-continue доигрывает хвост).
 *
 * Запуск: node tools/dsh-fake-llm/server.mjs  (env: PORT, HOST, DELTA_MS,
 * CHUNK_CHARS, STREAM_TOTAL_MS, FAKE_USAGE_SCALE, HEARTBEAT_MS, LOG_DIR, ...)
 */
import http from 'node:http';
import { loadConfig } from './lib/config.mjs';
import { loadScenarios, planResponse } from './lib/scenarios.mjs';
import {
  createSessionStore,
  detectScenario,
  hasToolResult,
  lastUserText,
  looksLikeTitleRequest,
  sessionKey,
  countToolResults,
} from './lib/session.mjs';
import { createJsonlLogger } from './lib/logger.mjs';
import {
  buildNonStreamMessage,
  computeUsage,
  planBlocks,
  writeSseStream,
} from './lib/protocol.mjs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Пауза (мс) — для delayMs сценария: окно «модель думает» до первого байта.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig();
const scenarios = loadScenarios(config.scenariosDir);
if (!scenarios.has('short')) {
  throw new Error("scenario 'short' is required as the default fallback (scenarios/short.json)");
}
const store = createSessionStore({ maxSessions: config.maxSessions, ttlMs: config.sessionTtlMs });
const log = createJsonlLogger(config.logDir);
const startedAt = Date.now();

/**
 * Прочитать тело запроса с ограничением размера.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 * @throws {Error & {statusCode?: number}}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Отправить JSON-ответ.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {string} [suffix=''] - дописывается после JSON (см. /health: '\n').
 */
function sendJson(res, status, body, suffix = '') {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body) + suffix);
}

/**
 * Отправить ошибку в формате anthropic-messages error.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string} message
 */
function sendError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

/**
 * Обработать POST /v1/messages: разбор запроса, выбор сценария, ответ.
 *
 * @param {object} body - распарсенный anthropic-messages запрос
 * @param {import('node:http').ServerResponse} res
 */
async function handleMessages(body, res) {
  const t0 = Date.now();
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    sendError(res, 400, 'invalid_request_error', 'field "messages" is required');
    return;
  }
  const model = typeof body.model === 'string' && body.model ? body.model : 'fake-model';
  const stream = body.stream === true;
  const availableTools = Array.isArray(body.tools)
    ? body.tools.map((t) => t?.name).filter((n) => typeof n === 'string' && n)
    : null;

  // Выбор сценария: title-запрос dsh, продолжение после tool_use,
  // продолжение после обрыва max_tokens, ход реплея по маркеру либо свежий
  // детект по тексту.
  const key = sessionKey(messages);
  const state = store.get(key);
  const last = messages[messages.length - 1];
  const isContinuation =
    hasToolResult(last) && state?.awaitingToolResult === true;
  const detected = detectScenario(lastUserText(messages));
  const stateScenario = state ? scenarios.get(state.scenarioName) : undefined;
  const replayActive =
    stateScenario?.replay?.kind === 'session-replay' && Number.isInteger(state.turnIndex);
  const resumeSegmentsLeft = replayActive
    ? stateScenario.replay.turns[Math.min(state.turnIndex, stateScenario.replay.turns.length - 1)]
        .segments.length
    : (stateScenario?.segments.length ?? 0);
  // Продолжение после max_tokens: предыдущий ответ оборван по лимиту токенов,
  // у сценария остались недоигранные сегменты, и запрос БЕЗ явного маркера
  // SCENARIO:<name> (явный маркер = осознанный запуск нового сценария) —
  // иначе detectScenario по тексту "continue" ушёл бы в 'short' и хвост
  // сценария никогда бы не доехал.
  const isMaxTokensResume =
    !isContinuation &&
    !detected.explicit &&
    state?.stopReason === 'max_tokens' &&
    typeof state.segIndex === 'number' &&
    state.segIndex < resumeSegmentsLeft;

  let scenario;
  let segIndex;
  let marker = false;
  let turnIndex; // определён только для replay-сценария
  let persistState = true;
  if (looksLikeTitleRequest(body)) {
    // Title-запрос dsh (session-title-first-prompt-llm): user-часть совпадает
    // с якорем реплей-сессии (маркер в ней есть!) — обслуживаем short без
    // записи состояния, иначе реплей-счётчик ходов съезжает.
    scenario = scenarios.get('short');
    segIndex = 0;
    persistState = false;
  } else if (isContinuation) {
    scenario = stateScenario ?? scenarios.get('short');
    segIndex = state.segIndex;
    if (replayActive) turnIndex = state.turnIndex;
  } else if (isMaxTokensResume) {
    scenario = stateScenario ?? scenarios.get('short');
    segIndex = state.segIndex;
    if (replayActive) turnIndex = state.turnIndex;
  } else {
    scenario = scenarios.get(detected.name) ?? scenarios.get('short');
    segIndex = 0;
    marker = detected.explicit;
    if (scenario.replay?.kind === 'session-replay') {
      // Реплей: N-е маркерное user-сообщение -> N-й записанный ход. Счётчик
      // ходов живёт в состоянии сессии; сообщения без маркера (title-вызовы,
      // runtime-снимки, "continue") его не двигают. За последним ходом —
      // fallback-текст (план от пустых сегментов).
      const prev =
        state?.scenarioName === scenario.name && Number.isInteger(state?.turnIndex)
          ? state.turnIndex
          : -1;
      turnIndex = Math.min(prev + 1, scenario.replay.turns.length);
    }
    // Побочный вызов без маркера в активной реплей-сессии: обслуживаем, но
    // состояние не трогаем — иначе реплей-сессия затирается.
    if (!marker && replayActive) persistState = false;
  }

  // Сценарий хода: сегменты записанного хода с его delayMs/usage (для
  // реплея). Ходы исчерпаны — пустые сегменты, planResponse отдаст fallback.
  const isReplayTurn = scenario?.replay?.kind === 'session-replay' && turnIndex !== undefined;
  const turn = isReplayTurn ? scenario.replay.turns[turnIndex] : null;
  const effective = isReplayTurn
    ? {
        name: scenario.name,
        description: scenario.description,
        delayMs: turn ? turn.delayMs : 0,
        usage: turn && Object.keys(turn.usage).length > 0 ? turn.usage : scenario.usage,
        segments: turn ? turn.segments : [],
      }
    : scenario;

  const plan = planResponse(effective, segIndex);
  if (persistState) {
    store.set(key, {
      scenarioName: scenario.name,
      segIndex: plan.nextIndex,
      awaitingToolResult: plan.awaitingToolResult,
      stopReason: plan.stopReason,
      ...(Number.isInteger(turnIndex) ? { turnIndex } : {}),
    });
  }
  const usage = computeUsage(effective, {
    scale: config.usageScale,
    toolResults: countToolResults(messages),
  });
  const blocks = planBlocks(plan.segments, {
    config,
    mode: stream ? 'stream' : 'json',
    availableTools,
  });

  // Фиксированная пауза сценария до первого байта ответа (delayMs): «модель
  // думает» — детекторы фаз (thinking/compaction) получают окно независимо
  // от режима (stream/non-stream). duration_ms в логе включает паузу.
  if (effective.delayMs > 0) await sleep(effective.delayMs);

  const logEntry = {
    session: key.slice(0, 12),
    scenario: scenario.name,
    marker,
    ...(isReplayTurn
      ? { replay_turn: turnIndex + 1, replay_turns_total: scenario.replay.turns.length }
      : {}),
    segments_done: plan.nextIndex,
    segments_total: effective.segments.length,
    stream,
    stop_reason: plan.stopReason,
    usage,
    model,
  };

  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      await writeSseStream(res, { blocks, model, stopReason: plan.stopReason, usage, config });
      if (!res.writableEnded) res.end();
    } catch (err) {
      // Обрыв клиента посреди стрима — фиксируем в логе и закрываем соединение.
      logEntry.aborted = true;
      logEntry.error = err.message;
      if (!res.destroyed) res.destroy();
    }
  } else {
    sendJson(
      res,
      200,
      buildNonStreamMessage({ blocks, model, stopReason: plan.stopReason, usage }),
    );
  }
  // duration_ms считаем в момент логирования: для стрима оно покрывает выдачу.
  log({ ...logEntry, duration_ms: Date.now() - t0 });
}

/**
 * Маршрутизация входящих запросов.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    // Trailing '\n' is load-bearing for SOC termseer-lane captures: the
    // executor's marker extraction ("__SOC_OUT_E*__") loses the LAST output
    // line when the command's stdout does not end with a newline — curl -s
    // prints the body verbatim, so without it the golden e2e-patches setup
    // step (curl /health; capture; assert 'ok' in ...) captures an empty
    // string. JSON consumers (res.json / JSON.parse) ignore the whitespace.
    sendJson(res, 200, {
      ok: true,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      sessions: store.size(),
      scenarios: [...scenarios.keys()],
    }, '\n');
    return;
  }
  // dsh sends POST /v1/messages?beta=true — match pathname, ignore query string
  const reqPath = req.url ? req.url.split('?')[0] : req.url;
  if (req.method === 'POST' && reqPath === '/v1/messages') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err.statusCode) {
        sendError(res, err.statusCode, 'invalid_request_error', err.message);
      } else {
        sendError(res, 400, 'invalid_request_error', `invalid JSON body: ${err.message}`);
      }
      return;
    }
    await handleMessages(body, res);
    return;
  }
  sendError(res, 404, 'not_found_error', `no route: ${req.method} ${req.url}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[dsh-fake-llm] unhandled request error:', err);
    if (!res.headersSent) {
      sendError(res, 500, 'api_error', err.message || 'internal error');
    } else {
      res.destroy();
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      msg: 'dsh-fake-llm listening',
      url: `http://${config.host}:${config.port}`,
      scenarios: [...scenarios.keys()],
      delta_ms: config.deltaMs,
      chunk_chars: config.chunkChars,
      pid: process.pid,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
