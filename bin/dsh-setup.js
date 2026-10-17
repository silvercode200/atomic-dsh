#!/usr/bin/env node
/**
 * dsh-setup — first-run configuration wizard for atomic-dsh.
 *
 * Writes $DSH_TUI_HOME/settings.yaml + $DSH_HOME/settings.yaml (profile dsh-tui →
 * vendored dist/). Env isolation: DSH_HOME (default ~/.dsh) + DSH_TUI_HOME
 * (default ~/.dsh-tui) — set both to isolate dev/test from live end-user config.
 * Idempotent: merges with existing settings (does not clobber user config).
 * Non-interactive mode: `dsh-setup --defaults` skips prompts and writes sane
 * defaults (for CI/scripted install).
 *
 * Also writes $DSH_HOME/profiles/dsh-tui/cordis.patch.yml (the path the TUI
 * loads as homePatchPath) + lazy-config.json (source-of-truth for the lazy
 * MCP subsystem: manager/lazy-skills/spot flags + server catalogue).
 *
 * 8 options:
 *  1. Provider config (api key + base URL + model)
 *  2. Lazy MCP enable? (wire mcp-lazy plugin)
 *  3. MCP auto-takeover manager? (hide TaskGate/octa behind lazy)
 *  4. Configure your own MCP servers? (transport/args/headers)
 *  5. Permanent always-on MCP? (which stay direct stdio)
 *  6. Lazy skills mode? (code-lazy preset vs full dsh-tool-skill)
 *  7. spot cold-discovery gate?
 *  8. Core-patch env knobs (DSH_TUI_MAX_TOKENS_CONTINUE, DSH_RETRY_BUDGET_MIN, etc.)
 *
 * Output format matches dsh-stack/settings.yaml.example (4 top-level keys:
 * agent-default-model, llm-pi-ai, dsh-tui, agent-presets).
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const NON_INTERACTIVE = args.includes('--defaults') || args.includes('--non-interactive');
// HOTFIX 2026-10-17: --force-dsh-settings to overwrite an existing real ~/.dsh/settings.yaml.
// Without this flag, dsh-setup preserves any real provider config (agent-default-model /
// providers section) and only backs it up to .bak-dsh-setup-clobber-<ts>.
// TODO: sonnet-debugger — root cause is unconditional clobber; reconsider whether the
// pointer-format ~/.dsh/settings.yaml should be written at all when a real config exists.
const FORCE_DSH_SETTINGS = args.includes('--force-dsh-settings');

const HOME = os.homedir();
// Env-driven isolation: dev/test sets DSH_HOME / DSH_TUI_HOME to a temp dir so
// atomic-dsh never touches the live end-user config (~/.dsh, ~/.dsh-tui).
// Defaults preserve backward-compat for end-users. The harness reads DSH_HOME
// via @deepseek-ai/dsh-home-paths.resolveDshHome() (same env var), so
// bin/dsh-bin.js needs no change — env inherits through process.env.
const DSH_DIR = process.env.DSH_HOME || path.join(HOME, '.dsh');
const DSH_TUI_DIR = process.env.DSH_TUI_HOME || path.join(HOME, '.dsh-tui');
const SETTINGS_TUI = path.join(DSH_TUI_DIR, 'settings.yaml');
const SETTINGS_DSH = path.join(DSH_DIR, 'settings.yaml');
const THEMES_USER_DIR = path.join(DSH_TUI_DIR, 'themes');

// ---------------------------------------------------------------------------
// readline helper
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} */
async function ask(rl, question, defaultValue = '') {
  if (NON_INTERACTIVE) return defaultValue;
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue;
}

/** @returns {Promise<boolean>} */
async function askBool(rl, question, defaultValue = true) {
  const dv = defaultValue ? 'y' : 'n';
  const raw = await ask(rl, `${question} (y/n)`, dv);
  return raw.toLowerCase().startsWith('y');
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate provider API key is non-empty.
 * @param {string} key
 * @returns {string} key if valid, else ''
 */
function validateApiKey(key) {
  return key && key.trim().length >= 8 ? key.trim() : '';
}

/**
 * Validate base URL is a valid URL.
 * @param {string} url
 * @returns {string} url if valid, else ''
 */
function validateUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// YAML serialization (minimal, no external dep)
// ---------------------------------------------------------------------------

/**
 * Serialize a JS value to a minimal YAML string.
 * Supports: null, string, number, boolean, arrays, nested objects.
 * @param {any} value
 * @param {number} indent
 * @returns {string}
 */
function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    // Quote strings that look like numbers/booleans/special, or contain special chars.
    if (/^[\d.-]/.test(value) || value === 'true' || value === 'false' || value === 'null' || /[:#{}\[\],&*?|<>=!%@`]/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // For array items: "- " replaces leading pad, nested keys indent under it.
    // Object items: first key on "- " line, rest at indent+1.
    return value
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item).filter(([, v]) => v !== undefined);
          if (entries.length === 0) return `${pad}- {}`;
          return entries
            .map(([k, v], i) => {
              const prefix = i === 0 ? `${pad}- ` : `${pad}  `;
              if (v === null) return `${prefix}${k}: null`;
              if (Array.isArray(v)) {
                if (v.length === 0) return `${prefix}${k}: []`;
                const items = toYaml(v, indent + 2);
                return `${prefix}${k}:\n${items}`;
              }
              if (typeof v === 'object') {
                const nested = toYaml(v, indent + 2);
                return `${prefix}${k}:\n${nested}`;
              }
              return `${prefix}${k}: ${toYaml(v, indent)}`;
            })
            .join('\n');
        }
        return `${pad}- ${toYaml(item, indent)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        if (v === null) return `${pad}${k}: null`;
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`;
          const items = toYaml(v, indent + 1);
          return `${pad}${k}:\n${items}`;
        }
        if (typeof v === 'object') {
          const nested = toYaml(v, indent + 1);
          return `${pad}${k}:\n${nested}`;
        }
        return `${pad}${k}: ${toYaml(v, indent)}`;
      })
      .join('\n');
  }
  return String(value);
}

