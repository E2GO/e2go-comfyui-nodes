"""
PowderPromptWildcard - batch prompts from multi-line text or a wildcard file.

One line = one prompt. Empty lines and lines starting with '#' are skipped.
Negative prompt is a single global value replicated to match positive count.
"""

import hashlib
import os
import re
from pathlib import Path

from ._log import log, info, warn


def _parse_wildcard_lines(text):
    """Split multi-line text into prompt list. Skip empty / '#' comment lines."""
    if not isinstance(text, str) or not text:
        return []
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        out.append(line)
    return out


_SELECTION_RE = re.compile(r"^\[(e2go|comfy)\]\s+(.+)$")


def _parse_selection(value):
    """Parse combo display '[source] name' -> (source, name). Pure.

    Returns None for the '(none)' sentinel, empty, non-string, or anything
    that doesn't match the '[e2go|comfy] <name>' shape.
    """
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or v == "(none)":
        return None
    m = _SELECTION_RE.match(v)
    return (m.group(1), m.group(2)) if m else None


class WildcardLibrary:
    """Scan / read / write .txt wildcard files in two known bases."""

    # IGNORECASE: list() accepts Foo.TXT (Windows FS is case-insensitive),
    # so read()/upload() must too — else a listed file is unreadable.
    _NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.txt\Z", re.IGNORECASE)
    _MAX_NAME = 128
    _MAX_FILE_BYTES = 1_048_576  # 1 MiB
    _SOURCES = ("e2go", "comfy")
    # Process-lifetime memoization, no invalidation hook. Tests that need a
    # different `folder_paths.base_path` must patch `_bases` wholesale (or
    # reset `_bases_cache` to None) — patching `folder_paths` alone won't
    # bust this cache.
    _bases_cache = None

    @classmethod
    def _bases(cls):
        """Resolve scan bases, memoized after first call (paths don't change
        at runtime). Returns [(source, Path), ...].
        """
        if cls._bases_cache is not None:
            return cls._bases_cache
        bases = []
        pkg_dir = Path(__file__).resolve().parent
        bases.append(("e2go", pkg_dir / "wildcards"))
        try:
            import folder_paths  # type: ignore
            comfy_base = Path(folder_paths.base_path) / "wildcards"
            bases.append(("comfy", comfy_base))
        except Exception:
            pass
        cls._bases_cache = bases
        return bases

    @classmethod
    def list(cls):
        """Return sorted list of {'source','name'} dicts."""
        out = []
        for source, base in cls._bases():
            if not base.is_dir():
                continue
            try:
                for entry in base.iterdir():
                    if not entry.is_file():
                        continue
                    if not entry.name.lower().endswith(".txt"):
                        continue
                    out.append({"source": source, "name": entry.name})
            except OSError as e:
                warn(f"[WildcardLibrary] scan failed for {base}: {e}")
        out.sort(key=lambda d: (d["source"], d["name"].lower()))
        return out

    @classmethod
    def _validate_name(cls, name, strict=False):
        """Validate a wildcard filename before accessing the local wildcard directory."""
        if not isinstance(name, str) or not name:
            raise ValueError("name must be a non-empty string")
        if len(name) > cls._MAX_NAME:
            raise ValueError(f"name too long (>{cls._MAX_NAME})")
        if strict:
            if not cls._NAME_RE.match(name):
                raise ValueError("name must match [A-Za-z0-9._-]+\\.txt")
        if not name.lower().endswith(".txt"):
            raise ValueError("name must end with .txt")
        if ("/" in name or "\\" in name or "\x00" in name
                or name != os.path.basename(name) or name.startswith("..")):
            raise ValueError("name must be a plain file name")
        return name

    @classmethod
    def _resolve_base(cls, source):
        if source not in cls._SOURCES:
            raise ValueError(f"invalid source: {source!r}")
        for s, base in cls._bases():
            if s == source:
                return base
        raise ValueError(f"source not available: {source!r}")

    @classmethod
    def read(cls, source, name):
        cls._validate_name(name)
        base = cls._resolve_base(source)
        target = (base / name).resolve()
        base_resolved = base.resolve()
        if base_resolved not in target.parents and target != base_resolved:
            raise ValueError("path escapes base")
        if not target.is_file():
            raise FileNotFoundError(name)
        size = target.stat().st_size
        if size > cls._MAX_FILE_BYTES:
            raise ValueError(f"file too large ({size} > {cls._MAX_FILE_BYTES})")
        return target.read_text(encoding="utf-8-sig", errors="replace")

    @classmethod
    def upload(cls, name, content):
        cls._validate_name(name, strict=True)
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        encoded = content.encode("utf-8")
        if len(encoded) > cls._MAX_FILE_BYTES:
            raise ValueError(f"content too large ({len(encoded)} > {cls._MAX_FILE_BYTES})")
        base = None
        for s, b in cls._bases():
            if s == "e2go":
                base = b
                break
        if base is None:
            raise RuntimeError("no e2go base available")
        base.mkdir(parents=True, exist_ok=True)
        target = (base / name).resolve()
        base_resolved = base.resolve()
        if base_resolved not in target.parents and target != base_resolved:
            raise ValueError("path escapes base")
        tmp = target.with_suffix(target.suffix + ".tmp")
        try:
            tmp.write_bytes(encoded)
            os.replace(str(tmp), str(target))
        except Exception:
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass
            raise
        return {"source": "e2go", "name": name}

    @classmethod
    def clear_local(cls):
        """Delete every .txt directly inside the package-local (e2go) base.

        The shared comfy base is never touched. Returns the count removed.
        """
        base = None
        for s, b in cls._bases():
            if s == "e2go":
                base = b
                break
        if base is None or not base.is_dir():
            return 0
        base_resolved = base.resolve()
        removed = 0
        for entry in base.iterdir():
            if not entry.is_file() or not entry.name.lower().endswith(".txt"):
                continue
            if entry.resolve().parent != base_resolved:   # direct children only
                continue
            try:
                entry.unlink()
                removed += 1
            except OSError as e:
                warn(f"[WildcardLibrary] clear failed for {entry}: {e}")
        return removed


