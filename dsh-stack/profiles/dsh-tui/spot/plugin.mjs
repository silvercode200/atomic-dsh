/**
 * spot — on-demand discovery of cold tools, skills and MCP servers.
 *
 * WHY: Code Mode renders every tool schema into the frozen `tools:sdk`
 * system-prompt section. Lazy MCP servers rewrite that section on every
 * activation/release, busting the prompt cache (~50% hit rate). The spot
 * plugin is one half of the fix: it keeps a small frozen registry of
 * "cold" builtin tools (hidden from the sdk section by the b2 patch),
 * skills and lazy MCP servers, and exposes two gate tools:
 *
 *  - `spot_search(intent)` — Jaccard-keyword search over the registry
 *    (Spot MCP v1.2 §9.2 semantics, ru+en stopwords, light stemming),
 *    answering found / clarification / unknown.
 *  - `spot_load(name)` — return one cold tool's full TS schema
 *    (ToolArgsMap/ToolOutputMap member format), load a skill's body, or
 *    explain how to activate a lazy MCP server (activation itself is b3).
 *
 * The plugin NEVER rewrites existing prompt sections: it only registers
 * its own small guidance section (<500 chars) and the two gate tools.
 */
import { registerGateTools } from './lib/gate-tools.mjs'
import { registerCompactionHint } from './lib/compaction-hint.mjs'
import { GUIDANCE_SECTION, GUIDANCE_TEXT, loadPluginData } from './lib/plugin-data.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spot'

/** Needs tools/skills (gate tools), systemPrompt (guidance section), agents (exec scope). */
export const inject = ['agents', 'tools', 'skills', 'systemPrompt']

/**
 * Apply the spot plugin: load registry data, register the two gate tools,
 * the frozen guidance section and the post-compaction cold-schema hint.
 *
 * @param {import('cordis').Context} ctx - the Cordis context.
 * @param {object} [config] - plugin config (unused, reserved).
 */
export function apply(ctx, config) {
  const cfg = config ?? {}
  const data = loadPluginData(import.meta.url, cfg)

  ctx.effect(() => ctx.systemPrompt.section({
    name: GUIDANCE_SECTION,
    order: 155,
    text: GUIDANCE_TEXT,
  }), 'spot.guidanceSection()')

  registerGateTools(ctx, data)
  registerCompactionHint(ctx)
}

export { GUIDANCE_SECTION, GUIDANCE_TEXT }
