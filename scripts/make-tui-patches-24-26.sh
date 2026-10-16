#!/usr/bin/env bash
# make-tui-patches-24-26.sh — генерация патчей 24/25/26 из живого кода dsh-tui.
# Правит файлы точечными заменами, диффит против бэкапа, откатывает файлы.
# Патчи кладёт в dsh-overrides/patches/. Запускать из корня репо.
set -euo pipefail

TUI_BASE="$(readlink -f "$HOME/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui")"
export TUI_BASE
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dsh-overrides/patches"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CHAT="$TUI_BASE/lib/types/screens/Chat.js"
PROMPT="$TUI_BASE/lib/types/components/PromptInput.js"
MLIST="$TUI_BASE/lib/types/components/MessageList.js"

cp "$CHAT" "$TMP/Chat.js.orig"
cp "$PROMPT" "$TMP/PromptInput.js.orig"
cp "$MLIST" "$TMP/MessageList.js.orig"

# ─── Патч 24: Chat.js root Box — fullscreen bottom-anchor ──────────────────
python3 - "$CHAT" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()
old = '''    return (_jsxs(Box, { ref: wakeTickRef, flexDirection: "column", flexGrow: 1, width: "100%", ...(inlinePinned ? { height: terminalRows, flexShrink: 0, justifyContent: "flex-end" } : {}), children: ['''
new = '''    // dsh-overrides 24: fullscreen bottom-anchor. In fullscreen the root Box
    // grows inside AlternateScreen's height=rows frame; without justifyContent
    // the free rows (short transcript, patch 01's flexGrow 0 while rows=0)
    // collected UNDER the statusline — a floating footer with blank space
    // below the status bar that grew/shrank as chrome mounted (the start-of-
    // session "breathing"). Anchoring the column to flex-end pins the footer
    // block to the last terminal row in fullscreen exactly like patch 11's
    // inline pinned frame (which keeps its height/flexShrink constraints).
    return (_jsxs(Box, { ref: wakeTickRef, flexDirection: "column", flexGrow: 1, width: "100%", ...(inlinePinned || fullscreen ? { justifyContent: "flex-end", ...(inlinePinned ? { height: terminalRows, flexShrink: 0 } : {}) } : {}), children: ['''
assert src.count(old) == 1, f'patch24 anchor not found or ambiguous: {src.count(old)}'
open(p, 'w').write(src.replace(old, new))
print('patch24: Chat.js root Box ok')
PYEOF

# ─── Патч 25: Chat.js contentJustify — fullscreen разделяет правило pinned ──
python3 - "$CHAT" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()
old = '''                contentJustify: inlinePinned ? 'flex-end' : undefined,'''
new = '''                // dsh-overrides 25: fullscreen shares the pinned-frame slack
                // rule. Without it the band sits between the transcript end
                // and the footer and MIGRATES as content mounts (the first
                // message moves the freed rows from below the statusline
                // into the viewport interior — visible "breathing"). With
                // flex-end the slack always stays ABOVE the transcript: the
                // footer never moves and content grows upward, terminal-
                // style. No-op when the content fills the viewport.
                contentJustify: inlinePinned || fullscreen ? 'flex-end' : undefined,'''
assert src.count(old) == 1, f'patch25 anchor not found or ambiguous: {src.count(old)}'
open(p, 'w').write(src.replace(old, new))
print('patch25: Chat.js contentJustify ok')
PYEOF

# ─── Патч 26a: PromptInput.js — helpOpen без marginBottom ───────────────────
python3 - "$PROMPT" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()
old = '''helpOpen && (_jsx(Box, { marginBottom: 1, children: _jsx(HelpMenu,'''
new = '''helpOpen && (_jsx(Box, { children: _jsx(HelpMenu,'''
assert src.count(old) == 1, f'patch26a anchor not found or ambiguous: {src.count(old)}'
open(p, 'w').write(src.replace(old, new))
print('patch26a: PromptInput.js helpOpen marginBottom ok')
PYEOF

# ─── Патч 26b: MessageList.js — streaming/compact margin ВНУТРЬ ref-узла ────
python3 - "$MLIST" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()

# streaming assistant: margin был на ref-узле → measured height его исключала.
old_s = '''            return streaming ? (_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: background, ref: ref, children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(text) }) })] }))'''
new_s = '''            // dsh-overrides 26: the margin lives INSIDE the ref'd wrapper
            // (an inner Box), matching every other row kind — the measured
            // wrapper height then includes the margin, so the virtualization
            // spacer that replaces this row while it is unmounted covers the
            // full row extent. With the margin on the wrapper itself the
            // spacer was one line short and the transcript jumped a line on
            // every mount/unmount crossing.
            return streaming ? (_jsx(Box, { flexDirection: "column", width: "100%", backgroundColor: background, ref: ref, children: [_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(text) }) })] })] }))'''
