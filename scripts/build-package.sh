#!/usr/bin/env bash
# build-package.sh — atomic-dsh vendored build (deterministic, idempotent).
#
# Produces self-contained dist/ + plugins/ + themes/ for npm publish.
# dist/ holds the full patched tree: @deepseek-ai/dsh harness (with 8 core
# patches) + @deepseek-harness-tui/dsh-tui (with 76 SUBSYS.FF.B patches) +
# ALL runtime deps (transitive). bin/dsh-bin.js is the entrypoint shim.
#
# Idempotent: rm -rf build-staging dist plugins themes at start, then rebuild.
# Exit 0 if all steps succeed (apply core+TUI failed=0, node --check OK).
#
# Versions are PINNED to match core patches (manifest.conf version_global).
# Core patches target @deepseek-ai/dsh@0.1.1-rc.2 sub-packages; npm latest
# (0.2.0-rc.2) has different lib/index.js → patches would fail. Do NOT bump
# without regenerating core patches (manifest.conf orig_md5 + backups).
#
# Usage: bash scripts/build-package.sh
# Env: DSH_VERSION (default 0.1.1-rc.2), TUI_VERSION (default 0.10.0-beta.4)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
TUI_VERSION="${TUI_VERSION:-0.10.0-beta.4}"

BUILD_DIR="build-staging"
DIST_DIR="dist"
PLUGINS_DIR="plugins"
THEMES_DIR="themes"

echo "== atomic-dsh build: @deepseek-ai/dsh@${DSH_VERSION} + @deepseek-harness-tui/dsh-tui@${TUI_VERSION}"

# --- Clean (idempotent) ------------------------------------------------------
rm -rf "$BUILD_DIR" "$DIST_DIR" "$PLUGINS_DIR" "$THEMES_DIR"

# --- (a) Install upstream sources -------------------------------------------
echo "== (a) npm install upstream"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
# Minimal package.json for npm install (deps declared so --save works).
cat > package.json <<EOF
{
  "name": "atomic-dsh-build-staging",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "@deepseek-ai/dsh": "${DSH_VERSION}",
    "@deepseek-harness-tui/dsh-tui": "${TUI_VERSION}"
  }
}
EOF
# --legacy-peer-deps: dsh-tui has 32 peer deps (cordis + 30 dsh-* + schemastery)
# that npm tries to resolve eagerly, causing multi-minute hangs. With --legacy-peer-deps
# npm skips peer resolution (peers provided by @deepseek-ai/dsh transitive deps).
npm install \
  --legacy-peer-deps \
  --no-audit --no-fund 2>&1 | tail -10
cd "$REPO_ROOT"

