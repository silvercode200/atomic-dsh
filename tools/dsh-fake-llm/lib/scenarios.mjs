/**
 * Загрузка, валидация и нормализация сценариев dsh-fake-llm.
 *
 * Формат сценария (см. README.md):
 * {
 *   "name": "short",                       // ключ выбора; по умолчанию имя файла
 *   "description": "...",                  // опционально
 *   "delayMs": 3000,                       // опционально: пауза до первого байта
 *                                          // ответа (мс) — окно фазы для детекторов
 *   "usage": { input_tokens, output_tokens, cache_read_input_tokens,
 *              cache_creation_input_tokens },   // числа; отсутствующее = 0
 *   "segments": [
 *     { "thinking": ["кусок 1", "кусок 2"] },          // блок thinking
 *     { "text": ["абзац 1", "абзац 2"] },              // блок text
 *     { "text": ["..."], "repeatMs": "STREAM_TOTAL_MS" }, // циклический повтор
 *     { "text": ["обрыв..."], "stopReason": "max_tokens" }, // обрыв хода по
 *                                                          // лимиту токенов:
 *                                                          // ответ кончается
 *                                                          // ЭТИМ сегментом со
 *                                                          // stop_reason
 *                                                          // max_tokens (wire;
 *                                                          // pi-ai маппит его
 *                                                          // в length, dsh — в
 *                                                          // finish max-tokens)
 *     { "tool_use": { "name": "Bash", "input": {...} } } // вызов инструмента
 *   ]
 * }
 *
 * Чанки сегмента — строки (равномерный DELTA_MS) либо объекты реплея
 * { "text": "кусок", "afterMs": 30 } — afterMs = пауза ПОСЛЕ выдачи чанка
 * (межчанковый зазор записи; после последнего чанка блока — зазор до
 * следующего блока/конца ответа). tool_use дополнительно принимает id
 * (реплей оригинального toolu_*), jsonPieces (нарезанные записью аргументы)
 * и afterMs (параллельно jsonPieces).
 *
 * Replay-сценарий (генерирует session-to-replay.mjs из session.jsonl):
 * { "replay": { "kind": "session-replay", "turns": [
 *     { "userText": "...", "delayMs": 169, "usage": {...}, "segments": [...] }
 * ] } } — сервер подаёт N-й записанный ход по N-му маркерному сообщению.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
];

/**
 * Прочитать и провалидировать все *.json сценарии из каталога.
 *
 * @param {string} dir
 * @returns {Map<string, object>} name -> нормализованный сценарий
 * @throws {Error} с человеко-понятным описанием, если каталог пуст или файл невалиден
 */
export function loadScenarios(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error(`no scenario files (*.json) found in ${dir}`);
  }
  const scenarios = new Map();
  for (const file of files) {
    const full = path.join(dir, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      throw new Error(`scenario ${full}: invalid JSON: ${err.message}`);
    }
    const scenario = normalizeScenario(parsed, file);
    if (scenarios.has(scenario.name)) {
      throw new Error(`duplicate scenario name "${scenario.name}" (${file})`);
    }
    scenarios.set(scenario.name, scenario);
  }
  return scenarios;
}

/**
 * Нормализовать usage-объект сценария/хода: 4 поля, числа >= 0.
 *
 * @param {any} rawUsage - объект usage или null/undefined
 * @param {string} where - контекст для сообщения об ошибке
 * @returns {{input_tokens: number, output_tokens: number,
 *            cache_read_input_tokens: number, cache_creation_input_tokens: number}}
 */