def _compose_with_base(prefix, line, suffix):
    """Join non-empty parts with ', '. Pure helper, easy to test in isolation."""
    parts = []
    if prefix:
        parts.append(prefix)
    if line:
        parts.append(line)
    if suffix:
        parts.append(suffix)
    return ", ".join(parts)


def _assemble_batch(raw_text, negative_text, prefix_text, suffix_text, start_index, count):
    """Pure core. Returns (positive_list, negative_list, next_index, total).

    count > 0  -> batch slice [start:start+count], next_index advances to end.
    count <= 0 -> classic: slice [start:total], next_index stays at start (no advance).
    start >= total (total>0) -> empty result, cursor clamped to total (end-of-list no-op).
    total == 0 -> legacy empty / base-only behaviour, next_index 0.
    """
    lines = _parse_wildcard_lines(raw_text)
    neg = (negative_text or "").strip() if isinstance(negative_text, str) else ""
    prefix = (prefix_text or "").strip() if isinstance(prefix_text, str) else ""
    suffix = (suffix_text or "").strip() if isinstance(suffix_text, str) else ""
    total = len(lines)

    if total == 0:
        if prefix or suffix:
            return ([_compose_with_base(prefix, "", suffix)], [neg], 0, 0)
        return ([""], [""], 0, 0)

    start = max(0, int(start_index))
    if start >= total:                       # end-of-list (incl. file shrink)
        return ([], [], total, total)

    c = int(count)
    end = total if c <= 0 else min(start + c, total)
    next_index = start if c <= 0 else end    # count<=0: classic, no advance

    batch = lines[start:end]
    composed = [_compose_with_base(prefix, line, suffix) for line in batch]
    return (composed, [neg] * len(composed), next_index, total)


def _resolve_text(wildcard_file, positive_prompt_list):
    """Pick the active source: live file (if selected) or the textbox fallback.

    Returns (raw_text, tag). On read failure -> ("", "missing:<name>") + warn,
    so the node degrades to a no-op without moving the cursor.
    """
    sel = _parse_selection(wildcard_file)
    if sel is None:
        return (positive_prompt_list or "", "text")
    source, name = sel
    try:
        return (WildcardLibrary.read(source, name), f"file:{source}:{name}")
    except Exception as e:
        warn(f"[PowderPromptWildcard] read {source}/{name} failed: {e!r}")
        return ("", f"missing:{source}:{name}")


from ._cursor import CursorStore

_CURSOR = CursorStore()


