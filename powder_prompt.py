"""
PowderPromptList - Dynamic prompt list with configurable slots.
"""

import json

from ._log import log, warn


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
    CATEGORY = "e2go_nodes"

    def get_prompts(self, prompt_config, **kwargs):
        log("[PowderPrompt] === START ===")

        config = []
        try:
            parsed = json.loads(prompt_config) if prompt_config else []
            if isinstance(parsed, list):
                config = [item for item in parsed if isinstance(item, dict)]
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
        num_slots = len(config)

        for i in range(num_slots):
            item = config[i]
            enabled = item.get("on", True)

            if not enabled:
                log(f"[PowderPrompt] Slot #{i+1}: disabled")
                continue

            # Positive prompt
            text_key = f"prompt_{i+1}_text"
            text = kwargs.get(text_key, "")

            # Defense-in-depth: filter stray "true"/"false" values that can
            # leak from ComfyUI toggle widgets sharing the same slot names.
            # The root cause is in the JS side, but we guard here as well.
            if text and isinstance(text, str):
                text = text.strip()
                if text.lower() in ("true", "false"):
                    text = ""
            else:
                text = ""

            # Negative prompt
            neg_key = f"negative_{i+1}_text"
            neg_text = kwargs.get(neg_key, "")

            if neg_text and isinstance(neg_text, str):
                neg_text = neg_text.strip()
                if neg_text.lower() in ("true", "false"):
                    neg_text = ""
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

        return (positive_prompts, negative_prompts)


NODE_CLASS_MAPPINGS = {
    "PowderPromptList": PowderPromptList,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderPromptList": "Powder Prompt List",
}
