/**
 * Environment-driven configuration for dsh-fake-llm.
 *
 * Все параметры берутся из env со значениями по умолчанию; пути по умолчанию
 * резолвятся относительно корня инструмента (не cwd), чтобы сервер можно было
 * запускать из любой директории репозитория.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень инструмента tools/dsh-fake-llm/ (каталог выше lib/). */
export const TOOL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Прочитать число из env; нечисловое/отрицательное значение -> fallback.
 *
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Собрать конфиг сервера из окружения.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   host: string, port: number, deltaMs: number, chunkChars: number,
 *   streamTotalMs: number, usageScale: number, heartbeatMs: number,
 *   scenariosDir: string, logDir: string, maxSessions: number, sessionTtlMs: number,
 * }}
 */
export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: Math.trunc(numOr(env.PORT, 8787)),
    // Задержка между дельтами (мс) — задаёт реалистичный tps стрима.
    deltaMs: numOr(env.DELTA_MS, 25),
    // Размер одного куска текста в символах на одну дельту.
    chunkChars: Math.max(1, Math.trunc(numOr(env.CHUNK_CHARS, 4))),
    // Бюджет длительности сценария 'long' (мс от начала ответа).
    streamTotalMs: numOr(env.STREAM_TOTAL_MS, 150000),
    // Множитель usage-чисел сценария — двигает ctx-бар/comp-поле.
    usageScale: numOr(env.FAKE_USAGE_SCALE, 1),
    // Heartbeat-комментарии SSE (": ping"), 0 = выключено.
    heartbeatMs: numOr(env.HEARTBEAT_MS, 0),
    scenariosDir: env.SCENARIOS_DIR || path.join(TOOL_ROOT, 'scenarios'),
    logDir: env.LOG_DIR || path.join(TOOL_ROOT, 'logs'),
    maxSessions: Math.max(1, Math.trunc(numOr(env.MAX_SESSIONS, 512))),
    sessionTtlMs: numOr(env.SESSION_TTL_MS, 2 * 60 * 60 * 1000),
  };
}
