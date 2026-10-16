#!/usr/bin/env python3
"""vm-analyze.py — вердикты живого WezTerm-стенда dsh (узлы 2-3 TG-DSH-LIVE).

Канонические детекторы saw/anim = trace-metrics.py (тот же код, что в
golden-сьюте v7) — вызывается субпроцессом на артефактах прогона:

  saw       — окно SCROLL_BEGIN..SCROLL_WHEEL_DONE (колесо вниз ×10 у дна):
              trace-metrics --expect clean --forbid-sticky-off. RED = пила
              (flips>0 / sticky_off>0). Живость инъекции доказывается
              ОТДЕЛЬНЫМ окном колеса вверх: sticky там обязан упасть
              (легитимное чтение истории) — если не упал, канал мыши мёртв
              → NO_DATA, не GREEN и не RED. В INLINE канал закрыт by-design
              (mouse tracking = fullscreen-only, Chat.js:910): 0 dsh-кадров
              в окне = пила невозможна, юзер-симптом требует zellij.
  anim      — окно [BOOT_READY+6с..IDLE_WINDOW_END] (за хвостом интро
              LogoV2 ~4.8с): кадры cause='animation' = дыхание при
              animations:false (патч 66) → RED. Inline + 0 кадров при
              живом трейсе = GREEN: полностью статичный idle; пост-таск
              no-op-петля (ANIM-RCA §3) — fullscreen-only (§6), в inline
              её нет — счётчик пост-таск окна фиксирует это явно.
  slash     — слеш-меню рендерит список команд = GREEN.
  tooltip   — текст транскрипта при hover идентичен кадру до hover (слой
              68 в inline не монтируется) = GREEN; расхождение вне зоны
              рамки ввода/статус-бара (последние 6 строк) = RED.
  scrollback— копии рамки ввода ('❯', '╭') в скроллбеке wezterm = E1:
              захват только истории (--start-line -2000), вьюпорт исключён;
              0 копий = GREEN. Стенд без zellij: чисто здесь + мусор у
              юзера = H-A (zellij); мусор здесь = H-B (растр WezTerm).
  mode     — рантайм-доказательство режима прогона (inline/fullscreen) по
              supplemental-рядку статус-бара; scrollback-гейт определён
              ТОЛЬКО для inline (ловушка прогонов #5-6).
  bootflick — кадр-диф 10fps первых 25с видео (jpg): число toggle-событий.
              Юзер-симптом (мигание рамки на старте), вердикт INFO — не гейт.

Выход: verdicts.json + verdicts.txt; exit 0 всегда (гейты читает json).
"""
from __future__ import annotations

import difflib
import glob
import json
import os
import re
import subprocess
import sys

WORK = sys.argv[1] if len(sys.argv) > 1 else "/root/wezterm-live/run-run"
LABEL = os.path.basename(WORK)
BASE = os.path.dirname(WORK)
V: dict[str, object] = {"label": LABEL, "work": WORK}