assert src.count(old_s) == 1, f'patch26b streaming anchor: {src.count(old_s)}'
src = src.replace(old_s, new_s)

# compact row: margin внутрь ref-обёртки (полная строка).
old_c = '''            return (_jsx(Box, { marginTop: addMargin ? 1 : 0, paddingLeft: 2, backgroundColor: background, ref: ref, onClick: foldOnClick, onMouseEnter: () => setCompactHovered(true), onMouseLeave: () => setCompactHovered(false), children: expanded || isExpanded ? (_jsx(Text, { dimColor: true, children: text })) : (_jsxs(Text, { dimColor: true, italic: true, color: compactHovered ? 'text' : undefined, children: [_jsx(Text, { color: compactHovered ? 'text' : undefined, children: "\\u2234" }), ' ', t('compact-summary-folded'), " \\u00B7 ", compactPreview(text), ' ', t('hint-expand-ctrl-o')] })) }));'''
new_c = '''            // dsh-overrides 26: margin inside the ref'd wrapper (see the
            // streaming-assistant row above) so the measured height feeds
            // the spacer model with the full row extent.
            return (_jsx(Box, { backgroundColor: background, ref: ref, onClick: foldOnClick, onMouseEnter: () => setCompactHovered(true), onMouseLeave: () => setCompactHovered(false), children: _jsx(Box, { marginTop: addMargin ? 1 : 0, paddingLeft: 2, children: expanded || isExpanded ? (_jsx(Text, { dimColor: true, children: text })) : (_jsxs(Text, { dimColor: true, italic: true, color: compactHovered ? 'text' : undefined, children: [_jsx(Text, { color: compactHovered ? 'text' : undefined, children: "\\u2234" }), ' ', t('compact-summary-folded'), " \\u00B7 ", compactPreview(text), ' ', t('hint-expand-ctrl-o')] })) }) }));'''
assert src.count(old_c) == 1, f'patch26b compact anchor: {src.count(old_c)}'
src = src.replace(old_c, new_c)
open(p, 'w').write(src)
print('patch26b: MessageList.js streaming/compact margin ok')
PYEOF

# ─── Патч 26c: MessageList.js — kind-aware спейсер-оценка + heightOf ────────
python3 - "$MLIST" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()

# heightOf: kind-average fallback между heightsRef и DEFAULT_ROW_HEIGHT.
old_h = '''    const heightOf = (row) => heightsRef.current.get(row.id) ?? DEFAULT_ROW_HEIGHT;'''
new_h = '''    // dsh-overrides 26: kind-aware spacer estimate. A never-measured row
    // (history replay past MAX_RENDERED_ROWS, loadOlder reveals, FAR jumps)
    // falls back to DEFAULT_ROW_HEIGHT=2, but a bash tool card measures ~6 —
    // the spacer model then undershoots the real extent by 4 lines per card
    // and the scroll geometry jumps as rows measure on entry. A running
    // per-kind average of already-measured rows (updated by the measure
    // effect below) is a far tighter prior; DEFAULT_ROW_HEIGHT remains the
    // cold-start value before any row of that kind has ever mounted.
    const heightOf = (row) => heightsRef.current.get(row.id) ?? (Math.round(kindAvgRef.current.get(row.kind)?.avg ?? 0) || DEFAULT_ROW_HEIGHT);'''
assert src.count(old_h) == 1, f'patch26c heightOf anchor: {src.count(old_h)}'
src = src.replace(old_h, new_h)

# ref для kind-средних — рядом с offsetsBufRef.
old_anchor = '''    const offsetsBufRef = React.useRef([]);'''
new_anchor = '''    // dsh-overrides 26: per-kind running average of measured row heights
    // (spacer estimate for never-measured rows — see heightOf).
    const kindAvgRef = React.useRef(new Map());
    const offsetsBufRef = React.useRef([]);'''
assert src.count(old_anchor) == 1, f'patch26c ref anchor: {src.count(old_anchor)}'
src = src.replace(old_anchor, new_anchor)

# измерение: поддерживать kind-средние после замера высот.
old_m = '''        for (const [id, el] of localRefs.current) {
            const h = el.yogaNode?.getComputedHeight();
            if (h !== undefined && h > 0 && heightsRef.current.get(id) !== h) {
                if (heightsRef.current.size >= HEIGHTS_CACHE_MAX) {
                    const oldest = heightsRef.current.keys().next().value;
                    if (oldest !== undefined)
                        heightsRef.current.delete(oldest);
                }
                heightsRef.current.set(id, h);
                heightsVersionRef.current++;
                changed = true;
            }
        }'''
