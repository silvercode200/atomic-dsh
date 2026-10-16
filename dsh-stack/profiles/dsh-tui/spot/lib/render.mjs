/**
 * Minimal JSON-schema → TypeScript renderer for spot_load.
 *
 * The plugin deliberately does NOT import dsh-tools' jsonSchemaToTs
 * (the plugin must stay zero-dependency and importable from the profile
 * directory, outside dsh's node_modules). This renderer covers the
 * schema subset builtin tools use — objects, arrays, enums, primitives —
 * and degrades anything exotic to `JsonValue`, the same escape hatch
 * the generated SDK itself uses. The PRIMARY path for cold tools is the
 * tsArgs/tsOutput snapshot extracted verbatim from a live session's
 * tools:sdk section (byte-identical to what the model sees natively);
 * this renderer only serves tools without a snapshot (e.g. registered
 * after the last registry build).
 */

/**
 * Render one JSON schema node as a TS type expression.
 *
 * @param {object | undefined} schema - the JSON schema node.
 * @param {number} depth - current indentation depth (for nested objects).
 * @returns {string} TS type text.
 */
export function jsonSchemaToTsType(schema, depth) {
  if (schema === null || typeof schema !== 'object') return 'JsonValue'
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ') || 'JsonValue'
  }
  if (Array.isArray(schema.type)) {
    const parts = schema.type.map((t) => primitive(t)).filter(Boolean)
    return parts.length > 0 ? parts.join(' | ') : 'JsonValue'
  }
  if (schema.type === 'array') {
    return `${jsonSchemaToTsType(schema.items, depth)}[]`
  }
  if (schema.type === 'object' || (schema.type === undefined && schema.properties !== undefined)) {
    const properties = schema.properties ?? {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const pad = '  '.repeat(depth + 1)
    const members = Object.entries(properties).map(([key, value]) => {
      const modifier = required.has(key) ? '' : '?'
      return `${pad}${safeKey(key)}${modifier}: ${jsonSchemaToTsType(value, depth + 1)};`
    })
    if (members.length === 0) return '{ [key: string]: JsonValue }'
    return `{\n${members.join('\n')}\n${'  '.repeat(depth)}}`
  }
  return primitive(schema.type) ?? 'JsonValue'
}

/** Map a primitive JSON schema type to its TS spelling. */
function primitive(type) {
  if (type === 'string') return 'string'
  if (type === 'number' || type === 'integer') return 'number'
  if (type === 'boolean') return 'boolean'
  if (type === 'null') return 'null'
  return undefined
}

/** Quote a property key unless it is a bare TS identifier. */
function safeKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

/**
 * Format the spot_load answer for a cold builtin tool: the exact
 * ToolArgsMap / ToolOutputMap member text (from the registry snapshot,
 * or rendered from a live definition when no snapshot exists), wrapped
 * so the model can splice it into its mental SDK picture.
 *
 * @param {object} entry - the registry entry (kind: tool).
 * @param {object} [liveDefinition] - live ctx.tools definition
 *   ({name, description, parameters, output: {schema}}); preferred over
 *   the snapshot's args render when the snapshot is missing.
 * @returns {string} the tool-result text.
 */
export function formatToolLoad(entry, liveDefinition) {
  const name = entry.name
  const lines = []
  lines.push(`Cold builtin tool "${name}"${entry.meta?.description ? ` — ${entry.meta.description}` : ''}`)
  lines.push('')
  lines.push('Call it inside run_code: `await tools.' + name + '(args)`.')

  const tsArgs = entry.meta?.tsArgs
  const tsOutput = entry.meta?.tsOutput
  if (typeof tsArgs === 'string' && tsArgs.trim().length > 0) {
    lines.push('')
    lines.push('Generated-SDK declarations (same format as the prompt\'s tools:sdk section):')
    lines.push('```ts')
    lines.push('interface ToolArgsMap {')
    lines.push(tsArgs)
    lines.push('}')
    if (typeof tsOutput === 'string' && tsOutput.trim().length > 0) {
      lines.push('')
      lines.push('interface ToolOutputMap {')
      lines.push(tsOutput)
      lines.push('}')
    }
    lines.push('```')
    return lines.join('\n')
  }

  if (liveDefinition !== undefined) {
    lines.push('')
    lines.push('Schema (rendered from the live definition):')
    lines.push('```ts')
    lines.push(`interface ToolArgsMap {`)
    lines.push(`  ${safeKey(name)}: ${jsonSchemaToTsType(liveDefinition.parameters, 1)};`)
    lines.push('}')
    const outputSchema = liveDefinition.output?.schema ?? liveDefinition.output
    if (outputSchema !== undefined) {
      lines.push('')
      lines.push('interface ToolOutputMap {')
      lines.push(`  ${safeKey(name)}: ${jsonSchemaToTsType(outputSchema, 1)};`)
      lines.push('}')
    }
    lines.push('```')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('No schema snapshot or live definition available. Rebuild the registry (node tools/build-registry.mjs) and retry.')
  return lines.join('\n')
}