# Verify install
[ -d "$BUILD_DIR/node_modules/@deepseek-ai/dsh" ] || { echo "FAIL: @deepseek-ai/dsh not installed"; exit 1; }
[ -d "$BUILD_DIR/node_modules/@deepseek-harness-tui/dsh-tui" ] || { echo "FAIL: @deepseek-harness-tui/dsh-tui not installed"; exit 1; }
echo "  installed: dsh $(grep -m1 '"version"' "$BUILD_DIR/node_modules/@deepseek-ai/dsh/package.json" | sed -E 's/.*"version".*"([^"]+)".*/\1/')"
echo "  installed: dsh-tui $(grep -m1 '"version"' "$BUILD_DIR/node_modules/@deepseek-harness-tui/dsh-tui/package.json" | sed -E 's/.*"version".*"([^"]+)".*/\1/')"

# --- (b) Apply core patches (8 patches on harness sub-packages) -------------
echo "== (b) apply core patches (8)"
# Override auto-discovery: target build-staging/node_modules (npm hoists all
# @deepseek-ai/* and @earendil-works/* deps to top-level node_modules with
# --legacy-peer-deps). discover_targets does $DSH_CORE_TARGET_DIR/$pkg/$rel.
export DSH_CORE_TARGET_DIR="$REPO_ROOT/$BUILD_DIR/node_modules"
bash "$SCRIPT_DIR/apply-dsh-core-overrides.sh" 2>&1 | tee /tmp/atomic-dsh-core-apply.log
CORE_RC=${PIPESTATUS[0]}
if [ "$CORE_RC" -ne 0 ]; then
  echo "FAIL: core patches apply failed (rc=$CORE_RC)"
  exit 1
fi
# Verify failed=0 (script exits non-zero on failures, but double-check log).
if grep -qE 'failed:[[:space:]]*[1-9]' /tmp/atomic-dsh-core-apply.log 2>/dev/null; then
  echo "FAIL: core patches had failures (see log)"
  exit 1
fi
echo "  core patches: failed=0 (OK)"

# --- (c) Apply TUI patches (76 SUBSYS.FF.B) --------------------------------
echo "== (c) apply TUI patches (76 SUBSYS.FF.B)"
export TUI_BASE="$REPO_ROOT/$BUILD_DIR/node_modules/@deepseek-harness-tui/dsh-tui"
export DSH_PROFILE="dsh-tui"
bash "$SCRIPT_DIR/apply-dsh-overrides.sh" 2>&1 | tee /tmp/atomic-dsh-tui-apply.log
TUI_RC=${PIPESTATUS[0]}
if [ "$TUI_RC" -ne 0 ]; then
  echo "FAIL: TUI patches apply failed (rc=$TUI_RC)"
  exit 1
fi
echo "  TUI patches: failed=0 (OK)"

# --- (d) Bundle into dist/ --------------------------------------------------
echo "== (d) bundle dist/"
mkdir -p "$DIST_DIR"

# Copy the full node_modules tree (self-contained: harness + TUI + all deps).
# This is the atomic guarantee — no runtime npm install needed by end user.
cp -r "$BUILD_DIR/node_modules" "$DIST_DIR/node_modules"

# Copy entrypoint shim (source bin/dsh-bin.js → dist/dsh-bin.js).
cp "bin/dsh-bin.js" "$DIST_DIR/dsh-bin.js"
chmod +x "$DIST_DIR/dsh-bin.js"

# --- (e) Bundle plugins -----------------------------------------------------
echo "== (e) bundle plugins/"
mkdir -p "$PLUGINS_DIR/mcp-lazy" "$PLUGINS_DIR/code-lazy" "$PLUGINS_DIR/spot"

# mcp-lazy plugin (from dsh-stack/profiles/dsh-tui/spot/mcp-lazy/)
cp -r dsh-stack/profiles/dsh-tui/spot/mcp-lazy/* "$PLUGINS_DIR/mcp-lazy/" 2>/dev/null || true
# Exclude test/ from published plugin
rm -rf "$PLUGINS_DIR/mcp-lazy/test" 2>/dev/null || true

# code-lazy preset (from dsh-stack/agent-presets/code-lazy/)
cp -r dsh-stack/agent-presets/code-lazy/* "$PLUGINS_DIR/code-lazy/"

# spot plugin (plugin.mjs + lib/ + registry/hide from dsh-stack/profiles/dsh-tui/spot/)
cp dsh-stack/profiles/dsh-tui/spot/plugin.mjs "$PLUGINS_DIR/spot/"
cp -r dsh-stack/profiles/dsh-tui/spot/lib "$PLUGINS_DIR/spot/"
cp dsh-stack/profiles/dsh-tui/spot/registry.json dsh-stack/profiles/dsh-tui/spot/hide.json "$PLUGINS_DIR/spot/" 2>/dev/null || true

# --- (f) Bundle themes ------------------------------------------------------
echo "== (f) bundle themes/"
mkdir -p "$THEMES_DIR"
cp -r dsh-overrides/themes/generated/* "$THEMES_DIR/"
THEME_COUNT=$(ls "$THEMES_DIR"/*.json 2>/dev/null | wc -l)
echo "  themes: $THEME_COUNT files (50 themes + signature.json)"

# --- (g) node --check entrypoints ------------------------------------------
echo "== (g) node --check"
node --check "$DIST_DIR/dsh-bin.js" || { echo "FAIL: dist/dsh-bin.js syntax"; exit 1; }
node --check "bin/dsh-setup.js" || { echo "FAIL: bin/dsh-setup.js syntax"; exit 1; }
echo "  node --check: OK"

# --- Summary ----------------------------------------------------------------
echo ""
echo "== atomic-dsh build complete =="
echo "  dist/:      $(du -sh "$DIST_DIR" | awk '{print $1}') ($(find "$DIST_DIR" -type f | wc -l) files)"
echo "  plugins/:   $(du -sh "$PLUGINS_DIR" | awk '{print $1}')"
echo "  themes/:    $THEME_COUNT files"
echo "  versions:   dsh@$DSH_VERSION + dsh-tui@$TUI_VERSION + 8 core-patches + 76 TUI-patches"
