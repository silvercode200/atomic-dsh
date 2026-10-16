/**
 * Конвертация лога сессии dsh (session.jsonl) в replay-сценарий dsh-fake-llm.
 *
 * session.jsonl — персистентный журнал агента dsh: каждая строка = JSON-событие
 * с полями type/seq/time (мс epoch). Чанковый поток записан двумя
 * взаимодополняющими видами событий (семантика выверена на реальной сессии,
 * см. reports/w4-evidence/replay-conversion-sample/):
 *  - батчи `text-chunks` / `reasoning-chunks` / `tool-call-chunks`: seq0 = seq
 *    первого чанка батча, time0 = его абсолютное время, dt[i] = зазор
 *    чанк[i]→чанк[i+1] (len(dt) == len(texts)−1), texts/args — тексты чанков;
 *  - raw `assistant/chunk` с chunk.type text-delta / reasoning-delta /
 *    tool-call-delta — одиночные чанки с точными seq/time.
 * Оба вида склеиваются по seq в единый поток; границы блоков — assistant/chunk
 * block-start/block-end (blockType reasoning | text | tool-call), стоп-причина
 * шага — finish (reason.kind stop | tool-calls | max-tokens), usage шага — usage.
 *
 * Результат — сценарий реплея: replay.turns[] с сегментами, где каждый чанк
 * несёт afterMs = паузу ПОСЛЕ его выдачи (межчанковый зазор записи). Зазоры
 * через границы блоков внутри шага сворачиваются в afterMs последнего чанка
 * блока; межшаговые паузы (исполнение тулзы, латентность авто-continue) НЕ
 * переносятся — они клиентские и в реплее рождаются заново. Сервер подаёт
 * N-й записанный ход по N-му маркерному сообщению (SCENARIO:<name>); циклы
 * tool_use и обрывы max_tokens продолжаются штатной continuation-машиной.
 */

/** Префиксы user-сообщений, не являющихся интентом хода (не драйверы). */
const NON_DRIVER_PREFIXES = [
  'Current runtime context.', // runtime-context-снимок инжектится после интента
  'This is an automatically generated checkpoint', // чекпоинт компакции
];

/** Синтетика авто-продолжения после max-tokens. */
const CONTINUE_TEXT = 'continue';

/** Батчные события → вид чанка. */
const BATCH_KINDS = {
  'text-chunks': 'text',
  'reasoning-chunks': 'reasoning',
  'tool-call-chunks': 'toolarg',
};

/** Raw assistant/chunk дельты → вид чанка. */
const RAW_DELTA_KINDS = {
  'text-delta': 'text',
  'reasoning-delta': 'reasoning',
  'tool-call-delta': 'toolarg',
};

/**
 * Распарсить session.jsonl в список событий (не-JSON строки пропускаются).
 *
 * @param {string} sessionText
 * @param {(msg: string) => void} say - сборщик предупреждений
 * @returns {object[]}
 */
function parseEvents(sessionText, say) {
  const events = [];
  let bad = 0;
  for (const line of sessionText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      bad++;
    }
  }
  if (bad > 0) say(`пропущено ${bad} не-JSON строк лога`);
  return events;
}

/**
 * Проиндексировать события: чанки (по seq), блоки, шаги, user-сообщения.
 *
 * @param {object[]} events
 * @param {(msg: string) => void} say
 * @returns {{sessionId: string, chunks: Map<number, object>, blocks: Map<string, object>,
 *           steps: Map<string, object>, userMessages: object[]}}
 */
