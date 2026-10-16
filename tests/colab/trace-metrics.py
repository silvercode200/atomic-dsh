#!/usr/bin/env python3
"""trace-metrics — детекторы golden-сьюта dsh по geometry-трейсу (патч 61).

  saw  — пила scrollHeight при sticky=false (репорт 2026-09-25: при скролле
         от дна экран «мигает и дёргается», высота осциллирует 39↔42;
         B1/B2-семья в ветке ручного скролла — патч 54 закрыл стриминг).
         Флип пилы = смена scrollHeight у кадра sticky=false, НЕ являющаяся
         монотонным ростом: рост = виртуализация замеряет скрытые ряды
         (легитимно), пила = спады и возвраты вниз.
  anim — кадры cause='animation' (ClockContext.tick): в IDLE-окне при
         animations:'off' их быть не должно — все idle-потребители часов
         гейтятся effectEnabled → mode 'off'. До патча 66 boolean false в
         settings.yaml → undefined → 'full' → дыхание рамки ~16 fps
         (memory dsh-animations-boolean-ignored). Окно обязано быть idle:
         таймер хода/спиннер легитимно тикают во время работы.

Этот же код встроен в tests/colab/dsh-tui-inline.yaml (setup-шаг
trace_metrics_lib, suite_version 9) и на VM живёт как
/root/dsh-inline/trace-metrics.py — держать синхронно байт-в-байт
(скрипт не содержит переменных программы сьюта: executor раскрывает
их в тексте шага ДО отправки на VM — синхронность сломается).

Формат строки: {"t": ISO|epoch, "pid": int, "frame": int, "cause": str,
"scroll": [{"sticky": bool, "scrollHeight": n, "prevScrollHeight": n}]}.
Ротация 8МБ → <file>.1 — поэтому --trace принимает glob ('geo.jsonl*').

Локальная валидация (юзер-трейс 24.09, memory dsh-scroll-height-saw-jitter):
  trace-metrics.py --trace ~/.dsh-tui/trace/geometry-2026-09-24.jsonl* \
    --from 2026-09-24T20:56:00Z --to 2026-09-24T20:57:00Z   # SAW: flips>0
  trace-metrics.py --trace ~/.dsh-tui/trace/geometry-2026-09-24.jsonl* \
    --from 2026-09-24T21:15:00Z --to 2026-09-24T21:16:00Z   # CLEAN: 0

Инфра-гейты (ложный «0» ≠ продукт-GREEN): --require-frames N — кадров в
окне < N = рендер/трейс мёртв (exit 2, clean и report); --require-sticky-off
— нет кадров sticky=false = скролл не сработал (exit 2). INLINE-семантика
suite v9 (патч 73, fixed terminalRows-кадр): maxScroll>0 → скролл чтения
истории — ФИЧЕЙ (гейт 67) → sticky_off>0 обязателен, ноль = скролл не
сработал (exit 2, НЕ продукт-GREEN); продукт-гейт = saw_flips (пила
scrollHeight): saw_flips>0 = продукт-RED exit 1.
--forbid-sticky-off — [v7-ЛЕГАСИ, до патча 73] sticky_off>0 = RED: v7 исходил
из «inline вьюпорт = контенту, maxScroll=0, колесо = visual no-op»; патч 73
сломал предпосылку намеренно (кадр фиксирован terminalRows, контент утекает
в скроллбек — чтение истории и есть фича).
Сьют различает их по exit code (0/1/2 = PASS/RED/инфра).
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Optional


def parse_t(value: Any) -> Optional[datetime]:
    """Поле 't' кадра (ISO / epoch-s / epoch-ms) → datetime UTC или None."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = float(value)
        if seconds > 1e12:  # epoch-миллисекунды
            seconds /= 1000.0
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:  # наивная строка = UTC
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def read_frames(pattern: str, t_from: datetime, t_to: datetime,
                pid: Optional[int]) -> tuple:
    """Кадры окна [t_from..t_to] из всех файлов glob-паттерна.

    Returns: (files, frames, stats) — файлы; кадры {t,pid,cause,sticky,sh,psh};
    счётчики lines/bad_lines/read_errors.
    """
    files = sorted(glob.glob(pattern))
    frames, stats = [], Counter()
    for path in files:
        try:
            with open(path, encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        stats['bad_lines'] += 1
                        continue
                    stats['lines'] += 1
                    dt = parse_t(rec.get('t'))
                    if dt is None or dt < t_from or dt > t_to:
                        continue
                    if pid is not None and rec.get('pid') != pid:
                        continue
                    scroll = rec.get('scroll') or []
                    entry = scroll[0] if isinstance(scroll, list) and scroll else {}
                    if not isinstance(entry, dict):
                        entry = {}
                    frames.append({'t': dt, 'pid': rec.get('pid'),
                                   'cause': rec.get('cause'),
                                   'sticky': entry.get('sticky'),
                                   'sh': entry.get('scrollHeight'),
                                   'psh': entry.get('prevScrollHeight')})
        except OSError as exc:
            stats['read_errors'] += 1
            print('trace-metrics: WARN cannot read {}: {}'.format(path, exc),
                  file=sys.stderr)
    return files, frames, stats


def saw_metrics(frames: list) -> tuple:
    """Пила scrollHeight при sticky=false по цепочке кадров каждого pid.

    Цепочка = кадры одного pid в окне, отсортированные по t (ротация
    раскладывает хронологию по двум файлам — сортировка восстанавливает).
    Флип = scrollHeight кадра != предыдущему в цепочке, кадр sticky=false:
      dec         — высота уменьшилась: видимый джиттер вниз = пила;
      inc_rebound — рост, ниже которого высота позже в окне ВОЗВРАЩАЕТСЯ
                    (откат = осцилляция); монотонный рост без возврата —
                    легитимный замер виртуализации, исключён.

    Returns: (metrics dict, Counter пар (psh->sh)).
    """
    per_pid = {}
    for fr in frames:
        per_pid.setdefault(fr['pid'], []).append(fr)
    m = {'frames': len(frames), 'sticky_off': 0,
         'record_flips': 0, 'record_dec': 0, 'record_inc': 0,
         'chain_flips': 0, 'saw_dec': 0, 'saw_inc_rebound': 0}
    pairs = Counter()
    for p in sorted(per_pid, key=str):
        seq = sorted(per_pid[p], key=lambda f: f['t'])
        for fr in seq:
            if fr['sticky'] is False:
                m['sticky_off'] += 1
                sh, psh = fr['sh'], fr['psh']
                if sh is not None and psh is not None and sh != psh:
                    m['record_flips'] += 1
                    m['record_dec' if sh < psh else 'record_inc'] += 1
                    pairs[(psh, sh)] += 1
        values = [(fr['sh'], fr['sticky']) for fr in seq if fr['sh'] is not None]
        n = len(values)
        suffix_min = [None] * n  # suffix_min[i] = минимум значений ПОСЛЕ i
        running = None
        for i in range(n - 1, -1, -1):
            suffix_min[i] = running
            running = values[i][0] if running is None else min(running, values[i][0])
        for i in range(1, n):
            sh, sticky = values[i]
            prev = values[i - 1][0]
            if sticky is not False or sh == prev:
                continue
            m['chain_flips'] += 1
            if sh < prev:
                m['saw_dec'] += 1
            else:
                later_min = suffix_min[i]
                if later_min is not None and later_min < sh:
                    m['saw_inc_rebound'] += 1
    m['saw_flips'] = m['saw_dec'] + m['saw_inc_rebound']
    return m, pairs


def anim_metrics(frames: list) -> dict:
    """Кадры cause='animation' в окне (+ топ-причины для диагностики)."""
    causes = Counter(str(fr['cause']) for fr in frames)
    return {'frames': len(frames),
            'animation_frames': causes.get('animation', 0),
            'top_causes': causes.most_common(5)}


def main() -> int:
    """CLI: метрики окна → stdout-маркеры; exit 0/1/2 = PASS/FAIL/инфра."""
    ap = argparse.ArgumentParser(
        description='Метрики пилы scrollHeight и гейта анимаций по '
                    'geometry-трейсу dsh (патч 61).')
    ap.add_argument('--trace', required=True,
                    help="glob файлов трейса ('geo.jsonl*' ловит ротацию .1)")
    ap.add_argument('--from', dest='t_from', required=True,
                    help='начало UTC-окна, ISO')
    ap.add_argument('--to', dest='t_to', required=True, help='конец UTC-окна, ISO')
    ap.add_argument('--pid', type=int, default=None, help='фильтр по pid')
    ap.add_argument('--metric', choices=['saw', 'anim', 'all'], default='all')
    ap.add_argument('--expect', choices=['report', 'clean', 'dirty'],
                    default='report',
                    help='report — только метрики; clean — ассерт «0»; '
                         'dirty — доказательство «пила найдена»')
    ap.add_argument('--require-frames', type=int, default=0, metavar='N',
                    help='clean/report-режимы: кадров в окне < N = рендер/'
                         'трейс мёртв — инфра-FAIL (exit 2), НЕ продукт-RED '
                         '(гейт живости: resize-пульс/стрим обязаны давать '
                         'кадры; report без гейта = чистые метрики)')
    ap.add_argument('--require-sticky-off', action='store_true',
                    help='clean-режим saw: кадров sticky=false нет = скролл '
                         'не сработал (v9 inline-контракт: maxScroll>0 с '
                         'патча 73, чтение истории — фича гейта 67) — '
                         'инфра-FAIL (exit 2), НЕ продукт-RED')
    ap.add_argument('--forbid-sticky-off', action='store_true',
                    help='[v7-ЛЕГАСИ, до патча 73] clean-режим saw: кадров '
                         'sticky=false > 0 = RED — v7 исходил из «inline '
                         'вьюпорт = контенту, maxScroll=0, колесо = visual '
                         'no-op»; патч 73 сломал предпосылку (см. '
                         '--require-sticky-off)')
    ap.add_argument('--detector-name', default='trace_metrics',
                    help='имя DETECTOR-маркера (в сьюте = имя теста)')
    args = ap.parse_args()

    t_from, t_to = parse_t(args.t_from), parse_t(args.t_to)
    if t_from is None or t_to is None or t_from > t_to:
        print('trace-metrics: FAIL bad --from/--to', file=sys.stderr)
        return 2
    files, frames, stats = read_frames(args.trace, t_from, t_to, args.pid)
    if not files:
        print('DETECTOR {}: FAIL (trace_files=0 по {} — трейс не пишется, '
              'инфра-условие, НЕ продукт-RED)'.format(args.detector_name,
                                                      args.trace))
        return 2

    saw_flips = animation_frames = sticky_off_frames = 0
    print('TRACE {} files={} lines={} bad={} window=[{}..{}] frames_in_window={}'.format(
        args.trace, len(files), stats['lines'], stats['bad_lines'],
        t_from.isoformat(), t_to.isoformat(), len(frames)))
    if args.metric in ('saw', 'all'):
        m, pairs = saw_metrics(frames)
        saw_flips = m['saw_flips']
        sticky_off_frames = m['sticky_off']
        pair_txt = ' '.join('{}->{}x{}'.format(a, b, c)
                            for (a, b), c in pairs.most_common(5))
        print('SAW frames_sticky_off={} record_flips={} (dec={} inc={}) '
              'chain_flips={} saw_dec={} saw_inc_rebound={} saw_flips={} '
              'pairs={}'.format(m['sticky_off'], m['record_flips'], m['record_dec'],
                                m['record_inc'], m['chain_flips'], m['saw_dec'],
                                m['saw_inc_rebound'], m['saw_flips'], pair_txt or '-'))
    if args.metric in ('anim', 'all'):
        a = anim_metrics(frames)
        animation_frames = a['animation_frames']
        top = ' '.join('{}={}'.format(c, n) for c, n in a['top_causes'])
        print('ANIM animation_frames={} of frames={} causes={}'.format(
            animation_frames, a['frames'], top or '-'))

    # Гейт живости (НЕ продукт-RED, оба режима): dead-рендер/мёртвый трейс
    # дают ложное «пусто в окне» — отсекаем до любого вердикта.
    if args.require_frames > 0 and len(frames) < args.require_frames:
        print('DETECTOR {}: FAIL (frames_in_window={} < {} — рендер/трейс '
              'мёртв в окне, инфра-условие, НЕ продукт-RED)'.format(
                  args.detector_name, len(frames), args.require_frames))
        return 2
    if args.expect == 'report':
        print('DETECTOR {}: INFO (report: saw_flips={} animation_frames={})'.format(
            args.detector_name, saw_flips, animation_frames))
        return 0
    if args.expect == 'clean':
        # Инфра-гейты окна (НЕ продукт-RED): не-сработавший скролл даёт
        # ложный «0 флипов» — отсекаем ДО вердикта.
        if args.require_sticky_off and args.metric in ('saw', 'all'):
            if sticky_off_frames == 0:
                print('DETECTOR {}: FAIL (frames_sticky_off=0 — скролл не '
                      'сработал (контент не выше вьюпорта или колесо не '
                      'дошло), инфра-условие, НЕ продукт-RED)'.format(
                          args.detector_name))
                return 2
        problems = []
        if args.metric in ('saw', 'all') and saw_flips > 0:
            problems.append('saw_flips={} (пила scrollHeight при sticky=false — '
                            'джиттер ручного скролла)'.format(saw_flips))
        # [v7-ЛЕГАСИ, до патча 73] INLINE-контракт гейта 67: вьюпорт = высоте
        # контента (maxScroll=0), колесо у дна обязано быть visual no-op —
        # sticky не имеет права упасть вовсе (пила 39↔42 юзер-трейса 24.09);
        # v9 (патч 73): maxScroll>0, sticky-off легитимен (--require-sticky-off).
        if (args.forbid_sticky_off and args.metric in ('saw', 'all')
                and sticky_off_frames > 0):
            problems.append('frames_sticky_off={} (inline: гейт 67 обязан '
                            'глотать колесо при maxScroll=0 — sticky упал, '
                            'пила вьюпорта вернулась)'.format(sticky_off_frames))
        if args.metric in ('anim', 'all') and animation_frames > 0:
            problems.append('animation_frames={} (часы анимаций тикают в '
                            'idle-окне при animations off)'.format(animation_frames))
        if problems:
            print('DETECTOR {}: FAIL ({})'.format(args.detector_name,
                                                  '; '.join(problems)))
            return 1
        ok_parts = []
        if args.metric in ('saw', 'all'):
            ok_parts.append('saw_flips=0')
            if args.forbid_sticky_off:
                ok_parts.append('sticky_off=0')
            if args.require_sticky_off:
                ok_parts.append('sticky_off={} (скролл чтения работает)'
                                .format(sticky_off_frames))
        if args.metric in ('anim', 'all'):
            ok_parts.append('animation_frames=0')
        print('DETECTOR {}: PASS ({} — окно чисто)'.format(
            args.detector_name, ' '.join(ok_parts)))
        return 0
    # expect == dirty: доказательство, что детектор ловит пилу
    if saw_flips > 0:
        print('DETECTOR {}: PASS (dirty-proof: saw_flips={} > 0 — пила '
              'детектирована)'.format(args.detector_name, saw_flips))
        return 0
    print('DETECTOR {}: FAIL (dirty-proof: saw_flips=0 — ожидавшаяся пила '
          'не найдена)'.format(args.detector_name))
    return 1


if __name__ == '__main__':
    sys.exit(main())
