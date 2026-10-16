#!/usr/bin/env node
/**
 * spot registry linter — Spot MCP v1.2 §14 (OP001–OP010) adapted to the
 * spot plugin's domain:
 *
 *   SP001  error  registry.json is valid JSON with an entries array
 *   SP002  error  no duplicate entry ids
 *   SP003  error  kind is one of tool|skill|mcp
 *   SP004  error  every entry carries routing text
 *   SP005  error  tool entries carry a tsArgs snapshot (loadable schema)
 *   SP006  error  mcp entries carry meta.serverName
 *   SP007  error  every hide.json name has a registry tool entry
 *   SP008  error  every registry tool entry appears in hide.json
 *
 * Exit 0 = clean, 1 = errors found.
 */
import { readFileSync } from 'node:fs'
import { validateRegistry, LintErrorIds } from './lib/registry.mjs'

/**
 * Lint the registry and hide list.
 *
 * @param {string | URL} registryPath - path to registry.json.
 * @param {string | URL} hidePath - path to hide.json.
 * @returns {{errors: Array<{id: string, message: string}>}} lint report.
 */
export function lintRegistry(registryPath, hidePath) {
  let registry
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch (error) {
    return { errors: [{ id: LintErrorIds.SP001, message: `registry.json unreadable: ${String(error.message)}` }] }
  }
  const errors = validateRegistry(registry)

  let hide
  try {
    hide = JSON.parse(readFileSync(hidePath, 'utf8'))
  } catch (error) {
    return { errors: [...errors, { id: LintErrorIds.SP001, message: `hide.json unreadable: ${String(error.message)}` }] }
  }
  if (!Array.isArray(hide) || !hide.every((name) => typeof name === 'string')) {
    return { errors: [...errors, { id: LintErrorIds.SP001, message: 'hide.json: expected an array of strings' }] }
  }

  const toolNames = new Set(registry.entries.filter((entry) => entry.kind === 'tool').map((entry) => entry.name))
  for (const name of hide) {
    if (!toolNames.has(name)) {
      errors.push({ id: LintErrorIds.SP007, message: `hide.json name "${name}" has no registry tool entry` })
    }
  }
  for (const name of toolNames) {
    if (!hide.includes(name)) {
      errors.push({ id: LintErrorIds.SP008, message: `registry tool "${name}" missing from hide.json` })
    }
  }
  return { errors }
}

/** CLI entry: `node lint.mjs`. */
function main() {
  const base = new URL('.', import.meta.url)
  const report = lintRegistry(new URL('registry.json', base), new URL('hide.json', base))
  for (const error of report.errors) {
    process.stderr.write(`${error.id}: ${error.message}\n`)
  }
  if (report.errors.length > 0) {
    process.stderr.write(`lint: ${report.errors.length} error(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('lint: 0 errors\n')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
