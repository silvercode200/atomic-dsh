/**
 * Registry loading and validation for the spot plugin.
 *
 * registry.json holds the static cold corpus (hidden builtin tools with
 * TS schema snapshots, lazy MCP servers). Skills are NOT in the file —
 * they are merged at runtime from the live skill catalog
 * ({@link mergeSkillEntries}), because the skill set varies per agent
 * scope while the builtin/MCP corpus is frozen.
 */
import { readFileSync } from 'node:fs'

/** Valid registry entry kinds. */
export const REGISTRY_KINDS = new Set(['tool', 'skill', 'mcp'])

/** Lint rule ids (SP = spot), mirroring Spot §14 OP001–OP010. */
export const LintErrorIds = Object.freeze({
  SP001: 'SP001', // registry is not valid JSON / wrong shape
  SP002: 'SP002', // duplicate id
  SP003: 'SP003', // invalid kind
  SP004: 'SP004', // missing/empty routing text
  SP005: 'SP005', // tool entry without TS snapshot
  SP006: 'SP006', // mcp entry without serverName
  SP007: 'SP007', // hide.json name with no registry tool entry
  SP008: 'SP008', // registry tool missing from hide.json
})

/**
 * Load and structurally validate a registry file.
 *
 * @param {string | URL} path - path to registry.json.
 * @returns {Array<object>} the registry entries.
 * @throws on unreadable file or invalid JSON (SP001-class failure).
 */
export function loadRegistry(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const entries = Array.isArray(raw) ? raw : raw.entries
  if (!Array.isArray(entries)) throw new Error('registry: top-level "entries" array missing')
  return entries
}

/**
 * Validate a parsed registry. Returns (not throws) the problem list so
 * the linter and tests share one verdict source.
 *
 * @param {object} registry - parsed registry ({version, entries}).
 * @returns {Array<{id: string, message: string}>} lint errors ([] = clean).
 */
export function validateRegistry(registry) {
  const errors = []
  const entries = registry?.entries
  if (!Array.isArray(entries)) {
    return [{ id: LintErrorIds.SP001, message: 'registry: top-level "entries" array missing' }]
  }
  const seen = new Set()
  for (const [index, entry] of entries.entries()) {
    const where = `entry[${index}]`
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      errors.push({ id: LintErrorIds.SP001, message: `${where}: missing id` })
      continue
    }
    if (seen.has(entry.id)) {
      errors.push({ id: LintErrorIds.SP002, message: `duplicate id "${entry.id}"` })
    }
    seen.add(entry.id)
    if (!REGISTRY_KINDS.has(entry.kind)) {
      errors.push({ id: LintErrorIds.SP003, message: `"${entry.id}": invalid kind ${JSON.stringify(entry.kind)}` })
    }
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) {
      errors.push({ id: LintErrorIds.SP004, message: `"${entry.id}": missing routing text` })
    }
    if (entry.kind === 'tool') {
      const ts = entry.meta?.tsArgs
      if (typeof ts !== 'string' || ts.trim().length === 0) {
        errors.push({ id: LintErrorIds.SP005, message: `"${entry.id}": tool entry without tsArgs snapshot` })
      }
    }
    if (entry.kind === 'mcp' && typeof entry.meta?.serverName !== 'string') {
      errors.push({ id: LintErrorIds.SP006, message: `"${entry.id}": mcp entry without meta.serverName` })
    }
  }
  return errors
}

/**
 * Project live skill catalog rows (ctx.skills.list output) onto registry
 * entries. Empty skills are dropped; rows already carrying an `id` are
 * passed through untouched (idempotent merge).
 *
 * @param {Array<object>} skills - rows from ctx.skills.list().
 * @returns {Array<object>} synthetic `kind: "skill"` entries.
 */
export function mergeSkillEntries(skills) {
  const out = []
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name : undefined
    if (name === undefined || name.length === 0) continue
    if (typeof skill.id === 'string' && skill.kind === 'skill') {
      out.push(skill)
      continue
    }
    const text = [name, skill.description ?? '', skill.whenToUse ?? '']
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length === 0) continue
    out.push({ id: `skill:${name}`, kind: 'skill', name, text, meta: {} })
  }
  return out
}