function indexSession(events, say) {
  let sessionId = '';
  /** @type {Map<number, object>} */
  const chunks = new Map();
  /** @type {Map<string, object>} ключ "turn/step/index" */
  const blocks = new Map();
  /** @type {Map<string, object>} ключ "turn/step" */
  const steps = new Map();
  const userMessages = [];
  for (const ev of events) {
    switch (ev.type) {
      case 'session':
        if (typeof ev.id === 'string') sessionId = ev.id;
        break;
      case 'user/message': {
        const text = ev?.data?.content?.[0]?.text;
        if (typeof text === 'string') {
          userMessages.push({ seq: ev.seq, time: ev.time, text });
        }
        break;
      }
      case 'step/start':
        steps.set(`${ev.data.turn}/${ev.data.step}`, {
          turn: ev.data.turn,
          step: ev.data.step,
          startSeq: ev.seq,
          startTime: ev.time,
        });
        break;
      case 'text-chunks':
      case 'reasoning-chunks':
      case 'tool-call-chunks': {
        const kind = BATCH_KINDS[ev.type];
        const texts = ev.data.texts ?? ev.data.args ?? [];
        let t = ev.time0;
        texts.forEach((text, i) => {
          const chunk = {
            seq: ev.seq0 + i,
            time: t,
            turn: ev.data.turn,
            step: ev.data.step,
            index: ev.data.index,
            kind,
            text,
          };
          if (ev.data.id) chunk.id = ev.data.id;
          if (ev.data.name) chunk.name = ev.data.name;
          if (chunks.has(chunk.seq)) say(`seq ${chunk.seq} записан дважды — оставлен последний (${ev.type})`);
          chunks.set(chunk.seq, chunk);
          const d = Array.isArray(ev.data.dt) ? ev.data.dt[i] : undefined;
          if (typeof d === 'number') t += d;
        });
        break;
      }
      case 'assistant/chunk': {
        const c = ev.data?.chunk;
        if (c?.type === 'block-start') {
          blocks.set(`${ev.data.turn}/${ev.data.step}/${c.index}`, {
            turn: ev.data.turn,
            step: ev.data.step,
            index: c.index,
            blockType: c.blockType,
            startSeq: ev.seq,
            startT: ev.time,
            endSeq: null,
            endT: null,
            endBlock: null,
            chunks: null,
          });
          if (!steps.has(`${ev.data.turn}/${ev.data.step}`)) {
            say(`блок ${ev.data.turn}/${ev.data.step}/${c.index} без step/start`);
          }
        } else if (c?.type === 'block-end') {
          const b = blocks.get(`${ev.data.turn}/${ev.data.step}/${c.index}`);
          if (!b) {
            say(`block-end без block-start: ${ev.data.turn}/${ev.data.step}/${c.index}`);
          } else {
            b.endSeq = ev.seq;
            b.endT = ev.time;
            b.endBlock = c.block ?? null;
          }
        } else if (c?.type === 'finish') {
          const st = steps.get(`${ev.data.turn}/${ev.data.step}`);
          if (st && st.finishKind === undefined) st.finishKind = c.reason?.kind ?? null;
        } else if (c?.type === 'usage') {
          const st = steps.get(`${ev.data.turn}/${ev.data.step}`);
          if (st && st.usage === undefined) st.usage = c.usage ?? null;
        } else if (RAW_DELTA_KINDS[c?.type]) {
          const kind = RAW_DELTA_KINDS[c.type];
          const chunk = {
            seq: ev.seq,
            time: ev.time,
            turn: ev.data.turn,
            step: ev.data.step,
            index: c.index,
            kind,
            text: kind === 'toolarg' ? c.argumentsDelta : c.text,
          };
          if (c.id) chunk.id = c.id;
          if (c.name) chunk.name = c.name;
          if (chunks.has(chunk.seq)) say(`seq ${chunk.seq} записан дважды — оставлен последний (${c.type})`);
          chunks.set(chunk.seq, chunk);
        }
        break;
      }
      default:
        // turn/start|end, tool/*, compaction/*, agent/*, session/* — реплей не используют
        break;
    }
  }
  return { sessionId, chunks, blocks, steps, userMessages };
}

/**
 * Является ли текст user-сообщения артефактом (снимок/чекпоинт/continue).
 *
 * @param {string} text
 * @returns {boolean}
 */