function normalizeUsage(rawUsage, where) {
  const usage = {};
  const src = typeof rawUsage === 'object' && rawUsage !== null ? rawUsage : {};
  for (const field of USAGE_FIELDS) {
    const value = Number(src[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${where}: usage.${field} must be a non-negative number`);
    }
    usage[field] = value;
  }
  return usage;
}

/**
 * Нормализовать один сценарий: значения по умолчанию + строгая валидация сегментов.
 *
 * @param {any} raw - распарсенный JSON
 * @param {string} file - имя файла (для диагностики)
 * @returns {object} { name, description, usage, segments } либо
 *          { ..., replay: { kind, source, turns } } для session-replay
 */
function normalizeScenario(raw, file) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`scenario ${file}: expected JSON object`);
  }
  const name = typeof raw.name === 'string' && raw.name ? raw.name : file.replace(/\.json$/, '');
  // delayMs: опциональная пауза до первого байта ответа (обоих режимов) —
  // создаёт окно «модель думает» для детекторов фаз (thinking/compaction).
  const delayMs = raw.delayMs === undefined ? 0 : Number(raw.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`scenario ${file}: delayMs must be a non-negative number`);
  }
  // Replay-сценарий: ходы записанной сессии (session-to-replay.mjs).
  if (raw.replay !== undefined) {
    if (typeof raw.replay !== 'object' || raw.replay === null || Array.isArray(raw.replay)) {
      throw new Error(`scenario ${file}: "replay" must be an object`);
    }
    if (raw.replay.kind !== 'session-replay') {
      throw new Error(`scenario ${file}: replay.kind must be "session-replay"`);
    }
    if (!Array.isArray(raw.replay.turns) || raw.replay.turns.length === 0) {
      throw new Error(`scenario ${file}: replay.turns must be a non-empty array`);
    }
    const turns = raw.replay.turns.map((t, i) => {
      const where = `${file}#replay.turns[${i}]`;
      if (typeof t !== 'object' || t === null || Array.isArray(t)) {
        throw new Error(`${where}: turn must be an object`);
      }
      if (t.userText !== undefined && typeof t.userText !== 'string') {
        throw new Error(`${where}: userText must be a string`);
      }
      const turnDelayMs = t.delayMs === undefined ? 0 : Number(t.delayMs);
      if (!Number.isFinite(turnDelayMs) || turnDelayMs < 0) {
        throw new Error(`${where}: delayMs must be a non-negative number`);
      }
      if (!Array.isArray(t.segments) || t.segments.length === 0) {
        throw new Error(`${where}: "segments" must be a non-empty array`);
      }
      return {
        userText: t.userText ?? '',
        delayMs: turnDelayMs,
        usage: t.usage === undefined ? {} : normalizeUsage(t.usage, where),
        segments: t.segments.map((seg, j) => normalizeSegment(seg, `${where}#segments[${j}]`)),
      };
    });
    return {
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      delayMs,
      usage: normalizeUsage(raw.usage, `scenario ${file}`),
      segments: turns[0].segments, // fallback: обычная машина никогда не видит replay-сценарий
      replay: {
        kind: 'session-replay',
        source: typeof raw.replay.source === 'string' ? raw.replay.source : '',
        turns,
      },
    };
  }
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw new Error(`scenario ${file}: "segments" must be a non-empty array`);
  }
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    delayMs,
    usage: normalizeUsage(raw.usage, `scenario ${file}`),
    segments: raw.segments.map((seg, i) => normalizeSegment(seg, `${file}#segments[${i}]`)),
  };
}

/**
 * Нормализовать один сегмент.
 *
 * @param {any} seg
 * @param {string} where - контекст для сообщения об ошибке
 * @returns {{type:'thinking'|'text', chunks:Array<{text:string, afterMs?:number}>,
 *            repeatMs?:number|string, stopReason?:'end_turn'|'max_tokens'}
 *          |{type:'tool_use', name:string, input:object, id?:string,
 *            jsonPieces?:string[], afterMs?:number[]}}
 */
