#!/usr/bin/env node
// auto-repair.mjs — самовосстановление dsh session.jsonl.zstd.
//
// Точный порт SessionLogScanner (dsh-session-persistence-jsonl 0.1.1-rc.2) +
// decodeStorageRecord из @deepseek-ai/dsh-session. Декомпрессия — ТОЛЬКО через
// zstd CLI (node zstdDecompressSync усекает большие кадры ~2MiB — известная
// ловушка; см. reports/session-repair/2026-09-04-session-82a60ef2.md).
//
// Типы повреждений и ремонт:
//   a) интерливинг двух+ писателей (seq-разрыв в committed region):
//      потоковое разделение строк по цепочкам expected; чужой поток отстаёт
//      (rewind) → строки с seq >= точки форка трогаем: поток с МАКСИМАЛЬНЫМ
//      конечным seq = живой (выбор ревизии), строки закрытия старого писателя
//      (step/end, turn/end, session/end-seed) и boot-вставки чужого потока
//      (command/run, permission/preset, sandbox/mode, approval/policy,
//      agent/inbox/spliced, command/done) дропаем.
//   b) torn final frame: обрезка по tornStart; оборванная строка без \n в конце
//      последнего полного кадра дропается (или до-писывается \n, если это
//      полная запись и seq континуален).
//   c) невосстановимые разрывы после разделения → exit 3, файл НЕ пишется.
//
// Перед записью: бэкап оригинала (не перезаписывает существующий), атомарная
// запись (tmp+rename), повторная валидация прочитанного с диска.
//
// Выход: JSON в stdout {status: healthy|repaired|unrepairable|error, file,
// events, detail}; коды 0/0/3/1. Человеческий лог — в
// ${DSH_HOME:-~/.dsh}/logs/session-doctor.log (append, с датой).
//
// Использование: node auto-repair.mjs <file>          (repair/check — heal если бит)
//                node auto-repair.mjs check <file>    (только диагностика, без записи)
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';
import { decodeStorageRecord } from '/home/user/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';

const ZSTD_MAGIC = 0xfd2fb528;
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const LOG_FILE = join(DSH_HOME, 'logs', 'session-doctor.log');
const BACKUP_DIR = join(DSH_HOME, 'session-backups');
const ZSTD_BIN = process.env.ZSTD_BIN || 'zstd';

// Типы строк, которые НЕ являются «рабочим контентом» живого потока:
// boot-события свежего процесса (вклиниваются в чужой лог) и закрывающие
// события старого писателя. drop только когда их seq отстаёт от закоммиченного.
const BOOT_TYPES = new Set(['command/run', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced', 'command/done']);
const CLOSE_TYPES = new Set(['step/end', 'turn/end', 'session/end-seed', 'session/end']);

// ---------------------------------------------------------------------------
// zstd-кадры: структурный скан без декомпрессии (порт diag-exact.mjs)
// ---------------------------------------------------------------------------
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
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
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
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

// Декомпрессия zstd CLI (надёжна на больших кадрах, в отличие от node zlib).
function zstdCliDecompress(input) {
  const res = spawnSync(ZSTD_BIN, ['-d', '-c', '-q'], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
    encoding: null,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = (res.stderr || Buffer.alloc(0)).toString('utf8').slice(0, 300);
    throw new Error(`zstd decompress failed (status ${res.status}): ${err}`);
  }
  return res.stdout;
}

// ---------------------------------------------------------------------------
// Точный порт SessionLogScanner (семантика dsh-session-persistence-jsonl).
// Пишем весь plaintext одним вызовом write(): эквивалентно построчной подаче
// кадров — фрагмент без \n остаётся не закоммиченным (committed < input).
// ---------------------------------------------------------------------------
class Scanner {
  constructor(headerRecord) {
    const s = headerRecord.toString('utf8');
    this.meta = JSON.parse(s.slice(0, s.indexOf('\n') === -1 ? undefined : s.indexOf('\n')));
    this.inputBytes = headerRecord.length;
    this.committedBytes = headerRecord.length;
    this.events = [];
    this.eventLine = 0;
    this.issue = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;
  }
  write(chunk) {
    const chunkStart = this.inputBytes;
    this.inputBytes += chunk.length;
    let lineStart = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
      const fragment = chunk.subarray(lineStart, newline);
      let line = fragment;
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment);
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length);
        this.fragments = [];
        this.fragmentBytes = 0;
      }
      this.consumeEventLine(line, chunkStart + newline + 1);
      lineStart = newline + 1;
    }
    if (lineStart < chunk.length) {
      this.fragments.push(Buffer.from(chunk.subarray(lineStart)));
      this.fragmentBytes += chunk.length - lineStart;
    }
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
      if (decoded.some((e) => e.type === 'turn/end')) throw this.issue;
      return;
    }
    const rowStart = this.events.length;
    for (const event of decoded) {
      if (event.seq !== this.events.length) {
        const expected = this.events.length;
        this.events.length = rowStart;
        this.issue = new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);
        if (decoded.some((c) => c.type === 'turn/end')) throw this.issue;
        return;
      }
      this.events.push(event);
    }
    this.committedBytes = endByte;
  }
  finish() {
    // Не закоммиченный фрагмент без \n — «torn tail». commit останавливается до него.
    return {
      meta: this.meta,
      events: this.events,
      committedBytes: this.committedBytes,
      inputBytes: this.inputBytes,
      issue: this.issue,
      tornTail: this.fragmentBytes > 0 ? this.inputBytes - this.committedBytes : 0,
    };
  }
}

