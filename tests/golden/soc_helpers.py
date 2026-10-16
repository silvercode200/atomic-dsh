#!/usr/bin/env python3
"""soc_helpers.py — шаги-помощники SOC-программы кеш-верификации.

Вызываются из soc-cache-verification.yaml однострочниками (внутри YAML
нельзя держать многострочные heredoc — block scalar рвётся на column 1).

Usage:
    python3 soc_helpers.py verdicts <run_dir>    # факты вердиктов
    python3 soc_helpers.py cache-threshold <run_dir>  # exit 0 если avg >= 97
"""
from __future__ import annotations

import glob
import json
import os
import sys


def verdicts(run_dir: str) -> int:
    """Печать: system_stable_count, header_change_count, cache_X=..., cache_avg."""
    stable = 0
    changes = 0
    pcts: list[tuple[str, float, int]] = []
    for f in sorted(glob.glob(os.path.join(run_dir, "*-verdict.json"))):
        try:
            v = json.load(open(f))["verdict"]
        except Exception:
            continue
        checks = v["checks"]
        if checks.get("system_stable"):
            stable += 1
        if checks.get("header_count", 0) > 1:
            changes += 1
        c = checks.get("cache_pct")
        if isinstance(c, (int, float)):
            pcts.append((os.path.basename(f)[0], c, checks.get("cache_steps", 0)))
    print(f"system_stable_count={stable}")
    print(f"header_change_count={changes}")
    for name, pct, n in pcts:
        print(f"cache_{name}={pct:.2f}% ({n} steps)")
    if pcts:
        avg = sum(p for _, p, _ in pcts) / len(pcts)
        print(f"cache_avg={avg:.2f}%")
    else:
        print("cache_avg=none")
    return 0


def cache_threshold(run_dir: str, threshold: float = 97.0) -> int:
    """exit 0 <=> средний cache_pct по вердиктам >= threshold (PASS)."""
    pcts = []
    for f in sorted(glob.glob(os.path.join(run_dir, "*-verdict.json"))):
        try:
            v = json.load(open(f))["verdict"]
        except Exception:
            continue
        c = v["checks"].get("cache_pct")
        if isinstance(c, (int, float)):
            pcts.append(c)
    if not pcts:
        print("cache_threshold=NO_DATA")
        return 1
    avg = sum(pcts) / len(pcts)
    ok = avg >= threshold
    print(f"cache_threshold={'PASS' if ok else 'FAIL'} avg={avg:.2f}% n={len(pcts)}")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in ("verdicts", "cache-threshold") or len(argv) < 3:
        print(__doc__)
        return 2
    run_dir = argv[2]
    if argv[1] == "verdicts":
        return verdicts(run_dir)
    return cache_threshold(run_dir)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
