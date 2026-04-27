"""
PowderConditioner - Optimised text encoder with caching.

Encodes each (clip, prompt) pair honestly, using the per-index CLIP object
that was passed in.  Results are cached via a thread-safe LRU cache.
"""

import os
import torch
import hashlib
import json
import time
import weakref

from ._log import log, warn, error
from ._cache import LRUCache

# ---------------------------------------------------------------------------
# Global caches
# ---------------------------------------------------------------------------
_conditioning_cache = LRUCache(maxsize=64)

_DEBUG_CACHE = os.environ.get("E2GO_CACHE_DEBUG", "").lower() in ("1", "true", "yes")

# weakref.ref(clip) → str hash. Entries auto-removed when clip is GC'd.
_clip_hash_refs: list = []  # list of (weakref, hash)


def _clip_hash_lookup(clip):
    """Return memoised hash for *clip* or None. Cleans dead refs along the way."""
    alive = []
    found = None
    for ref, h in _clip_hash_refs:
        target = ref()
        if target is None:
            continue  # dead, drop
        alive.append((ref, h))
        if target is clip:
            found = h
    _clip_hash_refs[:] = alive
    return found


def _clip_hash_remember(clip, hash_str):
    """Store hash for *clip* via weakref."""
    try:
        ref = weakref.ref(clip)
        _clip_hash_refs.append((ref, hash_str))
    except TypeError:
        # Some objects can't be weakref'd (e.g. proxies). Skip memoisation.
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_clip_hash(clip):
    """
    Structural fingerprint of a CLIP model.

    Built from class name + (param_name, shape, dtype) tuples for ALL parameters.
    Deterministic regardless of quantization state, weight materialization, or
    AIMDO offloading.

    Memoised per-CLIP via weakref; entries vanish when the CLIP is GC'd.
    """
    cached = _clip_hash_lookup(clip)
    if cached is not None:
        return cached

    try:
        cond_model = getattr(clip, "cond_stage_model", None)
        if cond_model is None:
            result = f"no_cond_stage:{type(clip).__name__}"
            if _DEBUG_CACHE:
                log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
            _clip_hash_remember(clip, result)
            return result

        class_name = type(cond_model).__name__

        # Collect (name, shape, dtype) for every parameter — structural only.
        sig_parts = [class_name]
        try:
            for name, p in cond_model.named_parameters():
                sig_parts.append(f"{name}:{tuple(p.shape)}:{p.dtype}")
        except Exception as e:
            warn(f"clip hash: named_parameters failed ({e}), falling back to id")
            result = f"fallback:{class_name}:{id(cond_model)}"
            if _DEBUG_CACHE:
                log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
            _clip_hash_remember(clip, result)
            return result

        if len(sig_parts) == 1:  # no params
            result = f"{class_name}:no_params"
            if _DEBUG_CACHE:
                log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
            _clip_hash_remember(clip, result)
            return result

        # Compact: hash the joined signature.
        sig_blob = "|".join(sig_parts).encode("utf-8")
        digest = hashlib.md5(sig_blob).hexdigest()[:16]
        result = f"{class_name}:{digest}"

        if _DEBUG_CACHE:
            log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
        _clip_hash_remember(clip, result)
        return result

    except Exception as e:
        warn(f"clip hash fallback due to: {e}")
        result = f"fallback:{type(clip).__name__}:{id(clip)}"
        if _DEBUG_CACHE:
            log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
        _clip_hash_remember(clip, result)
        return result


# clip_hash → known conditioning dimension (learned from first encode)
_clip_dim_cache = LRUCache(maxsize=64)


def _get_expected_cond_dim(clip, clip_hash=None):
    """Expected conditioning dimension for the given CLIP, or None.

    Instead of hardcoding dimensions per model class, we learn the actual
    dimension from the first encoding result and cache it per clip_hash.
    This works with any model architecture without maintenance.
    """
    if clip_hash:
        cached = _clip_dim_cache.get(clip_hash)
        if cached is not None:
            return cached
    return None


def _learn_cond_dim(clip_hash, conditioning):
    """Record the actual conditioning dimension from an encoding result."""
    try:
        if conditioning and len(conditioning) > 0:
            dim = conditioning[0][0].shape[-1]
            _clip_dim_cache.put(clip_hash, dim)
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


def _conditioning_to_cpu(conditioning):
    """Move conditioning tensors to CPU for safe caching. Returns new list."""
    out = []
    for cond, extras in conditioning:
        cond_cpu = cond.detach().to("cpu", copy=True) if hasattr(cond, "to") else cond
        extras_cpu = {}
        for k, v in extras.items():
            if hasattr(v, "to"):
                extras_cpu[k] = v.detach().to("cpu", copy=True)
            else:
                extras_cpu[k] = v
        out.append([cond_cpu, extras_cpu])
    return out