function isArtifact(text) {
  const t = text.trim();
  if (t === CONTINUE_TEXT) return true;
  return NON_DRIVER_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Найти интент-сообщение хода: первый не-артефактный user/message между
 * step/start первого шага и первым block-start хода (реальный порядок dsh:
 * turn/start → step/start → интент → [снимок] → чанки).
 *
 * @param {object[]} userMessages
 * @param {number} fromSeq - seq step/start (эксклюзивная граница)
 * @param {number} toSeq - seq первого block-start (эксклюзивная граница)
 * @returns {string}
 */
function findDriverText(userMessages, fromSeq, toSeq) {
  for (const um of userMessages) {
    if (um.seq <= fromSeq || um.seq >= toSeq) continue;
    if (isArtifact(um.text)) continue;
    return um.text;
  }
  return '';
}

/**
 * Собрать сегмент из блока (без таймингов — afterMs прикрепляет caller).
 *
 * @param {object} b - блок с отсортированными чанками
 * @param {(msg: string) => void} say
 * @returns {object | null} сегмент сценария или null (блок пропущен)
 */
function tryParseObject(s) {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Пересобрать валидные стриминговые куски из полной строки аргументов:
 * пропорционально длинам исходных кусков, число кусков сохраняется —
 * afterMs ложатся 1:1, тайминговая форма стрима не искажается.
 *
 * @param {string} argsStr - валидный JSON-объект строкой
 * @param {number[]} lens - длины исходных (битых) кусков
 * @returns {string[]}
 */
function resplitPieces(argsStr, lens) {
  if (lens.length === 0) return [argsStr];
  const total = lens.reduce((a, x) => a + x, 0);
  if (total <= 0) return [argsStr];
  const pieces = [];
  let pos = 0;
  for (let i = 0; i < lens.length - 1; i++) {
    const take = Math.round((lens[i] / total) * argsStr.length);
    pieces.push(argsStr.slice(pos, pos + take));
    pos += take;
  }
  pieces.push(argsStr.slice(pos));
  // Пустой кусок ломает контракт jsonPieces (p.length > 0) — аргументов
  // меньше, чем было стриминговых чанков: откатываемся к одному куску.
  if (pieces.some((p) => p.length === 0)) return [argsStr];
  return pieces;
}

function blockToSegment(b, say) {
  const list = b.chunks ?? [];
  if (b.blockType === 'tool-call') {
    const joined = list.map((c) => c.text).join('');
    const argsStr = typeof b.endBlock?.arguments === 'string' ? b.endBlock.arguments : joined;
    if (argsStr && joined && argsStr !== joined) {
      say(`turn ${b.turn} step ${b.step}: чанки tool-call != аргументам block-end`);
    }
    let input = {};
    if (argsStr) {
      try {
        input = JSON.parse(argsStr);
      } catch {
        say(`turn ${b.turn} step ${b.step}: аргументы tool-call не парсятся — input={}`);
      }
    }
    // Контракт сценария: конкатенация jsonPieces обязана парситься в
    // JSON-объект. В живых логах стрим tool-call бывает обрезан посреди
    // аргументов — тогда пересобираем куски из валидного источника,
    // сохраняя их число (afterMs лягут 1:1).
    const pieceTexts = list.map((c) => c.text);
    const joinedOk = tryParseObject(joined) !== null;
    const argsOk = tryParseObject(argsStr) !== null;
    let pieces = null;
    if (!joinedOk && pieceTexts.length > 0) {
      if (argsOk) {
        pieces = resplitPieces(argsStr, pieceTexts.map((t) => t.length));
        say(
          `turn ${b.turn} step ${b.step}: стрим tool-call обрезан — ` +
            `куски пересобраны из block-end (${pieces.length} шт.)`,
        );
      } else {
        pieces = ['{}'];
        say(`turn ${b.turn} step ${b.step}: куски tool-call без валидного JSON — '{}'`);
      }
    }
    const name = b.endBlock?.name ?? list[0]?.name;
    if (!name) {
      say(`turn ${b.turn} step ${b.step}: tool-call без имени — блок пропущен`);
      return null;
    }
    const tool_use = { name, input };
    if (typeof b.endBlock?.id === 'string' && b.endBlock.id) tool_use.id = b.endBlock.id;
    if (pieces) tool_use.replayPieces = pieces;
    return { tool_use };
  }
  const key = b.blockType === 'reasoning' ? 'thinking' : 'text';
  if (list.length === 0) {
    say(`turn ${b.turn} step ${b.step}: пустой блок ${key} — пропущен`);
    return null;
  }
  if (typeof b.endBlock?.text === 'string') {
    const joined = list.map((c) => c.text).join('');
    if (joined !== b.endBlock.text) {
      say(
        `turn ${b.turn} step ${b.step}: конкатенация чанков != тексту block-end ` +
          `(${joined.length} vs ${b.endBlock.text.length} символов)`,
      );
    }
  }
  return { [key]: list.map((c) => ({ text: c.text })) };
}

/**
 * Прикрепить afterMs к сегменту: текстовые чанки получают поле afterMs,
 * tool_use — параллельные jsonPieces + afterMs.
 *
 * @param {object} seg
 * @param {object} block
 * @param {number[]} delays
 */
function attachDelays(seg, block, delays) {
  if (seg.tool_use) {
    // replayPieces — пересобранные куски (см. blockToSegment): битый стрим
    // заменён валидным JSON с сохранением числа кусков.
    const pieces = seg.tool_use.replayPieces ?? (block.chunks ?? []).map((c) => c.text);
    delete seg.tool_use.replayPieces;
    if (pieces.length > 0) {
      seg.tool_use.jsonPieces = pieces;
      // afterMs параллелен jsonPieces: при откате к одному куску паузы
      // сворачиваются в сумму (время стрима сохраняется).
      seg.tool_use.afterMs =
        pieces.length === delays.length
          ? delays
          : [delays.reduce((a, x) => a + (Number(x) || 0), 0)];
    }
    return;
  }
  const key = seg.thinking ? 'thinking' : 'text';
  seg[key].forEach((c, i) => {
    c.afterMs = delays[i];
  });
}

/**
 * Применить speed-множитель и потолок к паузе (мс).
 *
 * @param {number} d - исходная пауза
 * @param {number} speed - множитель (1 = как записано)
 * @param {number} maxDelay - потолок (Infinity = без потолка)
 * @returns {number}
 */
function scaleDelay(d, speed, maxDelay) {
  let v = Math.round(d * speed);
  if (Number.isFinite(maxDelay)) v = Math.min(v, maxDelay);
  return Math.max(0, v);
}

/**
 * Смерджить чанки в блоки; пустые текстовые блоки с текстом в block-end
 * получают один синтетический чанк (лог мог быть обрезан).
 *
 * @param {Map<string, object>} blocks
 * @param {Map<number, object>} chunks
 * @param {(msg: string) => void} say
 * @returns {number} число блоков
 */
function assignChunksToBlocks(blocks, chunks, say) {
  let orphan = 0;
  for (const ch of chunks.values()) {
    const b = blocks.get(`${ch.turn}/${ch.step}/${ch.index}`);
    if (!b || ch.seq <= b.startSeq || (b.endSeq !== null && ch.seq >= b.endSeq)) {
      orphan++;
      continue;
    }
    (b.chunks ??= []).push(ch);
  }
  if (orphan > 0) say(`${orphan} чанков вне границ блоков — пропущены`);
  let count = 0;
  for (const b of blocks.values()) {
    if (!Array.isArray(b.chunks)) b.chunks = [];
    b.chunks.sort((x, y) => x.seq - y.seq);
    if (
      b.chunks.length === 0 &&
      b.blockType !== 'tool-call' &&
      typeof b.endBlock?.text === 'string' &&
      b.endBlock.text.length > 0
    ) {
      b.chunks = [{ text: b.endBlock.text, time: b.endT ?? 0, seq: b.endSeq ?? 0 }];
      say(`блок ${b.turn}/${b.step}/${b.index} без чанков — один чанк из block-end`);
    }
    if (b.chunks.length > 0) count++;
  }
  return count;
}

/**
 * Перевести usage-чанк записи в поля сценария fake-llm.
 *
 * @param {object | null | undefined} u
 * @returns {object | undefined}
 */
function mapUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_read_input_tokens: u.cacheReadTokens ?? 0,
    cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
  };
}

