#!/usr/bin/env python3
"""
rename-patches-bigbang.py — Phase 3A big-bang rename of dsh-overrides patch files.

Renames 83 .patch files from old-ID format (NN-slug.patch) to SUBSYS.FF.B format.
Updates reference files: PATCH-SERIES, apply-dsh-overrides.sh, PATCH-MAP.md.
Updates # Family: DEP-3 headers for split-family members only.
Updates test file references to renamed patches.
Updates test-series-apply.sh: removes lexicographic order assert (etap 0 -> etap 1).

Idempotent: if old filenames no longer exist (already renamed), skips rename.
Reference-file updates use string replacement (old-name -> new-name), which is
also idempotent: if old-name is already gone, the replacement is a no-op.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

# --- Paths ---

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
PATCHES_DIR = REPO_ROOT / "dsh-overrides" / "patches"
PATCH_MAP_FILE = REPO_ROOT / "dsh-overrides" / "PATCH-MAP.md"
PATCH_SERIES_FILE = PATCHES_DIR / "PATCH-SERIES"
APPLY_SCRIPT_FILE = REPO_ROOT / "scripts" / "apply-dsh-overrides.sh"
TESTS_DIR = REPO_ROOT / "tests"

# --- Family split table: old-ID -> new-family (SUBSYS.FF) ---
# Split members get a new family; branch .1 (first member of new family).
SPLIT_TABLE: dict[str, str] = {
    "09": "TG.05",
    "13": "TG.06",
    "14": "TG.07",
    "15": "TG.08",
    "27": "TG.09",
    "39": "HB.03",
    "44": "HB.08",
    "46": "HB.04",
    "47": "HB.05",
    "52": "HB.06",
    "63": "HB.07",
    "22": "PR.03",
    "31": "PR.04",
    "23": "IL.07",
    "24": "IL.05",
    "25": "IL.06",
}


# --- Functions ---


def parse_patch_map() -> dict[str, str]:
    """Parse PATCH-MAP.md -> {old-stem: column2-new-ID}.

    old-stem is the column-1 value without '.patch' (e.g. '01-empty-screen').
    column2-new-ID is the column-2 value (e.g. 'CH.01.1-empty-screen').
    """
    text = PATCH_MAP_FILE.read_text()
    result: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        if "Старый ID" in stripped or stripped.startswith("|---"):
            continue
        parts = [p.strip() for p in line.split("|")]
        # parts[0] = '' (leading |), parts[1] = old-stem, parts[2] = new-id
        if len(parts) < 3:
            continue
        old_stem = parts[1]
        new_id = parts[2]
        if not old_stem or not new_id or "---" in old_stem:
            continue
        result[old_stem] = new_id
    return result


def extract_old_id_and_slug(old_stem: str) -> tuple[str, str]:
    """Split '09-todo-collapsed' -> ('09', 'todo-collapsed')."""
    if "-" in old_stem:
        old_id, slug = old_stem.split("-", 1)
        return old_id, slug
    return old_stem, ""


def build_rename_map(
    patch_map: dict[str, str],
) -> dict[str, tuple[str, str | None]]:
    """Build final rename map.

    Returns {old-filename: (new-filename, new-family-or-None)}.
    new-family is set only for split members (where # Family: header needs update).
    """
    result: dict[str, tuple[str, str | None]] = {}
    for old_stem, col2 in patch_map.items():
        old_fname = f"{old_stem}.patch"
        old_id, slug = extract_old_id_and_slug(old_stem)

        if old_id in SPLIT_TABLE:
            new_family = SPLIT_TABLE[old_id]
            new_fname = f"{new_family}.1-{slug}.patch"
            result[old_fname] = (new_fname, new_family)
        else:
            # Non-split: use column 2 as-is (already includes branch B)
            new_fname = f"{col2}.patch"
            result[old_fname] = (new_fname, None)
    return result


def build_name_lookup(
    rename_map: dict[str, tuple[str, str | None]],
) -> dict[str, str]:
    """Build {old-filename: new-filename} lookup (drops family info)."""
    return {old: new for old, (new, _) in rename_map.items()}


def rename_patch_files(
    rename_map: dict[str, tuple[str, str | None]],
) -> list[tuple[str, str]]:
    """Rename .patch files on disk. Returns list of (old, new) actually renamed."""
    renamed: list[tuple[str, str]] = []
    for old_fname, (new_fname, _) in sorted(rename_map.items()):
        old_path = PATCHES_DIR / old_fname
        new_path = PATCHES_DIR / new_fname
        if not old_path.exists():
            # Already renamed or missing — skip
            continue
        if old_path == new_path:
            continue
        if new_path.exists():
            print(f"  WARNING: target exists, skipping: {new_fname}", file=sys.stderr)
            continue
        shutil.move(str(old_path), str(new_path))
        renamed.append((old_fname, new_fname))
    return renamed


def update_family_headers(
    rename_map: dict[str, tuple[str, str | None]],
) -> int:
    """Update '# Family:' DEP-3 header for split members only.

    Non-split patches are NOT touched.
    Returns count of files updated.
    """
    count = 0
    for _old_fname, (new_fname, new_family) in rename_map.items():
        if new_family is None:
            continue
        new_path = PATCHES_DIR / new_fname
        if not new_path.exists():
            continue
        text = new_path.read_text()
        # Replace '# Family:    OLD.FF' -> '# Family:    NEW.FF'
        new_text = re.sub(
            r"^(# Family:)\s+\S+\s*$",
            rf"\g<1>    {new_family}",
            text,
            count=1,
            flags=re.MULTILINE,
        )
        if new_text != text:
            new_path.write_text(new_text)
            count += 1
    return count


def replace_in_file(
    file_path: Path,
    replacements: dict[str, str],
) -> int:
    """Replace old strings with new strings in a file. Returns count of replacements made."""
    if not file_path.exists():
        return 0
    text = file_path.read_text()
    # Sort by length descending to avoid partial-match issues
    sorted_keys = sorted(replacements.keys(), key=len, reverse=True)
    new_text = text
    hits = 0
    for old_val in sorted_keys:
        new_val = replacements[old_val]
        if old_val == new_val:
            continue  # No-op: skip identity replacements
        if old_val in new_text:
            new_text = new_text.replace(old_val, new_val)
            hits += 1
    if new_text != text:
        file_path.write_text(new_text)
    return hits


def update_patch_series(
    name_lookup: dict[str, str],
) -> int:
    """Update PATCH-SERIES: replace old filenames with new, preserving order."""
    return replace_in_file(PATCH_SERIES_FILE, name_lookup)


def update_apply_script(
    name_lookup: dict[str, str],
) -> int:
    """Update apply-dsh-overrides.sh: MARKERS keys + marker_file cases."""
    return replace_in_file(APPLY_SCRIPT_FILE, name_lookup)


def update_patch_map_column2(
    patch_map: dict[str, str],
) -> int:
    """Update PATCH-MAP.md column 2 for split families only.

    For each split member, replace old-column2 with new-column2.
    old-column2 values are unique in the file, so string replacement is safe.
    """
    replacements: dict[str, str] = {}
    for old_stem, col2 in patch_map.items():
        old_id, slug = extract_old_id_and_slug(old_stem)
        if old_id in SPLIT_TABLE:
            new_family = SPLIT_TABLE[old_id]
            new_col2 = f"{new_family}.1-{slug}"
            replacements[col2] = new_col2
    return replace_in_file(PATCH_MAP_FILE, replacements)


def update_test_references(
    name_lookup: dict[str, str],
) -> int:
    """Update test file references to renamed patches.

    Scans tests/ for old patch filenames and replaces with new names.
    """
    count = 0
    for test_file in TESTS_DIR.rglob("*"):
        if not test_file.is_file():
            continue
        if test_file.suffix == ".pyc":
            continue
        if "rename-patches" in test_file.name:
            continue
        try:
            text = test_file.read_text()
        except (UnicodeDecodeError, PermissionError):
            continue
        if not any(old in text for old in name_lookup):
            continue
        hits = replace_in_file(test_file, name_lookup)
        if hits > 0:
            count += 1
            print(f"  updated: {test_file.relative_to(REPO_ROOT)}")
    return count


def update_series_test_lexicographic_assert() -> bool:
    """Remove lexicographic order assert from test-series-apply.sh.

    On etap 0 (alias), series order == lexicographic order of filenames.
    On etap 1 (SUBSYS.FF.B), filenames are no longer lexicographic in
    application order, so this assert is replaced with a simple pass.
    """
    test_file = TESTS_DIR / "patch-stack" / "test-series-apply.sh"
    if not test_file.exists():
        return False
    text = test_file.read_text()

    # Match the lexicographic assert block (lines ~134-143)
    pattern = re.compile(
        r'  # Этап 0: порядок серии = лексикографический.*?\n  fi\n',
        re.DOTALL,
    )
    replacement = (
        '  # Этап 1 (SUBSYS.FF.B): лексикографический ассерт снят — имена более\n'
        '  # не лексикографичны порядку применения. 1:1 проверяется выше.\n'
        '  # series-order.txt нужен Фазе 3 (порядок applied = порядок серии).\n'
        '  printf \'%s\\n\' "${SERIES[@]}" > "$SANDBOX/series-order.txt"\n'
        '  pass "порядок серии = явный (SUBSYS.FF.B, этап 1)"\n'
    )
    new_text, n = pattern.subn(replacement, text)
    if n > 0:
        test_file.write_text(new_text)
        return True
    return False


def main() -> int:
    print("=== rename-patches-bigbang.py ===")
    print(f"REPO_ROOT: {REPO_ROOT}")
    print()

    # Step 1: Parse PATCH-MAP
    patch_map = parse_patch_map()
    print(f"Step 1: PATCH-MAP parsed: {len(patch_map)} entries")

    # Step 2: Build rename map
    rename_map = build_rename_map(patch_map)
    name_lookup = build_name_lookup(rename_map)
    split_count = sum(1 for _, (_, fam) in rename_map.items() if fam is not None)
    print(f"Step 2: rename map built: {len(rename_map)} entries ({split_count} split members)")

    # Print split members for verification
    print("\n  Split members:")
    for old_fname, (new_fname, new_family) in sorted(rename_map.items()):
        if new_family is not None:
            print(f"    {old_fname:45s} -> {new_fname:55s} (Family: {new_family})")

    # Step 3: Rename patch files
    print("\nStep 3: Renaming .patch files...")
    renamed = rename_patch_files(rename_map)
    print(f"  Renamed: {len(renamed)} files")
    skipped = len(rename_map) - len(renamed)
    if skipped > 0:
        print(f"  Skipped (already renamed/missing): {skipped} files")

    # Step 4: Update # Family: headers for split members
    print("\nStep 4: Updating # Family: headers for split members...")
    family_updated = update_family_headers(rename_map)
    print(f"  Updated: {family_updated} headers")

    # Step 5: Update PATCH-SERIES
    print("\nStep 5: Updating PATCH-SERIES...")
    series_updated = update_patch_series(name_lookup)
    print(f"  Replaced: {series_updated} names")

    # Step 6: Update apply-dsh-overrides.sh (MARKERS + marker_file)
    print("\nStep 6: Updating apply-dsh-overrides.sh (MARKERS + marker_file)...")
    apply_updated = update_apply_script(name_lookup)
    print(f"  Replaced: {apply_updated} names")

    # Step 7: Update PATCH-MAP.md column 2 for split families
    print("\nStep 7: Updating PATCH-MAP.md column 2 for split families...")
    map_updated = update_patch_map_column2(patch_map)
    print(f"  Updated: {map_updated} column-2 values")

    # Step 8: Update test file references
    print("\nStep 8: Updating test file references...")
    test_updated = update_test_references(name_lookup)
    print(f"  Updated: {test_updated} test files")

    # Step 9: Update test-series-apply.sh lexicographic assert
    print("\nStep 9: Updating test-series-apply.sh lexicographic assert...")
    lex_updated = update_series_test_lexicographic_assert()
    print(f"  Updated: {lex_updated}")

    # Summary
    print("\n=== Summary ===")
    print(f"  Patches renamed:           {len(renamed)}")
    print(f"  # Family: headers updated:  {family_updated}")
    print(f"  PATCH-SERIES names:        {series_updated}")
    print(f"  apply-script names:        {apply_updated}")
    print(f"  PATCH-MAP column-2:        {map_updated}")
    print(f"  Test files updated:        {test_updated}")
    print(f"  Lexicographic assert:      {'updated' if lex_updated else 'NOT FOUND'}")

    # Verify patch count
    patch_count = len(list(PATCHES_DIR.glob("*.patch")))
    print(f"\n  .patch files in patches/:  {patch_count}")

    # Verify no old-ID filenames remain
    old_id_files = [f.name for f in PATCHES_DIR.glob("*.patch") if f.name[0].isdigit()]
    if old_id_files:
        print(f"  WARNING: {len(old_id_files)} old-ID filenames remain: {old_id_files[:5]}")
    else:
        print("  OK: no old-ID filenames remain")

    return 0


if __name__ == "__main__":
    sys.exit(main())