class PowderPromptWildcard:
    """Batch prompts from multi-line text. One line = one prompt."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive_prompt_list": ("STRING", {"default": "", "multiline": True}),
                "negative_prompt_list": ("STRING", {"default": "", "multiline": True}),
                "wildcard_file": (["(none)"],),
                "start_index": ("INT", {"default": 0, "min": 0, "max": 1_000_000}),
                "count": ("INT", {"default": 0, "min": 0, "max": 10_000}),
                "loop": ("BOOLEAN", {"default": False, "label_on": "ON", "label_off": "OFF"}),
            },
            "optional": {
                "prefix_text": ("STRING", {"default": "", "multiline": True}),
                "suffix_text": ("STRING", {"default": "", "multiline": True}),
                "cursor_scope": ("STRING", {"default": ""}),
                "on_exhausted": (["stop", "loop"], {"default": "stop", "tooltip": "stop: block downstream at the end; loop: restart from start_index and continue queued generations."}),
                "repeat_last": ("BOOLEAN", {"default": False, "label_on": "ON", "label_off": "OFF", "tooltip": "Repeat the last selection on every Queue. Turn off to continue. Reset or a changed source starts a new selection."}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompts", "negative_prompts")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "get_prompts"
    CATEGORY = "e2go"

    def get_prompts(self, positive_prompt_list, negative_prompt_list, wildcard_file="(none)",
                    start_index=0, count=0, prefix_text="", suffix_text="",
                    loop=False, unique_id=None, cursor_scope="", on_exhausted="stop", repeat_last=False):
        raw, tag = _resolve_text(wildcard_file, positive_prompt_list)
        start_index = max(0, int(start_index))
        # The cursor is keyed by node id on the server, and two workflows can
        # share an id — the source is part of the anchor so each list keeps its
        # own position. A file is its name (appending lines continues the run);
        # the textbox is its content.
        if ":" in tag:
            source = "file:" + tag.split(":", 1)[1]
        else:
            source = "text:" + hashlib.md5(raw.encode("utf-8")).hexdigest()[:8]
        anchor = (start_index, source)
        uid = str(unique_id) if unique_id is not None else None
        if uid is not None and cursor_scope:
            uid = f"{cursor_scope}:{uid}"

        if tag.startswith("missing:"):
            # File selected but unreadable: true no-op, per _resolve_text's
            # contract -- do not move the cursor or emit a fake prompt.
            current = _CURSOR.resolve(uid, anchor, start_index) if uid is not None else start_index
            info(f"[PowderPromptWildcard] {tag}: unreadable, no-op "
                 f"(cursor unchanged at {current})")
            return {"ui": {"next_index": [current], "total": [0], "status": ["File unavailable"]},
                    "result": _no_prompts()}

        # Keep the old input for workflow/API compatibility, but give it the
        # same restart-at-end meaning as the shared exhaustion policy.
        cycling = loop or on_exhausted == "loop"
        if uid is not None:
            start = _CURSOR.resolve(uid, anchor, start_index)
            if repeat_last:
                start = _CURSOR.last_position(uid, anchor, start)
        else:
            start = start_index
        pos, neg, next_index, total = _assemble_batch(
            raw, negative_prompt_list, prefix_text, suffix_text, start, count)
        if not pos and total and cycling and start_index < total:
            start = start_index
            pos, neg, next_index, total = _assemble_batch(
                raw, negative_prompt_list, prefix_text, suffix_text, start, count)
        if uid is not None:
            _CURSOR.commit(uid, anchor, next_index, position=start if pos else None)
        reported = next_index
        info(f"[PowderPromptWildcard] {tag}: anchor {start_index} pos {start}->{reported} "
             f"of {total}, {len(pos)} prompts, "
             f"negative {'set' if (neg and neg[0]) else 'empty'}")
        status = ("Loop - next Queue restarts the range" if cycling and start_index < total
                  else "Exhausted - reset to restart") if reported >= total else "Ready"
        if repeat_last and pos:
            status = "Repeat last - ON"
        return {"ui": {"next_index": [reported], "total": [total], "status": [status]},
                "result": (pos, neg) if pos else _no_prompts()}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # NaN != NaN -> ComfyUI re-executes on every Queue. Guarantees the file
        # is re-read live and onExecuted advances the cursor; avoids a cache-trap
        # when the index returns to a previously used value (reset to 0).
        return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, wildcard_file, **kwargs):
        # Combo options are populated dynamically in JS; only '(none)' is declared.
        # Without this, the server would reject '[e2go] x.txt' as "not in list".
        return True


def _no_prompts():
    """Outputs for "nothing to run" (end of list, unreadable file).

    An empty list crashes the first non-list consumer inside ComfyUI
    (IndexError on v[-1]); a blocker stops everything downstream quietly,
    which is what the no-op means.
    """
    try:
        from comfy_execution.graph_utils import ExecutionBlocker  # lazy: not available outside ComfyUI
    except ImportError:
        return ([], [])
    return (ExecutionBlocker(None), ExecutionBlocker(None))


NODE_CLASS_MAPPINGS = {
    "PowderPromptWildcard": PowderPromptWildcard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderPromptWildcard": "Powder Prompt Wildcard",
}
