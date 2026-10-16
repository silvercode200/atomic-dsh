/**
 * Post-compaction cold-schema hint.
 *
 * A compaction rewrites the model-visible surface: the conversation
 * collapses into a summary message. Any spot_load'ed cold-tool schemas
 * and skill instructions that lived in tool results or injected
 * messages are gone with them. The first post-compaction request gets
 * ONE non-waking user hint reminding the model to spot_load again —
 * the same request-scoped message pattern dsh-agent-loop injections
 * and the instruction-hint preset use.
 *
 * Epoch tracking mirrors compaction-epoch.mjs: the boundary is the seq
 * of the last compaction/end; the hint fires at most once per boundary
 * (resume-safe: a cold start scans the durable log).
 */

/** The hint text (kept short — it rides on the first post-compaction request). */
const HINT_TEXT = 'Heads-up: the previous compaction dropped earlier tool results and injections. If you were using a cold tool or skill loaded via spot_load (or plan to), call spot_load(name) again — its schema/instructions are no longer in the conversation.'

/**
 * Register the compaction watcher + pre-step hint injector.
 *
 * @param {object} ctx - the Cordis context.
 */
export function registerCompactionHint(ctx) {
  /** sessionId -> { boundary: lastCompactionEndSeq, hinted: boundary } */
  const state = new Map()

  /** Scan a session's durable log once (cold start / resume). */
  const scan = (session) => {
    let boundary = -1
    for (const event of session.events ?? []) {
      if (event.type === 'compaction/end') boundary = event.seq ?? 0
    }
    // hinted starts at -1: a session resumed AFTER a compaction has also
    // lost its loaded schemas, so it earns the hint on its first step.
    const entry = { boundary, hinted: -1 }
    state.set(session.id, entry)
    return entry
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    const entry = state.get(session.id) ?? scan(session)
    const seq = event.seq ?? 0
    state.set(session.id, { ...entry, boundary: seq })
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      const session = agent?.session
      if (session === undefined) return decision
      let entry = state.get(session.id)
      if (entry === undefined) entry = scan(session)
      if (entry.boundary < 0 || entry.hinted === entry.boundary) return decision

      state.set(session.id, { ...entry, hinted: entry.boundary })
      return {
        ...decision,
        messages: [...decision.messages, {
          id: `spot-compaction-hint-${session.id}-${entry.boundary}`,
          role: 'user',
          content: [{ type: 'text', text: HINT_TEXT }],
          source: { kind: 'spot-compaction-hint', form: 'hint' },
        }],
      }
    } catch {
      // A hint bug must never hurt the session.
      return decision
    }
  })
}
