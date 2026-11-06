"""
PowderLoraLoader - Optimised LoRA loader with batch processing.

Optimisations:
1. LRU caching of loaded LoRA files
2. disable_clip mode: passes clip=None to skip CLIP weights entirely
3. Separate outputs for prompt and trigger (Conditioner combines them)
"""

import hashlib
import json
import os

from ._log import log, info, warn, error
from ._cache import LRUCache


# ---------------------------------------------------------------------------
# lora_info schema (shared contract between Lora Loader and Conditioner)
# ---------------------------------------------------------------------------
LORA_INFO_SCHEMA_VERSION = 2

# Stack mode example:
# {
#   "schema_version": 2,
#   "loras": ["lora_a + lora_b"],
#   "strengths": [1.0],
#   "triggers": ["trigA, trigB", "trigA, trigB", ...],   # length == N_prompts
#   "combination_order": "Loras first" | "Prompts first",
#   "mode": "stack",
#   "original_loras": ["lora_a", "lora_b"],
#   "original_strengths": [0.8, 1.0],
#   "trigger_position": "before" | "after",
# }
#
# Single mode example:
# {
#   "schema_version": 2,
#   "loras": ["lora_a", "lora_b"],
#   "strengths": [0.8, 1.0],
#   "triggers": [<one per output combination>],   # length == N_loras × N_prompts
#   "combination_order": "Loras first" | "Prompts first",
#   "mode": "single",
#   "trigger_position": "before" | "after",
# }
#
# In both modes, triggers[i] must align with the i-th output prompt of the
# Conditioner. Conditioner does not need to know about Stack vs Single — it
# just zips triggers and prompts.


def get_trigger_path(lora_name):
    """Path to the trigger .txt file next to the LoRA."""
    import folder_paths  # lazy: not available outside ComfyUI
    lora_path = folder_paths.get_full_path("loras", lora_name)
    if lora_path:
        return os.path.splitext(lora_path)[0] + ".txt"
    return None


