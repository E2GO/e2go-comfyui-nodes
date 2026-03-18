"""
PowderStyler - Dynamic style applicator with tag deduplication.

Loads styles from bundled JSON files (prefix/suffix/negative format).
Outputs style parts separately for flexible prompt assembly.
"""

import json

from ._log import log, warn
from ._styles import load_styles_from_directory, get_styles_dir, deduplicate_tags


_ALL_STYLES: list = []
_STYLES_BY_NAME: dict = {}


def _ensure_styles_loaded():
    global _ALL_STYLES, _STYLES_BY_NAME
    if not _ALL_STYLES:
        _ALL_STYLES = load_styles_from_directory(get_styles_dir())
        _STYLES_BY_NAME = {s["name"]: s for s in _ALL_STYLES}


def _join_non_empty(*parts: str) -> str:
    return ", ".join(p for p in parts if p)


class PowderStyler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "style_position": (["Wrap prompt", "Before prompt", "After prompt"],),
                "use_positive": ("BOOLEAN", {"default": True}),
                "use_negative": ("BOOLEAN", {"default": True}),
                "style_config": ("STRING", {"default": "[]"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("style", "style_text")
    FUNCTION = "apply_styles"
    CATEGORY = "e2go_nodes"

    def apply_styles(self, style_position, use_positive, use_negative, style_config):
        _ensure_styles_loaded()

        config = []
        try:
            parsed = json.loads(style_config) if style_config else []
            if isinstance(parsed, list):
                config = [item for item in parsed if isinstance(item, dict)]
        except (json.JSONDecodeError, Exception) as e:
            warn(f"Style config error: {e}")

        all_prefixes = []
        all_suffixes = []
        all_negatives = []

        for item in config:
            name = item.get("name", "None")
            enabled = item.get("on", True)
            slot_use_positive = item.get("use_positive", True)
            slot_use_negative = item.get("use_negative", True)

            if not enabled or name == "None":
                continue

            style = _STYLES_BY_NAME.get(name)
            if not style:
                warn(f"Style not found: {name}")
                continue

            if use_positive and slot_use_positive:
                if style["prefix"]:
                    all_prefixes.append(style["prefix"])
                if style["suffix"]:
                    all_suffixes.append(style["suffix"])

            if use_negative and slot_use_negative and style["negative"]:
                all_negatives.append(style["negative"])

        prefix = deduplicate_tags(", ".join(all_prefixes))
        suffix = deduplicate_tags(", ".join(all_suffixes))
        negative = deduplicate_tags(", ".join(all_negatives))
        combined = _join_non_empty(prefix, suffix)

        pos_map = {"Before prompt": "before", "After prompt": "after"}
        position = pos_map.get(style_position, "wrap")

        style_info = json.dumps({
            "prefix": prefix,
            "suffix": suffix,
            "negative": negative,
            "position": position,
        })

        log(f"[PowderStyler] {len(config)} styles -> prefix={len(prefix)}ch, suffix={len(suffix)}ch, neg={len(negative)}ch")

        return (style_info, combined)


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/powder_styler/get_styles")
    async def get_styles_api(request):
        _ensure_styles_loaded()
        names = [s["name"] for s in _ALL_STYLES]
        return web.json_response({"styles": names})
except Exception:
    pass


NODE_CLASS_MAPPINGS = {
    "PowderStyler": PowderStyler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderStyler": "Powder Styler",
}
