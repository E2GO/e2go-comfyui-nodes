"""
PowderLoraLoader - Optimised LoRA loader with batch processing.

Optimisations:
1. LRU caching of loaded LoRA files
2. disable_clip mode: passes clip=None to skip CLIP weights entirely
3. Separate outputs for prompt and trigger (Conditioner combines them)
"""

import comfy.sd
import comfy.utils
import comfy.model_management
import folder_paths
import json
import os

from ._log import log, warn, error
from ._cache import LRUCache


def get_trigger_path(lora_name):
    """Path to the trigger .txt file next to the LoRA."""
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


# Register API route (wrapped in try/except for environments without PromptServer)
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/powder_lora/get_trigger")
    async def get_trigger_api(request):
        lora_name = request.query.get("lora", "")
        if not lora_name:
            return web.json_response({"trigger": ""})
        trigger = load_trigger(lora_name)
        return web.json_response({"trigger": trigger})
except Exception:
    pass


# ---------------------------------------------------------------------------
# LoRA cache
# ---------------------------------------------------------------------------
_lora_cache = LRUCache(maxsize=16)


def _get_lora_cache_key(lora_path):
    """Cache key based on path + mtime."""
    try:
        mtime = os.path.getmtime(lora_path)
        return f"{lora_path}:{mtime}"
    except Exception:
        return lora_path


def _load_lora_cached(lora_path):
    """Load LoRA with LRU caching."""
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
    CATEGORY = "e2go_nodes"

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
        if isinstance(mode, bool) or mode in ("True", "False", "true", "false"):
            mode = "Stack (all enabled)" if str(mode).lower() == "true" else "Single"
        if isinstance(combination_order, bool) or combination_order in ("True", "False", "true", "false"):
            combination_order = "Loras first" if str(combination_order).lower() == "true" else "Prompts first"
        lora_config = lora_config[0] if isinstance(lora_config, list) else lora_config
        disable_clip = disable_clip[0] if isinstance(disable_clip, list) else disable_clip
        trigger_position = trigger_position[0] if isinstance(trigger_position, list) else trigger_position

        # ComfyUI new frontend converts 2-option combos to boolean toggles
        if isinstance(trigger_position, bool) or trigger_position in ("True", "False", "true", "false"):
            trigger_position = "Before prompt" if str(trigger_position).lower() == "true" else "After prompt"

        if prompt is None:
            prompts_input = [""]
        elif isinstance(prompt, list):
            prompts_input = prompt if prompt else [""]
        else:
            prompts_input = [prompt]

        if negative_prompt is None:
            negatives_input = [""] * len(prompts_input)
        elif isinstance(negative_prompt, list):
            negatives_input = negative_prompt if negative_prompt else [""] * len(prompts_input)
        else:
            negatives_input = [negative_prompt]

        while len(negatives_input) < len(prompts_input):
            negatives_input.append("")

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

    def _process_single_mode(self, model, clip, valid_loras, prompts_input, negatives_input, combination_order, disable_clip, trigger_position):
        """Single mode: each LoRA separate."""
        unique_models = []
        base_clip = clip

        for idx, (orig_idx, item) in enumerate(valid_loras):
            name = item.get("name")
            str_model = float(item.get("strength_model", 1.0))
            str_clip = float(item.get("strength_clip", 1.0))
            trigger = item.get("trigger", "").strip()
            use_trigger = item.get("use_trigger", True)

            lora_path = self._find_lora_path(name)
            if not lora_path:
                warn(f"NOT FOUND: {name}")
                continue

            log(f"[PowderLora] Loading: {name} (m={str_model}, c={str_clip}{'*' if disable_clip else ''})")
            try:
                lora_data = _load_lora_cached(lora_path)

                if disable_clip:
                    # Pass clip=None to skip CLIP weights entirely
                    model_lora, _ = comfy.sd.load_lora_for_models(
                        model, None,
                        lora_data, str_model, 0.0
                    )
                    clip_lora = base_clip
                else:
                    model_lora, clip_lora = comfy.sd.load_lora_for_models(
                        model, clip,
                        lora_data, str_model, str_clip
                    )

                if trigger:
                    save_trigger(name, trigger)

                actual_trigger = trigger if use_trigger else ""
                unique_models.append((model_lora, clip_lora, actual_trigger, name, str_model))
                log(f"[PowderLora] OK: {name}")
            except Exception as e:
                error(f"Loading {name}: {e}")
                continue

        if not unique_models:
            log("[PowderLora] No loras loaded, returning original model")
            lora_info = json.dumps({"loras": [], "strengths": [], "triggers": [""] * len(prompts_input), "combination_order": combination_order, "mode": "single", "trigger_position": "before" if "Before" in trigger_position else "after"})
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

        lora_info = json.dumps({
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

        for orig_idx, item in valid_loras:
            name = item.get("name")
            str_model = float(item.get("strength_model", 1.0))
            str_clip = float(item.get("strength_clip", 1.0))
            trigger = item.get("trigger", "").strip()
            use_trigger = item.get("use_trigger", True)

            lora_path = self._find_lora_path(name)
            if not lora_path:
                warn(f"NOT FOUND: {name}")
                continue

            log(f"[PowderLora] Loading: {name} (m={str_model}, c={str_clip}{'*' if disable_clip else ''})")
            try:
                lora_data = _load_lora_cached(lora_path)
                if disable_clip:
                    current_model, _ = comfy.sd.load_lora_for_models(
                        current_model, None, lora_data, str_model, 0.0
                    )
                else:
                    current_model, current_clip = comfy.sd.load_lora_for_models(
                        current_model, current_clip, lora_data, str_model, str_clip
                    )
                lora_names.append(os.path.basename(name).replace(".safetensors", ""))
                lora_strengths.append(str_model)
                log(f"[PowderLora] OK: {name}")
            except Exception as e:
                error(f"Loading {name}: {e}")
                continue

            if trigger:
                save_trigger(name, trigger)
                if use_trigger:
                    triggers.append(trigger)

        trigger_string = ", ".join(triggers)
        prompts_out = prompts_input[:]
        triggers_out = [trigger_string] * len(prompts_input)
        negative_prompts_out = negatives_input[:]

        log(f"[PowderLora] Stack: all {len(lora_names)} loras × {len(prompts_input)} prompts")
        log(f"[PowderLora] === END ===")

        combined_lora_name = " + ".join(lora_names) if lora_names else "No LoRA"

        lora_info = json.dumps({
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
                return folder_paths.get_full_path("loras", lora)

        return None


NODE_CLASS_MAPPINGS = {
    "PowderLoraLoader": PowderLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderLoraLoader": "Powder Lora Loader",
}
