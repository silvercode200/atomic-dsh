/**
 * schemaDelivery: "message" support (profile-local fork).
 *
 * WHY: Code Mode renders every registered tool's schema into the frozen
 * `tools:sdk` system-prompt section. A lazy MCP server registers its tools
 * on activation, so every activate/release rewrites that section and busts
 * the prompt cache ("chessboard" cache pattern).
 *
 * In "message" mode the server's tools are still REGISTERED (they stay in
 * the tools runtime's visible map, so `run_code` SDK calls keep working),
 * but their names are added to the same hide list the patched dsh-tools
 * renderer reads (`spot/hide.json`, re-read on every render by the b2
 * patch helper `dshPatchHiddenTools()`). The renderer then produces the
 * exact bytes it would produce without those tools — byte-stable system
 * prompt whether the server is active or not.
 *
 * The schemas reach the model as a tool-result MESSAGE instead: the
 * activate tool (and the router's search_and_activate path) appends a
 * TS SDK snapshot (ToolArgsMap/ToolOutputMap members) rendered with the
 * same helpers dsh-tools itself uses.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsonSchemaToTs } from '@deepseek-ai/dsh-tools'

const HIDE_FILE = 'hide.json'
const PROFILE_MARKER = 'cordis.patch.yml'
const HIDE_DIR_HINT = 'spot'
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Indent by `depth * 2` spaces, mirroring dsh-tools' pad(). */
function pad(depth) {
  return '  '.repeat(depth)
}

/** Quote a member key unless it is a bare TS identifier (dsh-tools renderKey). */
function renderKey(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** Collapse a description into one /** ... *\/ doc line (dsh-tools docLines). */
function docLine(description, depth) {
  if (typeof description !== 'string' || description.length === 0) return []
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(depth)}/** ${collapsed.replaceAll('*/', '*\\/')} */`]
}

/**
 * Walk up from `startDir` until a directory containing `cordis.patch.yml`
 * (the dsh profile root) is found; stops at the filesystem root.
 *
 * @param {string} startDir - absolute path to start walking from.
 * @returns {string | undefined} the profile root, or undefined.
 */
