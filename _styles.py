"""
Style loading, normalization and helpers for e2go_nodes.

Style format (normalized):
    {"name": str, "prefix": str, "suffix": str, "negative": str}

Old format (from sdxl_prompt_styler):
    {"name": str, "prompt": "prefix {prompt} . suffix", "negative_prompt": str}
"""

import json
import os
import re
import threading
import time

from ._log import log, warn


# ---------------------------------------------------------------------------
# Category mapping for known style files.
# ---------------------------------------------------------------------------
_CATEGORY_NAMES = {
    "anime.json": "Anime & Manga",
    "cartoon.json": "Cartoon",
    "comics.json": "Comics",
    "photo.json": "Photography",
    "film.json": "Film & Cinematic",
    "painting.json": "Painting & Classic Art",
    "drawing.json": "Drawing & Ink",
    "digital.json": "Digital & Concept Art",
    "games.json": "Games",
    "render3d.json": "3D & Sculpture",
    "design.json": "Design & Graphic",
    "aesthetics.json": "Aesthetics & Worlds",
    "craft.json": "Craft & Materials",
    "utility.json": "Utility",
}


def _category_for_file(fname: str) -> str:
    """Display category for a styles file: known mapping or cleaned stem."""
    if fname in _CATEGORY_NAMES:
        return _CATEGORY_NAMES[fname]
    stem = re.sub(r'^sdxl_styles_', '', fname[:-5] if fname.endswith('.json') else fname)
    return stem.replace('_', ' ').strip().title() or "Other"


# ---------------------------------------------------------------------------
# Unified styles cache (used by both PowderStyler and PowderGridSaver).
# Auto-reloads when any .json in styles/ is modified.
# ---------------------------------------------------------------------------
# Single tuple (all_styles, by_name, scan_state) — readers on the aiohttp
# thread can never observe a new styles list paired with a stale by-name map.
# scan_state=None forces a reload on the next check.
_STYLES_STATE: tuple = ([], {}, None)
_STYLES_LAST_CHECK: float = 0.0
_STYLES_CHECK_INTERVAL: float = 2.0  # throttle stat() to one per N seconds


_STYLES_WRITE_LOCK = threading.Lock()


def _clean_tags(text: str) -> str:
    """Strip whitespace, remove leading/trailing separators, collapse spaces."""
    if not text:
        return ""
    text = text.strip()
    # Remove leading/trailing commas, dots, pipes (but not parens or colons)
    text = re.sub(r'^[\s,.\|]+|[\s,.\|]+$', '', text)
    # Collapse multiple spaces
    text = re.sub(r'\s{2,}', ' ', text)
    # Remove empty comma-segments: "a, , b" -> "a, b"
    parts = [p.strip() for p in text.split(",")]
    parts = [p for p in parts if p]
    return ", ".join(parts)


def normalize_style(style: dict) -> dict:
    """
    Convert a style dict to normalized {name, prefix, suffix, negative} format.

    Handles old formats:
    - "prefix {prompt} . suffix"  (SDXL dot separator)
    - "prefix {prompt}, suffix"   (comma separator)
    - "{prompt}, suffix"          (append only)
    - "prefix {prompt}"           (prepend only)
    - "text without {prompt}"     (all goes to prefix)
    - Already normalized          (pass through)
    """
    if not isinstance(style, dict):
        raise ValueError("Style must be an object")
    for field in ("name", "prefix", "suffix", "negative", "prompt", "negative_prompt"):
        if field in style and not isinstance(style[field], str):
            raise ValueError(f"Style {field} must be text")
    name = style.get("name", "unknown")

    # Already normalized?
    if "prefix" in style and "suffix" in style:
        return {
            "name": name,
            "prefix": _clean_tags(style.get("prefix", "")),
            "suffix": _clean_tags(style.get("suffix", "")),
            "negative": _clean_tags(style.get("negative", "")),
        }

    prompt_template = style.get("prompt", "")
    negative = style.get("negative_prompt", style.get("negative", ""))

    if not prompt_template or "{prompt}" not in prompt_template:
        # No placeholder -- entire text is prefix
        return {
            "name": name,
            "prefix": _clean_tags(prompt_template),
            "suffix": "",
            "negative": _clean_tags(negative),
        }

    # Split on {prompt}
    parts = prompt_template.split("{prompt}", 1)
    raw_prefix = parts[0] if len(parts) > 0 else ""
    raw_suffix = parts[1] if len(parts) > 1 else ""

    # Clean the SDXL " . " separator from suffix start
    raw_suffix = re.sub(r'^\s*\.\s*', '', raw_suffix)
    # Clean leading comma from suffix
    raw_suffix = re.sub(r'^\s*,\s*', '', raw_suffix)
    # Clean trailing comma/dot from prefix
    raw_prefix = re.sub(r'[\s,.\|]+$', '', raw_prefix)

    return {
        "name": name,
        "prefix": _clean_tags(raw_prefix),
        "suffix": _clean_tags(raw_suffix),
        "negative": _clean_tags(negative),
    }


