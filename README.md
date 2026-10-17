# atomic-dsh — terminal chat UI for DeepSeek

atomic-dsh is a fork of dsh-tui 0.10.0-beta.4 with the SUBSYS.FF.B patch stack (77 patches) and 9 core patches applied in-tree. The harness and TUI are vendored — there is no runtime dependency on `@deepseek-ai/*`, so a single npm install ships a working client. forkVersion +p77.

## Status

- 77 SUBSYS.FF.B patches over dsh-tui 0.10.0-beta.4 (`PATCH-SERIES`) + 9 core patches on `@deepseek-ai/*` packages
- 50+ themes (signature = true black, `#000000`, WCAG AA text contrast)
- 58 spinners, animated powerline status bar, escape overlay effects
- Recursive task tree with subagent cards
- Stream stall detection + retry budget — answers don't truncate on flaky connections
- Works in kitty, WezTerm, Termux, zellij

## Requirements

- **Node ≥ 22** — lower fails with an engine error during install
- **pnpm** (enable with `corepack enable`) — only needed for `dsh plugin`

## Install

```bash
npm i -g atomic-dsh && dsh-setup && dsh
```

`dsh-setup` runs the first-run wizard: provider, API key, model routing. Output lands in `~/.dsh/settings.yaml`. `dsh` boots the TUI; on first run it auto-initializes the config.

### From source (contributors)

The npm package ships pre-patched. To build from the upstream sources instead:

```bash
git clone <repo-url> && cd deepseek_harness
bash scripts/apply-dsh-overrides.sh
```

The script is idempotent on markers — re-running is safe. Integrity check:

```bash
bash scripts/apply-dsh-overrides.sh --verify
```

## Lazy mode

`/settings` has an **MCP & Tools** section with toggles that control how MCP servers and skills enter the model's context. The default behaviour loads every MCP server and every skill schema up front, so the tool-schema block grows with each addition. Lazy mode flips that: servers and skills load on demand instead of all at once — tool schemas stay ~94% smaller (9727 → 581 tokens per turn).

Four toggles:

| Toggle | What it does |
|---|---|
| **manager** | ON wraps TaskGate/octa behind `@yilinxiao/dsh-mcp-lazy` (`mode: manager`). The manager registers two control-tools — `activate` and `deactivate` — plus a router, so the model pulls a server in only when it actually calls a tool from it. OFF leaves TaskGate/octa as direct stdio entries (the manager entry is `disabled: true`). |
| **lazy-skills** | Switches `~/.dsh-tui/agent-preset.json` between `code-lazy` and `dsh-default`. Under `code-lazy`, skills surface through lazy MCP instead of loading all schemas into context up front. Persists via `presetPrefs.js` — `settings.yaml` has no `agent-presets.default` field. |
| **spot** | ON inserts `./spot/plugin.mjs` (cold-discovery gate, lazy activation). OFF omits it. |
| **per-server mode** | Each MCP server in `lazy-config.json` cycles `always-on → lazy → off → always-on`. `always-on` = direct `@deepseek-ai/dsh-mcp-client` entry (always visible to the model). `lazy` = `@yilinxiao/dsh-mcp-lazy` entry (auto-activate on tool call, release on turn end). `off` = omitted entirely. |

Changes apply after restarting dsh. `cordis.patch.yml` is regenerated from `lazy-config.json` on every toggle; dsh loads it as `homePatchPath` at boot. The hint row in the hub reminds you to restart.

`activate` / `deactivate` are the runtime control-tools the lazy manager exposes — the model uses them mid-turn to bring a server into context or release it once the turn ends.

## Themes

50+ themes in `dsh-overrides/themes/`. The signature theme (`signature.json`):

- True black background: `appBackground: #000000`
- WCAG AA-adjusted colours — text contrast checked ≥ 4.5:1
- Background renders from the theme (env > settings > theme)

`/theme` in the TUI opens the picker: filter-search by name, 8 swatches for quick select, live preview.

## Patch stack SUBSYS.FF.B

77 patches with hierarchical numbering `subsystem.family.branch` (e.g. `IL.03.1`). DEP-3 format, metadata in each patch header.

### 12 subsystem codes

| Code | Domain |
|---|---|
| IL | inline render, scrollback, log-update |
| SB | status bar / footer slots |
| CH | chat layout: empty screen, intro, fs footer |
| MS | MessageList / message heights |
| TG | todo panel / subagent cards |
| HB | hubs and settings panels |
| EF | effects / animations / spinners |
| TH | themes / appearance / preview |
| PR | provider / model / channel |
| PI | prompt input |
| TR | terminal infra / keyboard / trace |
| ID | fork identification: logo, version, update-notice |

Apply order is fixed in `dsh-overrides/patches/PATCH-SERIES` — one line per patch, strict order. The old-ID → SUBSYS.FF.B map lives in `dsh-overrides/PATCH-MAP.md`.

### Invariants

| # | Invariant | Tool |
|---|---|---|
| I1 | Pristine-hash: sha256 upstream matches before/after revert-all | `apply-dsh-overrides.sh --verify` |
| I2 | Zero live edits outside patches | `dsh-drift-detect.sh` |
| I3 | Fresh-apply: revert-all → apply-all, failed=0 | `apply-dsh-overrides.sh` |
| I4 | Golden-gate: suite GREEN before merge | `tests/colab/dsh-tui-inline.yaml` |
| I5 | Metadata in headers: DEP-3 / Family / Status / series↔files | `patch-stack-lint.sh` |

