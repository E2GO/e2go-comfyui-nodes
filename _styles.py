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

from ._log import log, warn


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

    for fname in sorted(os.listdir(styles_dir)):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(styles_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            warn(f"Error loading {fname}: {e}")
            continue

        if not isinstance(data, list):
            warn(f"Skipping {fname}: expected list, got {type(data)}")
            continue

        for item in data:
            if not isinstance(item, dict) or "name" not in item:
                continue
            style = normalize_style(item)
            # Deduplicate names
            base_name = style["name"]
            if base_name in seen_names:
                counter = 2
                while f"{base_name} ({counter})" in seen_names:
                    counter += 1
                style["name"] = f"{base_name} ({counter})"
            seen_names.add(style["name"])
            all_styles.append(style)

    log(f"Loaded {len(all_styles)} styles from {styles_dir}")
    return all_styles


def get_styles_dir() -> str:
    """Return path to the styles directory bundled with e2go_nodes."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "styles")
