/**
 * JSONL-логгер запросов/ответов dsh-fake-llm.
 *
 * Одна строка на пару запрос/ответ, дневная ротация файлов. Ошибки записи
 * лога не роняют сервер (в stderr), лог — вспомогательный инструмент.
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Создать логгер, пишущий в <dir>/server-YYYYMMDD.jsonl.
 *
 * @param {string} dir
 * @returns {(entry: object) => void}
 */
export function createJsonlLogger(dir) {
  let dirReady = false;
  return function log(entry) {
    try {
      if (!dirReady) {
        mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
      appendFileSync(path.join(dir, `server-${day}.jsonl`), line);
    } catch (err) {
      console.error(`[dsh-fake-llm] log write failed: ${err.message}`);
    }
  };
}
