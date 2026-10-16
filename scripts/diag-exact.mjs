#!/usr/bin/env node
// Точный порт SessionLogScanner (dsh-session-persistence-jsonl 0.1.1-rc.2)
// + decodeStorageRecord из @deepseek-ai/dsh-session 0.1.1-rc.2.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
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

class Scanner {
  constructor(headerRecord) {
    // parseHeaderRecord: JSON.parse первой строки
    const s = headerRecord.toString('utf8');
    this.meta = JSON.parse(s.slice(0, s.indexOf('\n') === -1 ? undefined : s.indexOf('\n')));
    this.inputBytes = headerRecord.length;
    this.committedBytes = headerRecord.length;
    this.events = [];
    this.eventLine = 0;
    this.issue = undefined;
  }
  write(chunk) {
    this.inputBytes += chunk.length;
    let lineStart = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, lineStart)) {
      this.consumeEventLine(chunk.subarray(lineStart, nl), this.inputBytes - chunk.length + nl + 1);
      lineStart = nl + 1;
    }
    // фрагмент без \n остаётся — как в оригинале (fragments), упрощаем: не коммитится
    if (lineStart < chunk.length) this.trailing = chunk.length - lineStart;
  }
  consumeEventLine(line, endByte) {
    this.eventLine += 1;
    let decoded;
    try {
      decoded = decodeStorageRecord(JSON.parse(line.toString('utf8')));
    } catch {
      this.issue ??= new Error(`corrupt session log: unparsable committed event at line ${this.eventLine}`);
      return;
    }
    if (this.issue !== undefined) {
      if (decoded.some(e => e.type === 'turn/end')) throw this.issue;
      return;
    }
    const rowStart = this.events.length;
    for (const event of decoded) {
      if (event.seq !== this.events.length) {
        const expected = this.events.length;
        this.events.length = rowStart;
        this.issue = new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);
        if (decoded.some(c => c.type === 'turn/end')) throw this.issue;
        return;
      }
      this.events.push(event);
    }
    this.committedBytes = endByte;
  }
}

const file = process.argv[2];
const buf = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(buf);
if (frames.length === 0) { console.log('NO FRAMES'); process.exit(0); }
const headerPt = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end));
const nl = headerPt.indexOf(10);
const scanner = new Scanner(headerPt.subarray(0, nl + 1));
let issue = null;
for (let i = 1; i < frames.length; i++) {
  const pt = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end));
  try { scanner.write(pt); } catch (e) { issue = e.message; break; }
}
if (!issue && scanner.issue) issue = scanner.issue.message + ' (pending issue)';
const committedAll = scanner.committedBytes === scanner.inputBytes;
console.log(JSON.stringify({
  file,
  frames: frames.length,
  tornStart: tornStart ?? null,
  events: scanner.events.length,
  committedBytes: scanner.committedBytes,
  inputBytes: scanner.inputBytes,
  committedAll,
  issue,
  verdict: issue ? 'FAIL' : (committedAll ? 'OK' : 'FAIL-torn: complete frame contains a torn JSONL record'),
}, null, 0));
