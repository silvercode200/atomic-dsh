/**
 * delegation-mandate — a system-prompt section telling the model WHEN to
 * delegate, not just how (the `tool:subagent_*` sections it sits before only
 * cover background/batching mechanics).
 *
 * WHY: the observed failure mode (real session, 17.09, relay/glm-5.3,
 * 34 steps) was 0 subagent tool calls — the model ground routine work
 * (corpus scans, downloads, endpoint probing) through the main loop's
 * run_code programs while the role-pinned delegation tools sat unused in
 * the catalog. A catalog entry plus "how" guidance does not make a model
 * delegate; an explicit mandate naming the triggers does.
 *
 * The text rides the preset row's config (agent.cordis.yml), so this plugin
 * owns only the registration: one static section, assembled once per
 * session into the cached request header. No dynamic parts — the prompt
 * cache stays one request/header per session.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'delegation-mandate'

/** The prompt registry must exist before the section can register. */
export const inject = ['systemPrompt']

/**
 * Register the preset's delegation-mandate prompt section.
 * @param ctx - the mounting (agent-scope) context.
 * @param {object} [config] - row config: `text` (the mandate), `order`.
 */
export function apply(ctx, config) {
  const text = typeof config?.text === 'string' ? config.text : ''
  // Order 116.4: inside the per-tool guidance band (100-199), right BEFORE
  // the tool:subagent_* "background by default" lines (116.5) — the mandate
  // names the tools whose usage guidance follows immediately after it.
  const order = Number.isFinite(config?.order) ? config.order : 116.4
  if (text.length === 0) return
  ctx.effect(() => ctx.systemPrompt.section({ name: 'preset:delegation-mandate', order, text }), 'delegation-mandate.section()')
}