new_m = '''        for (const [id, el] of localRefs.current) {
            const h = el.yogaNode?.getComputedHeight();
            if (h !== undefined && h > 0 && heightsRef.current.get(id) !== h) {
                if (heightsRef.current.size >= HEIGHTS_CACHE_MAX) {
                    const oldest = heightsRef.current.keys().next().value;
                    if (oldest !== undefined)
                        heightsRef.current.delete(oldest);
                }
                heightsRef.current.set(id, h);
                heightsVersionRef.current++;
                changed = true;
            }
        }
        // dsh-overrides 26: refresh the per-kind height averages feeding the
        // never-measured spacer estimate (see heightOf). Incremental: each
        // newly measured row nudges its kind's average; the first 64 samples
        // build a plain mean, afterwards an exponential drift so a changed
        // layout (theme/terminal width) re-converges instead of freezing.
        {
            const kindAvg = kindAvgRef.current;
            for (let i = 0; i < visibleRows.length; i++) {
                const h = heightsRef.current.get(visibleRows[i].id);
                if (h === undefined)
                    continue;
                const agg = kindAvg.get(visibleRows[i].kind);
                if (agg === undefined) {
                    kindAvg.set(visibleRows[i].kind, { sum: h, n: 1, avg: h });
                }
                else if (agg.n < 64) {
                    agg.sum += h;
                    agg.n++;
                    agg.avg = agg.sum / agg.n;
                }
                else {
                    agg.avg = agg.avg * 0.98 + h * 0.02;
                }
            }
        }'''
assert src.count(old_m) == 1, f'patch26c measure anchor: {src.count(old_m)}'
src = src.replace(old_m, new_m)
open(p, 'w').write(src)
print('patch26c: MessageList.js kind-average ok')
PYEOF

# ─── Синтакс-контроль изменённых файлов ─────────────────────────────────────
node --check "$CHAT"
node --check "$PROMPT"
node --check "$MLIST"
echo "node --check: OK"

# ─── Диффы ──────────────────────────────────────────────────────────────────
cd "$TUI_BASE"
diff -u "$TMP/Chat.js.orig" "$CHAT" > "$TMP/chat.diff" || true
diff -u "$TMP/PromptInput.js.orig" "$PROMPT" > "$TMP/prompt.diff" || true
diff -u "$TMP/MessageList.js.orig" "$MLIST" > "$TMP/mlist.diff" || true

python3 - "$TMP" "$OUT" <<'PYEOF'
import sys, os
tmp, out = sys.argv[1], sys.argv[2]

def read_hunks(path):
    lines = open(path).read().split('\n')
    head = []
    hunks = []
    cur = None
    for l in lines:
        if l.startswith('@@'):
            if cur is not None:
                hunks.append(cur)
            cur = [l]
        elif cur is None:
            head.append(l)
        else:
            cur.append(l)
    if cur is not None:
        hunks.append(cur)
    return head, hunks

def write_patch(fname, header_lines, hunks):
    with open(f'{out}/{fname}', 'w') as f:
        f.write('\n'.join(header_lines).rstrip('\n') + '\n')
        for h in hunks:
            f.write('\n'.join(h).rstrip('\n') + '\n')

_, chat_hunks = read_hunks(f'{tmp}/chat.diff')
_, prompt_hunks = read_hunks(f'{tmp}/prompt.diff')
_, mlist_hunks = read_hunks(f'{tmp}/mlist.diff')

CHAT_HDR = ['--- a/lib/types/screens/Chat.js', '+++ b/lib/types/screens/Chat.js']
PROMPT_HDR = ['--- a/lib/types/components/PromptInput.js', '+++ b/lib/types/components/PromptInput.js']
MLIST_HDR = ['--- a/lib/types/components/MessageList.js', '+++ b/lib/types/components/MessageList.js']

# 24: ханк с маркером dsh-overrides 24 (root Box).
h24 = [h for h in chat_hunks if any('dsh-overrides 24' in l for l in h)]
h25 = [h for h in chat_hunks if any('dsh-overrides 25' in l for l in h)]
assert len(h24) == 1, f'expected 1 hunk for 24, got {len(h24)}'
assert len(h25) == 1, f'expected 1 hunk for 25, got {len(h25)}'
write_patch('24-fs-footer-bottom.patch', CHAT_HDR, h24)
write_patch('25-fs-height-stable.patch', CHAT_HDR, h25)
write_patch('26-scroll-menu-nogap.patch', PROMPT_HDR, prompt_hunks)
write_patch('26b-scroll-menu-nogap.patch', MLIST_HDR, mlist_hunks)
print(f'chat hunks: {len(chat_hunks)}, prompt hunks: {len(prompt_hunks)}, mlist hunks: {len(mlist_hunks)}')
PYEOF

# Откат живых файлов к исходным (патчи применит apply-скрипт).
cp "$TMP/Chat.js.orig" "$CHAT"
cp "$TMP/PromptInput.js.orig" "$PROMPT"
cp "$TMP/MessageList.js.orig" "$MLIST"
echo "files reverted to pre-24/25/26 state; patches generated:"
ls -la "$OUT"/2[456]*.patch
