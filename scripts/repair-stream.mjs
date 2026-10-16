#!/usr/bin/env node
// Ремонт интерливинг-повреждения session.jsonl.zstd: два писателя писали
// построчно в один лог. Оставляем один непрерывный поток (stream A),
// дропая строки чужого потока. Политика:
//   - строка разворачивается в события, первое из которых == expected → коммит
//   - первое < expected (дубль) → дроп
//   - первое > expected (чужой поток/пропуск) → дроп, БЕЗ продвижения expected
// В конце — точная валидация портом SessionLogScanner.
// Использование: node repair-stream.mjs <in.zst> <out.zst>
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
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset); offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved bit at ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6, singleSegment = (descriptor & 32) !== 0,
      checksum = (descriptor & 4) !== 0, dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const bh = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (bh & 1) !== 0, blockType = bh >>> 1 & 3, blockSize = bh >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      offset += blockType === 1 ? 1 : blockSize;
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

const [file, out] = process.argv.slice(2);
const buf = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(buf);
if (tornStart !== undefined) { console.error('torn final frame — не этот случай'); process.exit(2); }

let parts = [];
for (const f of frames) parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
const pt = Buffer.concat(parts);
const nl = pt.indexOf(10);
const headerRecord = pt.subarray(0, nl + 1);
const body = pt.subarray(nl + 1);

const lines = [];
let ls = 0;
while (ls < body.length) {
  const i = body.indexOf(10, ls);
  if (i === -1) { lines.push({ start: ls, end: body.length, nl: false }); break; }
  lines.push({ start: ls, end: i + 1, nl: true });
  ls = i + 1;
}
console.log(`lines after header: ${lines.length}`);

// ---- Поточное разделение ----
let expected = 0;
const kept = [], dropped = [];
let dupCount = 0, foreignCount = 0;
for (let i = 0; i < lines.length; i++) {
  const raw = body.subarray(lines[i].start, lines[i].end);
  let decoded;
  try { decoded = decodeStorageRecord(JSON.parse(raw.toString('utf8'))); }
  catch { dropped.push({ i, why: 'unparsable' }); continue; }
  if (decoded.length === 0) { dropped.push({ i, why: 'empty' }); continue; }
  const first = decoded[0].seq;
  if (first === expected) {
    kept.push(raw); expected += decoded.length;
  } else if (first < expected) {
    dropped.push({ i, why: `dup first=${first} expected=${expected}` }); dupCount++;
  } else {
    dropped.push({ i, why: `foreign first=${first} expected=${expected} type=${decoded[0].type}` }); foreignCount++;
  }
}
console.log(`kept=${kept.length} dropped=${dropped.length} (dup=${dupCount}, foreign=${foreignCount}) finalExpected=${expected}`);
console.log('dropped detail:');
for (const d of dropped) console.log(`  line[${d.i}]: ${d.why}`);
const newBody = Buffer.concat(kept);
const newPt = Buffer.concat([headerRecord, newBody]);

// ---- Точная валидация ----
class Scanner {
  constructor(hr) {
    const s = hr.toString('utf8');
    this.meta = JSON.parse(s.slice(0, s.indexOf('\n')));
    this.inputBytes = hr.length; this.committedBytes = hr.length;
    this.events = []; this.eventLine = 0; this.issue = undefined;
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
    catch { this.issue ??= new Error(`unparsable at line ${this.eventLine}`); return; }
    if (this.issue !== undefined) { if (decoded.some(e => e.type === 'turn/end')) throw this.issue; return; }
    const rowStart = this.events.length;
    for (const event of decoded) {
      if (event.seq !== this.events.length) {
        this.events.length = rowStart;
        this.issue = new Error(`seq gap at line ${this.eventLine} (expected ${this.events.length}, got ${event.seq})`);
        if (decoded.some(c => c.type === 'turn/end')) throw this.issue;
        return;
      }
      this.events.push(event);
    }
    this.committedBytes = endByte;
  }
}
const sc = new Scanner(headerRecord);
let err = null;
try { sc.write(newBody); } catch (e) { err = e.message; }
const ok = !err && !sc.issue && sc.committedBytes === sc.inputBytes;
console.log(`validation: events=${sc.events.length} committed=${sc.committedBytes}/${sc.inputBytes} issue=${err ?? sc.issue?.message ?? 'none'}`);
if (!ok) { console.error('INVALID — nothing written'); process.exit(1); }

// ---- Пересборка ----
const headerFrame = buf.subarray(frames[0].start, frames[0].end);
const CHUNK = 256 * 1024;
const outFrames = [headerFrame];
for (let o = 0; o < newBody.length; o += CHUNK)
  outFrames.push(zstdCompressSync(newBody.subarray(o, o + CHUNK), { params: { checksumFlag: 1 } }));
writeFileSync(out, Buffer.concat(outFrames));
console.log(`written: ${out} (${outFrames.length} frames, body ${newBody.length}B)`);
