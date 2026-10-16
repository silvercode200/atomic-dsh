/**
 * Диалоговое состояние dsh-fake-llm: сессии, разбор сообщений, выбор сценария.
 *
 * Сессия идентифицируется отпечатком первого пользовательского сообщения
 * (system-промпт не входит: он динамический и ломал бы матчинг продолжений).
 * Внутри одной сессии state хранит имя сценария и индекс следующего сегмента.
 */
import { createHash } from 'node:crypto';

/**
 * Явный маркер сценария в тексте пользователя: "SCENARIO:<name>".
 * Матчится глобально, берётся ПОСЛЕДНЕЕ вхождение (см. detectScenario).
 */
const MARKER_ALL_RE = /SCENARIO[:\s=]+([a-zA-Z0-9_-]+)/gi;

/**
 * Префикс инжектируемого runtime-context-снимка dsh (plugin
 * @deepseek-ai/dsh-system-prompt, form=snapshot): ПОСЛЕ компакции dsh
 * инлайнит свежий снимок контекста ПОСЛЕ интента юзера, и хвост запроса
 * выглядит как [компакт-суммари, интент юзера, снимок]. API-запрос не
 * несёт source-метаданных (снимок неотличим от ввода юзера по ролям) —
 * опознаём по стабильному префиксу продукта и скипаем в lastUserText,
 * иначе детект сценария брал бы текст снимка и маркер SCENARIO:<name>
 * терялся (w4green3: maxtokens -> short, авто-continue не срабатывал).
 */
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context.';

/**
 * Префикс системного промпта title-запроса dsh (session-title-first-prompt-llm):
 * побочный вызов генерации заголовка сессии. Опознаём по системному промпту —
 * user-часть совпадает с якорем реплей-сессии, так что маркер и счётчик ходов
 * тут не работают (см. server.mjs).
 */
const TITLE_SYSTEM_PREFIX = 'Create a concise title';

/**
 * Ключевые слова для авто-выбора сценария (порядок = приоритет).
 * Детерминированный выбор — только через маркер SCENARIO:<name>;
 * ключевые слова — эвристика по последнему тексту пользователя.
 * 'compact' первым: запрос компакции dsh (/compact, авто-компакция) обязан
 * попасть в сценарий compact ДО любых других совпадений — иначе окно
 * компакции схлопывается до мгновенного short.
 */
const KEYWORDS = [
  ['compact', /compact/i],
  ['ctx90', /ctx\s?90|ctx90|90\s?%/i],
  ['subagent', /субагент\w*|subagent\w*/i],
  ['long', /длинн\w*|long\b/i],
  ['tools', /тулзы?|инструмент\w*|\btools?\b|\bbash\b/i],
];

/** Прибавка input_tokens за каждый tool_result в истории (движение ctx-бара). */
export const TOOL_RESULT_TOKEN_GROWTH = 800;

/**
 * Собрать текст из сообщения anthropic-messages (string | массив блоков).
 *
 * @param {any} message
 * @returns {string} склеенный текст text-блоков ('' если текста нет)
 */
export function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Содержит ли сообщение блок tool_result.
 *
 * @param {any} message
 * @returns {boolean}
 */
export function hasToolResult(message) {
  return (
    Array.isArray(message?.content) &&
    message.content.some((b) => b?.type === 'tool_result')
  );
}

/**
 * Текст последнего пользовательского сообщения с текстом (поиск с конца).
 *
 * Пустые и runtime-context-снимки пропускаются: снимок инжектится ПОСЛЕ
 * интента юзера (свежий контекст), но юзерским вводом не является.
 *
 * @param {any[]} messages
 * @returns {string}
 */
export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      const text = textOf(messages[i]);
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith(RUNTIME_CONTEXT_PREFIX)) continue;
      return text;
    }
  }
  return '';
}

/**
 * Текст первого пользовательского сообщения с текстом (якорь сессии).
 *
 * @param {any[]} messages
 * @returns {string}
 */
