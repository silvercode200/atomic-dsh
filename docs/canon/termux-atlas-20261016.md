# Termux Atlas — Terminal Capabilities for Mobile-Parity

**Source**: Primary research from Termux source code (termux/termux-app v0.118.x, GitHub master).
**Date**: 2026-10-16
**Purpose**: VISUAL-CANON.md mobile-parity reference for dsh TUI.

---

## 1. $TERM Value

- **`TERM=xterm-256color`** — set in `AndroidShellEnvironment.java` (line 41)
- **`COLORTERM=truecolor`** — set in `AndroidShellEnvironment.java` (line 40)
- **`LANG=en_US.UTF-8`** — set in `AndroidShellEnvironment.java` (line 35)

Termux does NOT use a custom terminfo entry like `termux` or `termux-256color`. It claims to be `xterm-256color` and relies on the standard xterm terminfo from ncurses.

**Source**: https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/shell/command/environment/AndroidShellEnvironment.java

---

## 2. Terminfo & Escape Sequence Support

### No custom `termux` terminfo entry
Termux reports itself as `xterm` in XTGETTCAP responses (`TerminalEmulator.java`, line 1242: `responseValue = "xterm"`). There is no separate `termux` terminfo shipped by the app.

### Device Attribute Responses
- **DA1 (Primary)**: `ESC[?64;1;2;4;6;9;15;18;21;22c` — claims VT420 capabilities
- **DA2 (Secondary)**: `ESC[>41;320;0c` — VT420 variant 41, firmware version 320

### DEC Modes (DECSET/DECRST) — Supported
| Mode | Name | Status |
|------|------|--------|
| 1 | Application Cursor Keys | YES |
| 5 | Reverse Video | YES |
| 6 | Origin Mode (DECOM) | YES |
| 7 | Auto-Wrap (DECAWM) | YES |
| 25 | Cursor Enabled | YES |
| 47 | Alternate Screen (legacy) | YES |
| 66 | Application Keypad | YES |
| 69 | Left/Right Margin (DECLRMM) | YES |
| 1000 | Mouse Press/Release | YES |
| 1001 | Highlight Mouse | YES (parsed) |
| 1002 | Mouse Button Event | YES |
| 1003 | Any Event Mouse | YES (parsed) |
| 1004 | Send Focus Events | **NO** (bit defined, case listed, but NOT implemented — no events sent) |
| 1005 | UTF-8 Mouse | Ignored |
| 1006 | SGR Mouse Protocol | YES |
| 1015 | URXVT Mouse | YES (parsed) |
| 1034 | Meta Key (8th bit) | YES (parsed) |
| 1047 | Alternate Screen | YES |
| 1048 | Save/Restore Cursor | YES |
| 1049 | Alternate Screen + Save/Restore | YES |
| 2004 | Bracketed Paste | YES |

### Other Escape Sequences Supported
- **CSI** (Control Sequence Introducer): full parser
- **OSC** (Operating System Command): full parser (title, colors, clipboard OSC 52)
- **DCS** (Device Control String): Sixel graphics support
- **APC** (Application Program Command): parsed but ignored
- **Scroll regions**: top/bottom margins (DECSTBM) + left/right margins (DECLRMM)
- **Line drawing** (DEC Special Graphics): via G0/G1 character set designation
- **Cursor styles**: Block (default), Underline, Bar — with blink
- **Cursor position reporting**: CSI 6 (report position), CSI 18 (report text area size), CSI 14 (report pixel size)
- **XTGETTCAP**: responds with `xterm` name, `256` colors, and termcap key codes
- **Kitty underline sub-parameters**: parsed (line 2489 reference to kitty underline protocol)

### Not Supported
- **DEC 2026 (Sync Output / BSU+ESU)**: NOT found anywhere in source code (confirmed: zero matches for "2026" in 3569-line TerminalEmulator.java)
- **Focus events (1004)**: bit defined but no event emission

**Source**: https://github.com/termux/termux-app/blob/master/terminal-emulator/src/main/java/com/termux/terminal/TerminalEmulator.java

---

## 3. Keyboard Protocol