function findProfileRoot(startDir) {
  let dir = startDir
  while (true) {
    if (existsSync(join(dir, PROFILE_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve the hide-list file the patched dsh-tools renderer reads.
 *
 * Default: `<profileRoot>/spot/hide.json`, where the profile root is the
 * nearest ancestor of the plugin that contains `cordis.patch.yml` (this
 * fork ships inside `<profile>/spot/mcp-lazy/`, so the walk is two levels).
 * `config.hideListPath` overrides with an absolute path (tests, exotic
 * layouts).
 *
 * @param {string} pluginFile - the importing module's file path
 *   (import.meta.url of lib/index.js).
 * @param {string | undefined} override - optional absolute path override.
 * @returns {string} absolute hide-list path.
 * @throws when no profile root is found and no override is given.
 */
export function resolveHideListPath(pluginFile, override) {
  if (typeof override === 'string' && override.length > 0) return resolve(override)
  // pluginFile is import.meta.url (file:// URL) or a plain path; normalize.
  const libDir = dirname(pluginFile.startsWith('file:')
    ? fileURLToPath(pluginFile)
    : pluginFile)
  // The plugin package root (<...>/dsh-mcp-lazy) carries its own bundle
  // cordis.patch.yml — the walk must START ABOVE it, or it would mistake
  // the fork root for the profile root. Layout assumption: lib/index.js.
  const packageRoot = dirname(libDir)
  const root = findProfileRoot(dirname(packageRoot))
  if (root === undefined) {
    throw new Error('mcp-lazy schemaDelivery: cannot locate the dsh profile root (no cordis.patch.yml ancestor); set hideListPath explicitly')
  }
  return join(root, HIDE_DIR_HINT, HIDE_FILE)
}

/**
 * Parse hide-list content: a JSON array of names, or `{ "names": [...] }`
 * (the same two shapes the patched dsh-tools helper accepts).
 *
 * @param {string} raw - file content.
 * @returns {string[]} names; empty for unreadable/invalid content.
 */
function parseHideNames(raw) {
  try {
    const parsed = JSON.parse(raw)
    const names = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.names) ? parsed.names : []
    return names.filter((n) => typeof n === 'string')
  } catch {
    return []
  }
}

/**
 * Create the hide-list maintainer for one lazy server.
 *
 * The maintainer owns exactly the entries matching `ownedPrefix`
 * (`mcp__<serverName>__`). Foreign entries (spot's cold builtin tools)
 * are always preserved untouched. Entries are ADDED before the tool is
 * registered and NEVER removed while the server runs in "message" mode:
 * the rendered system prompt must stay byte-identical whether the server
 * is currently active, warm, or released.
 *
 * Writes are atomic (tmp file + rename) because the renderer re-reads the
 * file on every prompt render.
 *
 * @param {object} options
 * @param {string} options.path - absolute hide-list path.
 * @param {string} options.ownedPrefix - tool-name prefix this server owns.
 * @returns {{ hide: (names: string[]) => void }} the maintainer.
 */
export function createHideListMaintainer({ path, ownedPrefix }) {
  const owned = (names) => names.filter((n) => typeof n === 'string' && n.startsWith(ownedPrefix))
  return {
    /**
     * Ensure `names` (this server's tools) are present in the hide list.
     * Foreign entries and previously hidden own names are preserved.
     *
     * @param {string[]} names - tool names to hide.
     */
    hide(names) {
      const additions = owned(names)
      if (additions.length === 0) return
      // Lost-update barrier (CAS-retry). hide() is deliberately SYNCHRONOUS:
      // it must complete before registerTool() renders the tool (ordering
      // safety property), and sync code within one process cannot interleave.
      // The race is CROSS-PROCESS: two dsh processes doing read→merge→write
      // can clobber each other (last rename wins, other's additions lost →
      // schema leak into the system prompt). The post-write re-read verify
      // detects that loss and retries, merging whatever the concurrent
      // writer landed instead of our stale snapshot.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let current = []
        try {
          current = parseHideNames(readFileSync(path, 'utf8'))
        } catch {
          current = [] // missing file: create it with our entries only
        }
        const mergedSet = new Set([...current, ...additions])
        // Foreign entries are always preserved (Set keeps them); own entries
        // never removed. Skip the write when nothing new would land: fewer
        // writes, fewer mtimes for external watchers.
        if (current.length === mergedSet.size) return
        const merged = [...mergedSet]
        const tmp = `${path}.mcp-lazy-${process.pid}-${Date.now()}-${attempt}.tmp`
        writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
        renameSync(tmp, path)
        // Verify our additions survived a possible concurrent writer; if a
        // foreign rename landed between our write and this re-read (or vice
        // versa), loop again and merge on top of the winner.
        try {
          const after = new Set(parseHideNames(readFileSync(path, 'utf8')))
          if (additions.every((n) => after.has(n))) return
        } catch {
          return // unreadable right now: our rename already landed atomically
        }
      }
    }
  }
}

/**
 * Wrap a registerTool callback so that, in "message" mode, the tool name
 * is added to the hide list BEFORE the registration happens. Order is the
 * safety property: by the time the tool is renderable in tools:sdk, its
 * hide entry already exists, so no activation can leak a schema into the
 * system prompt. Without a maintainer ("system" mode) the callback passes
 * through untouched.
 *
 * @param {(definition: object) => unknown} registerTool - the underlying
 *   registration callback.
 * @param {{hide: (names: string[]) => void} | undefined} maintainer - the
 *   hide-list maintainer, or undefined in "system" mode.
 * @returns {(definition: object) => unknown} the wrapped callback.
 */
export function createHidingRegisterTool(registerTool, maintainer) {
  return (definition) => {
    maintainer?.hide([definition.name])
    return registerTool(definition)
  }
}

/**
 * Render one server's tool schemas as the generated-SDK declarations the
 * tools:sdk section would have contained — ToolArgsMap/ToolOutputMap
 * members, byte-format identical to dsh-tools' renderToolsSdk (doc line,
 * `key: jsonSchemaToTs(schema, 1);`), minus the hide filter (these
 * declarations travel as a tool-result message, not through the renderer).
 *
 * @param {Array<{name: string, description: string, parameters: object,
 *   output: {schema: object}}>} definitions - registered tool definitions.
 * @returns {string} the TS declarations block (no surrounding fences).
 */
export function renderServerSdkSnapshot(definitions) {
  const argsMembers = []
  const outputMembers = []
  for (const definition of definitions) {
    argsMembers.push(...docLine(definition.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(definition.name)}: ${jsonSchemaToTs(definition.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(definition.name)}: ${jsonSchemaToTs(definition.output.schema, 1)};`)
  }
  return [
    `interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join('\n')}\n` : ''}}`,
    `interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join('\n')}\n` : ''}}`
  ].join('\n\n')
}

/**
 * Format the schema-delivery message appended to an activation result in
 * "message" mode.
 *
 * @param {string} serverName - the lazy server's name.
 * @param {Array<object>} definitions - the server's registered tool definitions.
 * @returns {string} the full tool-result text block, or '' when the server
 *   published no tools.
 */
export function formatSchemaDeliveryMessage(serverName, definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) return ''
  const lines = []
  lines.push('')
  lines.push(`Schema delivery for MCP server "${serverName}" (schemaDelivery: "message"): its tools are NOT declared in the prompt's tools:sdk section.`)
  lines.push(`Call them inside run_code: \`await tools.mcp__${serverName}__<tool>(args)\`.`)
  lines.push('Generated-SDK declarations (same format as the prompt\'s tools:sdk section):')
  lines.push('```ts')
  lines.push(renderServerSdkSnapshot(definitions))
  lines.push('```')
  return lines.join('\n')
}