```bash
bash tests/patch-stack/test-series-apply.sh
# 13+ asserts: series order, PATCH-SERIES↔files match, apply idempotency
```

## Testing

### Golden suite

`tests/colab/dsh-tui-inline.yaml` v10 — frozen E2E set, 20 detectors, 97 substeps.

| Category | Detectors | What they check |
|---|---|---|
| Baseline | `mode_inline` | inline render base |
| E1 scrollback | `e1_garbage_long`, `e1_garbage_resize`, `e1_garbage_shorts`, `e1_focus_probe` | scrollback free of chrome copies |
| E2 slash-menu | `e2_slash_menu_w47`, `e2_slash_menu_w180` | slash menu at narrow/wide widths |
| E5 contrast | `e5_color_contrast` | WCAG text contrast |
| Status bar | `sweep_statusbar_invariants`, `sweep_w47_minimum` | status bar invariants across widths |
| Geometry | `geometry_fuzz` | viewport geometry stress |
| Scenario | `scenario_smoke` | end-to-end scenario |
| Cards | `cards_render` | subagent card rendering |
| Stream | `stream_stall` | stream stall detection |
| Animations | `animations_gate` | effects/animations gate |
| Scroll | `scroll_jitter` | height jitter on scroll |
| E7 todo | `e7_todo_scrollback` | todo panel in scrollback |
| Compaction | `compact_visible` | compaction phase visibility |
| Exit | `exit_clean` | clean exit |
| Blank/flicker | `blank_spike` | blank zones and flicker |

### Fake-LLM

`tools/dsh-fake-llm/` — server on :8787 that emulates the model so the TUI can be tested without a real API. Scenarios: streaming, tool-use, subagents, errors.

### Running the golden suite

```bash
bash scripts/colab-dsh-up.sh --target current   # deploy the stack to the test VM
# then run tests/colab/dsh-tui-inline.yaml through the test runner
# green threshold: 20/20 detectors PASS
```

## Configuration

### settings.yaml

Main TUI config (`~/.dsh/settings.yaml`):

- `llm-pi-ai.providers` — provider routes (api, apiKeyEnv, baseURL, models)
- `agent-default-model` — default model
- `compaction-basic` — auto-compaction (`thresholdRatio`)

Example:

```yaml
llm-pi-ai:
  providers:
    bg:
      api: anthropic-messages
      apiKeyEnv: DSH_BG_API_KEY
      baseURL: https://your-relay.example
      models:
        - id: glm-5.3
cli:
  api: anthropic-messages
  apiKeyEnv: DSH_CLI_AUTH_TOKEN
  baseURL: http://localhost:8350
  models:
    - id: opus
    - id: sonnet
agent-default-model: bg/glm-5.3
```

### appearance.json

Effect toggles and theme settings:

- `animationsMode` — effects gate (spinnerRainbow, inputBreathe, todoPulse, etc.)
- `appBackground` — background colour (env > settings > theme)

### Environment variables

| Variable | Purpose |
|---|---|
| `DSH_TUI_GEOMETRY_TRACE` | Frame geometry trace (always-on); 8 MB rotation. `=0` kill-switch, `=<file>` override log path |
| `DSH_TUI_SYNC_OUTPUT` | Synced output for terminals with flicker |
| `DSH_RETRY_BUDGET_MIN` | Minimum retry budget for requests |

Secrets (`DSH_BG_API_KEY`, `DSH_CLI_AUTH_TOKEN`) live in the credentials file, never committed.

## Layout

```
deepseek_harness/
├── dsh-overrides/
│   ├── patches/              # 77 SUBSYS.FF.B .patch + PATCH-SERIES
│   ├── core-patches/         # 9 patches on @deepseek-ai/* packages
│   ├── themes/               # 50+ themes (signature.json = true black)
│   ├── PATCH-MAP.md          # old-ID → SUBSYS.FF.B map
│   └── settings/             # settings.yaml.example, appearance.json
├── scripts/
│   ├── apply-dsh-overrides.sh    # apply the stack (--verify for I1)
│   ├── colab-dsh-up.sh           # deploy the stack to test VM
│   ├── dsh-drift-detect.sh       # live-edit detector (I2)
│   ├── patch-stack-lint.sh       # DEP-3 header linter
│   ├── patch-stack-regen.sh      # regen a branch from live diff
│   └── generate-pristine-manifest.sh
├── tests/
│   ├── colab/dsh-tui-inline.yaml # golden suite v10
│   └── patch-stack/test-series-apply.sh
├── tools/
│   └── dsh-fake-llm/             # :8787 server, TUI test scenarios
└── README.md
```

## Contributors

### Patch-stack rules

1. Never edit live files outside patches (I2). Any change to an upstream file goes through a new or edited `.patch`.
2. After editing a patch: revert-all → apply-all (I3). Check `failed=0` in `apply-dsh-overrides.sh` output.
3. Golden-gate before merge (I4). Suite must be GREEN on the test VM.
4. DEP-3 headers mandatory (I5). Each patch carries `Subsystem`, `Family`, `Status`, and the series↔files mapping.
5. New patch = new entry in `PATCH-SERIES` + a marker in `apply-dsh-overrides.sh`.

### TDD

Non-trivial logic (branching, parsing, calculations) — write tests first (red), then the implementation (green). Tests live in `tests/`. Run `node --check` after every change.

### Git

- Commit after each step.
- Never commit secrets, `.env`, tokens, large logs.
- Push origin after a wave of changes lands.

---

forkVersion +p77 · upstream dsh-tui 0.10.0-beta.4 · 12 SUBSYS.FF.B subsystems · 9 core patches
