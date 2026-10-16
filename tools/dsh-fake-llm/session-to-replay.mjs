#!/usr/bin/env node
/**
 * Конвертер лога сессии dsh (session.jsonl или session.jsonl.zstd) в
 * replay-сценарий dsh-fake-llm с сохранением таймингов чанков.
 *
 * Сценарий кладётся рядом с обычными (scenarios/) — сервер подаёт N-й
 * записанный ход по N-му маркерному сообщению SCENARIO:<name> (подробности:
 * README.md, раздел «Реплей реальных сессий»).
 *
 * Использование:
 *   node tools/dsh-fake-llm/session-to-replay.mjs <session.jsonl[.zstd]>
 *       [--name <name>] [--speed <mult>] [--turns <список>] [--max-delay <ms>] [--out <file>]
 *
 * Опции:
 *   --name       имя сценария (маркер SCENARIO:<name>); по умолчанию replay-<sid8>
 *   --speed      множитель пауз: 1 = как записано, 0.5 = вдвое быстрее (default 1)
 *   --turns      номера ходов через запятую и диапазонами: 1,3,5-7 (default все)
 *   --max-delay  потолок одной паузы в мс (default без потолка)
 *   --out        файл результата (default stdout); сводка всегда в stderr
 *
 * Пример:
 *   node tools/dsh-fake-llm/session-to-replay.mjs ~/.dsh/sessions/slug/id/session.jsonl.zstd \
 *     --speed 1 --turns 1-3 --out scenarios/replay-stall.json
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { convertSessionToReplay } from './lib/replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * Прочитать сессию: .zst/.zstd распаковывается zstdcat (мультифрейм — нативно).
 *
 * @param {string} inputPath
 * @returns {string}
 */
function readSessionText(inputPath) {
  if (/\.zs(t|td)$/.test(inputPath)) {
    let buf;
    try {
      buf = execFileSync('zstdcat', [inputPath], { maxBuffer: MAX_DECOMPRESSED_BYTES });
    } catch (err) {
      throw new Error(
        `не удалось распаковать ${inputPath} через zstdcat: ${err.message} ` +
          `(проверьте, что zstd установлен: which zstdcat)`,
      );
    }
    return buf.toString('utf8');
  }
  return readFileSync(inputPath, 'utf8');
}

/**
 * Разобрать спецификацию ходов: "1,3,5-7" → Set{1,3,5,6,7}.
 *
 * @param {string} spec
 * @returns {Set<number>}
 * @throws {Error} на пустой или невалидной спецификации
 */
function parseTurnsSpec(spec) {
  const turns = new Set();
  for (const token of spec.split(',')) {
    const m = token.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`--turns: непонятный токен "${token.trim()}" (ожидается N или N-M)`);
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    if (to < from) throw new Error(`--turns: диапазон ${token.trim()} задом наперёд`);
    for (let n = from; n <= to; n++) turns.add(n);
  }
  if (turns.size === 0) throw new Error('--turns: пустой список ходов');
  return turns;
}

/**
 * Точка входа CLI.
 */
function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      speed: { type: 'string', default: '1' },
      turns: { type: 'string' },
      'max-delay': { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (positionals.length !== 1) {
    process.stderr.write('использование: node session-to-replay.mjs <session.jsonl[.zstd]> [опции]\n');
    process.exit(1);
  }
  const inputPath = path.resolve(positionals[0]);
  const speed = Number(values.speed);
  const maxDelay = values['max-delay'] !== undefined ? Number(values['max-delay']) : null;
  const turns = values.turns !== undefined ? parseTurnsSpec(values.turns) : null;

  const text = readSessionText(inputPath);
  const { scenario, stats } = convertSessionToReplay(text, {
    name: values.name,
    speed,
    maxDelay,
    turns,
    source: inputPath,
    warn: (msg) => process.stderr.write(`[session-to-replay] ${msg}\n`),
  });
  const json = `${JSON.stringify(scenario, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(`[session-to-replay] ${stats.summary}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[session-to-replay] ошибка: ${err.message}\n`);
  process.exit(1);
}