/**
 * Parse existing settings.yaml (very minimal line-based parser, good enough
 * for merging simple top-level keys — does not handle every YAML edge case).
 * @param {string} content
 * @returns {Record<string, any>}
 */
function parseSettingsYaml(content) {
  // Minimal: return empty if unparseable; we merge by overwriting top-level keys.
  // Full YAML parse would require js-yaml (not a runtime dep of wizard).
  // For idempotency we only merge our known top-level keys, preserving unknown
  // top-level blocks as raw text appended after our managed block.
  return {};
}

// ---------------------------------------------------------------------------
// Build settings object from wizard answers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WizardAnswers
 * @property {string} providerName
 * @property {string} apiKey
 * @property {string} baseURL
 * @property {string} model
 * @property {string} apiKeyEnv
 * @property {boolean} lazyMcp
 * @property {boolean} mcpAutoTakeover
 * @property {Array<{name:string, transport:string, command?:string, url?:string, args?:string[], headers?:Record<string,string>}>} customMcpServers
 * @property {string[]} alwaysOnMcp
 * @property {boolean} lazySkills
 * @property {boolean} spotGate
 * @property {number} maxTokensContinue
 * @property {number} retryBudgetMin
 * @property {string} fallbackCwd
 * @property {boolean} mcpStderrToLog
 */

/**
 * Build the settings.yaml object from wizard answers.
 * @param {WizardAnswers} a
 * @returns {Record<string, any>}
 */
function buildSettings(a) {
  /** @type {Record<string, any>} */
  const settings = {};

  // 1. Provider config → agent-default-model + llm-pi-ai.providers
  settings['agent-default-model'] = { provider: a.providerName, model: a.model };
  settings['llm-pi-ai'] = {
    providers: {
      [a.providerName]: {
        api: 'anthropic-messages',
        apiKeyEnv: a.apiKeyEnv,
        baseURL: a.baseURL,
        models: [{ id: a.model }],
        retryPolicy: { mode: 'normal', maxRetries: 37, backoff: { maxDelayMs: 120000 } },
      },
    },
  };

  // 2-5. dsh-tui config block (statusBar defaults + lazy knobs)
  /** @type {Record<string, any>} */
  const dshTui = {
    statusBar: {
      tokens: true,
      compact: true,
      contextBar: true,
      mode: true,
      trajectory: true,
      shortcutHint: true,
      activity: true,
      cache: true,
      gitBranch: true,
      compactThresholdRatio: 0.4768,
    },
    fullscreen: false,
    minimal: true,
    toolBackground: 'subtle',
  };

  // 6. Lazy skills → agent-presets.default
  settings['agent-presets'] = { default: a.lazySkills ? 'code-lazy' : 'dsh-default' };

  // 8. Core-patch env knobs live in process.env (not settings.yaml — settings
  // rejects unknown keys per memory dsh-retry-budget-env-only). We write them
  // to a separate $DSH_TUI_HOME/env.sh file sourced by the dsh wrapper.
  settings['dsh-tui'] = dshTui;

  return settings;
}

/**
 * Build the env.sh content for core-patch knobs.
 * @param {WizardAnswers} a
 * @returns {string}
 */
