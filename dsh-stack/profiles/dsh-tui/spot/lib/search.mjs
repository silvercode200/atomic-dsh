/**
 * Spot scoring engine — keyword search over the cold registry
 * (Spot MCP v1.2 §9.2: Jaccard similarity over normalized token sets).
 *
 * Normalization pipeline: NFKC → lowercase → strip ru+en stopwords →
 * tokenize on non-letter/digit runs → light stemming (ru inflection
 * endings, en plural "s"). The score combines Jaccard with query
 * coverage (|q∩e|/|q|): pure Jaccard is too harsh when an entry's
 * routing text legitimately carries more keywords than the query, so
 * the effective score is max(jaccard, coverage) — a query whose every
 * content token appears in an entry is a found, even if the entry also
 * lists synonyms the query did not use.
 */

/** Answer statuses, mirroring Spot's success/clarification_needed/unknown. */
export const STATUS_FOUND = 'found'
export const STATUS_CLARIFICATION = 'clarification'
export const STATUS_UNKNOWN = 'unknown'

export const FOUND_THRESHOLD = 0.7
export const CLARIFICATION_THRESHOLD = 0.4

/** Max candidates returned with a clarification answer. */
const MAX_CANDIDATES = 5

/**
 * Ru+en stopwords plus generic intent words that carry no routing signal
 * (найти, нужен, tool, …). Removing them keeps short queries from
 * matching every entry through filler tokens.
 */
export const STOPWORDS = new Set([
  // English (Spot §9.2 baseline)
  'the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'that', 'this', 'it', 'i', 'me', 'my', 'you', 'your', 'we', 'us',
  // Russian
  'в', 'во', 'и', 'на', 'с', 'со', 'по', 'для', 'от', 'до', 'из', 'к', 'у', 'о', 'об', 'не', 'ни', 'но', 'а', 'да', 'же', 'ли', 'бы', 'то', 'как', 'что', 'чтобы', 'это', 'этот', 'эта', 'эти', 'так', 'также', 'или', 'если', 'при', 'за', 'без', 'под', 'над',
  // Generic intent filler (both languages)
  'найти', 'найди', 'ищи', 'искать', 'нужен', 'нужна', 'нужно', 'нужны', 'хочу', 'хотел', 'сделай', 'дай', 'покажи', 'tool', 'тул', 'инструмент', 'функция', 'функцию', 'вызвать', 'вызови', 'call', 'use', 'want', 'need', 'find', 'get', 'сделать',
])

/** Russian inflection vowels endings stripped by the light stemmer. */
const RU_VOWEL_ENDINGS = new Set('аеёиоуыэюяьй'.split(''))

/**
 * Light Russian stemmer: strip up to two trailing vowel/soft-sign
 * characters while the stem stays ≥3 chars. Maps цель/цели/целей/целью
 * and задача/задачи/задач to the same stem without a full Porter table.
 *
 * @param {string} word - the lowercase word to stem.
 * @returns {string} the stemmed word.
 */
function stemRu(word) {
  let out = word
  for (let round = 0; round < 2; round += 1) {
    if (out.length <= 3) break
    const last = out[out.length - 1]
    if (!RU_VOWEL_ENDINGS.has(last)) break
    out = out.slice(0, -1)
  }
  return out
}

/**
 * Light English stemmer: strip one trailing plural "s" (goals → goal).
 *
 * @param {string} word - the lowercase word to stem.
 * @returns {string} the stemmed word.
 */