export function firstUserText(messages) {
  for (const message of messages) {
    if (message?.role === 'user') {
      const text = textOf(message);
      if (text.trim().length > 0) return text;
    }
  }
  return '';
}

/**
 * Ключ сессии: sha256 от якорного текста, первые 16 hex-символов.
 *
 * @param {any[]} messages
 * @returns {string}
 */
export function sessionKey(messages) {
  const anchor = firstUserText(messages);
  return createHash('sha256').update(anchor).digest('hex').slice(0, 16);
}

/**
 * Похоже ли тело запроса на title-запрос dsh (session-title-first-prompt-llm):
 * системный промпт начинается с «Create a concise title…».
 *
 * @param {any} body - распарсенный anthropic-messages запрос
 * @returns {boolean}
 */
export function looksLikeTitleRequest(body) {
  const sys = body?.system;
  const text =
    typeof sys === 'string'
      ? sys
      : Array.isArray(sys)
        ? sys
            .filter((b) => typeof b?.text === 'string')
            .map((b) => b.text)
            .join('\n')
        : '';
  return text.startsWith(TITLE_SYSTEM_PREFIX);
}

/**
 * Посчитать все tool_result-блоки в истории запроса.
 *
 * @param {any[]} messages
 * @returns {number}
 */
export function countToolResults(messages) {
  let count = 0;
  for (const message of messages) {
    if (Array.isArray(message?.content)) {
      count += message.content.filter((b) => b?.type === 'tool_result').length;
    }
  }
  return count;
}

/**
 * Выбрать сценарий по тексту пользователя: маркер -> ключевые слова -> 'short'.
 *
 * Маркер берётся ПОСЛЕДНИЙ из найденных: обычный turn несёт один маркер
 * (поведение неизменно), а запрос компакции инлайнит историю с несколькими
 * маркерами — последний = свежий интент пользователя.
 *
 * @param {string} userText
 * @returns {{name: string, explicit: boolean}} explicit=true, если найден маркер
 */
export function detectScenario(userText) {
  const markers = [...userText.matchAll(MARKER_ALL_RE)];
  if (markers.length > 0) {
    return { name: markers[markers.length - 1][1].toLowerCase(), explicit: true };
  }
  for (const [name, re] of KEYWORDS) {
    if (re.test(userText)) return { name, explicit: false };
  }
  return { name: 'short', explicit: false };
}

/**
 * Хранилище состояний сессий с TTL и ограничением размера.
 *
 * @param {{maxSessions?: number, ttlMs?: number}} [options]
 * @returns {{
 *   get: (key: string) => object | undefined,
 *   set: (key: string, state: object) => void,
 *   size: () => number,
 * }}
 */
// Состояние сессии: { scenarioName, segIndex, awaitingToolResult, stopReason,
// lastSeen }. stopReason = stop_reason последнего ответа; 'max_tokens' —
// признак оборванного хода для продолжения сценария (server.mjs).
export function createSessionStore({ maxSessions = 512, ttlMs = 2 * 60 * 60 * 1000 } = {}) {
  /** @type {Map<string, {scenarioName:string, segIndex:number, awaitingToolResult:boolean, lastSeen:number}>} */
  const sessions = new Map();

  /** Выкинуть просроченные и, если всё ещё больше лимита, самые старые. */
  function gc() {
    const now = Date.now();
    for (const [key, state] of sessions) {
      if (now - state.lastSeen > ttlMs) sessions.delete(key);
    }
    while (sessions.size > maxSessions) {
      let oldestKey = null;
      let oldestSeen = Infinity;
      for (const [key, state] of sessions) {
        if (state.lastSeen < oldestSeen) {
          oldestSeen = state.lastSeen;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      sessions.delete(oldestKey);
    }
  }

  return {
    get(key) {
      const state = sessions.get(key);
      if (!state) return undefined;
      if (Date.now() - state.lastSeen > ttlMs) {
        sessions.delete(key);
        return undefined;
      }
      return state;
    },
    set(key, state) {
      sessions.set(key, { ...state, lastSeen: Date.now() });
      gc();
    },
    size() {
      return sessions.size;
    },
  };
}
