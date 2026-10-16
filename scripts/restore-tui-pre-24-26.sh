#!/usr/bin/env bash
# restore-tui-pre-24-26.sh — откат МОИХ правок 24/25/26 из живых файлов
# dsh-tui (после падения генератора до revert-секции). Обратные замены
# new→old с проверкой счётчиков; после отката файлы должны быть байт-идентичны
# состоянию до моих правок (патчи 01-23 остаются применёнными).
set -euo pipefail

TUI_BASE="$(readlink -f "$HOME/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui")"
CHAT="$TUI_BASE/lib/types/screens/Chat.js"
PROMPT="$TUI_BASE/lib/types/components/PromptInput.js"
MLIST="$TUI_BASE/lib/types/components/MessageList.js"

cp "$CHAT" /tmp/Chat.js.broken
cp "$PROMPT" /tmp/PromptInput.js.broken
cp "$MLIST" /tmp/MessageList.js.broken

python3 - "$CHAT" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()

new24 = '''    // dsh-overrides 24: fullscreen bottom-anchor. In fullscreen the root Box
    // grows inside AlternateScreen's height=rows frame; without justifyContent
    // the free rows (short transcript, patch 01's flexGrow 0 while rows=0)
    // collected UNDER the statusline — a floating footer with blank space
    // below the status bar that grew/shrank as chrome mounted (the start-of-
    // session "breathing"). Anchoring the column to flex-end pins the footer
    // block to the last terminal row in fullscreen exactly like patch 11's
    // inline pinned frame (which keeps its height/flexShrink constraints).
    return (_jsxs(Box, { ref: wakeTickRef, flexDirection: "column", flexGrow: 1, width: "100%", ...(inlinePinned || fullscreen ? { justifyContent: "flex-end", ...(inlinePinned ? { height: terminalRows, flexShrink: 0 } : {}) } : {}), children: ['''
old24 = '''    return (_jsxs(Box, { ref: wakeTickRef, flexDirection: "column", flexGrow: 1, width: "100%", ...(inlinePinned ? { height: terminalRows, flexShrink: 0, justifyContent: "flex-end" } : {}), children: ['''
assert src.count(new24) == 1, f'24 restore anchor: {src.count(new24)}'
src = src.replace(new24, old24)

new25 = '''                // dsh-overrides 25: fullscreen shares the pinned-frame slack
                // rule. Without it the band sits between the transcript end
                // and the footer and MIGRATES as content mounts (the first
                // message moves the freed rows from below the statusline
                // into the viewport interior — visible "breathing"). With
                // flex-end the slack always stays ABOVE the transcript: the
                // footer never moves and content grows upward, terminal-
                // style. No-op when the content fills the viewport.
                contentJustify: inlinePinned || fullscreen ? 'flex-end' : undefined,'''
old25 = '''                contentJustify: inlinePinned ? 'flex-end' : undefined,'''
assert src.count(new25) == 1, f'25 restore anchor: {src.count(new25)}'
src = src.replace(new25, old25)

open(p, 'w').write(src)
print('Chat.js: 24/25 reverted')
PYEOF

python3 - "$PROMPT" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()
new = '''helpOpen && (_jsx(Box, { children: _jsx(HelpMenu,'''
old = '''helpOpen && (_jsx(Box, { marginBottom: 1, children: _jsx(HelpMenu,'''
assert src.count(new) == 1, f'26a restore anchor: {src.count(new)}'
open(p, 'w').write(src.replace(new, old))
print('PromptInput.js: 26a reverted')
PYEOF

python3 - "$MLIST" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()

# 26b streaming
new_s = '''            // dsh-overrides 26: the margin lives INSIDE the ref'd wrapper
            // (an inner Box), matching every other row kind — the measured
            // wrapper height then includes the margin, so the virtualization
            // spacer that replaces this row while it is unmounted covers the
            // full row extent. With the margin on the wrapper itself the
            // spacer was one line short and the transcript jumped a line on
            // every mount/unmount crossing.
            return streaming ? (_jsx(Box, { flexDirection: "column", width: "100%", backgroundColor: background, ref: ref, children: [_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(text) }) })] })] }))'''
old_s = '''            return streaming ? (_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: background, ref: ref, children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(text) }) })] }))'''
assert src.count(new_s) == 1, f'26b streaming restore: {src.count(new_s)}'
src = src.replace(new_s, old_s)