def _conditioning_to_device(conditioning, device):
    """Move conditioning tensors to *device* (typically GPU) for use."""
    out = []
    for cond, extras in conditioning:
        cond_dev = cond.to(device) if hasattr(cond, "to") else cond
        extras_dev = {}
        for k, v in extras.items():
            if hasattr(v, "to"):
                extras_dev[k] = v.to(device)
            else:
                extras_dev[k] = v
        out.append([cond_dev, extras_dev])
    return out


def _cache_conditioning(clip_hash, prompt, conditioning):
    cpu_cond = _conditioning_to_cpu(conditioning)
    _conditioning_cache.put(_get_cache_key(clip_hash, prompt), cpu_cond)


def _get_cached_conditioning(clip_hash, prompt, target_device):
    cache_key = _get_cache_key(clip_hash, prompt)
    cached = _conditioning_cache.get(cache_key)
    if _DEBUG_CACHE:
        log(f"[cache] {'HIT' if cached else 'MISS'} key={cache_key[:32]}...")
    if cached is None:
        return None
    if not _validate_conditioning_shape(cached, clip_hash=clip_hash):
        log("Cache invalidated: dimension mismatch")
        _conditioning_cache.remove(cache_key)
        return None
    return _conditioning_to_device(cached, target_device)


def _encode_prompt(clip_obj, prompt_text):
    """Encode a single prompt through a CLIP object, return [[cond, extras]]."""
    tokens = clip_obj.tokenize(prompt_text)
    output = clip_obj.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
    cond = output.pop("cond")
    return [[cond, output]]


# Class-name markers for CLIP/text encoder families that don't play well
# with structural caching (quantization-driven instability, frequent reloads, etc.)
_QUANTIZED_CLIP_MARKERS = ("Flux", "T5", "MixedPrecision", "Quantized")


def _is_unstable_clip(clip):
    """Detect CLIPs whose state can change in ways our cache can't track."""
    try:
        cond_model = getattr(clip, "cond_stage_model", None)
        if cond_model is None:
            return False
        class_name = type(cond_model).__name__
        return any(marker in class_name for marker in _QUANTIZED_CLIP_MARKERS)
    except Exception:
        return False


def _resolve_clip_device(clip):
    """Best-effort: where does this CLIP currently live? Default to CPU."""
    try:
        cond_model = getattr(clip, "cond_stage_model", None)
        if cond_model is None:
            return torch.device("cpu")
        for p in cond_model.parameters():
            return p.device
    except Exception:
        pass
    return torch.device("cpu")


# Latest lora_info schema_version this consumer knows how to parse.
LORA_INFO_SCHEMA_VERSION_KNOWN = 2