function stemEn(word) {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * Tokenize a free-text query or routing text into a stemmed, stopword-free
 * token set. Cyrillic is a first-class citizen (test: «найти тул для
 * задач/целей» → {задач, цел}).
 *
 * @param {string} text - the text to tokenize.
 * @returns {Set<string>} stemmed content tokens.
 */
export function tokenize(text) {
  const out = new Set()
  if (typeof text !== 'string') return out
  for (const raw of text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue
    const word = raw.length > 1 && raw.endsWith('s') && !/[\p{Script=Cyrillic}]/u.test(raw)
      ? stemEn(raw)
      : raw
    if (STOPWORDS.has(raw) || STOPWORDS.has(word)) continue
    const stemmed = /[\p{Script=Cyrillic}]/u.test(word) ? stemRu(word) : word
    if (stemmed.length === 0 || STOPWORDS.has(stemmed)) continue
    out.add(stemmed)
  }
  return out
}

/**
 * Jaccard similarity |a∩b| / |a∪b| (Spot §9.2 formula).
 *
 * @param {Set<string>} a - first token set.
 * @param {Set<string>} b - second token set.
 * @returns {number} similarity in [0, 1].
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * Query coverage |q∩e| / |q| — the fraction of query content tokens the
 * entry's routing text carries.
 *
 * @param {Set<string>} query - query token set.
 * @param {Set<string>} entry - entry token set.
 * @returns {number} coverage in [0, 1].
 */
export function coverage(query, entry) {
  if (query.size === 0) return 0
  let inter = 0
  for (const token of query) if (entry.has(token)) inter += 1
  return inter / query.size
}

/** Token-set cache keyed by entry identity — routing text is immutable. */
const tokenCache = new WeakMap()

/**
 * Tokenize one registry entry's routing text (cached).
 *
 * @param {object} entry - registry entry ({id, kind, name, text}).
 * @returns {Set<string>} entry tokens.
 */
function entryTokens(entry) {
  let tokens = tokenCache.get(entry)
  if (tokens === undefined) {
    tokens = tokenize(`${entry.name} ${entry.text ?? ''}`)
    tokenCache.set(entry, tokens)
  }
  return tokens
}

/**
 * Score one entry against a tokenized query.
 *
 * @param {Set<string>} queryTokens - tokenized query.
 * @param {object} entry - registry entry.
 * @returns {{jaccard: number, coverage: number, score: number}} components;
 *   score = max(jaccard, coverage).
 */
export function scoreEntry(queryTokens, entry) {
  const tokens = entryTokens(entry)
  const j = jaccard(queryTokens, tokens)
  const c = coverage(queryTokens, tokens)
  return { jaccard: j, coverage: c, score: Math.max(j, c) }
}

/**
 * Explicit name match: the query (or one of its raw words) equals the
 * entry's tool/server/skill name, e.g. `ralph`, `web_search`, `tavily`.
 *
 * @param {string} query - the raw query string.
 * @param {object} entry - registry entry.
 * @returns {boolean} true on an exact whole-name match.
 */
/** Escape regex metacharacters — skill/tool names like `c++`, `task(1)` must not build invalid or over-matching patterns. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function explicitNameMatch(query, entry) {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return false
  const name = String(entry.name ?? '').toLowerCase()
  if (name.length === 0) return false
  if (needle === name) return true
  // whole-word occurrence inside a longer query ("use ralph please")
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}([^\\p{L}\\p{N}_]|$)`, 'u').test(needle)
}

/**
 * Search the registry for an intent query (Spot §9.1 routing, reranker
 * step only — no param resolution, the model calls tools directly).
 *
 * Status mapping (Spot §9.1 step 5): score ≥ 0.7 (or an explicit name
 * match) → found; 0.4–0.69 → clarification with candidates; < 0.4 →
 * unknown with the list of registry categories.
 *
 * @param {Array<object>} entries - registry entries ({id, kind, name, text}).
 * @param {string} query - the natural-language intent.
 * @returns {{status: string, top?: {entry: object, score: number}, candidates: Array<object>}}
 *   routing decision (top/candidates carry {entry, score} pairs).
 */
export function search(entries, query) {
  const queryTokens = tokenize(query)

  const ranked = entries
    .map((entry) => {
      const { score } = scoreEntry(queryTokens, entry)
      const explicit = queryTokens.size > 0 && explicitNameMatch(String(query ?? ''), entry)
      return { entry, score: explicit ? 1 : score, explicit }
    })
    .filter((item) => item.score > 0)
    // Deterministic order: score desc, then fewer routing tokens (more
    // focused entry), then id — ties resolve stably across sessions.
    .sort((left, right) =>
      right.score - left.score
      || entryTokens(left.entry).size - entryTokens(right.entry).size
      || String(left.entry.id).localeCompare(String(right.entry.id)))

  if (ranked.length === 0) {
    return {
      status: STATUS_UNKNOWN,
      top: undefined,
      candidates: [],
      categories: [...new Set(entries.map((entry) => entry.kind))],
    }
  }

  const top = ranked[0]
  const candidates = ranked.slice(0, MAX_CANDIDATES)
  if (top.score >= FOUND_THRESHOLD) {
    return { status: STATUS_FOUND, top, candidates }
  }
  if (top.score >= CLARIFICATION_THRESHOLD) {
    return { status: STATUS_CLARIFICATION, top, candidates }
  }
  return {
    status: STATUS_UNKNOWN,
    top: undefined,
    candidates: [],
    categories: [...new Set(entries.map((entry) => entry.kind))],
  }
}
