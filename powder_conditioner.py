"""
PowderConditioner - Optimised text encoder with caching.

Encodes each (clip, prompt) pair honestly, using the per-index CLIP object
that was passed in.  Results are cached via a thread-safe LRU cache.
"""

import torch
import hashlib
import json
import time

from ._log import log, warn, error
from ._cache import LRUCache

# ---------------------------------------------------------------------------
# Global caches
# ---------------------------------------------------------------------------
_conditioning_cache = LRUCache(maxsize=500)

# id(clip) → (clip_hash, timestamp) – avoids repeated GPU→CPU transfer
_clip_hash_cache: dict = {}
_CLIP_HASH_TTL = 300  # 5 minutes


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_clip_hash(clip):
    """
    Unique identifier for a CLIP model.

    Uses class name + first parameter shapes + sampled values.
    The result is memoised per ``id(clip)`` for up to 5 min.
    """
    clip_id = id(clip)
    now = time.monotonic()
    cached = _clip_hash_cache.get(clip_id)
    if cached is not None:
        h, ts = cached
        if now - ts < _CLIP_HASH_TTL:
            return h

    try:
        cond_model = getattr(clip, "cond_stage_model", None)
        if cond_model is None:
            result = f"no_cond_stage:{clip_id}"
            _clip_hash_cache[clip_id] = (result, now)
            return result

        class_name = type(cond_model).__name__
        params = list(cond_model.parameters())
        if not params:
            result = f"{class_name}:no_params:{clip_id}"
            _clip_hash_cache[clip_id] = (result, now)
            return result

        shapes = []
        param_samples = []
        for p in params[:5]:
            shapes.append(str(p.shape))
            flat = p.flatten()[:50].detach().cpu().float()
            param_samples.append(flat.numpy().tobytes())

        shapes_str = "|".join(shapes)
        combined_bytes = b"".join(param_samples)
        param_hash = hashlib.md5(combined_bytes).hexdigest()[:12]

        result = f"{class_name}:{shapes_str}:{param_hash}"
        _clip_hash_cache[clip_id] = (result, now)
        return result

    except Exception as e:
        warn(f"clip hash fallback due to: {e}")
        result = f"fallback:{clip_id}"
        _clip_hash_cache[clip_id] = (result, now)
        return result


# clip_hash → known conditioning dimension (learned from first encode)
_clip_dim_cache: dict = {}


def _get_expected_cond_dim(clip, clip_hash=None):
    """Expected conditioning dimension for the given CLIP, or None.

    Instead of hardcoding dimensions per model class, we learn the actual
    dimension from the first encoding result and cache it per clip_hash.
    This works with any model architecture without maintenance.
    """
    if clip_hash and clip_hash in _clip_dim_cache:
        return _clip_dim_cache[clip_hash]
    return None


def _learn_cond_dim(clip_hash, conditioning):
    """Record the actual conditioning dimension from an encoding result."""
    try:
        if conditioning and len(conditioning) > 0:
            dim = conditioning[0][0].shape[-1]
            _clip_dim_cache[clip_hash] = dim
    except Exception:
        pass


def _validate_conditioning_shape(conditioning, clip_hash=None):
    """True if the cached conditioning dimension matches the current CLIP."""
    try:
        if conditioning is None or len(conditioning) == 0:
            return False

        cond_tensor = conditioning[0][0]
        cond_dim = cond_tensor.shape[-1]

        expected_dim = _get_expected_cond_dim(None, clip_hash=clip_hash)
        if expected_dim is None:
            return True

        if cond_dim != expected_dim:
            log(f"Dimension mismatch: cached={cond_dim}, expected={expected_dim}")
            return False
        return True
    except Exception:
        return True


def _get_cache_key(clip_hash: str, prompt: str) -> str:
    prompt_hash = hashlib.md5(prompt.encode("utf-8")).hexdigest()[:16]
    return f"{clip_hash}:{prompt_hash}"


def _cache_conditioning(clip_hash, prompt, conditioning):
    _conditioning_cache.put(_get_cache_key(clip_hash, prompt), conditioning)


def _get_cached_conditioning(clip_hash, prompt):
    cache_key = _get_cache_key(clip_hash, prompt)
    cached = _conditioning_cache.get(cache_key)
    if cached is not None:
        if not _validate_conditioning_shape(cached, clip_hash=clip_hash):
            log("Cache invalidated: dimension mismatch")
            _conditioning_cache.remove(cache_key)
            return None
    return cached


def _encode_prompt(clip_obj, prompt_text):
    """Encode a single prompt through a CLIP object, return [[cond, extras]]."""
    tokens = clip_obj.tokenize(prompt_text)
    output = clip_obj.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
    cond = output.pop("cond")
    return [[cond, output]]