def deduplicate_tags(text: str) -> str:
    """Remove duplicate comma-separated tags, preserving order."""
    if not text:
        return ""
    seen = set()
    result = []
    for tag in text.split(","):
        tag = tag.strip()
        if tag and tag not in seen:
            seen.add(tag)
            result.append(tag)
    return ", ".join(result)


def load_styles_from_directory(styles_dir: str) -> list:
    """Load all JSON style files, normalize, deduplicate names."""
    all_styles = []
    seen_names = set()

    if not os.path.isdir(styles_dir):
        warn(f"Styles directory not found: {styles_dir}")
        return []

    # user file last: on a name clash the bundled style keeps its name
    for fname in sorted(os.listdir(styles_dir), key=lambda f: (f == USER_STYLES_FILENAME, f)):
        if not fname.endswith(".json"):
            continue
        category = _category_for_file(fname)
        fpath = os.path.join(styles_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeError) as e:
            warn(f"Error loading {fname}: {e}")
            continue

        if not isinstance(data, list):
            warn(f"Skipping {fname}: expected list, got {type(data)}")
            continue

        for item in data:
            if not isinstance(item, dict) or "name" not in item:
                continue
            try:
                style = normalize_style(item)
            except ValueError as exc:
                warn(f"Skipping invalid style in {fname}: {exc}")
                continue
            style["category"] = category
            # Deduplicate names
            base_name = style["name"]
            if base_name in seen_names:
                counter = 2
                while f"{base_name} ({counter})" in seen_names:
                    counter += 1
                style["name"] = f"{base_name} ({counter})"
            seen_names.add(style["name"])
            all_styles.append(style)

    all_styles.sort(key=lambda s: s["name"].lower())

    log(f"Loaded {len(all_styles)} styles from {styles_dir}")
    return all_styles