def _validate_lora_info(li: dict, n_prompts: int) -> dict:
    """
    Validate and normalise lora_info from Lora Loader.

    Returns a dict with `triggers` aligned to n_prompts and `trigger_position`
    set. Logs warnings on inconsistencies; does not raise.
    """
    if not isinstance(li, dict):
        warn(f"lora_info: expected dict, got {type(li).__name__}; ignoring")
        return {"triggers": [""] * n_prompts, "trigger_position": "after"}

    schema_version = li.get("schema_version", 1)
    if schema_version > LORA_INFO_SCHEMA_VERSION_KNOWN:
        warn(f"lora_info: unknown schema_version={schema_version}, attempting best-effort parse")

    triggers = li.get("triggers", [])
    if not isinstance(triggers, list):
        warn(f"lora_info: triggers not a list ({type(triggers).__name__}), using empty")
        triggers = []

    if len(triggers) < n_prompts:
        if triggers:
            warn(f"lora_info: triggers length {len(triggers)} < prompts {n_prompts}, padding with empty strings")
        triggers = list(triggers) + [""] * (n_prompts - len(triggers))
    elif len(triggers) > n_prompts:
        warn(f"lora_info: triggers length {len(triggers)} > prompts {n_prompts}, truncating")
        triggers = triggers[:n_prompts]

    triggers = [t if isinstance(t, str) else "" for t in triggers]

    trigger_position = li.get("trigger_position", "after")
    if trigger_position not in ("before", "after"):
        warn(f"lora_info: unknown trigger_position={trigger_position!r}, defaulting to 'after'")
        trigger_position = "after"

    return {"triggers": triggers, "trigger_position": trigger_position}


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
                "cache_mode": (["auto", "aggressive", "disabled"], {"default": "auto"}),
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "STRING", "STRING")
    RETURN_NAMES = ("positive_conditioning", "negative_conditioning", "final_positive", "final_negative")
    OUTPUT_IS_LIST = (True, True, True, True)
    FUNCTION = "encode"
    CATEGORY = "e2go_nodes"

    def encode(self, clip, prompt, negative_prompt=None,
               style=None, lora_info=None, use_cache=None, cache_mode=None):
        use_cache = use_cache[0] if isinstance(use_cache, list) else (use_cache if use_cache is not None else True)
        cache_mode = cache_mode[0] if isinstance(cache_mode, list) else (cache_mode if cache_mode is not None else "auto")

        # Resolve effective caching policy.
        # Backward compat: use_cache=False overrides cache_mode to disabled.
        if not use_cache:
            effective_mode = "disabled"
        else:
            effective_mode = cache_mode  # auto / aggressive / disabled

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

        # Parse lora_info: trigger_position + triggers array (validated below
        # once we know the prompt list length).
        raw_li: dict = {}
        if lora_info is not None:
            li_str = lora_info[0] if isinstance(lora_info, list) else lora_info
            try:
                parsed = json.loads(li_str) if li_str else {}
                raw_li = parsed if isinstance(parsed, dict) else {}
            except (json.JSONDecodeError, Exception) as e:
                warn(f"lora_info: JSON parse failed ({e})")
                raw_li = {}

        if not isinstance(clip, list):
            clip = [clip]
        if not isinstance(prompt, list):
            prompt = [prompt]

        li_validated = _validate_lora_info(raw_li, len(prompt))
        triggers = li_validated["triggers"]
        trigger_position = li_validated["trigger_position"]

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

            # Decide whether to use cache for THIS clip
            if effective_mode == "disabled":
                cache_active = False
            elif effective_mode == "aggressive":
                cache_active = True
            else:  # auto
                cache_active = not _is_unstable_clip(clip_obj)

            if cache_active:
                target_device = _resolve_clip_device(clip_obj)
                cached = _get_cached_conditioning(clip_hash, text, target_device)
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

            if cache_active:
                _cache_conditioning(clip_hash, text, conditioning)

            log(f"[PowderConditioner] positive {idx+1}/{len(unique_pos_texts)}: encoded ({time.time()-enc_start:.2f}s)")

        # ----- encode unique negatives --------------------------------------
        neg_results_unique = [None] * len(unique_neg_texts)
        for idx, (clip_obj, text) in enumerate(zip(unique_neg_clips, unique_neg_texts)):
            clip_hash = _get_clip_hash(clip_obj)

            # Decide whether to use cache for THIS clip
            if effective_mode == "disabled":
                cache_active = False
            elif effective_mode == "aggressive":
                cache_active = True
            else:  # auto
                cache_active = not _is_unstable_clip(clip_obj)

            if cache_active:
                target_device = _resolve_clip_device(clip_obj)
                cached = _get_cached_conditioning(clip_hash, text, target_device)
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

            if cache_active:
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
    """Clears the conditioning cache and dim cache.

    Triggered by changing the `trigger` value (any change). Set to a different
    int to fire on next queue. Auto-incremented by the JS frontend button.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "trigger": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "clear"
    CATEGORY = "e2go_nodes"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, trigger, **_kwargs):
        return trigger  # only re-runs when trigger changes

    def clear(self, trigger):
        count = _conditioning_cache.clear()
        _clip_dim_cache.clear()
        log(f"[ClearConditioningCache] Cleared {count} entries + dim cache (trigger={trigger})")
        return {}


class PowderCacheStats:
    """Logs current cache sizes. Useful for debugging cache behavior."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stats",)
    FUNCTION = "report"
    CATEGORY = "e2go_nodes"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, *_args, **_kwargs):
        return float("NaN")

    def report(self):
        # Local imports to avoid circular dependencies if module structure changes.
        from .powder_lora import _lora_cache, _patcher_entries, _PATCHER_CACHE_MAXSIZE
        from ._styles import _STYLES_CACHE

        live_clip_refs = sum(1 for ref, _ in _clip_hash_refs if ref() is not None)
        live_patcher = sum(
            1 for m_ref, c_ref, _, _, _ in _patcher_entries
            if m_ref() is not None and (c_ref is None or c_ref() is not None)
        )

        stats = {
            "lora_raw_cache": _lora_cache.stats(),
            "lora_patcher_cache": {
                "size": live_patcher,
                "raw_entries": len(_patcher_entries),
                "maxsize": _PATCHER_CACHE_MAXSIZE,
            },
            "conditioning_cache": _conditioning_cache.stats(),
            "clip_dim_cache": _clip_dim_cache.stats(),
            "clip_hash_refs": live_clip_refs,
            "styles_loaded": len(_STYLES_CACHE),
        }
        report_str = json.dumps(stats, indent=2)
        log(f"[PowderCacheStats]\n{report_str}")
        return (report_str,)


NODE_CLASS_MAPPINGS = {
    "PowderConditioner": PowderConditioner,
    "ClearConditioningCache": ClearConditioningCache,
    "PowderCacheStats": PowderCacheStats,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderConditioner": "Powder Conditioner",
    "ClearConditioningCache": "Powder Clear Conditioning Cache",
    "PowderCacheStats": "Powder Cache Stats",
}