def rd(p: str) -> str:
    try:
        return open(os.path.join(WORK, p), encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def marks() -> dict[str, str]:
    """marks.txt: 'ISO имя [аргументы]' → имя (без аргументов) → ISO."""
    m: dict[str, str] = {}
    for line in rd("marks.txt").splitlines():
        parts = line.split(" ", 1)
        if len(parts) == 2:
            m.setdefault(parts[1].split(" ")[0], parts[0])
    return m


def tm(t_from: str, t_to: str, extra: list[str], out_name: str) -> tuple[int, str]:
    """trace-metrics прогон окна; вывод → артефакт; return (exit, stdout)."""
    cmd = [
        "python3", os.path.join(BASE, "trace-metrics.py"),
        "--trace", os.path.join(WORK, "geo.jsonl*"),
        "--from", t_from, "--to", t_to,
    ] + extra
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        out = (r.stdout or "") + (r.stderr or "")
        rc = r.returncode
    except (subprocess.SubprocessError, OSError) as e:
        out, rc = f"trace-metrics crash: {e!r}", 2
    try:
        open(os.path.join(WORK, out_name), "w", encoding="utf-8").write(out)
    except OSError:
        pass
    return rc, out


def grab(pattern: str, text: str) -> int | None:
    m = re.search(pattern, text)
    return int(m.group(1)) if m else None


# ------------------------------------------------------------------ saw (67)
def saw() -> None:
    mk = marks()
    t0, t1 = mk.get("SCROLL_BEGIN"), mk.get("SCROLL_WHEEL_DONE")
    if not t0 or not t1:
        V["saw"] = {"verdict": "NO_DATA", "reason": "нет меток SCROLL_BEGIN/WHEEL_DONE"}
        return
    # --metric saw ОБЯЗАТЕЛЕН: без него trace-metrics гоняет все метрики и
    # anim-кадры (живая правда, но ДРУГОЙ гейт) роняют saw-окно в ложный RED
    # (ловушка прогона #5: saw_flips=0/sticky_off=0, а вердикт RED)
    rc, out = tm(t0, t1, ["--metric", "saw", "--expect", "clean",
                          "--forbid-sticky-off",
                          "--detector-name", "saw_gate67"], "trace-saw.txt")
    flips = grab(r"saw_flips=(\d+)", out)
    sticky_off = grab(r"frames_sticky_off=(\d+)", out)
    # живость канала колеса: вверх ОБЯЗАН ломать sticky (окно после WHEEL_DONE)
    up_sticky = None
    if mk.get("SCROLL_END"):
        _, out2 = tm(mk["SCROLL_WHEEL_DONE"], mk["SCROLL_END"],
                     ["--expect", "report", "--detector-name", "wheelup_liveness"],
                     "trace-wheelup.txt")
        up_sticky = grab(r"frames_sticky_off=(\d+)", out2)
    if rc == 1:
        verdict = "RED"
    elif rc == 2:
        verdict = "NO_DATA"
    elif (up_sticky or 0) > 0:
        verdict = "GREEN"
    else:
        verdict = "NO_DATA"  # колесо не доказано живым — GREEN запрещён
    V["saw"] = {
        "window": [t0, t1], "saw_flips": flips, "sticky_off": sticky_off,
        "wheelup_sticky_off": up_sticky, "tm_exit": rc, "verdict": verdict,
    }
    if verdict == "NO_DATA" and (V.get("mode") or {}).get("inferred") == "inline":
        # inline: колесо уходит в СОБСТВЕННЫЙ скроллбек WezTerm — до dsh
        # не доходит вовсе → scrollHeight не меняется → пила на стороне
        # dsh невозможна. Юзер-среда (inline+zellij) пересылает колесо в
        # pane — тот путь вне этого стенда (см. REPORT §H-A).
        V["saw"]["note"] = (
            "inline: канал колеса у WezTerm (mouse tracking = "
            "fullscreen-only, Chat.js:910), dsh-кадров 0 — пила на стороне "
            "dsh невозможна в голом WezTerm; юзер-симптом = zellij-пересылка"
        )


# ------------------------------------------------------------------ anim (66)
def anim() -> None:
    mk = marks()
    t0, t1 = mk.get("BOOT_READY"), mk.get("IDLE_WINDOW_END")
    if not t0 or not t1:
        V["anim"] = {"verdict": "NO_DATA", "reason": "нет меток BOOT_READY/IDLE_WINDOW_END"}
        return
    # RCA-ANIM §7.1: idle-окно от BOOT_READY включает хвост интро LogoV2
    # (~4.8с, settled→null) → anim-кадры интро = ложный RED при живом режиме
    # 'off'. Сдвиг старта за интро (+6с); в окне остаются только мышь-свипы
    # (react-commit) и — если ручка не работает — всегда-живые 60ms-тикеры.
    from datetime import datetime, timedelta
    t_start = (datetime.fromisoformat(t0.replace("Z", "+00:00"))
               + timedelta(seconds=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rc, out = tm(t_start, t1, ["--metric", "anim", "--expect", "clean",
                               "--detector-name", "anim_gate66"], "trace-anim.txt")
    frames = grab(r"frames_in_window=(\d+)", out)
    count = grab(r"animation_frames=(\d+)", out)
    # здоровье трейса: TASK-фаза обязана писать кадры; 0 в idle-окне при
    # живом трейсе = полностью статичный idle, а не мёртвый канал
    try:
        with open(os.path.join(WORK, "geo.jsonl"), encoding="utf-8") as f:
            healthy = sum(1 for _ in f) >= 100
    except OSError:
        healthy = False
    inline = (V.get("mode") or {}).get("inferred") == "inline"
    if frames is None or frames < 10:
        if inline and frames == 0 and healthy:
            # inline: мышь до dsh не доходит (react-commit нет) и пост-таск
            # петля ANIM-RCA §3 НЕ монтируется (supplemental-рядок =
            # fullscreen-only, §6) → 0 репейнтов = сильнейшее доказательство
            # отсутствия мигания: дышать НЕЧЕМУ
            verdict = "GREEN"
            note = ("статичный idle: 0 репейнтов при живом трейсе "
                    f"(TASK-фаза пишет кадры); пост-таск петля — "
                    "fullscreen-only (ANIM-RCA §6)")
        else:
            verdict = "NO_DATA"
            note = None
    elif rc == 0:
        verdict = "GREEN"
        note = None
    elif rc == 1:
        verdict = "RED"
        note = None
    else:
        verdict = "NO_DATA"
        note = None
    v: dict[str, object] = {
        "window": [t_start, t1], "window_from_boot_ready": t0,
        "frames": frames, "animation_frames": count,
        "trace_healthy": healthy, "tm_exit": rc, "verdict": verdict,
    }
    if note:
        v["note"] = note
    # пост-таск окно (TASK_DONE..SCROLL_BEGIN, ноль пользовательского
    # ввода): fullscreen-петля ~70ms-каденции (ANIM-RCA §3) vs inline-тишина
    # — счётчик фиксирует экспериментальное подтверждение §6
    if mk.get("TASK_DONE") and mk.get("SCROLL_BEGIN"):
        _, pt = tm(mk["TASK_DONE"], mk["SCROLL_BEGIN"],
                   ["--expect", "report", "--detector-name", "posttask_loop"],
                   "trace-posttask.txt")
        v["posttask_frames"] = grab(r"frames_in_window=(\d+)", pt)
    V["anim"] = v


# ------------------------------------------------------------------ slash
def slash() -> None:
    # структурный чек (прогоны #5-6): меню рендерит шапку «commands · N
    # items», строки «│ ❯ new …»/«│   <cmd> <desc>» и скролл-маркер «↓N».
    # Слово-греп («settings»/«theme»/...) был ложным RED двух прогонов:
    # первая страница списка — new/clear/compact/resume/rename, искомых
    # слов там НЕТ; меню при этом живое (61 команда).
    def menu_stats(text: str) -> tuple[bool, int, bool, int]:
        lines = text.splitlines()
        hdr = any(("commands" in l and "items" in l) for l in lines)
        rows = sum(1 for l in lines if l.lstrip().startswith("│"))
        scroll = any(re.search(r"↓\d+", l) for l in lines)
        return hdr, rows, scroll, len(lines)

    hdr, rows, scroll, n = menu_stats(rd("slash.txt"))
    V["slash"] = {
        "menu_header": hdr, "menu_rows": rows, "scroll_marker": scroll,
        "lines": n,
        "verdict": "GREEN" if (hdr and rows >= 3) else "RED",
    }
    # продукт-наблюдение E2 (не гейт): слеш при прокрученном от дна
    # транскрипте — меню якорится у ввода и НЕ зависит от скролла
    # (подтверждено прогонами #5/#6: рендерится в обоих состояниях).
    sc = rd("slash-scrolled.txt")
    if sc:
        sc_hdr, sc_rows, _, sc_n = menu_stats(sc)
        V["slash_scrolled"] = {
            "menu_header": sc_hdr, "menu_rows": sc_rows, "lines": sc_n,
            "verdict": "INFO",
            "note": "меню в прокрученном состоянии: живое = якорь у ввода "
                    "не зависит от скролла (E2 H-A)",
        }


# ------------------------------------------------------------------ tooltip (68)
def tooltip() -> None:
    base = rd("scroll-up.txt").splitlines()
    if not base:
        V["tooltip"] = {"verdict": "NO_DATA", "reason": "нет scroll-up.txt"}
        return
    # зона транскрипта: без рамки ввода и статус-бара (низ кадра)
    base_zone = [l for l in base[:-6]]
    res = []
    for k in (2, 3, 4, 5):
        cur = rd(f"hover-{k}.txt").splitlines()
        if not cur:
            continue
        sm = difflib.SequenceMatcher(a=base_zone, b=[l for l in cur[:-6]])
        sim = sm.ratio()
        blocks = sum(1 for op in sm.get_opcodes() if op[0] != "equal")
        res.append({"k": k, "sim": round(sim, 4), "diff_blocks": blocks})
    if not res:
        V["tooltip"] = {"verdict": "NO_DATA", "reason": "нет hover-кадров"}
        return
    bad = [r for r in res if r["sim"] < 0.998]
    V["tooltip"] = {
        "per_point": res,
        "verdict": "RED" if bad else "GREEN",
    }


# ------------------------------------------------------------------ scrollback (E1)
def scrollback() -> None:
    sb = rd("scrollback.txt").splitlines()
    prompt_rows = sum(1 for l in sb if "❯" in l)
    frame_corners = sum(1 for l in sb if "╭" in l)
    # E1-сигнатура: (a) соседние одинаковые непустые строки; (b) непустые
    # строки ≥8 симв., встречающиеся 3+ раз (копии рамки/статус-рядов).
    # Нормализация пробелов; порог калиброван на контроле (0/0).
    import re as _re
    norm = [_re.sub(r"\s+", " ", l).strip() for l in sb]
    meat = [l for l in norm if l and len(l) >= 8]
    dup_adjacent = sum(1 for a, b in zip(meat, meat[1:]) if a == b)
    from collections import Counter as _Counter
    cnt = _Counter(meat)
    dup_repeated = sum(c for c in cnt.values() if c >= 3)
    inferred = (V.get("mode") or {}).get("inferred")
    v: dict[str, object] = {
        "lines_captured": len(sb),
        "prompt_rows": prompt_rows,
        "frame_corner_rows": frame_corners,
        "dup_adjacent": dup_adjacent,
        "dup_repeated": dup_repeated,
        "mode": inferred,
    }
    if inferred != "inline":
        # fullscreen (alt-screen) не пишет primary-историю юзера — GREEN там
        # ничего не сертифицирует про inline-E1 (ловушка прогонов #5-6)
        v["verdict"] = "NO_DATA"
        v["note"] = "не-inline прогон: гейт E1 вакуумен (см. mode)"
    else:
        # inline: scrollback = ТОЛЬКО история (живой кадр исключён клей-скриптом
        # — паритет с контролем wt get-text --end-line -1). Симптом E1 юзера —
        # ЭКРАН копий (десятки рядов); контроль калибровки: 0 дублей.
        v["verdict"] = ("GREEN" if prompt_rows <= 1 and frame_corners <= 1
                        and dup_adjacent < 3 and dup_repeated < 6
                        else "RED")
    V["scrollback"] = v


# ------------------------------------------------------------------ boot flicker
def bootflick() -> None:
    vids = sorted(glob.glob(os.path.join(WORK, "video-*.mp4")))
    video = vids[0] if vids else ""
    if not video or not os.path.exists(video):
        V["bootflick"] = {"verdict": "NO_DATA", "reason": "нет видео"}
        return
    outdir = os.path.join(WORK, "bootfps")
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", video, "-t", "25", "-vf", "fps=10", "-q:v", "5",
         os.path.join(outdir, "%04d.jpg")],
        check=False,
    )
    try:
        from PIL import Image
    except ImportError:
        V["bootflick"] = {"verdict": "NO_DATA", "reason": "no PIL"}
        return
    frames = sorted(glob.glob(os.path.join(outdir, "*.jpg")))
    if len(frames) < 5:
        V["bootflick"] = {"verdict": "NO_DATA", "reason": f"кадров {len(frames)}"}
        return
    sigs = [list(Image.open(p).convert("L").resize((160, 100)).getdata()) for p in frames]
    diffs = []
    for i in range(1, len(sigs)):
        diffs.append(sum(1 for a, b in zip(sigs[i - 1], sigs[i]) if abs(a - b) > 24))
    toggles = 0
    prev = None
    for d in diffs:
        sig = d > 500
        if prev is not None and sig != prev and sig:
            toggles += 1
        prev = sig
    V["bootflick"] = {
        "frames": len(frames), "toggle_events": toggles,
        "max_frame_diff_px": max(diffs) if diffs else 0,
        "verdict": "INFO",
    }


def taskinfo() -> None:
    for line in rd("marks.txt").splitlines():
        if " TASK_DONE" in line or " TASK_TIMEOUT" in line:
            V["task"] = line.split(" ", 1)[1]
            return
    V["task"] = "нет метки задачи"


# ------------------------------------------------------------------ mode (инвариант прогона)
def mode() -> None:
    # Ловушка прогонов #5-6 (2026-09-26): деплойный settings.yaml не имел
    # ключа fullscreen → побеждал cordis.patch.yml fullscreen:true → dsh
    # стартовал в FULLSCREEN (alt-screen; Chat.js:910: «fullscreen
    # (<AlternateScreen> supplies mouse tracking)»), а стенд верил режиму
    # из промпта. Рантайм-доказательство режима в каждом прогоне:
    # supplemental-рядок статус-бара монтируется ТОЛЬКО в fullscreen
    # (StatusLine.js:952 `fullscreen && …`); в inline его нет вовсе.
    # Маркер рядка — трейлер «? for (shortcuts)»: в wide текст рядка
    # «Sorted · 0 tools …», в user «Task: destroyed …» — содержимое
    # ActivityLine НЕ стабильно, трейлер стабилен. Ищем ТОЛЬКО ниже
    # рамки ввода (последний «╰»), чтобы не поймать «? for» в транскрипте.
    tail = [l for l in rd("task-final.txt").splitlines()[-10:]]
    if not any(l.strip() for l in tail):
        V["mode"] = {"supplemental_row": None, "inferred": "unknown",
                     "reason": "task-final.txt пуст/отсутствует"}
        return
    bottom = max((i for i, l in enumerate(tail) if "╰" in l), default=-1)
    zone = tail[bottom + 1:]
    supp = any("? for" in l for l in zone)
    V["mode"] = {"supplemental_row": supp,
                 "inferred": "fullscreen" if supp else "inline"}


for fn in (taskinfo, mode, saw, anim, slash, tooltip, scrollback, bootflick):
    try:
        fn()
    except Exception as e:  # noqa: BLE001 — агрегатор не падает на одном вердикте
        V[fn.__name__] = {"verdict": "ERROR", "error": repr(e)}

with open(os.path.join(WORK, "verdicts.json"), "w", encoding="utf-8") as f:
    json.dump(V, f, ensure_ascii=False, indent=1)

lines = [f"# verdicts {LABEL}", json.dumps(V.get("task"), ensure_ascii=False)]
for k in ("mode", "saw", "anim", "slash", "tooltip", "scrollback", "bootflick"):
    lines.append(f"{k}: {json.dumps(V.get(k), ensure_ascii=False)}")
open(os.path.join(WORK, "verdicts.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines))