/**
 * Собрать один ход: сегменты всех шагов + тайминги + драйвер + delayMs/usage.
 *
 * @param {object} turnInfo - { turn, steps: Map, blocks: [] }
 * @param {object[]} userMessages
 * @param {{speed: number, maxDelay: number, say: (m: string) => void}} ctx
 * @returns {{turn: number, userText: string, delayMs: number, usage?: object,
 *            segments: object[], chunks: number, pauses: number[]}} | null
 */
function buildTurn(turnInfo, userMessages, ctx) {
  const { say } = ctx;
  const stepNums = [...turnInfo.steps.keys()].sort((a, b) => a - b);
  turnInfo.blocks.sort((a, b) => a.startSeq - b.startSeq);
  const firstBlock = turnInfo.blocks[0];
  if (!firstBlock) {
    say(`turn ${turnInfo.turn}: нет блоков — ход пропущен`);
    return null;
  }
  const step1 = turnInfo.steps.get(stepNums[0]) ?? null;
  if (!step1) say(`turn ${turnInfo.turn}: нет step/start — delayMs=0`);

  const userText = findDriverText(
    userMessages,
    step1?.startSeq ?? -Infinity,
    firstBlock.startSeq,
  );
  if (!userText) say(`turn ${turnInfo.turn}: интент-сообщение не найдено — userText пуст`);

  const segments = [];
  const pauses = [];
  let chunkTotal = 0;
  for (const sn of stepNums) {
    const st = turnInfo.steps.get(sn);
    const stepBlocks = turnInfo.blocks.filter((b) => b.step === sn);
    const stepSegments = [];
    for (const b of stepBlocks) {
      const seg = blockToSegment(b, say);
      if (seg) stepSegments.push({ seg, block: b });
    }
    if (stepSegments.length === 0) {
      say(`turn ${turnInfo.turn} step ${sn}: нет сегментов — шаг пропущен`);
      continue;
    }
    // Тайминги шага: чанки в порядке сегментов; зазор последнего чанка шага =
    // block-end последнего блока (межшаговые паузы клиентские, не переносим).
    const flat = [];
    for (const { block } of stepSegments) {
      for (const c of block.chunks) flat.push({ time: c.time });
    }
    chunkTotal += flat.length;
    const lastBlock = stepSegments[stepSegments.length - 1].block;
    for (let i = 0; i < flat.length; i++) {
      let d = i + 1 < flat.length ? flat[i + 1].time - flat[i].time : 0;
      if (i + 1 === flat.length && lastBlock.endT !== null) {
        d = lastBlock.endT - flat[i].time;
      }
      if (!Number.isFinite(d) || d < 0) {
        if (d < 0) say(`turn ${turnInfo.turn} step ${sn}: отрицательная пауза ${d}мс — кламп 0`);
        d = 0;
      }
      pauses.push(d);
      flat[i].afterMs = scaleDelay(d, ctx.speed, ctx.maxDelay);
    }
    let idx = 0;
    for (const { seg, block } of stepSegments) {
      const n = block.chunks.length;
      attachDelays(seg, block, flat.slice(idx, idx + n).map((f) => f.afterMs));
      idx += n;
    }
    // Стоп-причина шага → маркер сегмента.
    const finishKind = st?.finishKind ?? null;
    const lastSeg = stepSegments[stepSegments.length - 1].seg;
    if (finishKind === 'max-tokens') {
      if (lastSeg.tool_use) {
        say(`turn ${turnInfo.turn} step ${sn}: max-tokens на tool-call блоке — stopReason пропущен`);
      } else {
        lastSeg.stopReason = 'max_tokens';
      }
    } else if (finishKind === 'tool-calls') {
      if (!lastSeg.tool_use) {
        say(`turn ${turnInfo.turn} step ${sn}: finish tool-calls, но последний блок не tool-call`);
      }
    } else if (finishKind === null) {
      say(`turn ${turnInfo.turn} step ${sn}: нет finish-чанка — стоп-причина end_turn`);
    } else if (finishKind !== 'stop') {
      say(`turn ${turnInfo.turn} step ${sn}: неизвестный finish kind "${finishKind}" — трактован как stop`);
    }
    segments.push(...stepSegments.map((s) => s.seg));
  }
  if (segments.length === 0) return null;

  // delayMs: окно «модель думает» = первый чанк первого блока − step/start.
  const firstChunkT = turnInfo.blocks.find((b) => b.chunks.length > 0)?.chunks[0]?.time;
  const rawDelay = firstChunkT !== undefined && step1 ? firstChunkT - step1.startTime : 0;
  if (rawDelay < 0) say(`turn ${turnInfo.turn}: отрицательный delayMs ${rawDelay}мс — кламп 0`);
  const delayMs = scaleDelay(Math.max(0, rawDelay), ctx.speed, ctx.maxDelay);
  return {
    turn: turnInfo.turn,
    userText,
    delayMs,
    ...(step1 ? { usage: mapUsage(step1.usage) ?? {} } : {}),
    segments,
    chunks: chunkTotal,
    pauses,
  };
}