### kitty CSI-u: NOT SUPPORTED
Termux does NOT implement the kitty keyboard protocol (CSI u encoding). There is no code for `CSI <codepoint>u` key encoding.

### modifyOtherKeys: PARSED but IGNORED
The `CSI > Ps ; Ps m` sequence (modifyKeyboard/modifyCursorKeys/modifyFunctionKeys/modifyOtherKeys) is received and parsed, but then logged as `"(ignored) CSI > MODIFY RESOURCE"` (line 1967). No actual modification of key encoding behavior occurs.

### Key Encoding — Traditional xterm
Termux uses the classic xterm escape sequence encoding via `KeyHandler.java`:

| Key | Normal Mode | Application Mode | With Modifiers |
|-----|-------------|------------------|-----------------|
| Up | `ESC[A` | `ESC OA` | `ESC[1;<mod>A` |
| Down | `ESC[B` | `ESC OB` | `ESC[1;<mod>B` |
| Right | `ESC[C` | `ESC OC` | `ESC[1;<mod>C` |
| Left | `ESC[D` | `ESC OD` | `ESC[1;<mod>D` |
| Home | `ESC[H` | `ESC OH` | `ESC[1;<mod>H` |
| End | `ESC[F` | `ESC OF` | `ESC[1;<mod>F` |
| F1-F4 | `ESC OP/Q/R/S` | — | `ESC[1;<mod>P/Q/R/S` |
| F5-F12 | `ESC[15~` etc | — | `ESC[15;<mod>~` etc |
| Insert | `ESC[2~` | — | `ESC[2;<mod>~` |
| Delete | `ESC[3~` | — | `ESC[3;<mod>~` |
| PageUp | `ESC[5~` | — | `ESC[5;<mod>~` |
| PageDn | `ESC[6~` | — | `ESC[6;<mod>~` |
| Tab | `\t` | — | — |
| Enter | `\r` | — | — |
| Backspace | `KEYCODE_DEL` → `\x7f` (DEL, not BS) | — | — |
| Escape | `\x1b` | — | — |

### Modifier Encoding (transformForModifiers)
| Modifier Combo | Code |
|----------------|------|
| Shift | 2 |
| Alt | 3 |
| Shift+Alt | 4 |
| Ctrl | 5 |
| Shift+Ctrl | 6 |
| Alt+Ctrl | 7 |
| Shift+Alt+Ctrl | 8 |

### Ctrl + Letter
Ctrl+A → `\x01`, Ctrl+B → `\x02`, ... Ctrl+Z → `\x1a` (standard control character mapping). Also:
- Ctrl+Space / Ctrl+2 → `\x00` (NUL)
- Ctrl+[ / Ctrl+3 → `\x1b` (ESC)
- Ctrl+\\ / Ctrl+4 → `\x1c`
- Ctrl+] / Ctrl+5 → `\x1d`
- Ctrl+^ / Ctrl+6 → `\x1e`
- Ctrl+_ / Ctrl+7 / Ctrl+/ → `\x1f`
- Ctrl+8 → `\x7f` (DEL)

### Alt Key
Left Alt sends `ESC` prefix before the code point (e.g., Alt+B → `ESC b`), enabling readline shortcuts like Alt+B (back-word), Alt+F (forward-word).

### Soft Keyboard (IME)
- Enter key from Android soft keyboard sends `\n`, which Termux converts to `\r`
- Ctrl from soft keyboard detected via control character range (codes 1-31)
- Backspace via `KEYCODE_DEL`
- Extra keys panel (TermuxExtraKeysView) provides Ctrl, Alt, Shift, Fn, arrows, ESC, TAB, etc. as on-screen buttons

### Shift+Enter
No special encoding — Shift+Enter from soft keyboard sends `\r` (same as Enter). Android IME does not distinguish Shift+Enter from Enter in text input mode. For hardware keyboards, Shift+Enter would go through `handleKeyCode` but Enter maps to `\r` regardless of Shift.

**Sources**:
- https://github.com/termux/termux-app/blob/master/terminal-emulator/src/main/java/com/termux/terminal/KeyHandler.java
- https://github.com/termux/termux-app/blob/master/terminal-view/src/main/java/com/termux/view/TerminalView.java

---