# ---------------------------------------------------------------------------
# Assembly helpers
# ---------------------------------------------------------------------------
def _assemble_prompt(prompt, trigger, style_prefix, style_suffix, trigger_position, style_position="wrap"):
    """Assemble final positive prompt from parts, skipping empty ones.

    trigger_position controls where the trigger goes relative to EVERYTHING:
      "before" = trigger first (before style and prompt)
      "after"  = trigger last (after style and prompt)

    style_position controls where style wraps/sits relative to prompt:
      "wrap"   = [prefix], [prompt], [suffix]
      "before" = [prefix], [suffix], [prompt]
      "after"  = [prompt], [prefix], [suffix]
    """
    # Build core (style + prompt) without trigger
    if style_position == "before":
        core = [style_prefix, style_suffix, prompt]
    elif style_position == "after":
        core = [prompt, style_prefix, style_suffix]
    else:  # wrap
        core = [style_prefix, prompt, style_suffix]

    # Place trigger at the edges
    if trigger_position == "before":
        parts = [trigger] + core
    else:
        parts = core + [trigger]

    return ", ".join(p for p in parts if p and p.strip())


def _assemble_negative(user_negative, style_negative):
    """Combine user negative and style negative."""
    parts = [user_negative, style_negative]
    return ", ".join(p for p in parts if p and p.strip())


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------
class PowderConditioner:
    """
    Optimised text encoder.

    Each element of the *clip* list is used with its corresponding prompt
    (per-index CLIP).  Prompts sharing the same ``(id(clip), prompt)`` pair
    are deduplicated so the actual encode happens only once.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
            },
            "optional": {
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "lora_info": ("STRING", {"default": "", "multiline": False, "forceInput": True}),
                "style": ("STRING", {"default": "", "multiline": False, "forceInput": True}),
                "use_cache": ("BOOLEAN", {"default": True}),
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "STRING", "STRING")
    RETURN_NAMES = ("positive_conditioning", "negative_conditioning", "final_positive", "final_negative")
    OUTPUT_IS_LIST = (True, True, True, True)
    FUNCTION = "encode"
    CATEGORY = "e2go_nodes"

    def encode(self, clip, prompt, negative_prompt=None,
               style=None, lora_info=None, use_cache=None):
        use_cache = use_cache[0] if isinstance(use_cache, list) else (use_cache if use_cache is not None else True)

        # Parse style JSON
        style_prefix = ""
        style_suffix = ""
        style_negative = ""
        style_position = "wrap"
        if style is not None:
            si_str = style[0] if isinstance(style, list) else style
            try:
                si = json.loads(si_str) if si_str else {}
                style_prefix = si.get("prefix", "")
                style_suffix = si.get("suffix", "")
                style_negative = si.get("negative", "")
                style_position = si.get("position", "wrap")
            except (json.JSONDecodeError, Exception):
                pass

        # Parse lora_info: trigger_position + triggers array
        trigger_position = "after"
        triggers = []
        if lora_info is not None:
            li_str = lora_info[0] if isinstance(lora_info, list) else lora_info
            try:
                li = json.loads(li_str) if li_str else {}
                trigger_position = li.get("trigger_position", "after")
                triggers = li.get("triggers", [])
            except (json.JSONDecodeError, Exception):
                pass

        if not isinstance(clip, list):
            clip = [clip]
        if not isinstance(prompt, list):
            prompt = [prompt]

        has_negatives = negative_prompt is not None and len(negative_prompt) > 0
        if has_negatives and not isinstance(negative_prompt, list):
            negative_prompt = [negative_prompt]

        # ----- build final prompt / negative lists --------------------------
        n = len(prompt)
        final_prompts = []
        final_negatives = []
        for i in range(n):
            p = prompt[i]
            trig = ""
            if i < len(triggers):
                t = triggers[i]
                trig = t if t and t.strip() else ""

            final_prompts.append(_assemble_prompt(p, trig, style_prefix, style_suffix, trigger_position, style_position))

            neg = ""
            if has_negatives and i < len(negative_prompt):
                neg = negative_prompt[i] if negative_prompt[i] else ""
            final_negatives.append(_assemble_negative(neg, style_negative))

        # ----- per-index CLIP mapping ---------------------------------------
        # Expand clip list to match prompt length (last element repeated)
        clip_per_prompt = []
        for i in range(len(final_prompts)):
            clip_per_prompt.append(clip[i] if i < len(clip) else clip[-1])

        mode_str = "with triggers" if triggers else "simple"
        log(f"[PowderConditioner] === START ({mode_str}) ===")
        log(f"[PowderConditioner] Total prompts: {len(final_prompts)}, negatives: {len(final_negatives)}")

        # ----- deduplicate by (id(clip), prompt) ----------------------------
        # For positives
        unique_pos: dict[tuple, int] = {}  # (clip_id, text) → index into unique lists
        unique_pos_clips = []
        unique_pos_texts = []
        pos_mapping: list[int] = []  # final_prompts[i] → index in unique lists

        for i, text in enumerate(final_prompts):
            key = (id(clip_per_prompt[i]), text)
            if key not in unique_pos:
                unique_pos[key] = len(unique_pos_clips)
                unique_pos_clips.append(clip_per_prompt[i])
                unique_pos_texts.append(text)
            pos_mapping.append(unique_pos[key])

        # For negatives
        unique_neg: dict[tuple, int] = {}
        unique_neg_clips = []
        unique_neg_texts = []
        neg_mapping: list[int] = []

        for i, text in enumerate(final_negatives):
            clip_obj = clip_per_prompt[i] if i < len(clip_per_prompt) else clip_per_prompt[-1]
            key = (id(clip_obj), text)
            if key not in unique_neg:
                unique_neg[key] = len(unique_neg_clips)
                unique_neg_clips.append(clip_obj)
                unique_neg_texts.append(text)
            neg_mapping.append(unique_neg[key])

        log(f"[PowderConditioner] Unique positive: {len(unique_pos_texts)}, unique negative: {len(unique_neg_texts)}")

        start_time = time.time()
        encoded_count = 0
        cache_hits = 0

        # ----- encode unique positives --------------------------------------
        pos_results_unique = [None] * len(unique_pos_texts)
        for idx, (clip_obj, text) in enumerate(zip(unique_pos_clips, unique_pos_texts)):
            clip_hash = _get_clip_hash(clip_obj)
            if use_cache:
                cached = _get_cached_conditioning(clip_hash, text)
                if cached is not None:
                    pos_results_unique[idx] = cached
                    cache_hits += 1
                    log(f"[PowderConditioner] positive {idx+1}/{len(unique_pos_texts)}: cache hit")
                    continue

            enc_start = time.time()
            conditioning = _encode_prompt(clip_obj, text)
            pos_results_unique[idx] = conditioning
            encoded_count += 1
            _learn_cond_dim(clip_hash, conditioning)

            if use_cache:
                _cache_conditioning(clip_hash, text, conditioning)

            log(f"[PowderConditioner] positive {idx+1}/{len(unique_pos_texts)}: encoded ({time.time()-enc_start:.2f}s)")

        # ----- encode unique negatives --------------------------------------
        neg_results_unique = [None] * len(unique_neg_texts)
        for idx, (clip_obj, text) in enumerate(zip(unique_neg_clips, unique_neg_texts)):
            clip_hash = _get_clip_hash(clip_obj)
            if use_cache:
                cached = _get_cached_conditioning(clip_hash, text)
                if cached is not None:
                    neg_results_unique[idx] = cached
                    cache_hits += 1
                    log(f"[PowderConditioner] negative {idx+1}/{len(unique_neg_texts)}: cache hit")
                    continue

            enc_start = time.time()
            conditioning = _encode_prompt(clip_obj, text)
            neg_results_unique[idx] = conditioning
            encoded_count += 1
            _learn_cond_dim(clip_hash, conditioning)

            if use_cache:
                _cache_conditioning(clip_hash, text, conditioning)

            log(f"[PowderConditioner] negative {idx+1}/{len(unique_neg_texts)}: encoded ({time.time()-enc_start:.2f}s)")

        # ----- fan results back out to full lists ---------------------------
        positive_results = [pos_results_unique[pos_mapping[i]] for i in range(len(final_prompts))]
        negative_results = [neg_results_unique[neg_mapping[i]] for i in range(len(final_negatives))]

        total_time = time.time() - start_time
        log(f"[PowderConditioner] Encoded: {encoded_count}, Cache hits: {cache_hits}")
        log(f"[PowderConditioner] Done in {total_time:.1f}s")

        return (positive_results, negative_results, final_prompts, final_negatives)


class ClearConditioningCache:
    """Clears the conditioning cache."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "clear"
    CATEGORY = "e2go_nodes"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, *_args, **_kwargs):
        return float("NaN")

    def clear(self):
        count = _conditioning_cache.clear()
        _clip_dim_cache.clear()
        log(f"[ClearConditioningCache] Cleared {count} entries + dimension cache")
        return {}


NODE_CLASS_MAPPINGS = {
    "PowderConditioner": PowderConditioner,
    "ClearConditioningCache": ClearConditioningCache,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderConditioner": "Powder Conditioner",
    "ClearConditioningCache": "Powder Clear Conditioning Cache",
}