/**
 * Конвертировать текст session.jsonl в replay-сценарий dsh-fake-llm.
 *
 * @param {string} sessionText - содержимое session.jsonl
 * @param {{name?: string, speed?: number, maxDelay?: number, turns?: Set<number>|null,
 *          source?: string, warn?: (msg: string) => void}} [options]
 *     speed — множитель пауз (1 = как записано); maxDelay — потолок паузы (мс);
 *     turns — множество номеров ходов (1-based) для включения, null = все.
 * @returns {{scenario: object, stats: {turns: number, blocks: number, chunks: number,
 *            pauses: {min: number, median: number, mean: number, max: number},
 *            warnings: string[], summary: string}}}
 * @throws {Error} если ходы не найдены или опции невалидны
 */
export function convertSessionToReplay(sessionText, options = {}) {
  const {
    name,
    speed = 1,
    maxDelay = Infinity,
    turns = null,
    source = '',
    warn = () => {},
  } = options;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`--speed должен быть положительным числом (получено ${speed})`);
  if (maxDelay !== null && maxDelay !== undefined && (!Number.isFinite(maxDelay) || maxDelay <= 0)) {
    throw new Error(`--max-delay должен быть положительным числом (получено ${maxDelay})`);
  }
  const ceiling = maxDelay ?? Infinity;
  const warnings = [];
  const say = (msg) => {
    warnings.push(msg);
    warn(msg);
  };

  const events = parseEvents(sessionText, say);
  const session = indexSession(events, say);
  const usedBlocks = assignChunksToBlocks(session.blocks, session.chunks, say);

  const turnsMap = new Map();
  for (const b of session.blocks.values()) {
    if (!turnsMap.has(b.turn)) turnsMap.set(b.turn, { turn: b.turn, steps: new Map(), blocks: [] });
    turnsMap.get(b.turn).blocks.push(b);
  }
  for (const st of session.steps.values()) {
    if (!turnsMap.has(st.turn)) turnsMap.set(st.turn, { turn: st.turn, steps: new Map(), blocks: [] });
    turnsMap.get(st.turn).steps.set(st.step, st);
  }

  const ctx = { speed, maxDelay: ceiling, say };
  let built = [];
  for (const t of [...turnsMap.values()].sort((a, b) => a.turn - b.turn)) {
    const turn = buildTurn(t, session.userMessages, ctx);
    if (turn) built.push(turn);
  }
  if (turns) {
    const missing = [...turns].filter((n) => !built.some((t) => t.turn === n));
    if (missing.length > 0) say(`запрошенные ходы не найдены: ${missing.join(', ')}`);
    built = built.filter((t) => turns.has(t.turn));
  }
  if (built.length === 0) throw new Error('в сессии не найдено ходов с блоками для реплея');

  const allPauses = built.flatMap((t) => t.pauses).sort((a, b) => a - b);
  const median = allPauses.length > 0 ? allPauses[Math.floor(allPauses.length / 2)] : 0;
  const mean = allPauses.length > 0 ? allPauses.reduce((s, v) => s + v, 0) / allPauses.length : 0;
  const chunkCount = built.reduce((s, t) => s + t.chunks, 0);
  const sid8 = session.sessionId ? session.sessionId.split('-')[0].slice(0, 8) : 'nosession';
  const generatedAt = new Date().toISOString();
  const sourceLabel = source ? source.split('/').pop() : 'session.jsonl';

  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const scenario = {
    name: name ?? `replay-${sid8}`,
    description:
      `session replay: ${sourceLabel} — ${built.length} ход(ов), ${chunkCount} чанков, ` +
      `медиана паузы ${median}мс, сгенерирован ${generatedAt}`,
    delayMs: built[0].delayMs,
    usage: built[0].usage && Object.keys(built[0].usage).length > 0 ? built[0].usage : zeroUsage,
    replay: {
      kind: 'session-replay',
      source,
      generatedAt,
      speed,
      maxDelay: Number.isFinite(ceiling) ? ceiling : null,
      turnCount: built.length,
      chunkCount,
      turns: built.map((t) => ({
        turn: t.turn,
        userText: t.userText,
        delayMs: t.delayMs,
        ...(t.usage && Object.keys(t.usage).length > 0 ? { usage: t.usage } : {}),
        segments: t.segments,
      })),
    },
  };
  const stats = {
    turns: built.length,
    blocks: usedBlocks,
    chunks: chunkCount,
    pauses: {
      min: allPauses[0] ?? 0,
      median,
      mean: Math.round(mean),
      max: allPauses[allPauses.length - 1] ?? 0,
    },
    warnings,
    summary:
      `ходов ${built.length}, блоков ${usedBlocks}, чанков ${chunkCount}; ` +
      `паузы мс: min ${allPauses[0] ?? 0} / медиана ${median} / средняя ${Math.round(mean)} / max ${allPauses[allPauses.length - 1] ?? 0}; ` +
      `предупреждений ${warnings.length}`,
  };
  return { scenario, stats };
}
