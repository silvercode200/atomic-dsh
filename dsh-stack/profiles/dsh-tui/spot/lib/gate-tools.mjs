/**
 * spot_search / spot_load gate tools.
 *
 * Hybrid of Spot MCP v1.2 (intent → candidates → load) and the Claude
 * tool-search pattern: NO param resolver — after spot_load returns the
 * schema, the model calls the tool directly via run_code.
 *
 * spot_search scope: cold builtin tools (registry.json) + live skills
 * (ctx.skills, merged at call time — the skill set varies per scope)
 * + lazy MCP servers (registry.json, search-only: activation stays
 * with mcp__router__search_and_activate; b3 wires spot to it).
 */
import { search, STATUS_FOUND, STATUS_CLARIFICATION, STATUS_UNKNOWN } from './search.mjs'
import { mergeSkillEntries } from './registry.mjs'
import { formatToolLoad } from './render.mjs'
import { trace } from './trace.mjs'

/** Max skills listed from ctx.skills (matches the skill-search preset cap). */
const MAX_SKILLS = 200

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** The shared {text} output contract of both gate tools. */
function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

/** One candidate line for search answers. */
function candidateLine({ entry, score }) {
  const marker = entry.kind === 'mcp' ? 'mcp' : entry.kind === 'skill' ? 'skill' : 'tool'
  const desc = (entry.meta?.description ?? '').split('\n')[0].slice(0, 90)
  return `- [${marker}] ${entry.name} (score ${score.toFixed(2)})${desc ? ` — ${desc}` : ''}`
}

/**
 * Collect the full searchable corpus: registry + live skills of the
 * calling agent's scope.
 *
 * @param {object} ctx - the Cordis context.
 * @param {object} data - plugin data ({registry}).
 * @param {object} [exec] - tool execution context (agent/signal).
 * @returns {Promise<Array<object>>} merged entries.
 */
async function collectEntries(ctx, data, exec) {
  const entries = [...data.registry.entries]
  try {
    const skills = await ctx.skills.list({
      scope: exec?.agent ?? ctx,
      cwd: exec?.agent?.session?.header?.cwd,
      signal: exec?.signal,
    })
    entries.push(...mergeSkillEntries((skills ?? []).slice(0, MAX_SKILLS)))
  } catch {
    // Skills unavailable (e.g. headless boot) — registry-only search.
  }
  return entries
}

/**
 * Register the spot_search and spot_load gate tools.
 *
 * @param {object} ctx - the Cordis context (services: tools, skills).
 * @param {object} data - plugin data ({registry, hide}).
 */
export function registerGateTools(ctx, data) {
  ctx.tools.register({
    name: 'spot_search',
    description: 'Search cold tools, skills and lazy MCP servers that are NOT declared in tools:sdk (goal/todo/ralph/workflow/ask_user_question/web_search/image/agent-messaging tools, any skill, any lazy MCP server). Returns matching candidates with scores. Then call spot_load(name) for the one you need. Do NOT assume cold tool names or arguments.',
    parameters: toJsonSchema({
      intent: { type: 'string', required: true, description: 'natural-language intent or a tool/skill/server name, ru or en (e.g. "работа с целями", "web search", "ralph")' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const entries = await collectEntries(ctx, data, exec)
      const result = search(entries, String(args.intent ?? ''))
      trace({ gate: 'spot_search', query: args.intent, status: result.status, top: result.top?.entry?.name, score: result.top?.score })

      if (result.status === STATUS_FOUND) {
        const lines = result.candidates.map(candidateLine)
        return { text: [`Best match: ${result.top.entry.name} (score ${result.top.score.toFixed(2)}).`, 'Call spot_load with the exact name to get its schema/instructions.', '', 'Other matches:', ...lines].join('\n') }
      }
      if (result.status === STATUS_CLARIFICATION) {
        const lines = result.candidates.map(candidateLine)
        return { text: ['Ambiguous intent — no candidate scored ≥0.70. Did you mean one of these?', ...lines, 'Refine the intent or call spot_load with the exact name.'].join('\n') }
      }
      const categories = (result.categories ?? []).join(', ')
      return { text: [`No cold tool/skill/MCP matches "${args.intent}" (all scores < 0.40).`, `Registry categories: ${categories}.`, 'Rephrase the intent, or proceed with the tools already declared in tools:sdk.'].join('\n') }
    },
  })

  ctx.tools.register({
    name: 'spot_load',
    description: 'Load ONE cold item by its exact name (from spot_search): a builtin tool\'s full TS schema (ToolArgsMap/ToolOutputMap member format — call it via run_code: await tools.<name>(args)), or a skill\'s full instructions (injected for the next request). Does NOT activate MCP servers — search them with spot_search and activate with mcp__router__search_and_activate.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact tool or skill name (from spot_search results)' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const wanted = String(args.name ?? '').trim()
      const entries = await collectEntries(ctx, data, exec)
      const entry = entries.find((item) => item.name === wanted) ?? entries.find((item) => item.id === wanted)
      trace({ gate: 'spot_load', query: wanted, status: entry === undefined ? 'unknown' : entry.kind, top: entry?.name, score: entry === undefined ? undefined : 1 })

      if (entry === undefined) {
        return { text: `No cold tool/skill named "${wanted}". Call spot_search(intent) to list candidates. (Hot tools — read/write/edit/bash/glob/grep/subagent/skill_search/skill_load/run_code — are already declared in tools:sdk.)` }
      }

      if (entry.kind === 'tool') {
        let live
        try {
          const definition = ctx.tools.get(wanted, exec?.agent)
          if (definition !== undefined) live = definition
        } catch {
          // Live lookup is best-effort; the snapshot serves the answer.
        }
        return { text: formatToolLoad(entry, live) }
      }

      if (entry.kind === 'skill') {
        const agent = exec?.agent
        if (agent === undefined) return { text: 'spot_load of a skill requires an agent context.' }
        try {
          // `wanted` may carry the registry id form "skill:<name>" (entry
          // matched by id) — ctx.skills.get resolves by bare skill name.
          const skillName = wanted.startsWith('skill:') ? wanted.slice('skill:'.length) : wanted
          const skill = await ctx.skills.get(skillName, {
            scope: agent,
            cwd: agent.session?.header?.cwd,
            signal: exec?.signal,
          })
          if (skill === undefined) return { text: `No skill named "${wanted}". Run spot_search to list available skills.` }
          const body = extractSkillBody(skill)
          if (body.length === 0) return { text: `Skill "${wanted}" has no loadable body.` }
          // Non-waking next-step inbox, exactly like the skill-search preset.
          agent.inject({
            id: `spot-load-${wanted}-${Date.now()}`,
            role: 'user',
            content: [{ type: 'text', text: body }],
            source: { kind: 'skill-invocation', name: wanted, form: 'instructions' },
          })
          return { text: `Skill "${wanted}" loaded; its instructions will be injected for the next request.` }
        } catch (error) {
          return { text: `spot_load failed: ${String(error?.message ?? error)}` }
        }
      }

      // kind === 'mcp': search-only. Activation stays with the router tool.
      return {
        text: [
          `"${wanted}" is a lazy MCP server, not a direct tool.`,
          'Its tool schemas appear in tools:sdk only while active.',
          `Activate it with the router tool: mcp__router__search_and_activate (serverName: ${entry.meta?.serverName ?? wanted}), then call its tools via run_code.`,
        ].join('\n'),
      }
    },
  })
}

/** Extract the model-facing body of a loaded skill definition. */
function extractSkillBody(skill) {
  const content = skill?.content ?? skill?.instructions ?? skill?.body
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('\n')
  }
  return ''
}