def load_trigger(lora_name):
    """Load trigger text from file."""
    trigger_path = get_trigger_path(lora_name)
    if trigger_path and os.path.exists(trigger_path):
        try:
            with open(trigger_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception as e:
            warn(f"Error loading trigger: {e}")
    return ""


def save_trigger(lora_name, trigger):
    """Save trigger to file next to the LoRA, only if content differs."""
    if not trigger.strip():
        return

    trigger_path = get_trigger_path(lora_name)
    if not trigger_path:
        return

    # Check existing content to avoid unnecessary writes
    new_content = trigger.strip()
    if os.path.exists(trigger_path):
        try:
            with open(trigger_path, "r", encoding="utf-8") as f:
                if f.read().strip() == new_content:
                    return
        except Exception:
            pass

    try:
        with open(trigger_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        log(f"Saved trigger: {trigger_path}")
    except Exception as e:
        warn(f"Error saving trigger: {e}")


def _lora_entries(names):
    """
    Pure helper: map a flat list of lora filenames (as returned by
    folder_paths.get_filename_list) to [{"name", "category"}] entries.

    Category = first path segment when the name contains a separator
    ("/" or "\\"), else "Root". Input order is preserved (the caller,
    folder_paths, already sorts).
    """
    entries = []
    for name in names:
        split_idx = None
        for sep in ("/", "\\"):
            idx = name.find(sep)
            if idx != -1 and (split_idx is None or idx < split_idx):
                split_idx = idx
        category = name[:split_idx] if split_idx is not None else "Root"
        entries.append({"name": name, "category": category})
    return entries


# Register API route (wrapped in try/except for environments without PromptServer)
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/powder_lora/get_trigger")
    async def get_trigger_api(request):
        lora_name = request.query.get("lora", "")
        if not lora_name:
            return web.json_response({"trigger": ""})
        try:
            trigger = load_trigger(lora_name)
        except ValueError:  # relpath across drives for an absolute name
            trigger = ""
        return web.json_response({"trigger": trigger})

    @PromptServer.instance.routes.get("/powder_lora/get_loras")
    async def get_loras_api(request):
        import folder_paths
        names = folder_paths.get_filename_list("loras")
        return web.json_response({"loras": _lora_entries(names)})
except Exception:
    pass


# ---------------------------------------------------------------------------
# LoRA cache
# ---------------------------------------------------------------------------
_lora_cache = LRUCache(maxsize=16, ttl_seconds=1800, max_bytes=2 * 1024**3)  # 30 min TTL on raw safetensors


def _lora_fp(entries, combination_order, disable_clip):
    """Deterministic fingerprint of the CLIP-side LoRA patches applied to a
    CLIP object: (lora names + clip strengths + order + disable_clip).

    *entries* is a list of (basename_without_ext, clip_strength) tuples in
    application order. Stamped on the CLIP as `_e2go_lora_fp` so the
    Conditioner's cache key can tell a LoRA-patched CLIP apart from the base
    CLIP (and from a differently-configured LoRA patch on the same base).
    """
    parts = [f"{name}@{strength:.4g}" for name, strength in entries]
    blob = "|".join(parts) + f"|order={combination_order}|disable_clip={bool(disable_clip)}"
    digest = hashlib.md5(blob.encode("utf-8")).hexdigest()[:12]
    return f"{','.join(parts)}#{digest}"


def _coerce_bool_combo(value, true_label, false_label):
    """ComfyUI new frontend converts 2-option combos to boolean toggles; map back to labels."""
    if isinstance(value, bool) or value in ("True", "False", "true", "false"):
        return true_label if str(value).lower() == "true" else false_label
    return value


def _get_lora_cache_key(lora_path):
    """Cache key based on path + mtime."""
    try:
        mtime = os.path.getmtime(lora_path)
        return f"{lora_path}:{mtime}"
    except Exception:
        return lora_path


def _load_lora_cached(lora_path):
    """Load LoRA with LRU caching."""
    import comfy.utils  # lazy
    cache_key = _get_lora_cache_key(lora_path)

    cached = _lora_cache.get(cache_key)
    if cached is not None:
        log(f"Cache hit: {os.path.basename(lora_path)}")
        return cached

    lora_data = comfy.utils.load_torch_file(lora_path, safe_load=True)
    _lora_cache.put(cache_key, lora_data)
    return lora_data


class PowderLoraLoader:
    """
    Optimised LoRA loader.

    Modes:
    - Stack: all LoRAs combined into a single model
    - Single: each LoRA separate (for style comparison)

    disable_clip: passes clip=None to load_lora_for_models, skipping CLIP
    weights entirely for faster testing.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "mode": (["Stack (all enabled)", "Single"],),
                "combination_order": (["Loras first", "Prompts first"],),
                "lora_config": ("STRING", {"default": "[]"}),
                "disable_clip": ("BOOLEAN", {"default": True}),
                "trigger_position": (["After prompt", "Before prompt"],),
            },
            "optional": {
                "prompt": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "prompt", "negative_prompt", "lora_info")
    OUTPUT_IS_LIST = (True, True, True, True, False)
    FUNCTION = "load_loras"
    CATEGORY = "e2go"

    @classmethod
    def VALIDATE_INPUTS(cls, mode, combination_order, trigger_position, **kwargs):
        """Accept boolean values from new ComfyUI frontend for 2-option combos."""
        return True

    def load_loras(self, model, clip, mode, combination_order, lora_config, disable_clip, trigger_position, prompt=None, negative_prompt=None):
        # Unpack scalars
        model = model[0] if isinstance(model, list) else model
        clip = clip[0] if isinstance(clip, list) else clip
        mode = mode[0] if isinstance(mode, list) else mode
        combination_order = combination_order[0] if isinstance(combination_order, list) else combination_order

        # ComfyUI new frontend converts 2-option combos to boolean toggles
        mode = _coerce_bool_combo(mode, "Stack (all enabled)", "Single")
        combination_order = _coerce_bool_combo(combination_order, "Loras first", "Prompts first")
        lora_config = lora_config[0] if isinstance(lora_config, list) else lora_config
        disable_clip = disable_clip[0] if isinstance(disable_clip, list) else disable_clip
        trigger_position = trigger_position[0] if isinstance(trigger_position, list) else trigger_position

        # ComfyUI new frontend converts 2-option combos to boolean toggles
        trigger_position = _coerce_bool_combo(trigger_position, "Before prompt", "After prompt")

        if prompt is None:
            prompts_input = [""]
        elif isinstance(prompt, list):
            prompts_input = prompt if prompt else [""]
        else:
            prompts_input = [prompt]

        if negative_prompt is None:
            negatives_input = [""] * len(prompts_input)
        elif isinstance(negative_prompt, list):
            negatives_input = list(negative_prompt) if negative_prompt else [""] * len(prompts_input)
        else:
            negatives_input = [negative_prompt]

        while len(negatives_input) < len(prompts_input):
            negatives_input.append(negatives_input[-1] if negatives_input else "")

        log(f"[PowderLora] === START ===")
        log(f"[PowderLora] Mode: {mode}, Order: {combination_order}")
        log(f"[PowderLora] Disable CLIP: {disable_clip} {'(clip=None)' if disable_clip else ''}")
        log(f"[PowderLora] Input prompts: {len(prompts_input)}, negatives: {len(negatives_input)}")

        # Parse config
        config = []
        try:
            parsed = json.loads(lora_config) if lora_config else []
            if isinstance(parsed, dict):
                config = parsed.get("loras", [])
            elif isinstance(parsed, list):
                config = parsed
            else:
                warn(f"Invalid config type: {type(parsed)}, expected list or dict")
                config = []
            config = [item for item in config if isinstance(item, dict)]
        except json.JSONDecodeError as e:
            warn(f"JSON parse error: {e}")
            config = []
        except Exception as e:
            warn(f"Config error: {e}")
            config = []

        # Filter valid LoRAs
        valid_loras = []
        for i, item in enumerate(config):
            name = item.get("name", "None")
            enabled = item.get("on", True)
            if name and name != "None" and enabled:
                valid_loras.append((i, item))

        lora_count = len(valid_loras)
        log(f"[PowderLora] Valid loras: {lora_count}")

        if mode == "Single" and lora_count > 0:
            return self._process_single_mode(
                model, clip, valid_loras, prompts_input, negatives_input, combination_order, disable_clip, trigger_position
            )
        else:
            return self._process_stack_mode(
                model, clip, valid_loras, prompts_input, negatives_input, combination_order, disable_clip, trigger_position
            )

    def _load_lora_step(self, item, current_model, current_clip, disable_clip):
        """Load one enabled LoRA and return patched model/CLIP, strengths and trigger metadata. Missing or unreadable enabled files raise an error."""
        import comfy.sd  # lazy

        name = item.get("name")
        str_model = float(item.get("strength_model", 1.0))
        str_clip = float(item.get("strength_clip", 1.0))
        trigger = item.get("trigger", "").strip()
        use_trigger = item.get("use_trigger", True)

        lora_path = self._find_lora_path(name)
        if not lora_path:
            raise FileNotFoundError(f"Enabled LoRA not found: {name}")

        log(f"[PowderLora] Loading: {name} (m={str_model}, c={str_clip}{'*' if disable_clip else ''})")

        lora_data = _load_lora_cached(lora_path)
        if disable_clip:
            # Pass clip=None to skip CLIP weights entirely
            model_lora, _ = comfy.sd.load_lora_for_models(
                current_model, None,
                lora_data, str_model, 0.0
            )
            clip_lora = current_clip
        else:
            model_lora, clip_lora = comfy.sd.load_lora_for_models(
                current_model, current_clip,
                lora_data, str_model, str_clip
            )

        return (model_lora, clip_lora, name, str_model, str_clip, trigger, use_trigger)

    def _process_single_mode(self, model, clip, valid_loras, prompts_input, negatives_input, combination_order, disable_clip, trigger_position):
        """Single mode: each LoRA separate."""
        unique_models = []

        for idx, (orig_idx, item) in enumerate(valid_loras):
            name = item.get("name")
            try:
                step = self._load_lora_step(item, model, clip, disable_clip)
                model_lora, clip_lora, name, str_model, str_clip, trigger, use_trigger = step

                if not disable_clip:
                    base_name = os.path.basename(name).replace(".safetensors", "")
                    try:
                        clip_lora._e2go_lora_fp = _lora_fp(
                            [(base_name, str_clip)], combination_order, disable_clip
                        )
                    except Exception:
                        pass

                actual_trigger = trigger if use_trigger else ""
                unique_models.append((model_lora, clip_lora, actual_trigger, name, str_model))
                log(f"[PowderLora] OK: {name}")
            except Exception as e:
                raise RuntimeError(
                    f"Powder LoRA: could not load enabled LoRA '{name}'. "
                    f"Generation stopped instead of continuing without it. {e}") from e

        if not unique_models:
            log("[PowderLora] No loras loaded, returning original model")
            lora_info = json.dumps({
                "schema_version": LORA_INFO_SCHEMA_VERSION,
                "loras": [],
                "strengths": [],
                "triggers": [""] * len(prompts_input),
                "combination_order": combination_order,
                "mode": "single",
                "trigger_position": "before" if "Before" in trigger_position else "after",
            })
            return ([model], [clip], prompts_input, negatives_input, lora_info)

        # Build combinations
        models = []
        clips = []
        prompts = []
        triggers = []
        negative_prompts = []

        lora_names = [os.path.basename(name).replace(".safetensors", "") for _, _, _, name, _ in unique_models]
        lora_strengths = [strength for _, _, _, _, strength in unique_models]

        if combination_order == "Loras first":
            for model_lora, clip_lora, trigger, name, strength in unique_models:
                for i, p in enumerate(prompts_input):
                    models.append(model_lora)
                    clips.append(clip_lora)
                    prompts.append(p)
                    triggers.append(trigger)
                    negative_prompts.append(negatives_input[i] if i < len(negatives_input) else "")
        else:
            for i, p in enumerate(prompts_input):
                for model_lora, clip_lora, trigger, name, strength in unique_models:
                    models.append(model_lora)
                    clips.append(clip_lora)
                    prompts.append(p)
                    triggers.append(trigger)
                    negative_prompts.append(negatives_input[i] if i < len(negatives_input) else "")

        log(f"[PowderLora] Returning {len(models)} combinations ({len(unique_models)} loras × {len(prompts_input)} prompts)")
        log(f"[PowderLora] === END ===")
        info(f"[PowderLora] Single: {len(unique_models)} LoRA × {len(prompts_input)} prompt{'s' if len(prompts_input) != 1 else ''} = {len(models)} combinations")

        lora_info = json.dumps({
            "schema_version": LORA_INFO_SCHEMA_VERSION,
            "loras": lora_names,
            "strengths": lora_strengths,
            "triggers": triggers,
            "combination_order": combination_order,
            "mode": "single",
            "trigger_position": "before" if "Before" in trigger_position else "after",
        })
        return (models, clips, prompts, negative_prompts, lora_info)

    def _process_stack_mode(self, model, clip, valid_loras, prompts_input, negatives_input, combination_order, disable_clip, trigger_position):
        """Stack mode: all LoRAs into one model."""
        triggers = []
        lora_names = []
        lora_strengths = []
        current_model = model
        current_clip = clip
        clip_fp_entries = []  # (basename, clip_strength) applied so far, in order

        for orig_idx, item in valid_loras:
            name = item.get("name")
            try:
                step = self._load_lora_step(item, current_model, current_clip, disable_clip)
                model_lora, clip_lora, name, str_model, str_clip, trigger, use_trigger = step
                current_model, current_clip = model_lora, clip_lora
                base_name = os.path.basename(name).replace(".safetensors", "")
                lora_names.append(base_name)
                lora_strengths.append(str_model)

                if not disable_clip:
                    clip_fp_entries.append((base_name, str_clip))
                    try:
                        current_clip._e2go_lora_fp = _lora_fp(
                            clip_fp_entries, combination_order, disable_clip
                        )
                    except Exception:
                        pass

                log(f"[PowderLora] OK: {name}")
            except Exception as e:
                raise RuntimeError(
                    f"Powder LoRA: could not load enabled LoRA '{name}'. "
                    f"Generation stopped instead of continuing without it. {e}") from e

            if trigger:
                if use_trigger:
                    triggers.append(trigger)

        trigger_string = ", ".join(triggers)
        prompts_out = prompts_input[:]
        triggers_out = [trigger_string] * len(prompts_input)
        negative_prompts_out = negatives_input[:]

        log(f"[PowderLora] Stack: all {len(lora_names)} loras × {len(prompts_input)} prompts")
        log(f"[PowderLora] === END ===")
        info(f"[PowderLora] Stack: {len(lora_names)} LoRA × {len(prompts_input)} prompt{'s' if len(prompts_input) != 1 else ''}")

        combined_lora_name = " + ".join(lora_names) if lora_names else "No LoRA"

        lora_info = json.dumps({
            "schema_version": LORA_INFO_SCHEMA_VERSION,
            "loras": [combined_lora_name],
            "strengths": [1.0],
            "triggers": triggers_out,
            "combination_order": combination_order,
            "mode": "stack",
            "original_loras": lora_names,
            "original_strengths": lora_strengths,
            "trigger_position": "before" if "Before" in trigger_position else "after",
        })

        return ([current_model] * len(prompts_out), [current_clip] * len(prompts_out),
                prompts_out, negative_prompts_out, lora_info)

    def _find_lora_path(self, name):
        import folder_paths  # lazy
        path = folder_paths.get_full_path("loras", name)
        if path:
            return path

        all_loras = folder_paths.get_filename_list("loras")
        variants = [name, name.replace("\\", "/"), name.replace("/", "\\")]

        for variant in variants:
            if variant in all_loras:
                return folder_paths.get_full_path("loras", variant)

        basename = os.path.basename(name)
        for lora in all_loras:
            if os.path.basename(lora) == basename:
                # Two same-named files in different subfolders would both
                # match — say which one won so a wrong substitution is
                # diagnosable instead of silent.
                warn(f"[PowderLoraLoader] {name!r} not found; substituting "
                     f"first basename match {lora!r} — rename to "
                     f"disambiguate if wrong")
                return folder_paths.get_full_path("loras", lora)

        return None


NODE_CLASS_MAPPINGS = {
    "PowderLoraLoader": PowderLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderLoraLoader": "Powder Lora Loader",
}