## 4. Glyph / Font Fallback

### Default Font
- **Typeface.MONOSPACE** — Android system monospace font (typically Roboto Mono on modern Android)
- Font set via `TerminalRenderer.java`: `mTypeface = Typeface.MONOSPACE` (default)
- User can override via **Termux:Styling** add-on: long-press → More → Style → CHOOSE FONT

### Rendering
- Uses Android `Canvas.drawTextRun()` (API 23+) or `canvas.drawText()` (older)
- `Paint.measureText("X")` determines cell width — true monospace measurement
- **Font width mismatch detection**: if a glyph's measured width differs from expected `wcwidth()` by >1%, the renderer scales the glyph to match expected width. This handles non-monospace fonts or wide emoji.
- Combining characters: eaten as part of the preceding code point run
- Surrogate pairs: handled (Character.toCodePoint)

### Box-Drawing Characters (│─┌┐└┘├┤┬┴┼)
- Rendered via the font's glyph coverage — Android system fonts (Roboto Mono / Noto Mono) include full box-drawing block (U+2500–U+257F)
- No native/custom box-drawing renderer — purely font-dependent
- If a custom font lacks box-drawing glyphs, they will show as tofu/replacement character

### Braille Patterns (⠁⠉ etc., U+2800–U+28FF)
- Rendered via font glyph coverage — Noto fonts on Android include braille patterns
- Width: treated as wcwidth=1 by default (may be rendered wider by some fonts)

### Powerline Symbols (U+E0A0–U+E0D4, Private Use Area)
- NOT included in default Android system fonts
- Require a Powerline-patched font installed via Termux:Styling
- Without custom font: will render as tofu (□) or replacement character

### Line Drawing Mode (DEC Special Graphics)
- Supported via G0/G1 character set switching (`ESC ( 0` / `ESC ) 0`)
- Maps ASCII letters to box-drawing characters (e.g., `j` → ┘, `k` → ┐, `l` → ┌, etc.)
- This is the VT100 line drawing mode, distinct from Unicode box-drawing

**Sources**:
- https://github.com/termux/termux-app/blob/master/terminal-view/src/main/java/com/termux/view/TerminalRenderer.java
- https://github.com/termux/termux-styling/blob/master/README.md

---

## 5. Terminal Size (Columns/Rows)

### Size Calculation
```java
int newColumns = Math.max(4, (int) (viewWidth / mRenderer.mFontWidth));
int newRows = Math.max(4, (viewHeight - mRenderer.mFontLineSpacingAndAscent) / mRenderer.mFontLineSpacing);
```
- Columns = pixel width / font cell width, minimum **4**
- Rows = (pixel height - top inset) / font line height, minimum **4**
- Size changes dynamically with font size and screen orientation

### Typical Phone Dimensions

