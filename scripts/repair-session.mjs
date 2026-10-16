#!/usr/bin/env node
// Ремонт session.jsonl.zstd dsh: удаляет конфликтные строки двойной записи,
// проверяет результат точным портом SessionLogScanner и пересобирает лог.
// Использование: node repair-session.mjs <file.zst> <out.zst> --drop <lineIdxCsv>
// lineIdx — 0-based индексы СТРОК ПОСЛЕ header-строки (т.е. события).
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import { decodeStorageRecord } from '/home/user/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';

const ZSTD_MAGIC = 0xfd2fb528;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
      throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

// ---- Разбор аргументов ----
const [file, out, , dropCsv] = process.argv.slice(2);
const dropSet = new Set((dropCsv ?? '').split(',').filter(Boolean).map(Number));

const buf = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(buf);
if (tornStart !== undefined) { console.error('torn final frame — этот скрипт не для этого случая'); process.exit(2); }

// Полный plaintext + границы строк
let parts = [];
for (const f of frames) parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
const pt = Buffer.concat(parts);
const nl = pt.indexOf(10);
const headerRecord = pt.subarray(0, nl + 1); // header-строка с \n
const body = pt.subarray(nl + 1);

// Список строк тела (каждая с \n, кроме возможного хвоста без \n)
const lines = [];
let ls = 0;
while (ls < body.length) {
  const i = body.indexOf(10, ls);
  if (i === -1) { lines.push({ start: ls, end: body.length, nl: false }); break; }
  lines.push({ start: ls, end: i + 1, nl: true });
  ls = i + 1;
}

// Проверка: dropped индексы и их содержимое
for (const idx of dropSet) {
  const l = lines[idx];
  if (!l) { console.error(`line ${idx} not found`); process.exit(2); }
  const raw = body.subarray(l.start, l.end).toString('utf8');
  let seq, type;
  try { const o = JSON.parse(raw); seq = o.seq; type = o.type; } catch { seq = '?'; type = 'PARSE-FAIL'; }
  console.log(`drop line[${idx}]: seq=${seq} type=${type}`);
}

// Пересборка plaintext: header + все строки кроме dropped
const kept = [];
for (let i = 0; i < lines.length; i++) if (!dropSet.has(i)) kept.push(body.subarray(lines[i].start, lines[i].end));
const newBody = Buffer.concat(kept);
const newPt = Buffer.concat([headerRecord, newBody]);

// ---- Точная валидация (порт SessionLogScanner) ----
class Scanner {
  constructor(headerRecord) {
    const s = headerRecord.toString('utf8');
    this.meta = JSON.parse(s.slice(0, s.indexOf('\n')));
    this.inputBytes = headerRecord.length;
    this.committedBytes = headerRecord.length;
    this.events = [];
    this.eventLine = 0;
    this.issue = undefined;
  }
  write(chunk) {
    this.inputBytes += chunk.length;
    let lineStart = 0;
    for (let n = chunk.indexOf(10); n !== -1; n = chunk.indexOf(10, lineStart)) {
      this.consumeEventLine(chunk.subarray(lineStart, n), this.inputBytes - chunk.length + n + 1);
      lineStart = n + 1;
    }
  }
  consumeEventLine(line, endByte) {
    this.eventLine += 1;
    let decoded;
    try { decoded = decodeStorageRecord(JSON.parse(line.toString('utf8'))); }
    catch { this.issue ??= new Error(`unparsable committed event at line ${this.eventLine}`); return; }
    if (this.issue !== undefined) {
      if (decoded.some(e => e.type === 'turn/end')) throw this.issue;
      return;
    }
    const rowStart = this.events.length;
    for (const event of decoded) {
      if (event.seq !== this.events.length) {
        const expected = this.events.length;
        this.events.length = rowStart;
        this.issue = new Error(`seq gap at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);
        if (decoded.some(c => c.type === 'turn/end')) throw this.issue;
        return;
      }
      this.events.push(event);
    }
    this.committedBytes = endByte;
  }
}

const scanner = new Scanner(headerRecord);
let err = null;
try { scanner.write(newBody); } catch (e) { err = e.message; }
const ok = !err && !scanner.issue && scanner.committedBytes === scanner.inputBytes;
console.log(`validation: events=${scanner.events.length} committed=${scanner.committedBytes}/${scanner.inputBytes} issue=${err ?? scanner.issue?.message ?? 'none'}`);
if (!ok) { console.error('REPAIRED LOG STILL INVALID — aborting, nothing written'); process.exit(1); }

// ---- Пересборка файла: frame0 (header, исходные байты) + новые фреймы тела ----
const headerFrame = buf.subarray(frames[0].start, frames[0].end);
const CHUNK = 256 * 1024;
const outFrames = [headerFrame];
for (let o = 0; o < newBody.length; o += CHUNK) {
  outFrames.push(zstdCompressSync(newBody.subarray(o, o + CHUNK)));
}
writeFileSync(out, Buffer.concat(outFrames));
console.log(`written: ${out} (${outFrames.length} frames, body ${newBody.length}B, dropped ${dropSet.size} lines)`);