def get_styles_dir() -> str:
    """Return path to the styles directory bundled with e2go_nodes."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "styles")


# ---------------------------------------------------------------------------
# User styles: locally-authored styles stored in sdxl_styles_user.json
# (category "User" via _category_for_file's stem rule). The file is
# git-ignored — it belongs to the user, not the package.
# ---------------------------------------------------------------------------
USER_STYLES_FILENAME = "sdxl_styles_user.json"

# Matches the loader's collision suffix ("Name (2)") — used by the CRUD repair
# fallbacks below.
_DEDUP_SUFFIX_RE = re.compile(r" \(\d+\)$")


MAX_STYLE_NAME = 128
MAX_STYLE_FIELD = 4096


def get_user_styles_path() -> str:
    return os.path.join(get_styles_dir(), USER_STYLES_FILENAME)


def load_user_styles() -> list:
    try:
        with open(get_user_styles_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError, UnicodeError) as exc:
        raise ValueError("Cannot read user styles. Repair or back up the existing file before editing styles.") from exc
    if not isinstance(data, list):
        raise ValueError("User styles must be a JSON list; the existing file has not been changed.")
    for item in data:
        normalize_style(item)
    return data


def _write_user_styles(styles: list) -> None:
    # tmp + os.replace: a crash mid-dump must never truncate the user's
    # hand-authored library (same pattern as WildcardLibrary.upload).
    path = get_user_styles_path()
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(styles, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise
    invalidate_styles_cache()


def invalidate_styles_cache() -> None:
    """Force the next get_styles() call to re-stat AND reload styles."""
    global _STYLES_LAST_CHECK, _STYLES_STATE
    with _STYLES_WRITE_LOCK:
        _STYLES_LAST_CHECK = 0.0
        # Clear the scan state too: a write that lands within the same mtime
        # second (or an unchanged count/mtime pair) must still trigger a reload.
        _STYLES_STATE = (_STYLES_STATE[0], _STYLES_STATE[1], None)


def upsert_user_style(style: dict, original_name: str | None = None) -> dict:
    """
    Add or update a user style. `original_name` targets an existing entry when
    the edit renames it; entries matching either name collapse into one so a
    rename onto an existing style never leaves duplicates.
    """
    # Force the already-normalized branch of normalize_style: a partial dict
    # (prefix without suffix) would otherwise fall into the legacy
    # prompt-template parser and silently drop fields.
    norm = normalize_style({
        "name": style.get("name", ""),
        "prefix": style.get("prefix", ""),
        "suffix": style.get("suffix", ""),
        "negative": style.get("negative", ""),
    })
    if not norm["name"] or norm["name"] == "unknown":
        raise ValueError("style name required")
    if len(norm["name"]) > MAX_STYLE_NAME:
        raise ValueError(f"style name too long (>{MAX_STYLE_NAME})")
    for field in ("prefix", "suffix", "negative"):
        if len(norm[field]) > MAX_STYLE_FIELD:
            raise ValueError(f"style {field} too long (>{MAX_STYLE_FIELD})")


    _, by_name = get_styles()
    clash = by_name.get(norm["name"])
    if clash is not None and clash.get("category") != "User" and norm["name"] != (original_name or ""):
        raise ValueError(f"name '{norm['name']}' already exists in the built-in library")

    key = original_name or norm["name"]
    # Legacy repair: entries already shadowed before the guard existed reach us
    # under their load-renamed "Name (2)" alias — fall back to the on-disk name.
    key_unsuffixed = _DEDUP_SUFFIX_RE.sub("", key)

    existing = load_user_styles()
    names_on_disk = {s.get("name") for s in existing}
    # Only for an EDIT of a shadowed entry: a brand-new "X (2)" must not
    # replace the user's own style "X".
    if (original_name and key not in names_on_disk and key_unsuffixed in names_on_disk
            and _is_bundled_name(by_name, key_unsuffixed)):
        key = key_unsuffixed

    out, replaced = [], False
    for s in existing:
        n = s.get("name")
        if n == key or n == norm["name"]:
            if not replaced:
                out.append(norm)
                replaced = True
        else:
            out.append(s)
    if not replaced:
        out.append(norm)
    _write_user_styles(out)
    return norm


def _is_bundled_name(by_name: dict, name: str) -> bool:
    style = by_name.get(name)
    return style is not None and style.get("category") != "User"


def delete_user_style(name: str) -> bool:
    styles = load_user_styles()
    out = [s for s in styles if s.get("name") != name]
    if len(out) == len(styles):
        # Legacy repair: a bundled-name-shadowing user style is shown (and thus
        # deleted) under its load-renamed "Name (2)" alias — retry with the
        # suffix stripped so the on-disk entry is actually removable.
        unsuffixed = _DEDUP_SUFFIX_RE.sub("", name)
        if unsuffixed != name and _is_bundled_name(get_styles()[1], unsuffixed):
            out = [s for s in styles if s.get("name") != unsuffixed]
        if len(out) == len(styles):
            return False
    _write_user_styles(out)
    return True


def _scan_styles_state(styles_dir: str) -> tuple:
    """Build a stable fingerprint of the current style files for cache invalidation."""
    try:
        files = []
        for entry in os.scandir(styles_dir):
            if entry.is_file() and entry.name.lower().endswith(".json"):
                st = entry.stat()
                files.append((entry.name, st.st_mtime_ns, st.st_size))
        return tuple(sorted(files))
    except Exception:
        return ()


def styles_state_token() -> str:
    """Opaque token that changes whenever the styles library changes on disk.
    Used by PowderStyler.IS_CHANGED to invalidate Comfy's exec cache when a
    style's TEXT changes without any node input changing."""
    return repr(_scan_styles_state(get_styles_dir()))


def get_styles() -> tuple[list, dict]:
    """
    Return (all_styles, styles_by_name). Auto-reloads when files change,
    throttled to one stat() per _STYLES_CHECK_INTERVAL seconds.
    """
    global _STYLES_STATE, _STYLES_LAST_CHECK

    now = time.monotonic()
    all_styles, by_name, cached_scan = _STYLES_STATE
    if now - _STYLES_LAST_CHECK >= _STYLES_CHECK_INTERVAL or not all_styles:
        _STYLES_LAST_CHECK = now
        styles_dir = get_styles_dir()
        current = _scan_styles_state(styles_dir)
        if current != cached_scan or not all_styles:
            loaded = load_styles_from_directory(styles_dir)
            with _STYLES_WRITE_LOCK:
                _STYLES_STATE = (loaded, {s["name"]: s for s in loaded}, current)
            all_styles, by_name = loaded, _STYLES_STATE[1]

    return all_styles, by_name
