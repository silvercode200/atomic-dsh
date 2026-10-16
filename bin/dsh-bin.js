#!/usr/bin/env node
/**
 * atomic-dsh entrypoint — loads vendored, patched @deepseek-ai/dsh harness.
 *
 * dist/ is self-contained: dist/node_modules/ holds the full patched tree
 * (@deepseek-ai/dsh + 60 deps, @deepseek-harness-tui/dsh-tui + 26 deps,
 * 8 bundled @dsh-std/* + @deepseek-harness-tui/dsh-auth). The harness root
 * bin is lib/bin.js (ESM, type:module). We rewrite process.argv to inject
 * `--profile dsh-tui` (the patched TUI profile) unless the caller overrides,
 * then dynamically import the harness bin.
 *
 * ESM/CJS interop: harness is type:module — direct dynamic import via
 * pathToFileURL is the correct path (no createRequire needed for the bin
 * itself). Memory: dsh-fork-version-esm-cjs-trap.md.
 *
 * Usage: dsh [--profile dsh-tui] [args...]
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessBin = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// Default --profile dsh-tui unless caller passed --profile/-p.
const argv = process.argv.slice(2);
const hasProfile = argv.some((a) => a === '--profile' || a === '-p' || a.startsWith('--profile=') || a.startsWith('-p='));
if (!hasProfile) {
  argv.unshift('--profile', 'dsh-tui');
}

// Rewrite argv so commander inside the harness sees its own bin path.
process.argv = [process.argv[0], harnessBin, ...argv];

await import(pathToFileURL(harnessBin).href);
