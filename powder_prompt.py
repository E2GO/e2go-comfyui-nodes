"""
PowderPromptList - Dynamic prompt list with configurable slots.
"""

import json

from ._log import log, info, warn


class PowderPromptList:
    """Prompt list with dynamic slots and inputs."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_config": ("STRING", {"default": "[]"}),
            },
            "optional": {
                **{f"prompt_{i}_text": ("STRING", {"default": "", "multiline": True}) for i in range(1, 21)},
                **{f"negative_{i}_text": ("STRING", {"default": "", "multiline": True}) for i in range(1, 21)},
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompts", "negative_prompts")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "get_prompts"
    CATEGORY = "e2go"

    def get_prompts(self, prompt_config, **kwargs):
        log("[PowderPrompt] === START ===")  # debug-only

        config = []
        try:
            parsed = json.loads(prompt_config) if prompt_config else []
            if isinstance(parsed, list):
                # Slot positions address prompt_N_text / negative_N_text.
                # Removing a malformed entry would enable the wrong prompt
                # (including one whose own slot is disabled).
                config = parsed
            else:
                warn(f"Invalid config type: {type(parsed)}, expected list")
                config = []
        except json.JSONDecodeError as e:
            warn(f"JSON parse error: {e}")
            config = []
        except Exception as e:
            warn(f"Config error: {e}")
            config = []

        positive_prompts = []
        negative_prompts = []
        # Clamp to the 20 slots actually declared in INPUT_TYPES
        # (prompt_1_text..prompt_20_text / negative_1_text..negative_20_text).
        num_slots = min(len(config), 20)

        for i in range(num_slots):
            item = config[i]
            if not isinstance(item, dict):
                warn(f"Invalid prompt slot #{i + 1}: expected object; skipped")
                continue
            enabled = item.get("on", True)

            if not enabled:
                log(f"[PowderPrompt] Slot #{i+1}: disabled")
                continue

            # Positive prompt
            text_key = f"prompt_{i+1}_text"
            text = kwargs.get(text_key, "")

            # Defense-in-depth: filter stray bool values that can leak from
            # ComfyUI toggle widgets sharing the same slot names (the actual
            # leak vector is a non-str widget value, not literal text).
            # The root cause is in the JS side, but we guard here as well.
            if text and isinstance(text, str):
                text = text.strip()
            else:
                text = ""

            # Negative prompt
            neg_key = f"negative_{i+1}_text"
            neg_text = kwargs.get(neg_key, "")

            if neg_text and isinstance(neg_text, str):
                neg_text = neg_text.strip()
            else:
                neg_text = ""

            positive_prompts.append(text)
            negative_prompts.append(neg_text)

            log(f"[PowderPrompt] Slot #{i+1}: {text[:50]}..." if text else f"[PowderPrompt] Slot #{i+1}: empty prompt")

        if not positive_prompts:
            positive_prompts = [""]
            negative_prompts = [""]
            log("[PowderPrompt] No enabled slots, returning single empty prompt")

        log(f"[PowderPrompt] Returning {len(positive_prompts)} positive, {len(negative_prompts)} negative prompts")
        log("[PowderPrompt] === END ===")

        non_empty = sum(1 for p in positive_prompts if p)
        if non_empty > 0:
            info(f"[PowderPrompt] {len(positive_prompts)} prompt{'s' if len(positive_prompts) != 1 else ''}, {non_empty} non-empty")

        return (positive_prompts, negative_prompts)


NODE_CLASS_MAPPINGS = {
    "PowderPromptList": PowderPromptList,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderPromptList": "Powder Prompt List",
}