// Полный скан plaintext (header-строка отдельно, тело — остальное).
function scanWholePlaintext(pt) {
  const nl = pt.indexOf(10);
  if (nl === -1) return { invalid: 'no newline / header-less' };
  const headerRecord = pt.subarray(0, nl + 1);
  const body = pt.subarray(nl + 1);
  const sc = new Scanner(headerRecord);
  let thrown = null;
  try {
    sc.write(body);
  } catch (e) {
    thrown = e.message;
  }
  const fin = sc.finish();
  const healthy = thrown === null && fin.issue === undefined && fin.tornTail === 0 && fin.committedBytes === fin.inputBytes;
  return {
    healthy,
    events: fin.events.length,
    committedBytes: fin.committedBytes,
    inputBytes: fin.inputBytes,
    tornTail: fin.tornTail,
    issue: thrown ?? fin.issue?.message ?? null,
    headerRecord,
  };
}

// ---------------------------------------------------------------------------
// Классификация одной строки тела (уже без заголовка).
// ---------------------------------------------------------------------------
function classifyLine(lineBuf) {
  let decoded;
  try {
    decoded = decodeStorageRecord(JSON.parse(lineBuf.toString('utf8')));
  } catch {
    return { unparsable: true };
  }
  if (decoded.length === 0) return { empty: true };
  let allBoot = true;
  let allClose = true;
  for (const e of decoded) {
    if (!BOOT_TYPES.has(e.type)) allBoot = false;
    if (!CLOSE_TYPES.has(e.type)) allClose = false;
    if (!allBoot && !allClose) break;
  }
  return {
    firstSeq: decoded[0].seq,
    count: decoded.length,
    allBoot,
    allClose,
  };
}

// ---------------------------------------------------------------------------
// Проход ремонта: потоковое разделение по ожидаемым seq.
// Возвращает kept-строки (Buffer[]), статистику и признак невосстановимости.
// ---------------------------------------------------------------------------
function repairBodyLines(bodyLines) {
  // bodyLines: {buf: Buffer, nl: boolean, idx} — строки тела в порядке файла.
  let expected = 0; // следующий seq непрерывной «живой» цепочки
  const kept = []; // индексы строк, оставляемых в логе
  const drops = []; // {idx, why}
  const truncs = []; // {idx, from, to} — строки усечённые форком (seq >= точки форка)
  let unrepairable = null;

  for (let i = 0; i < bodyLines.length; i++) {
    const info = classifyLine(bodyLines[i].buf);
    if (info.unparsable) { drops.push({ idx: i, why: 'unparsable' }); continue; }
    if (info.empty) { drops.push({ idx: i, why: 'empty' }); continue; }
    const { firstSeq: f, count: n, allBoot, allClose } = info;

    if (f === expected) {
      kept.push(i);
      expected += n;
    } else if (f < expected) {
      // Отстающая строка: чужой/старый поток.
      if (allBoot) { drops.push({ idx: i, why: 'boot' }); continue; }
      if (allClose) { drops.push({ idx: i, why: 'closing' }); continue; }
      // Rewind-продолжение: новый писатель начал с f (< уже закоммиченного).
      // Усекаем цепочку до точки форка (строки с seq >= f), дальше — его поток.
      while (kept.length > 0) {
        const li = kept[kept.length - 1];
        const m = classifyLine(bodyLines[li].buf);
        if (m.firstSeq >= f) {
          kept.pop();
          truncs.push({ idx: li, to: f });
          expected -= m.count;
        } else break;
      }
      if (f !== expected) {
        // Частичное перекрытие строки с seq-диапазоном, пересекающим форк — невосстановимо.
        unrepairable = `rewind to seq ${f} overlaps committed chain ending at ${expected}`;
        break;
      }
      kept.push(i);
      expected += n;
    } else {
      // Прямой разрыв (f > expected): пропущены события. Интерливинг-дропами
      // это не лечится — отступаемся (spec c).
      unrepairable = `seq gap at line ${i}: expected ${expected}, got ${f}`;
      break;
    }
  }

  if (unrepairable !== null) return { unrepairable, kept, drops, truncs, expected };
  return { unrepairable: null, kept, drops, truncs, expected };
}