function buildEnvSh(a) {
  const lines = [
    '# env.sh — core-patch env knobs (sourced by dsh wrapper)',
    '# Generated by dsh-setup. Edit manually or re-run dsh-setup.',
    '',
  ];
  lines.push(`export DSH_TUI_MAX_TOKENS_CONTINUE=${a.maxTokensContinue}`);
  lines.push(`export DSH_RETRY_BUDGET_MIN=${a.retryBudgetMin}`);
  if (a.fallbackCwd) lines.push(`export DSH_FALLBACK_CWD=${JSON.stringify(a.fallbackCwd)}`);
  lines.push(`export DSH_MCP_STDERR_TO_LOG=${a.mcpStderrToLog ? 1 : 0}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Cordis patch YAML for lazy MCP wiring
// ---------------------------------------------------------------------------

/**
 * @typedef {'always-on'|'lazy'|'off'} McpMode
 * @typedef {'stdio'|'streamable-http'} McpTransport
 * @typedef {{
 *   name: string,
 *   mode: McpMode,
 *   transport: McpTransport,
 *   command?: string,
 *   args?: string[],
 *   url?: string,
 *   headers?: Record<string, string>,
 *   autoActivate?: boolean,
 *   releaseOnTurnEnd?: boolean,
 *   schemaDelivery?: 'system'|'message',
 *   routingHints?: string[],
 * }} McpServerSpec
 */

/**
 * Default MCP server catalogue. The wizard emits entries for these in
 * cordis.patch.yml + lazy-config.json so a fresh install has a working
 * starting point (the user edits paths to match their machine).
 *
 * - always-on servers (taskgate, octa): mounted direct via
 *   @deepseek-ai/dsh-mcp-client (always visible to the model — never gated
 *   behind lazy activate). Mirrors the machine-layer ~/.dsh/cordis.patch.yml
 *   shape: id `mcp-<name>`, config.serverName/transport/command/args,
 *   failOnStartupError:false.
 * - lazy servers (codegraph, context-mode, tavily, deep-research): mounted via
 *   @yilinxiao/dsh-mcp-lazy with autoActivate:false, releaseOnTurnEnd:true,
 *   schemaDelivery:'message'. The model pays no token cost until it calls
 *   mcp__<name>__activate.
 *
 * The mcp-stderr-to-log wrapper ($DSH_HOME/bin/mcp-stderr-to-log) redirects
 * each server's stderr to $DSH_HOME/logs/mcp-<name>.stderr.log so raw MCP
 * WARNINGs never overlay ink frames (frame-diffing breakage). The wrapper is
 * generated at install time; its path is $DSH_HOME/bin/mcp-stderr-to-log.
 * @type {Record<string, McpServerSpec>}
 */
const KNOWN_MCP_DEFAULTS = {
  taskgate: {
    name: 'taskgate',
    mode: 'always-on',
    transport: 'stdio',
    command: 'mcp-stderr-to-log',
    args: ['taskgate', 'run-taskgate-mcp.sh'],
    routingHints: ['task', 'taskgate', 'progress', 'evidence'],
  },
  octa: {
    name: 'octa',
    mode: 'always-on',
    transport: 'stdio',
    command: 'mcp-stderr-to-log',
    args: ['octa', 'run-octa-mcp.sh'],
    routingHints: ['code', 'octa', 'discover', 'context'],
  },
  codegraph: {
    name: 'codegraph',
    mode: 'lazy',
    transport: 'stdio',
    command: 'mcp-stderr-to-log',
    args: ['codegraph', 'codegraph', 'serve', '--mcp', '--no-watch'],
    routingHints: ['code graph', 'codegraph', 'call paths', 'code'],
  },
  'context-mode': {
    name: 'context-mode',
    mode: 'lazy',
    transport: 'stdio',
    command: 'mcp-stderr-to-log',
    args: ['context-mode', 'npx', '-y', 'context-mode'],
    routingHints: ['context', 'sandbox', 'index', 'aggregate'],
  },
  tavily: {
    name: 'tavily',
    mode: 'lazy',
    transport: 'stdio',
    command: 'mcp-stderr-to-log',
    args: ['tavily', 'run-tavily-mcp.sh'],
    routingHints: ['web search', 'search', 'tavily', 'research'],
  },
  'deep-research': {
    name: 'deep-research',
    mode: 'lazy',
    transport: 'stdio',
    command: 'mcp-stderr-to-log',
    args: ['deep-research', 'python3', 'run-deep-research.py'],
    routingHints: ['deep research', 'research', 'multi-source'],
  },
};

/** Default lazy server names emitted when lazy MCP is enabled. */
const DEFAULT_LAZY_SERVERS = ['codegraph', 'context-mode', 'tavily', 'deep-research'];

/**
 * Resolve the absolute path of the mcp-stderr-to-log wrapper for the active
 * $DSH_HOME. Used to prefix KNOWN_MCP_DEFAULTS commands so the emitted
 * cordis.patch.yml has absolute paths (dsh-mcp-client strips ambient env, so
 * bare command names fail to resolve).
 * @returns {string}
 */
function mcpStderrWrapperPath() {
  return path.join(DSH_DIR, 'bin', 'mcp-stderr-to-log');
}

/**
 * Resolve a KNOWN_MCP_DEFAULTS server's command into an absolute path.
 * The wrapper itself (mcp-stderr-to-log) is resolved against $DSH_HOME/bin.
 * Sub-command scripts (run-taskgate-mcp.sh) stay bare — they are looked up
 * in $DSH_HOME/bin by the wrapper at exec time, OR edited by the user.
 * @param {McpServerSpec} spec
 * @returns {{command: string, args: string[]}}
 */
function resolveServerCommand(spec) {
  if (spec.transport === 'streamable-http') {
    // http servers have url+headers, no command/args
    return { command: '', args: [] };
  }
  // The wrapper is the absolute entry point; sub-command is the first arg.
  if (spec.command === 'mcp-stderr-to-log') {
    return { command: mcpStderrWrapperPath(), args: spec.args ?? [] };
  }
  return { command: spec.command ?? '', args: spec.args ?? [] };
}

/**
 * Quote a scalar for YAML emission. Strings that look like numbers, booleans,
 * null, or contain YAML-significant chars are JSON-quoted; bare path segments
 * with no specials are emitted unquoted.
 * @param {string} s
 * @returns {string}
 */
function yamlScalar(s) {
  if (s === '') return "''";
  if (/^[\d.-]/.test(s) || s === 'true' || s === 'false' || s === 'null' || /[:#{}\[\],&*?|<>=!%@`]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Emit YAML list items under a `- insert:` block for one server spec, using
 * the @deepseek-ai/dsh-mcp-client direct-entry shape (always-on servers).
 * Shape (from machine-layer ~/.dsh/cordis.patch.yml):
 *   - id: mcp-<name>
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       serverName: <name>
 *       transport: stdio
 *       command: <abs>
 *       args: [...]
 *       failOnStartupError: false
 * @param {McpServerSpec} spec
 * @param {string[]} lines
 * @returns {void}
 */
function emitDirectEntry(spec, lines) {
  const { command, args } = resolveServerCommand(spec);
  lines.push(`    - id: mcp-${spec.name}`);
  lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`);
  lines.push(`      config:`);
  lines.push(`        serverName: ${yamlScalar(spec.name)}`);
  lines.push(`        transport: ${spec.transport}`);
  if (spec.transport === 'stdio') {
    lines.push(`        command: ${yamlScalar(command)}`);
    if (args.length) {
      lines.push(`        args:`);
      for (const a of args) lines.push(`          - ${yamlScalar(a)}`);
    }
  } else if (spec.transport === 'streamable-http' && spec.url) {
    lines.push(`        url: ${yamlScalar(spec.url)}`);
    if (spec.headers && Object.keys(spec.headers).length) {
      lines.push(`        headers:`);
      for (const [k, v] of Object.entries(spec.headers)) {
        lines.push(`          ${yamlScalar(k)}: ${yamlScalar(v)}`);
      }
    }
  }
  lines.push(`        failOnStartupError: false`);
}

/**
 * Emit YAML list items under a `- insert:` block for one server spec, using
 * the @yilinxiao/dsh-mcp-lazy lazy-entry shape (lazy servers).
 * Shape (from profile-layer dsh-stack/profiles/dsh-tui/cordis.patch.yml):
 *   - id: mcp-lazy-<name>
 *     name: '@yilinxiao/dsh-mcp-lazy'
 *     config:
 *       transport: stdio
 *       serverName: <name>
 *       command: <abs>
 *       args: [...]
 *       autoActivate: false
 *       releaseOnTurnEnd: true
 *       schemaDelivery: message
 *       routingHints: [...]
 * @param {McpServerSpec} spec
 * @param {string[]} lines
 * @returns {void}
 */
function emitLazyEntry(spec, lines) {
  const { command, args } = resolveServerCommand(spec);
  lines.push(`    - id: mcp-lazy-${spec.name}`);
  lines.push(`      name: '@yilinxiao/dsh-mcp-lazy'`);
  lines.push(`      config:`);
  lines.push(`        transport: ${spec.transport}`);
  lines.push(`        serverName: ${yamlScalar(spec.name)}`);
  if (spec.transport === 'stdio') {
    lines.push(`        command: ${yamlScalar(command)}`);
    if (args.length) {
      lines.push(`        args:`);
      for (const a of args) lines.push(`          - ${yamlScalar(a)}`);
    }
  } else if (spec.transport === 'streamable-http' && spec.url) {
    lines.push(`        url: ${yamlScalar(spec.url)}`);
    if (spec.headers && Object.keys(spec.headers).length) {
      lines.push(`        headers:`);
      for (const [k, v] of Object.entries(spec.headers)) {
        lines.push(`          ${yamlScalar(k)}: ${yamlScalar(v)}`);
      }
    }
  }
  lines.push(`        autoActivate: false`);
  lines.push(`        releaseOnTurnEnd: true`);
  lines.push(`        schemaDelivery: message`);
  if (spec.routingHints && spec.routingHints.length) {
    lines.push(`        routingHints: [${spec.routingHints.map((h) => yamlScalar(h)).join(', ')}]`);
  }
}

/**
 * Build the list of McpServerSpec the wizard emits — derived from answers +
 * KNOWN_MCP_DEFAULTS. Used by both buildCordisPatch (cordis.patch.yml) and
 * buildLazyConfig (lazy-config.json) so the two outputs stay in sync.
 * @param {WizardAnswers} a
 * @returns {McpServerSpec[]}
 */
function collectServerSpecs(a) {
  /** @type {McpServerSpec[]} */
  const specs = [];
  // always-on: direct @deepseek-ai/dsh-mcp-client entries (BUG1 fix — wire the
  // previously-dead alwaysOnMcp option). For names in KNOWN_MCP_DEFAULTS we use
  // the canonical command/args; unknown names are emitted with a placeholder
  // command the user edits.
  for (const name of a.alwaysOnMcp) {
    const base = KNOWN_MCP_DEFAULTS[name];
    if (base) {
      specs.push({ ...base, mode: 'always-on' });
    } else {
      specs.push({
        name,
        mode: 'always-on',
        transport: 'stdio',
        command: 'mcp-stderr-to-log',
        args: [name, `run-${name}-mcp.sh`],
        routingHints: [],
      });
    }
  }
  // lazy: default servers (codegraph/context-mode/tavily/deep-research) — only
  // when lazyMcp is enabled.
  if (a.lazyMcp) {
    for (const name of DEFAULT_LAZY_SERVERS) {
      const base = KNOWN_MCP_DEFAULTS[name];
      if (base) specs.push({ ...base, mode: 'lazy' });
    }
    // custom user-defined servers (mode: lazy)
    for (const srv of a.customMcpServers) {
      specs.push({
        name: srv.name,
        mode: 'lazy',
        transport: /** @type {McpTransport} */ (srv.transport),
        command: srv.command,
        args: srv.args,
        url: srv.url,
        headers: srv.headers,
        routingHints: [],
      });
    }
    // spot — emitted as a lazy server entry in lazy-config.json only when
    // spotGate is on (the cordis.plugin.mjs entry is emitted separately in
    // buildCordisPatch as a './spot/plugin.mjs' insert, not an mcp-lazy entry).
    if (a.spotGate) {
      specs.push({
        name: 'spot',
        mode: 'lazy',
        transport: 'stdio',
        command: 'mcp-stderr-to-log',
        args: ['spot', './spot/plugin.mjs'],
        routingHints: ['cold discovery', 'spot', 'skills', 'tools'],
      });
    }
  }
  return specs;
}

/**
 * Build cordis.patch.yml fragment for mcp-lazy + spot plugin wiring.
 *
 * Output path: $DSH_HOME/profiles/dsh-tui/cordis.patch.yml (BUG4 fix — the TUI
 * loads the profile-layer patch from homePatchPath =
 * $DSH_HOME/profiles/dsh-tui/cordis.patch.yml, NOT $DSH_TUI_HOME). Writing to
 * $DSH_TUI_DIR/cordis.patch.yml produced an inert file the harness ignored.
 *
 * @param {WizardAnswers} a
 * @returns {string}
 */
function buildCordisPatch(a) {
  /** @type {string[]} */
  const lines = ['# cordis.patch.yml — dsh-setup generated plugin wiring', ''];

  // 5. Permanent always-on MCP — direct @deepseek-ai/dsh-mcp-client entries
  // (BUG1 fix: previously alwaysOnMcp was collected but never emitted — the
  // option was dead). Direct entries are always visible to the model (no
  // activate/deactivate gate); failOnStartupError:false so a broken server
  // does not crash the boot.
  const alwaysOnSpecs = collectServerSpecs(a).filter((s) => s.mode === 'always-on');
  if (alwaysOnSpecs.length) {
    lines.push('# Always-on MCP servers (direct stdio, always visible to model)');
    lines.push('- insert:');
    for (const spec of alwaysOnSpecs) emitDirectEntry(spec, lines);
    lines.push('');
  }

  // 2. Lazy MCP enable → wire mcp-lazy entries for default + custom servers
  if (a.lazyMcp) {
    const lazySpecs = collectServerSpecs(a).filter((s) => s.mode === 'lazy' && s.name !== 'spot');
    if (lazySpecs.length) {
      lines.push('# Lazy MCP servers (auto-activate on tool call, release on turn end)');
      lines.push('- insert:');
      for (const spec of lazySpecs) emitLazyEntry(spec, lines);
      lines.push('');
    }

    // 3. MCP auto-takeover manager (BUG2 fix: dispatch in
    // dsh-stack/profiles/dsh-tui/spot/mcp-lazy/lib/index.js checks
    // config.mode === 'manager' — the old takeover-toggle key was an unknown
    // field the schemastery Config union rejected, so the manager never
    // installed). When enabled, emit a config block with mode:manager; when
    // disabled, emit disabled:true.
    if (a.mcpAutoTakeover) {
      lines.push('# MCP auto-takeover manager (hides TaskGate/octa behind lazy proxy)');
      lines.push('- id: mcp-lazy-manager');
      lines.push(`  name: '@yilinxiao/dsh-mcp-lazy'`);
      lines.push(`  config:`);
      lines.push(`    mode: manager`);
      lines.push('');
    } else {
      lines.push('# MCP auto-takeover manager — OFF (TaskGate/octa stay direct stdio)');
      lines.push('- id: mcp-lazy-manager');
      lines.push(`  disabled: true`);
      lines.push('');
    }
  }

  // 7. spot cold-discovery gate — local plugin entry, NOT an mcp-lazy server
  if (a.spotGate) {
    lines.push('# spot cold-discovery gate enabled');
    lines.push(`- insert:`);
    lines.push(`  - id: spot`);
    lines.push(`    name: './spot/plugin.mjs'`);
  } else {
    lines.push('# spot cold-discovery gate — disabled');
  }

  return lines.join('\n') + '\n';
}

/**
 * Build lazy-config.json — the source-of-truth config consumed by Wave 2
 * (lazy server bootstrapping, manager wiring, spot gate). Mirrors the server
 * list emitted into cordis.patch.yml so the two stay in sync.
 *
 * Canonical schema:
 *   {
 *     "manager": <boolean>,
 *     "lazy-skills": <boolean>,
 *     "spot": <boolean>,
 *     "servers": [
 *       { "name", "mode", "transport", "command", "args", "url", "headers",
 *         "autoActivate", "releaseOnTurnEnd", "schemaDelivery", "routingHints" }
 *     ]
 *   }
 * @param {WizardAnswers} a
 * @returns {string} pretty-printed JSON
 */
function buildLazyConfig(a) {
  const specs = collectServerSpecs(a);
  /** @type {Record<string, unknown>[]} */
  const servers = specs.map((s) => {
    /** @type {Record<string, unknown>} */
    const entry = {
      name: s.name,
      mode: s.mode,
      transport: s.transport,
    };
    if (s.transport === 'stdio') {
      const { command, args } = resolveServerCommand(s);
      entry.command = command;
      entry.args = args;
    } else if (s.transport === 'streamable-http') {
      entry.url = s.url ?? '';
      entry.headers = s.headers ?? {};
    }
    entry.autoActivate = s.mode === 'lazy' ? false : true;
    entry.releaseOnTurnEnd = s.mode === 'lazy' ? true : false;
    entry.schemaDelivery = s.mode === 'lazy' ? 'message' : 'system';
    entry.routingHints = s.routingHints ?? [];
    return entry;
  });
  const cfg = {
    manager: Boolean(a.mcpAutoTakeover),
    'lazy-skills': Boolean(a.lazySkills),
    spot: Boolean(a.spotGate),
    servers,
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Themes copy
// ---------------------------------------------------------------------------

/**
 * Copy themes from vendored dist/ or source themes/ into ~/.dsh-tui/themes/
 * if absent. Idempotent — does not overwrite existing user themes.
 * @returns {number} count of themes copied
 */
function copyThemesIfNeeded() {
  // Source themes: repo themes/ (built by build-package.sh) OR dsh-overrides/themes/generated/
  const repoThemes = path.join(__dirname, '..', 'themes');
  const fallbackThemes = path.resolve(__dirname, '..', 'dsh-overrides', 'themes', 'generated');
  const src = fs.existsSync(repoThemes) ? repoThemes : fallbackThemes;
  if (!fs.existsSync(src)) return 0;

  if (!fs.existsSync(THEMES_USER_DIR)) {
    fs.mkdirSync(THEMES_USER_DIR, { recursive: true });
  }
  let count = 0;
  for (const entry of fs.readdirSync(src)) {
    if (!entry.endsWith('.json')) continue;
    const dest = path.join(THEMES_USER_DIR, entry);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(src, entry), dest);
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main wizard flow
// ---------------------------------------------------------------------------

/**
 * Run the 8-option wizard.
 * @returns {Promise<WizardAnswers>}
 */
async function runWizard() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  if (NON_INTERACTIVE) {
    console.log('dsh-setup --defaults: writing sane defaults (non-interactive)');
  } else {
    console.log('dsh-setup — first-run configuration wizard');
    console.log('8 options. Press Enter to accept defaults.\n');
  }

  // 1. Provider config
  console.log('\n== 1. Provider config ==');
  const providerName = await ask(rl, 'Provider name', 'bg');
  let apiKey = '';
  if (!NON_INTERACTIVE) {
    do {
      apiKey = await ask(rl, 'API key (env DSH_BG_API_KEY if empty)', '');
    } while (!apiKey && !await askBool(rl, 'Leave API key empty (use env var)?', true));
  } else {
    apiKey = '';
  }
  const apiKeyEnv = apiKey ? `DSH_${providerName.toUpperCase()}_API_KEY` : 'DSH_BG_API_KEY';
  const baseURL = await ask(rl, 'Base URL', 'https://api.deepseek.com');
  const validUrl = validateUrl(baseURL);
  if (!validUrl && !NON_INTERACTIVE) {
    console.error(`Invalid URL: ${baseURL}`);
    process.exitCode = 1;
  }
  const model = await ask(rl, 'Model', 'deepseek-chat');

  // 2. Lazy MCP enable?
  console.log('\n== 2. Lazy MCP ==');
  const lazyMcp = await askBool(rl, 'Enable lazy MCP? (auto-activate on tool call)', true);

  // 3. MCP auto-takeover manager?
  console.log('\n== 3. MCP auto-takeover manager ==');
  const mcpAutoTakeover = await askBool(rl, 'MCP auto-takeover? (hide TaskGate/octa behind lazy)', false);

  // 4. Configure your own MCP servers?
  console.log('\n== 4. Custom MCP servers ==');
  /** @type {WizardAnswers['customMcpServers']} */
  const customMcpServers = [];
  if (lazyMcp && !NON_INTERACTIVE) {
    let addMore = await askBool(rl, 'Add a custom MCP server?', false);
    while (addMore) {
      const name = await ask(rl, 'Server name', '');
      // BUG3 fix: mcp-lazy plugin dispatch supports only 'stdio' and
      // 'streamable-http' transports (StdioServerConfig / StreamableHttpServerConfig
      // in dsh-stack/profiles/dsh-tui/spot/mcp-lazy/lib/index.js:74-110). The old
      // prompt advertised two stale transport names that no schema branch
      // matched — one was a bare alias for streamable-http with no Config
      // variant, the other named a transport the @modelcontextprotocol/sdk
      // mapping does not expose. Either choice produced an entry mcp-lazy
      // rejected at boot. Validate input strictly so the wizard never emits an
      // entry that fails dispatch.
      let transport;
      if (NON_INTERACTIVE) {
        transport = 'stdio';
      } else {
        do {
          const raw = await ask(rl, 'Transport (stdio|streamable-http)', 'stdio');
          if (raw === 'stdio' || raw === 'streamable-http') {
            transport = raw;
            break;
          }
          console.error(`Invalid transport: ${raw} (only stdio or streamable-http)`);
        } while (true);
      }
      /** @type {{name:string, transport:string, command?:string, url?:string, args?:string[], headers?:Record<string,string>}} */
      const srv = { name, transport };
      if (transport === 'stdio') {
        srv.command = await ask(rl, 'Command', '');
        const argsRaw = await ask(rl, 'Args (comma-separated)', '');
        srv.args = argsRaw ? argsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
      } else {
        // streamable-http: needs a URL (+ optional headers)
        srv.url = await ask(rl, 'URL', '');
      }
      customMcpServers.push(srv);
      addMore = await askBool(rl, 'Add another?', false);
    }
  }

  // 5. Permanent always-on MCP?
  console.log('\n== 5. Permanent always-on MCP ==');
  let alwaysOnMcp = ['taskgate', 'octa'];
  if (!NON_INTERACTIVE) {
    const raw = await ask(rl, 'Always-on MCP servers (comma-separated)', 'taskgate,octa');
    alwaysOnMcp = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }

  // 6. Lazy skills mode?
  console.log('\n== 6. Lazy skills ==');
  const lazySkills = await askBool(rl, 'Lazy skills (code-lazy preset, skill_search/skill_load)?', true);

  // 7. spot cold-discovery gate?
  console.log('\n== 7. spot cold-discovery gate ==');
  const spotGate = await askBool(rl, 'Enable spot cold-discovery gate?', false);

  // 8. Core-patch env knobs
  console.log('\n== 8. Core-patch env knobs ==');
  const maxTokensContinueStr = await ask(rl, 'DSH_TUI_MAX_TOKENS_CONTINUE (0=off)', '3');
  const maxTokensContinue = parseInt(maxTokensContinueStr, 10);
  if (Number.isNaN(maxTokensContinue) || maxTokensContinue < 0) {
    console.error(`Invalid DSH_TUI_MAX_TOKENS_CONTINUE: ${maxTokensContinueStr}`);
    process.exitCode = 1;
  }
  const retryBudgetMinStr = await ask(rl, 'DSH_RETRY_BUDGET_MIN (0=off)', '0');
  const retryBudgetMin = parseInt(retryBudgetMinStr, 10);
  if (Number.isNaN(retryBudgetMin) || retryBudgetMin < 0) {
    console.error(`Invalid DSH_RETRY_BUDGET_MIN: ${retryBudgetMinStr}`);
    process.exitCode = 1;
  }
  const fallbackCwd = await ask(rl, 'DSH_FALLBACK_CWD (empty=off)', '');
  const mcpStderrToLog = await askBool(rl, 'mcp-stderr-to-log (capture MCP stderr to log)?', true);

  rl.close();

  return {
    providerName,
    apiKey,
    baseURL: validUrl || baseURL,
    model,
    apiKeyEnv,
    lazyMcp,
    mcpAutoTakeover,
    customMcpServers,
    alwaysOnMcp,
    lazySkills,
    spotGate,
    maxTokensContinue,
    retryBudgetMin,
    fallbackCwd,
    mcpStderrToLog,
  };
}

// ---------------------------------------------------------------------------
// ~/.dsh/settings.yaml clobber guard (HOTFIX 2026-10-17)
// ---------------------------------------------------------------------------
// dsh-setup previously wrote an unconditional 202-byte inert pointer
// (`profile: dsh-tui` + `profileDir`) to ~/.dsh/settings.yaml, destroying any
// real provider config (agent-default-model / providers / apiKeyEnv) the user
// or another tool had placed there. These helpers detect a "real" config and
// back it up before any pointer write, unless --force-dsh-settings is passed.

/**
 * Decide whether the file at `p` is a real dsh provider config (vs. the inert
 * pointer that dsh-setup itself writes). A file counts as real if it contains
 * an `agent-default-model` key, OR it has a `providers` section that is more
 * than just the pointer shape (profile / profileDir).
 * @param {string} p — absolute path to ~/.dsh/settings.yaml
 * @returns {boolean}
 */
function isRealDshSettings(p) {
  if (!fs.existsSync(p)) return false;
  let txt;
  try {
    txt = fs.readFileSync(p, 'utf8');
  } catch {
    return false;
  }
  if (txt.includes('agent-default-model')) return true;
  if (txt.includes('providers')) {
    // pointer-only files contain exactly profile + profileDir (+ comments).
    const nonComment = txt
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('#');
      })
      .join('\n');
    const hasNonPointerKey = /(^|\n)(profile|profileDir)\s*:/i.test(nonComment)
      ? nonComment
          .split('\n')
          .some((l) => {
            const k = l.split(':')[0].trim();
            return k && k !== 'profile' && k !== 'profileDir';
          })
      : true;
    return hasNonPointerKey;
  }
  return false;
}

/**
 * If `p` holds a real dsh config, copy it aside to
 * `<p>.bak-dsh-setup-clobber-<ts>` and return true. Otherwise return false.
 * Never throws on read failure (treats as not-real, skips backup).
 * @param {string} p
 * @returns {boolean} true if a real config was backed up
 */
function backupDshSettingsIfReal(p) {
  if (!isRealDshSettings(p)) return false;
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const bak = `${p}.bak-dsh-setup-clobber-${ts}`;
  try {
    fs.copyFileSync(p, bak);
    fs.chmodSync(bak, 0o600);
    console.warn(`[dsh-setup] existing real ~/.dsh/settings.yaml backed up to: ${bak}`);
    return true;
  } catch (e) {
    console.warn(`[dsh-setup] WARNING: failed to back up existing ~/.dsh/settings.yaml (${e.message}); skipping write to avoid clobber.`);
    return true; // still treat as real so we skip the pointer write
  }
}

/**
 * Write settings files to disk (idempotent merge).
 * @param {WizardAnswers} answers
 */
function writeSettings(answers) {
  fs.mkdirSync(DSH_TUI_DIR, { recursive: true });
  fs.mkdirSync(DSH_DIR, { recursive: true });

  // Build settings.yaml
  const settings = buildSettings(answers);
  const yamlContent = `# ~/.dsh-tui/settings.yaml — generated by dsh-setup (${new Date().toISOString()})
# Edit manually or re-run: dsh-setup\n\n${toYaml(settings, 0)}\n`;

  // Merge: if existing settings.yaml, preserve unknown top-level keys.
  if (fs.existsSync(SETTINGS_TUI)) {
    const existing = fs.readFileSync(SETTINGS_TUI, 'utf8');
    const managedMarker = '# ~/.dsh-tui/settings.yaml — generated by dsh-setup';
    const idx = existing.indexOf(managedMarker);
    if (idx >= 0) {
      // Replace managed block (from marker to EOF).
      const preserved = existing.slice(0, idx);
      fs.writeFileSync(SETTINGS_TUI, preserved + yamlContent);
    } else {
      // No managed block — append.
      fs.appendFileSync(SETTINGS_TUI, '\n' + yamlContent);
    }
  } else {
    fs.writeFileSync(SETTINGS_TUI, yamlContent);
  }

  // ~/.dsh/settings.yaml — FULL config (the file @deepseek-ai/dsh-settings-file reads).
  // NOT a pointer: profile/profileDir keys are inert — the harness ignores them.
  // The harness reads ~/.dsh/settings.yaml directly via resolveDshHome() + '/settings.yaml'.
  // Writing a bare pointer here leaves dsh with no agent-default-model / llm-pi-ai,
  // causing a silent fallback to DEFAULT_MODEL_ROUTE {deepseek-official, deepseek-v4-flash}.
  // HOTFIX 2026-10-17: clobber guard — never overwrite a real provider config unless
  // --force-dsh-settings is passed. isRealDshSettings() catches both agent-default-model
  // and providers-only configs; backupDshSettingsIfReal() backs up before skip.
  const dshYaml = `# ~/.dsh/settings.yaml — generated by dsh-setup (${new Date().toISOString()})
# Edit manually or re-run: dsh-setup\n\n${toYaml(settings, 0)}\n`;

  if (FORCE_DSH_SETTINGS) {
    // Explicit override — back up first (if real), then write full config.
    backupDshSettingsIfReal(SETTINGS_DSH);
    fs.writeFileSync(SETTINGS_DSH, dshYaml);
    fs.chmodSync(SETTINGS_DSH, 0o600);
    console.log(`  ${SETTINGS_DSH}: full config written (--force-dsh-settings)`);
  } else if (isRealDshSettings(SETTINGS_DSH)) {
    // Existing real provider config — preserve it, back up, skip write.
    backupDshSettingsIfReal(SETTINGS_DSH);
    console.warn(`[dsh-setup] existing real ~/.dsh/settings.yaml preserved (backed up to .bak-dsh-setup-clobber-...); pass --force-dsh-settings to overwrite.`);
  } else {
    // No real config (inert pointer, empty, or absent) — write the full config.
    fs.writeFileSync(SETTINGS_DSH, dshYaml);
    fs.chmodSync(SETTINGS_DSH, 0o600);
    console.log(`  ${SETTINGS_DSH}: full config written`);
  }

  // env.sh — core-patch env knobs
  const envShPath = path.join(DSH_TUI_DIR, 'env.sh');
  fs.writeFileSync(envShPath, buildEnvSh(answers));
  fs.chmodSync(envShPath, 0o644);

  // cordis.patch.yml — lazy MCP + spot wiring.
  // BUG4 fix: write to the profile-layer path the TUI actually loads
  // (homePatchPath = $DSH_HOME/profiles/dsh-tui/cordis.patch.yml, see
  // profile-boot-DG5t9aNs.js / i18n.js). The previous $DSH_TUI_DIR path was
  // inert — the harness never read it. mkdir -p the profile dir so a fresh
  // $DSH_HOME install (no profiles/dsh-tui/ tree yet) does not fail.
  const profileDir = path.join(DSH_DIR, 'profiles', 'dsh-tui');
  fs.mkdirSync(profileDir, { recursive: true });
  const cordisPatchPath = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(cordisPatchPath, buildCordisPatch(answers));

  // lazy-config.json — source-of-truth for the lazy MCP subsystem. Wave 2 reads
  // this same file (manager/lazy-skills/spot flags + server catalogue). Path
  // sits next to cordis.patch.yml so the profile dir holds the whole lazy
  // subsystem config in one place.
  const lazyConfigPath = path.join(profileDir, 'lazy-config.json');
  fs.writeFileSync(lazyConfigPath, buildLazyConfig(answers));

  // Copy themes if absent
  const themesCopied = copyThemesIfNeeded();

  console.log(`\n== dsh-setup complete ==`);
  console.log(`  settings:    ${SETTINGS_TUI}`);
  console.log(`  dsh:         ${SETTINGS_DSH}`);
  console.log(`  env:         ${envShPath}`);
  console.log(`  cordis:      ${cordisPatchPath}`);
  console.log(`  lazy-config: ${lazyConfigPath}`);
  if (themesCopied > 0) {
    console.log(`  themes:      ${themesCopied} copied to ${THEMES_USER_DIR}`);
  }
  console.log(`\nNext: source ${envShPath} && dsh`);
}

// ---------------------------------------------------------------------------
// Entry — guarded so importing the module (for unit tests) does NOT run the
// wizard. Only executes when invoked directly as `node bin/dsh-setup.js`.
// ---------------------------------------------------------------------------

// ESM auto-run guard: process.argv[1] is the entry script path; comparing it
// to import.meta.url tells us whether this module was imported or run.
const __isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (__isMain) {
  const answers = await runWizard();
  if (process.exitCode) {
    console.error('Validation error — fix and re-run dsh-setup');
    process.exit(process.exitCode);
  }
  writeSettings(answers);
}

// Exports for unit tests (buildCordisPatch / buildLazyConfig / collectServerSpecs
// contain non-trivial logic validated by tests/dsh-setup.test.js).
export {
  buildCordisPatch,
  buildLazyConfig,
  collectServerSpecs,
  KNOWN_MCP_DEFAULTS,
  DEFAULT_LAZY_SERVERS,
  resolveServerCommand,
  mcpStderrWrapperPath,
};
