/**
 * Wire-протокол anthropic-messages для dsh-fake-llm.
 *
 * Строит содержимое ответа (блоки text/thinking/tool_use), стримит его как SSE
 * (message_start -> content_block_start/delta/stop -> message_delta -> message_stop)
 * или отдаёт цельным JSON для non-stream запросов. Формат соответствует тому,
 что парсит @earendil-works/pi-ai (dist/api/anthropic-messages.js) поверх
 * официального @anthropic-ai/sdk: события вне известного набора и строки-комментарии
 * игнорируются клиентом, поэтому heartbeat-комментарии ": ping" безопасны.
 */
import { randomUUID } from 'node:crypto';

/**
 * Сгенерировать идентификатор с префиксом (msg_/toolu_).
 *
 * @param {string} prefix
 * @returns {string}
 */
export function makeId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Разрезать строку на куски по size символов.
 *
 * @param {string} s
 * @param {number} size
 * @returns {string[]}
 */
export function chunkString(s, size) {
  if (s.length === 0) return [];
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * Разрешить repeatMs сегмента: число как есть; строка = имя env-переменной
 * (отсутствует/невалидна -> config.streamTotalMs).
 *
 * @param {number | string | undefined} raw
 * @param {{streamTotalMs: number}} config
 * @returns {number} бюджет повтора в мс (0 = без повтора)
 */
export function resolveRepeatMs(raw, config) {
  if (typeof raw === 'number' && raw > 0) return raw;
  if (typeof raw === 'string') {
    const value = Number(process.env[raw]);
    if (Number.isFinite(value) && value > 0) return value;
    return config.streamTotalMs;
  }
  return 0;
}

/**
 * Сопоставить имя инструмента сценария с реальным набором инструментов запроса:
 * точное совпадение, затем case-insensitive; иначе имя как есть (клиент получит
 * tool_use с незнакомым именем и ответит tool_result с is_error — машина
 * продолжится).
 *
 * @param {string} name
 * @param {string[] | null} availableTools
 * @returns {string}
 */
export function mapToolName(name, availableTools) {
  if (!availableTools || availableTools.length === 0) return name;
  if (availableTools.includes(name)) return name;
  const ci = availableTools.find((t) => t.toLowerCase() === name.toLowerCase());
  return ci ?? name;
}

/**
 * Собрать блоки ответа из запланированных сегментов.
 *
 * @param {object[]} segments - сегменты сценария на этот ответ
 * @param {{config: object, mode: 'stream'|'json', availableTools: string[]|null}} opts
 * @returns {Array<{kind:'text'|'thinking', pieces:Array<{text:string, afterMs?:number}>,
 *                   repeatMs:number}
 *          |{kind:'tool_use', id:string, name:string, input:object,
 *            jsonPieces:string[], delays?:number[]|null}>}
 */
export function planBlocks(segments, { config, mode, availableTools }) {
  const blocks = [];
  for (const seg of segments) {
    if (seg.type === 'tool_use') {
      const name = mapToolName(seg.name, availableTools);
      blocks.push({
        kind: 'tool_use',
        id: seg.id ?? makeId('toolu'),
        name,
        input: seg.input,
        jsonPieces: seg.jsonPieces ?? chunkString(JSON.stringify(seg.input), config.chunkChars),
        delays: seg.afterMs ?? null,
      });
    } else {
      const pieces = [];
      for (const chunk of seg.chunks) {
        if (chunk.afterMs !== undefined) {
          // replay-чанк: уже нарезан записью — повторно не режем
          pieces.push({ text: chunk.text, afterMs: chunk.afterMs });
        } else {
          for (const part of chunkString(chunk.text, config.chunkChars)) {
            pieces.push({ text: part });
          }
        }
      }
      if (pieces.length === 0) continue; // пустые сегменты не порождают блоков
      blocks.push({
        kind: seg.type === 'thinking' ? 'thinking' : 'text',
        pieces,
        repeatMs: mode === 'stream' ? resolveRepeatMs(seg.repeatMs, config) : 0,
      });
    }
  }
  return blocks;
}

/**
 * Посчитать usage ответа из сценария: числа сценария * FAKE_USAGE_SCALE,
 * input_tokens дополнительно растёт на TOOL_RESULT_TOKEN_GROWTH за каждый
 * tool_result в истории (ctx-бар двигается по ходу цикла инструментов).
 *
 * @param {{usage: object}} scenario
 * @param {{scale?: number, toolResults?: number}} [opts]
 * @returns {{input_tokens:number, output_tokens:number,
 *            cache_read_input_tokens:number, cache_creation_input_tokens:number}}
 */
export function computeUsage(scenario, { scale = 1, toolResults = 0 } = {}) {
  const scaled = (value) => Math.max(0, Math.round((Number(value) || 0) * scale));
  const grownInput = (Number(scenario.usage.input_tokens) || 0) + toolResults * 800;
  return {
    input_tokens: scaled(grownInput),
    output_tokens: scaled(scenario.usage.output_tokens),
    cache_read_input_tokens: scaled(scenario.usage.cache_read_input_tokens),
    cache_creation_input_tokens: scaled(scenario.usage.cache_creation_input_tokens),
  };
}

/**
 * Собрать полный non-stream ответ anthropic-messages.
 * Блоки с repeatMs отдаются одной итерацией (повтор — только стримовый режим).
 *
 * @param {{blocks: object[], model: string, stopReason: string, usage: object}} opts
 * @returns {object}
 */
export function buildNonStreamMessage({ blocks, model, stopReason, usage }) {
  const content = blocks.map((block) => {
    if (block.kind === 'text') {
      return { type: 'text', text: block.pieces.map((p) => p.text).join('') };
    }
    if (block.kind === 'thinking') {
      return {
        type: 'thinking',
        thinking: block.pieces.map((p) => p.text).join(''),
        signature: makeId('sig_fake'),
      };
    }
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  });
  return {
    id: makeId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

/**
 * Записать одну SSE-строку события.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} type
 * @param {object} payload
 */
function sseSend(res, type, payload) {
  if (res.destroyed || !res.writable) throw new Error('client disconnected');
  res.write(`event: ${type}\ndata: ${JSON.stringify({ ...payload, type })}\n\n`);
}

/**
 * Пауза между дельтами.
 *
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Выдать один текстовый/thinking-блок: start, дельты (с повтором до repeatMs),
 * опциональная signature_delta (thinking), stop.
 *
 * Пауза после каждого чанка: replay-чанки несут свою (afterMs = межчанковый
 * зазор записи), обычные строки — глобальный DELTA_MS.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {object} block
 * @param {number} index
 * @param {{deltaMs: number}} config
 * @param {number} streamStart - Date.now() начала ответа
 */
async function emitTextBlock(res, block, index, config, streamStart) {
  sseSend(res, 'content_block_start', {
    index,
    content_block:
      block.kind === 'text'
        ? { type: 'text', text: '' }
        : { type: 'thinking', thinking: '', signature: '' },
  });
  const isText = block.kind === 'text';
  let i = 0;
  while (block.pieces.length > 0) {
    const piece = block.pieces[i % block.pieces.length];
    sseSend(res, 'content_block_delta', {
      index,
      delta: isText
        ? { type: 'text_delta', text: piece.text }
        : { type: 'thinking_delta', thinking: piece.text },
    });
    i++;
    const delay = piece.afterMs !== undefined ? piece.afterMs : config.deltaMs;
    if (delay > 0) await sleep(delay);
    if (block.repeatMs > 0) {
      if (Date.now() - streamStart >= block.repeatMs) break;
    } else if (i >= block.pieces.length) {
      break;
    }
  }
  if (!isText) {
    sseSend(res, 'content_block_delta', {
      index,
      delta: { type: 'signature_delta', signature: makeId('sig_fake') },
    });
  }
  sseSend(res, 'content_block_stop', { index });
}

/**
 * Выдать один tool_use-блок: start, input_json_delta-дельты, stop.
 *
 * Паузы: replay-блок несёт delays (параллельно jsonPieces), иначе DELTA_MS.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {object} block
 * @param {number} index
 * @param {{deltaMs: number}} config
 */
async function emitToolBlock(res, block, index, config) {
  sseSend(res, 'content_block_start', {
    index,
    content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
  });
  for (const [i, piece] of block.jsonPieces.entries()) {
    sseSend(res, 'content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: piece },
    });
    const delay = block.delays ? block.delays[i] : config.deltaMs;
    if (delay > 0) await sleep(delay);
  }
  sseSend(res, 'content_block_stop', { index });
}

/**
 * Застремить полный ответ: message_start -> блоки -> message_delta -> message_stop.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{blocks: object[], model: string, stopReason: string, usage: object,
 *          config: object}} opts
 * @throws {Error} при отключении клиента посреди стрима
 */
export async function writeSseStream(res, { blocks, model, stopReason, usage, config }) {
  const streamStart = Date.now();
  let lastBeat = streamStart;
  const maybeHeartbeat = () => {
    if (config.heartbeatMs > 0 && Date.now() - lastBeat >= config.heartbeatMs) {
      if (!res.destroyed && res.writable) res.write(': ping\n\n');
      lastBeat = Date.now();
    }
  };
  sseSend(res, 'message_start', {
    message: {
      id: makeId('msg'),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // message_start несёт input-usage сразу (клиент берёт input даже при
      // раннем обрыве стрима); output здесь стартовый, финальный - в message_delta.
      usage: { ...usage, output_tokens: 4 },
    },
  });
  for (const [index, block] of blocks.entries()) {
    maybeHeartbeat();
    if (block.kind === 'tool_use') {
      await emitToolBlock(res, block, index, config);
    } else {
      await emitTextBlock(res, block, index, config, streamStart);
    }
  }
  sseSend(res, 'message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  });
  sseSend(res, 'message_stop', {});
}