**Portrait** (typical 6.1" phone, 1080×2400px, 420dpi, default font ~12dp):
- ~1080px / ~28px per cell ≈ **38-42 columns**
- ~(2400-status_bar) / ~52px per line ≈ **40-44 rows**

**Landscape** (same phone rotated):
- ~2400px / ~28px ≈ **80-85 columns**
- ~1080px / ~52px ≈ **18-20 rows**

**Tablet** (10", 1280×800 or higher):
- Portrait: ~60-70 columns × 30-40 rows
- Landscape: ~90-110 columns × 40-50 rows

**Very small phones** (older 4.5-5" devices, 720×1280):
- Portrait: ~25-30 columns × 25-30 rows
- Landscape: ~50-60 columns × 12-15 rows

**Minimum**: 4 columns × 4 rows (hardcoded floor)

### Font Size Adjustment
- User can change font size via pinch-to-zoom or Termux settings (`termux.properties`)
- Smaller font = more columns/rows, harder to read
- Default: system-determined based on screen density

**Source**: https://github.com/termux/termux-app/blob/master/terminal-view/src/main/java/com/termux/view/TerminalView.java (updateSize method)

---

## 6. Color Support

### Truecolor (24-bit): YES
- `COLORTERM=truecolor` environment variable set
- Internal color storage: `mForeColor, mBackColor` can be "a color index in [0,259] or a truecolor (24-bit) value. For a 24-bit value the top byte (0xff000000) is set." (TerminalEmulator.java)
- Truecolor parsed from `CSI 38;2;r;g;bm` (foreground) and `CSI 48;2;r;g;bm` (background)
- Underline color also parsed (but not yet used in rendering, per comment)

### 256 Colors: YES
- XTGETTCAP responds with `256` for the `Co`/`colors` query
- Standard 16-color palette + 216 color cube + 24 grayscale
- Bold text uses bright colors (foreColor 0-7 → 8-15 when bold)
- Default palette configurable via Termux:Styling color themes

### Color Rendering
- Colors stored as `int` array palette (`mColors.mCurrentColors`)
- `TerminalRenderer.drawTexTRun()` looks up palette for indexed colors
- Truecolor values (with 0xff000000 bit) passed directly as ARGB int
- Dim effect: RGB * 2/3 (from xterm/libvte)

**Sources**:
- https://github.com/termux/termux-app/blob/master/terminal-emulator/src/main/java/com/termux/terminal/TerminalEmulator.java (color handling)
- https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/shell/command/environment/AndroidShellEnvironment.java

---

## 7. Sync Output (DEC 2026 / BSU+ESU)

### NOT SUPPORTED

There is **zero** support for synchronized output in Termux. A comprehensive search of the 3569-line `TerminalEmulator.java` found:
- Zero matches for "2026"
- Zero matches for "BSU" or "ESU"
- Zero matches for "sync" (in the context of output synchronization)
- Zero matches for "BEGIN_SYNC" or "END_SYNC"

The `case 2026` is not present in the DECSET/DECRST handler (`doCsiQuestionMark`).

**Implication**: TUI applications cannot use `ESC[?2026h` (Begin Synchronized Update) and `ESC[?2026l` (End Synchronized Update) to reduce flickering in Termux. Frame-level synchronization must rely on other techniques (alt-screen, double-buffering in the app, or reducing redraw frequency).

**Source**: https://github.com/termux/termux-app/blob/master/terminal-emulator/src/main/java/com/termux/terminal/TerminalEmulator.java (confirmed: 0 matches for "2026")

---

## 8. Alt-Screen (ESC[?1049h)

### FULLY SUPPORTED

Three alt-screen modes are implemented:
- **Mode 47** (legacy): switch to alt buffer (no cursor save/restore beyond what mode handles)
- **Mode 1047**: switch to alt buffer
- **Mode 1049**: switch to alt buffer + save cursor (DECSC) on entry, restore cursor (DECRC) on exit

Implementation details (`TerminalEmulator.java`, line 1853):
- `mMainBuffer`: normal screen with scrollback transcript (default 2000 rows)
- `mAltBuffer`: alternate screen, exactly as large as display, **no saved lines** (no scrollback)
- On entering alt-screen: cursor saved, screen switched
- On leaving: cursor restored, screen switched back
- Handles resized alt buffer: cursor position preserved across resize

**Source**: https://github.com/termux/termux-app/blob/master/terminal-emulator/src/main/java/com/termux/terminal/TerminalEmulator.java (doCsiQuestionMark, case 1049)

---

## 9. Termux-Specific Limitations vs Desktop Terminals

### Mouse Support
- **Touch input**: translated to mouse events when mouse tracking is active (modes 1000/1002/1003)
  - Single tap: left button press+release
  - Drag: left button moved (only for SOURCE_MOUSE, not touch)
  - Scroll: touch drag and fling translated to scroll wheel events
- **Hardware mouse**: supported via SOURCE_MOUSE (Bluetooth/USB mouse)
- **SGR Mouse (1006)**: supported — `ESC[<button;col;rowM` (press) / `m` (release)
- **Touch scrolling**: when mouse tracking is OFF, touch drag scrolls scrollback; when ON, sends mouse events

### Scrollback
- Default: **2000 rows** (configurable: 100–50000)
- Scrollback only on main buffer, NOT on alt buffer
- No reflow on resize — scrollback lines retain their original column layout
- Scrolling via touch drag (gesture), Shift+PageUp/PageDn, or hardware scroll wheel

### Reflow on Resize: NO
Termux does **not** reflow text when the terminal is resized. The `resizeScreen()` method preserves existing content but does not rewrap lines to the new column width. This means:
- Narrowing the terminal may truncate visible content
- Widening the terminal does not rejoin previously-wrapped lines
- This matches traditional xterm behavior (pre-reflow era)

### Focus Events (1004): NO
DECSET 1004 is parsed (the bit is defined and the case exists in the switch), but no focus/blur events (`ESC[I` / `ESC[O`) are ever emitted. Applications relying on focus detection will not work.

### Sync Output (2026): NO
As documented in point 7 above — no synchronized output support.

### Sixel Graphics: YES
Termux supports Sixel graphics (DCS q commands) — a rarity among mobile terminal emulators. Images can be displayed inline via sixel sequences.

### Process Killing (Android 12+)
Android OS kills phantom processes (>32 combined limit) and excessive CPU users. Termux sessions may be killed with `[Process completed (signal 9) - press Enter]` without user action. This is an OS-level limitation, not a terminal capability issue.

### No Bracketed Paste on Soft Keyboard
While bracketed paste mode (2004) is supported at the protocol level, Android soft keyboards don't have a clipboard paste mechanism that triggers bracketed paste naturally. Long-press → Paste goes through IME text input, which does send the paste bracket sequence if enabled.

### Keyboard Limitations
- No kitty keyboard protocol (CSI u)
- No modifyOtherKeys (parsed but ignored)
- Shift+Enter indistinguishable from Enter on soft keyboard
- Many special keys (Home, End, Page Up/Down, F-keys) only accessible via the Extra Keys panel or hardware keyboard
- Android Back button can be mapped to Escape (configurable)

### IME Quirks
- AOSP keyboard sends `\n` for Enter (converted to `\r`)
- Samsung keyboard with Auto Check Spelling sends `deleteSurroundingText` with leftLength > 1
- Bluetooth keyboards send Unicode variants of `~`, `` ` ``, `^` — Termux normalizes these to ASCII
- Penti keyboard sends control characters for Ctrl input

**Sources**:
- https://github.com/termux/termux-app/blob/master/terminal-view/src/main/java/com/termux/view/TerminalView.java
- https://github.com/termux/termux-app/blob/master/terminal-emulator/src/main/java/com/termux/terminal/TerminalEmulator.java
- https://github.com/termux/termux-app/blob/master/README.md (Android 12+ process killing)

---

## Summary for dsh Mobile-Parity

| Feature | Termux | Impact on dsh TUI |
|---------|--------|-------------------|
| $TERM | xterm-256color | Standard terminfo works |
| Truecolor | YES (COLORTERM=truecolor) | Full color themes OK |
| Alt-screen | YES (1049) | Full-screen TUI mode works |
| Sync output | **NO** | Flicker reduction must use other means |
| kitty CSI-u | **NO** | Must use traditional key encoding |
| modifyOtherKeys | **NO** (ignored) | Ctrl+Shift+key may not disambiguate |
| Focus events | **NO** | App cannot detect foreground/background |
| Box-drawing | Font-dependent | Default Android font OK; custom fonts need checking |
| Powerline | **Needs custom font** | Default font lacks PUA glyphs |
| Min columns | 4 (practical: ~30-40 portrait) | UI must handle narrow widths |
| Reflow on resize | **NO** | Content may truncate on rotation |
| Sixel | YES | Inline graphics possible |
| Mouse | YES (SGR + touch) | Touch as mouse works |
| Bracketed paste | YES | Paste detection works |
| Scrollback | 2000 (configurable) | Sufficient for most use cases |

### Key Risks for dsh on Termux
1. **No sync output** → dsh must minimize flicker through inline-render optimization (already addressed via patch stack SUBSYS.FF.B)
2. **Narrow widths** (30-40 cols portrait) → layout must gracefully degrade; status-bar may overflow
3. **No kitty CSI-u** → Shift+Enter and other special key combos may not reach dsh correctly
4. **No reflow** → rotation may cause content loss
5. **No focus events** → dsh cannot pause rendering when backgrounded
6. **Powerline glyphs** → require Termux:Styling custom font; fallback to ASCII separators needed