// ---------------------------------------------------------------------------
// Вспомогательные
// ---------------------------------------------------------------------------
function logLine(msg) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
  } catch { /* лог не должен ронять ремонт */ }
}

function emit(status, filePath, events, detail, code) {
  const out = { status, file: filePath, events, detail };
  process.stdout.write(JSON.stringify(out) + '\n');
  if (status !== 'healthy') {
    logLine(`${status} ${filePath} events=${events} detail=${String(detail).slice(0, 300)}`);
  } else {
    logLine(`healthy ${filePath} events=${events}`);
  }
  return { code };
}

function backupPathFor(filePath) {
  // id: имя сессионной директории (encodeSegment(id)); ищем от файла вверх.
  const parent = dirname(filePath);
  const idSeg = parent.split(/[\\/]/).pop() || 'session';
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const base = join(BACKUP_DIR, `${idSeg}.${date}`);
  if (!existsSync(`${base}.bak`)) return `${base}.bak`;
  let k = 2;
  while (existsSync(`${base}.${k}.bak`)) k += 1;
  return `${base}.${k}.bak`;
}

// ---------------------------------------------------------------------------
// Основной поток
// ---------------------------------------------------------------------------
function load(filePath) {
  const buf = readFileSync(filePath);
  const { frames, tornStart } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error('no zstd frames');
  const headerFrame = buf.subarray(frames[0].start, frames[0].end);
  // Декомпрессия префикса ПОЛНЫХ кадров (torn-хвост отбрасываем).
  const completeBytes = tornStart === undefined ? buf : buf.subarray(0, tornStart);
  const pt = zstdCliDecompress(completeBytes);
  return { buf, frames, tornStart, pt, headerFrame };
}

function splitBody(pt) {
  const nl = pt.indexOf(10);
  if (nl === -1) return { headerRecord: null, lines: [] };
  const headerRecord = pt.subarray(0, nl + 1);
  const body = pt.subarray(nl + 1);
  const lines = [];
  let ls = 0;
  while (ls < body.length) {
    const i = body.indexOf(10, ls);
    if (i === -1) {
      lines.push({ buf: body.subarray(ls, body.length), nl: false, idx: lines.length });
      break;
    }
    lines.push({ buf: body.subarray(ls, i + 1), nl: true, idx: lines.length });
    ls = i + 1;
  }
  return { headerRecord, lines };
}

