"""
PowderStyler - Dynamic style applicator with tag deduplication.

Loads styles from bundled JSON files (prefix/suffix/negative format).
Outputs style parts separately for flexible prompt assembly.
"""

import hashlib
import json

from ._http import is_json_request
from ._log import log, info, warn
from ._styles import get_styles, deduplicate_tags, upsert_user_style, delete_user_style
from ._cursor import CursorStore

_STYLE_CURSOR = CursorStore()


def _join_non_empty(*parts: str) -> str:
    return ", ".join(p for p in parts if p)


def _build_sweep_range(names, from_name, to_name):
    """Ordered style names from from_name to to_name inclusive (library order).

    Reversed when from_name sits later than to_name. Empty list if either
    endpoint is not in `names`.
    """
    try:
        i = names.index(from_name)
        j = names.index(to_name)
    except ValueError:
        return []
    if i <= j:
        return names[i:j + 1]
    return list(reversed(names[j:i + 1]))


class PowderStyler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "style_position": (["Wrap prompt", "Before prompt", "After prompt"],),
                "use_positive": ("BOOLEAN", {"default": True}),
                "use_negative": ("BOOLEAN", {"default": True}),
                "style_config": ("STRING", {"default": "[]"}),
                "strength_mode": (["cond mix — node", "cond mix — per style"],
                    {"default": "cond mix — node",
                     "tooltip": "Style strength is applied at the CONDITIONING level in Powder Conditioner — linear; binary token masks are aligned, unsupported token metadata is rejected. node: one style_mix knob for the whole set (1.0 = plain styled prompt, zero extra cost). per style: each row's ×w is its blend weight (note: at all ×1 the result is close to, not identical to, the plain joint prompt, and costs one extra encode per style)."}),
                "style_mix": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.5, "step": 0.05,
                    "tooltip": "cond mix — node only: 0 = no style, 1 = full style, >1 extrapolates."}),
                "style_sweep": ("BOOLEAN", {"default": False, "label_on": "ON", "label_off": "OFF"}),
                "sweep_from": (["None"],),
                "sweep_to": (["None"],),
            },
            "optional": {
                "cursor_scope": ("STRING", {"default": ""}),
                "on_exhausted": (["stop", "loop"], {"default": "stop", "tooltip": "stop: block downstream at the end of the range; loop: restart the range and continue queued generations."}),
                "style_category": (["All styles"], {"tooltip": "Limit style arrows and Style Sweep to this category. All styles uses the entire library."}),
                "repeat_last": ("BOOLEAN", {"default": False, "label_on": "ON", "label_off": "OFF", "tooltip": "Repeat the last selection on every Queue. Turn off to continue. Reset or a changed source starts a new selection."}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("style", "style_text")
    FUNCTION = "apply_styles"
    CATEGORY = "e2go"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # sweep_from / sweep_to combos are populated dynamically in JS.
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Force re-exec each Queue ONLY while sweeping, so the cursor advances.
        if kwargs.get("style_sweep"):
            return float("nan")
        # Otherwise: stable while the style library is untouched, but a style
        # edited on disk / via the CRUD route must invalidate Comfy's exec
        # cache — the node's INPUTS don't change when a style's TEXT does.
        from ._styles import styles_state_token
        return f"styles:{styles_state_token()}"

    def apply_styles(self, style_position, use_positive, use_negative, style_config,
                     strength_mode="cond mix — node", style_mix=1.0,
                     style_sweep=False, sweep_from="None", sweep_to="None",
                     unique_id=None, cursor_scope="", on_exhausted="stop",
                     style_category="All styles", repeat_last=False):
        all_styles, styles_by_name = get_styles()

        config = []
        try:
            parsed = json.loads(style_config) if style_config else []
            if isinstance(parsed, list):
                config = [item for item in parsed if isinstance(item, dict)]
        except Exception as e:
            warn(f"Style config error: {e}")

        # Unknown/legacy values (incl. the removed "token weights") fall back
        # to node mode — at mix 1.0 that is byte-identical to the old plain
        # styled prompt, so pre-removal workflows keep their output.
        mode_key = "per_style" if strength_mode == "cond mix — per style" else "node"
        parts = []  # per_style: [{"prefix", "suffix", "strength"}]

        all_prefixes = []
        all_suffixes = []
        all_negatives = []
        applied_names = []

        for item in config:
            name = item.get("name", "None")
            enabled = item.get("on", True)
            slot_use_positive = item.get("use_positive", True)
            slot_use_negative = item.get("use_negative", True)

            if not enabled or not isinstance(name, str) or name == "None":
                continue

            style = styles_by_name.get(name)
            if not style:
                warn(f"Style not found: {name}")
                continue
            applied_names.append(name)


            try:
                strength = float(item.get("strength", 1.0))
            except (TypeError, ValueError):
                strength = 1.0

            if use_positive and slot_use_positive:


                contributes = True
                if mode_key == "per_style":


                    part_strength = max(0.0, min(1.5, strength))
                    contributes = part_strength >= 1e-3
                    if contributes:
                        part_prefix = deduplicate_tags(style["prefix"]) if style["prefix"] else ""
                        part_suffix = deduplicate_tags(style["suffix"]) if style["suffix"] else ""
                        if part_prefix or part_suffix:
                            parts.append({
                                "prefix": part_prefix,
                                "suffix": part_suffix,
                                "strength": part_strength,
                            })
                        else:
                            contributes = False

                if contributes:
                    if style["prefix"]:
                        all_prefixes.append(style["prefix"])
                    if style["suffix"]:
                        all_suffixes.append(style["suffix"])

            if use_negative and slot_use_negative and style["negative"]:
                all_negatives.append(style["negative"])

        # --- style sweep: append the current style from the range -----------
        sweep_ui = None
        if style_sweep and unique_id is not None:
            names = [s["name"] for s in all_styles
                     if style_category == "All styles" or s.get("category") == style_category]
            rng = _build_sweep_range(names, sweep_from, sweep_to)
            uid = f"{cursor_scope}:{unique_id}" if cursor_scope else str(unique_id)


            rng_digest = hashlib.md5("\x00".join(rng).encode("utf-8")).hexdigest()[:12]
            anchor = f"{style_category}\x00{sweep_from}\x00{sweep_to}\x00{rng_digest}"
            pos = _STYLE_CURSOR.resolve(uid, anchor, 0)
            if repeat_last:
                pos = _STYLE_CURSOR.last_position(uid, anchor, pos)
            if pos >= len(rng) and rng and on_exhausted == "loop":
                pos %= len(rng)
            if not (0 <= pos < len(rng)):
                from .powder_prompt_wildcard import _no_prompts
                return {"ui": {"next_index": [pos], "total": [len(rng)], "status": ["Exhausted - reset to restart"]}, "result": _no_prompts()}
            if 0 <= pos < len(rng):
                swept = styles_by_name.get(rng[pos])
                if swept:
                    applied_names.append(rng[pos])
                    if use_positive:
                        if swept["prefix"]:
                            all_prefixes.append(swept["prefix"])
                        if swept["suffix"]:
                            all_suffixes.append(swept["suffix"])


                        if mode_key == "per_style" and (swept["prefix"] or swept["suffix"]):
                            parts.append({
                                "prefix": deduplicate_tags(swept["prefix"]) if swept["prefix"] else "",
                                "suffix": deduplicate_tags(swept["suffix"]) if swept["suffix"] else "",
                                "strength": 1.0,
                            })
                    if use_negative and swept["negative"]:
                        all_negatives.append(swept["negative"])
                _STYLE_CURSOR.commit(uid, anchor, pos + 1, position=pos)
                reported = pos + 1
            else:
                info(f"[PowderStyler] sweep exhausted ({len(rng)} styles); reset to iterate")
                reported = pos
            status = ("Loop - next Queue restarts the range" if on_exhausted == "loop"
                      else "Exhausted - reset to restart") if reported >= len(rng) else "Ready"
            if repeat_last:
                status = "Repeat last - ON"
            sweep_ui = {"next_index": [reported], "total": [len(rng)], "status": [status]}

        prefix = deduplicate_tags(", ".join(all_prefixes))
        suffix = deduplicate_tags(", ".join(all_suffixes))
        negative = deduplicate_tags(", ".join(all_negatives))
        combined = _join_non_empty(prefix, suffix)

        pos_map = {"Before prompt": "before", "After prompt": "after"}
        position = pos_map.get(style_position, "wrap")

        style_info_dict = {
            "names": applied_names,
            "prefix": prefix,
            "suffix": suffix,
            "negative": negative,
            "position": position,
            "mix_mode": mode_key,
        }
        if mode_key == "node":
            try:
                mix_val = float(style_mix)
            except (TypeError, ValueError):
                mix_val = 1.0
            style_info_dict["mix"] = max(0.0, min(1.5, mix_val))
        elif mode_key == "per_style":
            style_info_dict["parts"] = parts

        style_info = json.dumps(style_info_dict)

        log(f"[PowderStyler] {len(config)} styles -> prefix={len(prefix)}ch, suffix={len(suffix)}ch, neg={len(negative)}ch")

        active_count = sum(1 for item in config if item.get("on", True) and item.get("name", "None") != "None")
        if active_count > 0:
            info(f"[PowderStyler] {active_count} active style{'s' if active_count != 1 else ''}, position={position}")

        if sweep_ui is not None:
            return {"ui": sweep_ui, "result": (style_info, combined)}
        return (style_info, combined)


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/powder_styler/get_styles")
    async def get_styles_api(request):
        all_styles, _ = get_styles()
        return web.json_response({"styles": all_styles})

    @PromptServer.instance.routes.post("/powder_styler/user_style")
    async def user_style_api(request):


        if not is_json_request(request.content_type):
            return web.json_response({"ok": False, "error": "json required"}, status=400)
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
        action = data.get("action")
        try:
            if action in ("add", "update"):
                style = data.get("style") or {}
                name = str(style.get("name") or "").strip()
                if not name:
                    return web.json_response({"ok": False, "error": "name required"}, status=400)
                saved = upsert_user_style(
                    {
                        "name": name,
                        "prefix": str(style.get("prefix") or ""),
                        "suffix": str(style.get("suffix") or ""),
                        "negative": str(style.get("negative") or ""),
                    },
                    original_name=str(data.get("original_name") or "") or None,
                )
                return web.json_response({"ok": True, "style": saved})
            if action == "delete":
                name = str(data.get("name") or "").strip()
                return web.json_response({"ok": delete_user_style(name)})
            return web.json_response({"ok": False, "error": "unknown action"}, status=400)
        except ValueError as e:
            # Validation feedback ("style name required") is user-facing —
            # keep it; only the 500 path below hides internals.
            return web.json_response({"ok": False, "error": str(e)}, status=400)
        except Exception as e:
            warn(f"[PowderStyler] user_style failed: {e!r}")
            return web.json_response({"ok": False, "error": "internal error"}, status=500)
except (ImportError, AttributeError):
    pass  # outside ComfyUI (tests): no `server` module / no PromptServer.instance
except Exception as e:
    # A real registration bug (typo in a handler decorator etc.) must not
    # vanish into a blanket pass.
    warn(f"[PowderStyler] route registration failed: {e!r}")


NODE_CLASS_MAPPINGS = {
    "PowderStyler": PowderStyler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderStyler": "Powder Styler",
}