function normalizeSegment(seg, where) {
  if (typeof seg !== 'object' || seg === null) {
    throw new Error(`${where}: segment must be an object`);
  }
  if (typeof seg.tool_use === 'object' && seg.tool_use !== null) {
    const { name, input } = seg.tool_use;
    if (typeof name !== 'string' || !name) {
      throw new Error(`${where}: tool_use.name must be a non-empty string`);
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error(`${where}: tool_use.input must be a JSON object`);
    }
    const tool = { type: 'tool_use', name, input };
    // Реплей-поля: id оригинального toolu_*, нарезанные записью аргументы
    // jsonPieces (конкатенация обязана парситься в JSON-объект) и afterMs —
    // паузы после каждого куска (параллельно jsonPieces).
    if (seg.tool_use.id !== undefined) {
      if (typeof seg.tool_use.id !== 'string' || !seg.tool_use.id) {
        throw new Error(`${where}: tool_use.id must be a non-empty string`);
      }
      tool.id = seg.tool_use.id;
    }
    if (seg.tool_use.jsonPieces !== undefined) {
      if (
        !Array.isArray(seg.tool_use.jsonPieces) ||
        seg.tool_use.jsonPieces.length === 0 ||
        !seg.tool_use.jsonPieces.every((p) => typeof p === 'string' && p.length > 0)
      ) {
        throw new Error(`${where}: tool_use.jsonPieces must be a non-empty array of strings`);
      }
      try {
        const parsed = JSON.parse(seg.tool_use.jsonPieces.join(''));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
      } catch {
        throw new Error(`${where}: tool_use.jsonPieces concatenation must be a valid JSON object`);
      }
      tool.jsonPieces = seg.tool_use.jsonPieces;
    }
    if (seg.tool_use.afterMs !== undefined) {
      if (!tool.jsonPieces) {
        throw new Error(`${where}: tool_use.afterMs requires tool_use.jsonPieces`);
      }
      if (
        !Array.isArray(seg.tool_use.afterMs) ||
        seg.tool_use.afterMs.length !== tool.jsonPieces.length ||
        !seg.tool_use.afterMs.every((ms) => Number.isFinite(ms) && ms >= 0)
      ) {
        throw new Error(
          `${where}: tool_use.afterMs must be an array of non-negative numbers, ` +
            `parallel to jsonPieces (${tool.jsonPieces.length} шт.)`,
        );
      }
      tool.afterMs = seg.tool_use.afterMs.map(Number);
    }
    return tool;
  }
  const key = seg.thinking !== undefined ? 'thinking' : seg.text !== undefined ? 'text' : null;
  if (!key) {
    throw new Error(
      `${where}: segment must have exactly one of "text" | "thinking" | "tool_use"`,
    );
  }
  const rawChunks = seg[key];
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    throw new Error(`${where}: "${key}" must be a non-empty array of chunks`);
  }
  const chunks = [];
  for (const c of rawChunks) {
    if (typeof c === 'string') {
      if (c.length > 0) chunks.push({ text: c });
      continue;
    }
    if (typeof c === 'object' && c !== null && typeof c.text === 'string' && c.text.length > 0) {
      if (c.afterMs === undefined) {
        chunks.push({ text: c.text });
        continue;
      }
      const afterMs = Number(c.afterMs);
      if (!Number.isFinite(afterMs) || afterMs < 0) {
        throw new Error(`${where}: chunk.afterMs must be a non-negative number`);
      }
      chunks.push({ text: c.text, afterMs });
      continue;
    }
    // пустые строки/объекты пропускаются (как в прежнем filter-поведении)
  }
  if (chunks.length === 0) {
    throw new Error(`${where}: "${key}" contains no non-empty chunks`);
  }
  const segment = { type: key, chunks };
  if (seg.repeatMs !== undefined) {
    if (typeof seg.repeatMs === 'number' && seg.repeatMs > 0) {
      segment.repeatMs = seg.repeatMs;
    } else if (typeof seg.repeatMs === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(seg.repeatMs)) {
      segment.repeatMs = seg.repeatMs; // имя env-переменной, резолвится при запросе
    } else {
      throw new Error(`${where}: repeatMs must be a positive number or an ENV var name`);
    }
  }
  // stopReason у сегмента: принудительный stop_reason ответа на ЭТОМ сегменте
  // (эмуляция max-tokens: ход обрывается, wire "max_tokens" pi-ai маппит в
  // "length", dsh — в finish kind "max-tokens"). Допустим только на не-tool
  // сегментах: 'end_turn' (ранний конец) и 'max_tokens' (обрыв по лимиту);
  // 'tool_use' бессмысленен — его даёт сегмент tool_use.
  if (seg.stopReason !== undefined) {
    if (seg.stopReason === 'end_turn' || seg.stopReason === 'max_tokens') {
      segment.stopReason = seg.stopReason;
    } else {
      throw new Error(`${where}: stopReason must be "end_turn" or "max_tokens"`);
    }
  }
  return segment;
}

/**
 * Спланировать ответ: какие сегменты выдать, начиная с segIndex.
 *
 * Ответ поглощает сегменты до первого tool_use (включительно), до сегмента
 * с принудительным stopReason (эмуляция max-tokens: ответ кончается этим
 * сегментом, точка продолжения = следующий сегмент) либо до конца сценария.
 * После tool_use сервер ждёт tool_result от клиента.
 *
 * @param {object} scenario - нормализованный сценарий
 * @param {number} segIndex - индекс сегмента, с которого продолжаем
 * @returns {{segments: object[], stopReason:'tool_use'|'end_turn'|'max_tokens',
 *            nextIndex:number, awaitingToolResult:boolean}}
 */
export function planResponse(scenario, segIndex) {
  const fallback = {
    segments: [
      {
        type: 'text',
        chunks: ['Все сегменты сценария завершены. Ответ по умолчанию.'],
      },
    ],
    stopReason: 'end_turn',
    nextIndex: segIndex,
    awaitingToolResult: false,
  };
  if (segIndex >= scenario.segments.length) {
    // Продолжение после финального tool_use без хвостовых сегментов:
    // отдаём закрывающий текст, чтобы сообщение не было пустым (иначе
    // harness трактует пустой ответ как EMPTY_RESPONSE).
    return fallback;
  }
  const out = [];
  let i = segIndex;
  while (i < scenario.segments.length) {
    const seg = scenario.segments[i];
    out.push(seg);
    if (seg.type === 'tool_use') {
      return { segments: out, stopReason: 'tool_use', nextIndex: i + 1, awaitingToolResult: true };
    }
    if (seg.stopReason !== undefined) {
      // Принудительный обрыв ответа на этом сегменте (эмуляция max-tokens).
      // awaitingToolResult=false: продолжение сценария = СЛЕДУЮЩИЙ запрос
      // без tool_result (сервер решает по session state, см. server.mjs).
      return { segments: out, stopReason: seg.stopReason, nextIndex: i + 1, awaitingToolResult: false };
    }
    i++;
  }
  return { segments: out, stopReason: 'end_turn', nextIndex: i, awaitingToolResult: false };
}
