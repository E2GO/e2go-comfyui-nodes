"""
PowderPromptWildcard - batch prompts from multi-line text or a wildcard file.

One line = one prompt. Empty lines and lines starting with '#' are skipped.
Negative prompt is a single global value replicated to match positive count.
"""

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


class WildcardLibrary:
    """Scan / read / write .txt wildcard files in two known bases."""

    _NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.txt$")
    _MAX_NAME = 128
    _MAX_FILE_BYTES = 1_048_576  # 1 MiB
    _SOURCES = ("e2go", "comfy")

    @classmethod
    def _bases(cls):
        """Resolve scan bases lazily. Returns [(source, Path), ...]."""
        bases = []
        pkg_dir = Path(__file__).resolve().parent
        bases.append(("e2go", pkg_dir / "wildcards"))
        try:
            import folder_paths  # type: ignore
            comfy_base = Path(folder_paths.base_path) / "wildcards"
            bases.append(("comfy", comfy_base))
        except Exception:
            pass
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
    def _validate_name(cls, name):
        if not isinstance(name, str) or not name:
            raise ValueError("name must be a non-empty string")
        if len(name) > cls._MAX_NAME:
            raise ValueError(f"name too long (>{cls._MAX_NAME})")
        if not cls._NAME_RE.match(name):
            raise ValueError("name must match [A-Za-z0-9._-]+\\.txt")
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
        return target.read_text(encoding="utf-8", errors="replace")

    @classmethod
    def upload(cls, name, content):
        cls._validate_name(name)
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


class PowderPromptWildcard:
    """Batch prompts from multi-line text. One line = one prompt."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive_text": ("STRING", {"default": "", "multiline": True}),
                "negative_text": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "prefix_text": ("STRING", {"default": "", "multiline": True}),
                "suffix_text": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompts", "negative_prompts")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "get_prompts"
    CATEGORY = "e2go_nodes"

    def get_prompts(self, positive_text, negative_text, prefix_text="", suffix_text=""):
        lines = _parse_wildcard_lines(positive_text)
        neg = (negative_text or "").strip() if isinstance(negative_text, str) else ""
        prefix = (prefix_text or "").strip() if isinstance(prefix_text, str) else ""
        suffix = (suffix_text or "").strip() if isinstance(suffix_text, str) else ""

        if not lines:
            # No wildcard lines. If a base exists, emit one entry with just the base.
            if prefix or suffix:
                composed = _compose_with_base(prefix, "", suffix)
                info(f"[PowderPromptWildcard] 0 wildcard lines, 1 base-only prompt")
                return ([composed], [neg])
            info("[PowderPromptWildcard] 0 prompts (empty input)")
            return ([""], [""])

        composed = [_compose_with_base(prefix, line, suffix) for line in lines]
        base_note = ""
        if prefix and suffix:
            base_note = ", prefix+suffix"
        elif prefix:
            base_note = ", prefix"
        elif suffix:
            base_note = ", suffix"
        info(f"[PowderPromptWildcard] {len(composed)} prompts, negative {'set' if neg else 'empty'}{base_note}")
        return (composed, [neg] * len(composed))


NODE_CLASS_MAPPINGS = {
    "PowderPromptWildcard": PowderPromptWildcard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderPromptWildcard": "Powder Prompt Wildcard",
}