function runRepair(filePath, doWrite) {
  try {
    const { buf: origBuf, frames, tornStart, pt } = load(filePath);
    const scan = scanWholePlaintext(pt);

    if (scan.invalid) {
      // Пустой/битый файл без заголовка — нельзя даже идентифицировать сессию.
      return emit('error', filePath, 0, scan.invalid, 1);
    }

    if (scan.healthy && tornStart === undefined) {
      return emit('healthy', filePath, scan.events, 'log is valid', 0);
    }

    // ---- повреждён: определяем тип и чиним ----
    const { headerRecord, lines } = splitBody(pt);
    const res = repairBodyLines(lines);
    if (res.unrepairable !== null) {
      return emit('unrepairable', filePath, scan.events, res.unrepairable, 3);
    }

    const changed = res.drops.length > 0 || res.truncs.length > 0 || tornStart !== undefined || scan.tornTail > 0;
    if (!changed) {
      const detail = `damaged but nothing recoverable: ${scan.issue ?? 'committed!=input'}`;
      return emit('unrepairable', filePath, scan.events, detail, 3);
    }

    if (!doWrite) {
      const detail = `would repair: drop ${res.drops.length} (boot/closing/dup), truncate ${res.truncs.length} rewind rows, torn-frame=${tornStart !== undefined}, tornTail=${scan.tornTail}B`;
      return emit('repaired', filePath, res.expected, detail, 0);
    }

    // ---- сборка нового тела ----
    const keptBufs = [];
    for (const i of res.kept) {
      keptBufs.push(lines[i].buf);
      if (!lines[i].nl) keptBufs.push(Buffer.from('\n')); // фрагмент без \n — до-писываем
    }
    const newBody = Buffer.concat(keptBufs);

    // Повторная валидация собранного тела до записи (анти-театр: реальная проверка).
    const rebuiltPt = Buffer.concat([headerRecord, newBody]);
    const rebuiltScan = scanWholePlaintext(rebuiltPt);
    if (!rebuiltScan.healthy || rebuiltScan.events !== res.expected) {
      const why = rebuiltScan.issue ?? `committed ${rebuiltScan.committedBytes}/${rebuiltScan.inputBytes}`;
      return emit('unrepairable', filePath, scan.events, `rebuilt log invalid: ${why}`, 3);
    }

    // Файл мог измениться с момента чтения (активный писатель) — не пишем поверх.
    if (!existsSync(filePath)) return emit('error', filePath, 0, 'file disappeared during repair', 1);
    try {
      const cur = statSync(filePath);
      if (cur.size !== origBuf.length) {
        return emit('error', filePath, 0, 'file changed during repair; retry', 1);
      }
    } catch { /* stat не удался — ниже разберёмся при записи */ }

    // ---- бэкап + атомарная запись ----
    try { mkdirSync(BACKUP_DIR, { recursive: true }); } catch { /* ignore */ }
    const bak = backupPathFor(filePath);
    try {
      writeFileSync(bak, origBuf, { flag: 'wx' });
    } catch (e) {
      return emit('error', filePath, 0, `cannot write backup ${bak}: ${e.message}`, 1);
    }

    const CHUNK = 256 * 1024;
    const outFrames = [frames.length > 0 ? origBuf.subarray(frames[0].start, frames[0].end) : Buffer.alloc(0)];
    for (let o = 0; o < newBody.length; o += CHUNK) {
      const chunk = newBody.subarray(o, o + CHUNK);
      // Без params: валидный checksumFlag для чтения dsh — референс-пересборка
      // repair-session.mjs (рабочий, проверен реальным resume).
      outFrames.push(zstdCompressSync(chunk));
    }
    const outFile = Buffer.concat(outFrames);

    const tmp = `${filePath}.doctor-tmp-${process.pid}`;
    writeFileSync(tmp, outFile);
    renameSync(tmp, filePath);

    // ---- повторная валидация прочитанного с диска ----
    let post;
    try {
      post = load(filePath);
    } catch (e) {
      // откат: вернуть оригинал (бэкап уже есть)
      try { renameSync(bak, filePath); } catch { /* ignore */ }
      return emit('error', filePath, 0, `post-write read failed: ${e.message}`, 1);
    }
    const postScan = scanWholePlaintext(post.pt);
    if (!postScan.healthy || post.tornStart !== undefined) {
      try { renameSync(bak, filePath); } catch { /* ignore */ }
      const why = postScan.issue ?? 'invalid after write';
      return emit('error', filePath, 0, `post-write invalid: ${why}`, 1);
    }

    const detailBits = [];
    if (res.truncs.length) detailBits.push(`fork-truncated ${res.truncs.length} rewind row(s)`);
    if (res.drops.length) detailBits.push(`dropped ${res.drops.length} foreign row(s)`);
    if (tornStart !== undefined) detailBits.push(`torn frame truncated at byte ${tornStart}`);
    if (scan.tornTail > 0) detailBits.push(`torn tail (+${scan.tornTail}B) resolved`);
    return emit('repaired', filePath, postScan.events, `${detailBits.join('; ')}; backup=${bak}`, 0);
  } catch (e) {
    return emit('error', filePath, 0, e.message, 1);
  }
}

// ---- разбор argv ----
const argv = process.argv.slice(2);
let doWrite = true;
let filePath = argv[0];
if (argv[0] === 'check') {
  doWrite = false;
  filePath = argv[1];
} else if (argv[0] === 'repair') {
  filePath = argv[1];
}
if (!filePath) {
  process.stdout.write(JSON.stringify({ status: 'error', file: null, events: 0, detail: 'usage: auto-repair.mjs [check|repair] <file>' }) + '\n');
  process.exit(1);
}

const res = runRepair(filePath, doWrite);
if (res && typeof res.code === 'number') process.exit(res.code);
process.exit(0);