# 26b compact
new_c = '''            // dsh-overrides 26: margin inside the ref'd wrapper (see the
            // streaming-assistant row above) so the measured height feeds
            // the spacer model with the full row extent.
            return (_jsx(Box, { backgroundColor: background, ref: ref, onClick: foldOnClick, onMouseEnter: () => setCompactHovered(true), onMouseLeave: () => setCompactHovered(false), children: _jsx(Box, { marginTop: addMargin ? 1 : 0, paddingLeft: 2, children: expanded || isExpanded ? (_jsx(Text, { dimColor: true, children: text })) : (_jsxs(Text, { dimColor: true, italic: true, color: compactHovered ? 'text' : undefined, children: [_jsx(Text, { color: compactHovered ? 'text' : undefined, children: "\\u2234" }), ' ', t('compact-summary-folded'), " \\u00B7 ", compactPreview(text), ' ', t('hint-expand-ctrl-o')] })) }) }));'''
old_c = '''            return (_jsx(Box, { marginTop: addMargin ? 1 : 0, paddingLeft: 2, backgroundColor: background, ref: ref, onClick: foldOnClick, onMouseEnter: () => setCompactHovered(true), onMouseLeave: () => setCompactHovered(false), children: expanded || isExpanded ? (_jsx(Text, { dimColor: true, children: text })) : (_jsxs(Text, { dimColor: true, italic: true, color: compactHovered ? 'text' : undefined, children: [_jsx(Text, { color: compactHovered ? 'text' : undefined, children: "\\u2234" }), ' ', t('compact-summary-folded'), " \\u00B7 ", compactPreview(text), ' ', t('hint-expand-ctrl-o')] })) }));'''
assert src.count(new_c) == 1, f'26b compact restore: {src.count(new_c)}'
src = src.replace(new_c, old_c)

# 26c heightOf (сломанная строка)
new_h = '''    // dsh-overrides 26: kind-aware spacer estimate. A never-measured row
    // (history replay past MAX_RENDERED_ROWS, loadOlder reveals, FAR jumps)
    // falls back to DEFAULT_ROW_HEIGHT=2, but a bash tool card measures ~6 —
    // the spacer model then undershoots the real extent by 4 lines per card
    // and the scroll geometry jumps as rows measure on entry. A running
    // per-kind average of already-measured rows (updated by the measure
    // effect below) is a far tighter prior; DEFAULT_ROW_HEIGHT remains the
    // cold-start value before any row of that kind has ever mounted.
    const heightOf = (row) => heightsRef.current.get(row.id) ?? Math.round(kindAvgRef.current.get(row.kind)?.avg ?? 0) || DEFAULT_ROW_HEIGHT;'''
old_h = '''    const heightOf = (row) => heightsRef.current.get(row.id) ?? DEFAULT_ROW_HEIGHT;'''
assert src.count(new_h) == 1, f'26c heightOf restore: {src.count(new_h)}'
src = src.replace(new_h, old_h)

# 26c ref
new_ref = '''    // dsh-overrides 26: per-kind running average of measured row heights
    // (spacer estimate for never-measured rows — see heightOf).
    const kindAvgRef = React.useRef(new Map());
    const offsetsBufRef = React.useRef([]);'''
old_ref = '''    const offsetsBufRef = React.useRef([]);'''
assert src.count(new_ref) == 1, f'26c ref restore: {src.count(new_ref)}'
src = src.replace(new_ref, old_ref)

# 26c measure-effect addition
new_m = '''        // dsh-overrides 26: refresh the per-kind height averages feeding the
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
marker = '''        // dsh-overrides 26: refresh the per-kind height averages feeding the'''
assert src.count(marker) == 1, f'26c measure marker: {src.count(marker)}'
src = src.replace('\n' + new_m, '')

open(p, 'w').write(src)
print('MessageList.js: 26b/26c reverted')
PYEOF

# ─── Проверки после отката ──────────────────────────────────────────────────
node --check "$CHAT"
node --check "$PROMPT"
node --check "$MLIST"
echo "node --check: все три OK"

# Мои маркеры должны исчезнуть.
for m in 'dsh-overrides 24' 'dsh-overrides 25' 'dsh-overrides 26' 'kindAvgRef' 'inlinePinned || fullscreen'; do
  if grep -qF "$m" "$CHAT" "$PROMPT" "$MLIST" 2>/dev/null; then
    echo "ОШИБКА: маркер '$m' остался после отката" >&2
    exit 1
  fi
done
echo "мои маркеры 24/25/26: отсутствуют (OK)"

# Маркеры патчей 01-23 должны остаться (проверка по реперным точкам).
grep -qF 'dsh-overrides 11: inline bottom-anchor' "$CHAT" && echo 'Chat.js: маркер 11 на месте'
grep -qF 'dsh-overrides 23: pinned-frame slack goes ABOVE the' "$CHAT" && echo 'Chat.js: маркер 23 на месте'
grep -qF 'dsh-overrides 02' "$PROMPT" || grep -qF 'lastNotification && (_jsx(Box' "$PROMPT" && echo 'PromptInput.js: патч 02 на месте'
grep -qF 'dsh-overrides 20' "$PROMPT" && echo 'PromptInput.js: маркер 20 на месте'
echo "restore complete"
