/**
 * Plugin-level static data: the frozen guidance section and registry
 * file loading.
 */
import { readFileSync } from 'node:fs'

/** System-prompt section name for the spot guidance. */
export const GUIDANCE_SECTION = 'tools:spot-guidance'

/**
 * The ONLY prompt text spot adds (frozen for the whole session — this
 * is what keeps the system prompt cache-stable). Must stay ≤500 chars.
 */
export const GUIDANCE_TEXT = [
  'Some builtin tools, all skills, and lazy MCP servers are NOT declared in tools:sdk.',
  'If you need one (goal/todo/ralph/workflow/ask_user_question/web_search/image/agent-messaging tools, a skill, an MCP server),',
  'first call spot_search(intent) to find it, then spot_load(name) to get its exact schema or instructions.',
  'Never guess a cold tool\'s arguments and never assume a skill/MCP exists without searching.',
].join(' ')

/** Total guidance budget (chars) enforced by tests. */
export const GUIDANCE_MAX_CHARS = 500

/**
 * Load registry.json + hide.json from the plugin root.
 *
 * @param {string | URL} pluginUrl - import.meta.url of plugin.mjs.
 * @param {object} [config] - plugin config; `registryPath`/`hidePath`
 *   override the default files (tests use this).
 * @returns {{registry: object, hide: string[]}} parsed data.
 * @throws when either file is unreadable — a broken registry must fail
 *   the boot loudly, not silently degrade search to nothing.
 */
export function loadPluginData(pluginUrl, config = {}) {
  // Registry/hide live next to plugin.mjs (the plugin root is spot/).
  const root = new URL('./', pluginUrl instanceof URL ? pluginUrl : new URL(String(pluginUrl)))
  const registryPath = config.registryPath ?? new URL('registry.json', root)
  const hidePath = config.hidePath ?? new URL('hide.json', root)
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  const hide = JSON.parse(readFileSync(hidePath, 'utf8'))
  return { registry, hide }
}
