/**
 * JSONL trace logging for spot gate tools (Spot §12 semantics).
 *
 * One line per spot_search/spot_load call in spot/logs/trace.jsonl:
 * {ts, gate, query, status, top, score}. Append-only, best-effort — a
 * logging failure must never break the tool result.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Trace file location (spot/logs/trace.jsonl, next to lib/). */
const TRACE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'trace.jsonl')

let warned = false

/**
 * Append one trace record.
 *
 * @param {object} record - {gate, query, status, top?, score?} — `ts`
 *   is added automatically.
 */
export function trace(record) {
  try {
    mkdirSync(dirname(TRACE_PATH), { recursive: true })
    appendFileSync(TRACE_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`)
  } catch (error) {
    if (!warned) {
      warned = true
      // Surface once on stderr for the harness log; never throw.
      process.stderr.write(`spot: trace write failed: ${String(error?.message ?? error)}\n`)
    }
  }
}
