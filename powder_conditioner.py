"""
PowderConditioner - Optimised text encoder with caching.

Encodes each (clip, prompt) pair honestly, using the per-index CLIP object
that was passed in.  Results are cached via a thread-safe LRU cache.
"""

import os
import torch
import hashlib
import itertools
import json
import math
import threading
import time
import weakref

from ._log import log, info, warn, error
from ._cache import LRUCache
from .powder_references import bundle_source, link_source, profile_for_clip, tokenizer_params, vl_sequence

# ---------------------------------------------------------------------------
# Global caches
# ---------------------------------------------------------------------------
_conditioning_cache = LRUCache(maxsize=64, max_bytes=512 * 1024**2)

_DEBUG_CACHE = os.environ.get("E2GO_CACHE_DEBUG", "").lower() in ("1", "true", "yes")

# weakref.ref(clip) → str hash. Entries auto-removed when clip is GC'd.
_clip_hash_refs: list = []  # list of (weakref, hash)
_clip_hash_refs_lock = threading.Lock()


def _clip_hash_lookup(clip, weight_stamp=None):
    """Return memoised hash for *clip* or None.

    Cleans dead refs along the way, and also drops (invalidates) any stale
    entry for *clip* whose remembered ``weight_stamp`` no longer matches the
    current one -- e.g. the same CLIP object got re-patched in place (new
    LoRA / strength) without becoming a new Python object.
    """
    alive = []
    found = None
    with _clip_hash_refs_lock:
        for ref, payload in _clip_hash_refs:
            target = ref()
            if target is None:
                continue  # dead, drop
            stamp, h = payload
            if target is clip:
                if stamp != weight_stamp:
                    continue  # stale weight state, drop -- forces recompute
                found = h
            alive.append((ref, payload))
        _clip_hash_refs[:] = alive
    return found


def _clip_hash_remember(clip, hash_str, weight_stamp=None):
    """Store hash for *clip* (keyed also by its current weight stamp) via weakref."""
    try:
        ref = weakref.ref(clip)
        with _clip_hash_refs_lock:
            _clip_hash_refs.append((ref, (weight_stamp, hash_str)))
    except TypeError:
        # Some objects can't be weakref'd (e.g. proxies). Skip memoisation.
        pass


def _get_clip_weight_stamp(clip):
    """Return a string capturing the CLIP's *current effective weights*
    (LoRA/patch state), or None if nothing patch-related is present.

    The patcher's UUID includes the complete patch chain. Human-readable
    LoRA labels are only a fallback for objects without a patcher.
    """
    patcher = getattr(clip, "patcher", None)
    if patcher is not None:
        patches_uuid = getattr(patcher, "patches_uuid", None)
        if patches_uuid is not None:
            return f"puuid:{patches_uuid}"
        patches = getattr(patcher, "patches", None)
        if patches:
            # Fold each patch list's strengths in: the same LoRA at 0.5 vs
            # 1.0 patches identical keys, so keys alone would collide.
            # (Defense-in-depth: current core always sets patches_uuid, so
            # this branch only runs for exotic patcher objects.)
            try:
                items = []
                for key in sorted(patches.keys(), key=str):
                    strengths = tuple(
                        round(float(p[0]), 6) for p in patches[key]
                        if isinstance(p, (tuple, list)) and p
                    )
                    items.append((str(key), strengths))
                return f"pkeys:{id(patches)}:{items}"
            except Exception:
                return f"pid:{id(patches)}"

    fp = getattr(clip, "_e2go_lora_fp", None)
    return f"fp:{id(clip)}:{fp}" if fp else None


def _param_value_fingerprint(p):
    """Cheap, deterministic sample of a parameter tensor's *values* (not just
    shape/dtype), so genuinely different weights (e.g. a different
    fine-tune) don't collide on the same hash. Sampling a handful of
    evenly-spaced elements keeps this O(1) per parameter instead of O(n).
    """
    try:
        flat = p.detach().reshape(-1)
    except Exception:
        try:
            flat = p.reshape(-1)
        except Exception:
            return "novals"

    try:
        n = flat.shape[0]
    except Exception:
        return "novals"
    if n == 0:
        return "empty"

    try:
        idxs = sorted(set([0, n // 4, n // 2, (3 * n) // 4, n - 1]))
        vals = [flat[i].item() for i in idxs]
        return ",".join(f"{v:.6g}" for v in vals)
    except Exception:
        return "novals"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
# One-shot flag: the all-novals degradation is worth exactly one loud line,
# not one per queue.
_NOVALS_WARNED = False


def _get_clip_hash(clip):
    """
    Weight-aware fingerprint of a CLIP model.

    Built from class name + (param_name, shape, dtype, value-sample) tuples
    for ALL parameters, plus the CLIP's current weight/LoRA stamp (see
    `_get_clip_weight_stamp`) when present. This means two CLIPs sharing the
    same architecture but different effective weights (fine-tune, LoRA
    patch, LoRA strength) get different hashes -- required so
    PowderConditioner's conditioning cache never serves conditioning encoded
    under a different, no-longer-current CLIP.

    Memoised per-CLIP via weakref, keyed additionally by the weight stamp so
    an in-place re-patch of the same CLIP object busts the memo entry.
    """
    weight_stamp = _get_clip_weight_stamp(clip)
    cached = _clip_hash_lookup(clip, weight_stamp)
    if cached is not None:
        return cached

    try:
        cond_model = getattr(clip, "cond_stage_model", None)
        if cond_model is None:
            result = f"no_cond_stage:{type(clip).__name__}"
            if _DEBUG_CACHE:
                log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
            _clip_hash_remember(clip, result, weight_stamp)
            return result

        class_name = type(cond_model).__name__

        # Collect (name, shape, dtype) for every parameter, plus value samples
        # for a BOUNDED subset (evenly spread). Different fine-tunes differ in
        # nearly every tensor, so 16 sampled params discriminate just as well
        # as all of them — while keeping the worst case (5GB staged/offloaded
        # encoders: every .item() may force a load) at a fixed small cost.
        sig_parts = [class_name]
        try:
            params = list(cond_model.named_parameters())
            n_params = len(params)
            max_sampled = 16
            step = max(1, n_params // max_sampled) if n_params else 1
            sampled = 0
            novals = 0
            for i, (name, p) in enumerate(params):
                if i % step == 0:
                    fp = _param_value_fingerprint(p)
                    sampled += 1
                    if fp == "novals":
                        novals += 1
                    sig_parts.append(
                        f"{name}:{tuple(p.shape)}:{p.dtype}:{fp}"
                    )
                else:
                    sig_parts.append(f"{name}:{tuple(p.shape)}:{p.dtype}")
            global _NOVALS_WARNED
            if sampled and novals == sampled and not _NOVALS_WARNED:
                _NOVALS_WARNED = True
                warn("[PowderConditioner] parameter values unreadable "
                     "(offloaded/meta?) — cache key degraded to names/shapes "
                     "only; different fine-tunes of the same architecture "
                     "may collide")
        except Exception as e:
            warn(f"clip hash: named_parameters failed ({e}), falling back to id")
            result = f"fallback:{class_name}:{id(cond_model)}"
            if _DEBUG_CACHE:
                log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
            _clip_hash_remember(clip, result, weight_stamp)
            return result

        if len(sig_parts) == 1:  # no params
            result = f"{class_name}:no_params"
            if _DEBUG_CACHE:
                log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
            _clip_hash_remember(clip, result, weight_stamp)
            return result

        # Weight/LoRA stamp, when present, is part of the signature too --
        # covers CLIPs whose base params don't reflect applied patches.
        if weight_stamp:
            sig_parts.append(f"weight_stamp:{weight_stamp}")

        # Compact: hash the joined signature.
        sig_blob = "|".join(sig_parts).encode("utf-8")
        digest = hashlib.md5(sig_blob).hexdigest()[:16]
        result = f"{class_name}:{digest}"

        if _DEBUG_CACHE:
            log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
        _clip_hash_remember(clip, result, weight_stamp)
        return result

    except Exception as e:
        warn(f"clip hash fallback due to: {e}")
        result = f"fallback:{type(clip).__name__}:{id(clip)}"
        if _DEBUG_CACHE:
            log(f"[cache] clip_hash for {type(clip).__name__}: {result}")
        _clip_hash_remember(clip, result, weight_stamp)
        return result


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
    """Move conditioning tensors to *device* (typically GPU) for use.

    copy=True even when the device already matches (CPU-offloaded encoders):
    handing out the LRU's own tensors would let any downstream in-place
    mutation poison every future cache hit for that key."""
    out = []
    for cond, extras in conditioning:
        cond_dev = cond.to(device, copy=True) if hasattr(cond, "to") else cond
        extras_dev = {}
        for k, v in extras.items():
            if hasattr(v, "to"):
                extras_dev[k] = v.to(device, copy=True)
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
    return _conditioning_to_device(cached, target_device)


# Default VLM reference size. Vision-capable text encoders (Qwen3-VL behind
# Krea2 and Qwen-Image-Edit, Gemma behind LTX, ...) read the image at a COARSE
# resolution — it carries composition and subject, not detail; the detail
# rides in reference_latents on the image side. 384x384 is the size both
# ostris/ComfyUI-Krea2-Ostris-Edit and stock TextEncodeQwenImageEditPlus use.
# The family profile (powder_references) raises it where the latents REPLACE
# the vision tokens (Qwen Image 2.1: ~1024², the core node's `resolution`).
# Never upscaled: a reference bigger than training buys nothing.
_VL_MAX_PIXELS = 384 * 384

_VL_UNSUPPORTED_WARNED = set()
_VL_FALLBACK_COUNTER = itertools.count()


def _prepare_vl_images(references, max_pixels=_VL_MAX_PIXELS):
    """POWDER_REFS -> [image, ...] fit into the VLM budget, in bundle order.

    `area` on the way down (stock TextEncodeQwenImageEdit's choice): a box
    filter keeps thin structures visible at 384 px where bilinear drops them
    between sample points.
    """
    return [im for im in (_fit_vl(im, max_pixels) for im in vl_sequence(references))
            if im is not None]


def _fit_vl(image, max_pixels=_VL_MAX_PIXELS):
    if image is None:
        return None
    try:
        if not hasattr(image, "shape") or image.ndim != 4:
            return None
        image = image[:1, :, :, :3]
        h, w = int(image.shape[1]), int(image.shape[2])
        if h < 1 or w < 1:
            return None
        if h * w > max_pixels:
            # torch directly, not comfy.utils.common_upscale: for "area" with
            # cropping disabled that helper IS this call, and skipping it keeps
            # the function importable (and testable) outside ComfyUI.
            scale = math.sqrt(max_pixels / float(h * w))
            image = torch.nn.functional.interpolate(
                image.movedim(-1, 1),
                size=(max(1, round(h * scale)), max(1, round(w * scale))),
                mode="area").movedim(1, -1)
        return image.contiguous()
    except Exception as e:  # an odd tensor / dtype the resize refuses
        warn(f"[PowderConditioner] a reference image is unusable ({e}) — skipped")
        return None


def _vl_fingerprint(images):
    """Content key for the conditioning cache.

    Exact (md5 over the downscaled pixels), not shape+stats: two frames of the
    same clip have identical shapes and near-identical statistics, and serving
    a cached conditioning for the wrong reference image is silent and
    expensive to notice. At 384x384 the hash costs a few milliseconds.
    """
    if not images:
        return ""
    try:
        blob = b"".join(im.detach().cpu().numpy().tobytes() for im in images)
        return hashlib.md5(blob).hexdigest()[:16]
    except Exception:


        return f"uncacheable{next(_VL_FALLBACK_COUNTER)}"


def _tokenizer_takes_images(clip_obj):
    """Does this CLIP's tokenizer accept an `images=` argument?

    Checked on the tokenizer, not on CLIP.tokenize: the latter forwards
    **kwargs to everything, so it accepts `images=` syntactically and then
    fails deep inside a sub-tokenizer for SDXL/T5-only stacks.
    """
    return "images" in tokenizer_params(clip_obj)


def _bundle_consumer_mode(graph, unique_id):
    """Mode of the Powder Image Conditioning that consumes this node's bundle.

    Mirror of powder_inpaint._refs_reach_the_text_encoder. "Edit" for a
    wired (unreadable) mode widget: the bundle on an Image Conditioning is
    the strong signal. None without a graph, a bundle or a consumer.
    """
    bundle = bundle_source(graph, unique_id)
    if bundle is None:
        return None
    found = None
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "PowderImageConditioning":
            continue
        inputs = node.get("inputs") or {}
        if link_source(graph, inputs.get("references")) != bundle:
            continue
        mode = inputs.get("mode", "Edit")
        mode = mode if isinstance(mode, str) else "Edit"
        # several consumers (a Generate hub and an Edit hub behind a
        # switcher): Edit wins whatever the node order
        if mode.startswith("Edit"):
            return mode
        found = found or mode
    return found


def stamp_consumer_modes(graph):
    """Write the consumer's mode into each conditioner's prompt inputs.

    encode() depends on the mode of a node DOWNSTREAM of it, and ComfyUI's
    execution cache signs a node by its own inputs and ancestors only — so
    switching Edit/Repaint/Generate left the conditioner a cache hit with the
    old keep_vision / edited-image decision. The stamp goes into the node's
    own `consumer_mode` input, which the signature covers.
    """
    if not isinstance(graph, dict):
        return
    for node_id, node in graph.items():
        if isinstance(node, dict) and node.get("class_type") == "PowderConditioner":
            if isinstance(node.get("inputs"), dict):
                node["inputs"]["consumer_mode"] = _bundle_consumer_mode(graph, node_id) or ""


def _latents_replace_vision(graph, unique_id, mode=None):
    """Will an Edit-mode Powder Image Conditioning splice latents for this bundle?

    On families where the encoder drops the vision spans (Qwen Image 2.1,
    keep_vision=False) the image must live on through reference_latents — so
    vision is dropped only when a consumer of the SAME bundle is going to
    supply them. Any doubt (no graph, no consumer, Repaint) keeps the vision
    tokens: a doubled image is a visible defect, a vanished one is silent.
    """
    mode = mode or _bundle_consumer_mode(graph, unique_id)
    return mode is not None and mode.startswith("Edit")


def _encode_prompt(clip_obj, prompt_text, images=None, keep_vision=None):
    """Encode a single prompt through a CLIP object, return [[cond, extras]]."""
    if not hasattr(clip_obj, "tokenize"):


        raise ValueError(
            f"PowderConditioner: the clip input received "
            f"{type(clip_obj).__name__} ({str(clip_obj)[:60]!r}) instead of a "
            f"CLIP object — check the upstream wiring (an any-typed "
            f"switch/reroute may be forwarding the wrong link)")
    tokens = None
    if images:
        # No manual "<|vision_start|>..." placeholder: every vision tokenizer
        # in comfy/text_encoders swaps to its OWN images template when
        # `images` is non-empty (qwen3vl.py:176-183 and the same shape in
        # qwen35/boogu/lt/joyimage). Injecting the block by hand would either
        # duplicate it or pin the wrong system prompt for that family.
        if _tokenizer_takes_images(clip_obj):
            params = tokenizer_params(clip_obj)
            kwargs = {"images": images}
            if keep_vision is not None and "keep_vision" in params:
                kwargs["keep_vision"] = keep_vision
            if "prevent_empty_text" in params:
                kwargs["prevent_empty_text"] = True   # core: an empty negative encodes as ' '
            tokens = clip_obj.tokenize(prompt_text, **kwargs)
        else:
            name = type(getattr(clip_obj, "tokenizer", clip_obj)).__name__
            if name not in _VL_UNSUPPORTED_WARNED:
                _VL_UNSUPPORTED_WARNED.add(name)
                warn(f"[PowderConditioner] references are connected but {name} has no "
                     f"vision branch — the images are ignored and the prompt is "
                     f"encoded as text. Vision needs a VL text encoder (Krea2 / "
                     f"Qwen-Image-Edit / LTX and friends), loaded from a "
                     f"checkpoint that includes the vision weights.")
    if tokens is None:
        tokens = clip_obj.tokenize(prompt_text)
    output = clip_obj.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
    cond = output.pop("cond")
    return [[cond, output]]


def _encode_side(unique_clips, unique_texts, effective_mode, label, images=None, keep_vision=None):
    """Encode one side (positives OR negatives) of the unique prompt set,
    consulting/populating the conditioning cache per clip. Returns
    (results, encoded_count, cache_hits). The positive and negative passes
    were verbatim copies of this loop."""
    results = [None] * len(unique_texts)
    encoded_count = 0
    cache_hits = 0


    vl_fp = _vl_fingerprint(images) if images else ""
    for idx, (clip_obj, text) in enumerate(zip(unique_clips, unique_texts)):
        clip_images = images if images and _tokenizer_takes_images(clip_obj) else None
        clip_hash = _get_clip_hash(clip_obj) + (f"|vl:{vl_fp}:kv{int(bool(keep_vision))}" if clip_images else "")
        # clip skip and tokenizer options live on the CLIP wrapper, not in the
        # weights: clone() keeps the weight stamp, so they must key separately
        layer_idx = getattr(clip_obj, "layer_idx", None)
        if layer_idx is not None:
            clip_hash += f"|skip:{layer_idx}"
        tok_opts = getattr(clip_obj, "tokenizer_options", None)
        if tok_opts:
            clip_hash += f"|tok:{sorted(tok_opts.items())!r}"

        # Decide whether to use cache for THIS clip
        if effective_mode == "disabled":
            cache_active = False
        elif effective_mode == "aggressive":
            cache_active = True
        else:  # auto
            cache_active = not _is_unstable_clip(clip_obj)

        # Hook groups can change weights, schedules and output metadata without
        # changing patches_uuid. Encode these CLIPs fresh in every cache mode.
        if (getattr(clip_obj, "apply_hooks_to_conds", None) is not None
                or getattr(getattr(clip_obj, "patcher", None), "forced_hooks", None) is not None
                or getattr(clip_obj, "use_clip_schedule", False)):
            cache_active = False

        if cache_active:
            target_device = _resolve_clip_device(clip_obj)
            cached = _get_cached_conditioning(clip_hash, text, target_device)
            if cached is not None:
                results[idx] = cached
                cache_hits += 1
                log(f"[PowderConditioner] {label} {idx+1}/{len(unique_texts)}: cache hit")
                continue

        enc_start = time.time()
        conditioning = _encode_prompt(clip_obj, text, images=images, keep_vision=keep_vision)
        results[idx] = conditioning
        encoded_count += 1

        if cache_active:
            _cache_conditioning(clip_hash, text, conditioning)

        log(f"[PowderConditioner] {label} {idx+1}/{len(unique_texts)}: encoded ({time.time()-enc_start:.2f}s)")

    return results, encoded_count, cache_hits


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


def _pad_to(t, length):
    """Zero-pad (or trim) dim-1 of [B, T, C] to `length` tokens."""
    if t.shape[1] == length:
        return t
    if t.shape[1] > length:
        return t[:, :length]
    pad = torch.zeros((t.shape[0], length - t.shape[1], t.shape[2]),
                      dtype=t.dtype, device=t.device)
    return torch.cat([t, pad], dim=1)


def _blend_conditioning(to_cond, from_cond, w):
    """Blend conditioning tensors while preserving compatible metadata and aligning token lengths."""
    t1, meta_to = to_cond[0][0], to_cond[0][1]
    t0 = _pad_to(from_cond[0][0], t1.shape[1]).to(device=t1.device, dtype=t1.dtype)
    mixed = t1 * w + t0 * (1.0 - w)
    meta = _mix_metadata(to_cond, [(to_cond, w), (from_cond, 1.0 - w)], t1.shape[1])
    p_to = meta_to.get("pooled_output")
    p_from = from_cond[0][1].get("pooled_output")
    if p_to is not None and p_from is not None:
        p_from = p_from.to(device=p_to.device, dtype=p_to.dtype)
        meta["pooled_output"] = p_to * w + p_from * (1.0 - w)
    return [[mixed, meta]]


def _superpose_deltas(base_cond, variants):
    """base + Σ w·(variant − base): order-independent per-style strengths.

    variants: list of (conditioning, w). Everything is aligned to the longest
    sequence with zero padding (core practice), so a style that lengthens the
    prompt contributes its extra tokens at full delta.
    """
    b, meta_base = base_cond[0][0], base_cond[0][1]
    if not variants:
        return [[b, dict(meta_base)]]
    max_len = max([b.shape[1]] + [v[0][0].shape[1] for v, _w in variants])
    acc = _pad_to(b, max_len).clone()
    bp = _pad_to(b, max_len)
    p_base = meta_base.get("pooled_output")
    p_acc = None if p_base is None else p_base.clone()
    for v, w in variants:
        # Same device/dtype normalize as _blend_conditioning: cached variants
        # can live on CPU while the base is a fresh cuda encode.
        vt = _pad_to(v[0][0], max_len).to(device=bp.device, dtype=bp.dtype)
        acc = acc + (vt - bp) * w
        p_v = v[0][1].get("pooled_output")
        if p_acc is not None and p_v is not None:
            p_v = p_v.to(device=p_base.device, dtype=p_base.dtype)
            p_acc = p_acc + (p_v - p_base) * w
    meta = _mix_metadata(base_cond, [(base_cond, 1.0 - sum(w for _, w in variants)), *variants], max_len)
    if p_acc is not None:
        meta["pooled_output"] = p_acc
    return [[acc, meta]]


def _mix_metadata(reference, contributors, length):
    """Keep binary token masks aligned with the nonzero terms of the blend.

    Unmasked encodes mean all their original tokens are valid; padding is not.
    Unknown position-dependent metadata cannot safely be linearly mixed.
    """
    meta = dict(reference[0][1])
    active = [(c, w) for c, w in contributors if abs(w) > 1e-8]
    for cond, _ in active:
        if len(cond) != 1:
            raise ValueError('Style mixing supports a single conditioning entry; use style_mix=1 without per-style mixing.')
        for key, value in cond[0][1].items():
            if key in ('attention_mask', 'pooled_output'):
                continue
            if isinstance(value, torch.Tensor) and value.ndim >= 2 and value.shape[1] == cond[0][0].shape[1]:
                raise ValueError(f'Style mixing does not support token metadata {key!r}; use plain styled prompts.')
    if not any('attention_mask' in c[0][1] for c, _ in active):
        meta.pop('attention_mask', None)
        return meta
    target = reference[0][0]
    mask = torch.zeros((target.shape[0], length), dtype=torch.bool, device=target.device)
    for cond, _ in active:
        tensor, extras = cond[0]
        current = extras.get('attention_mask')
        if current is None:
            current = torch.ones(tensor.shape[:2], dtype=torch.bool, device=target.device)
        if current.ndim != 2 or tuple(current.shape) != tuple(tensor.shape[:2]):
            raise ValueError('Style mixing requires attention_mask shaped [batch, tokens].')
        if not bool(((current == 0) | (current == 1)).all()):
            raise ValueError('Style mixing supports binary attention masks only.')
        n = min(length, tensor.shape[1])
        mask[:, :n] |= current[:, :n].to(device=target.device, dtype=torch.bool)
    meta['attention_mask'] = mask
    return meta


from .powder_lora import LORA_INFO_SCHEMA_VERSION as LORA_INFO_SCHEMA_VERSION_KNOWN


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
    try:
        schema_version = int(schema_version)
    except (TypeError, ValueError, OverflowError):
        schema_version = 1
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
                "references": ("POWDER_REFS", {
                    "tooltip": "Reference images from Powder References: the VL text encoder SEES them while reading the prompt, so 'the same coat, in red' has something to refer to. Downscaled to the family's vision budget (384px; ~1024px on Qwen Image 2.1, whose model replaces the vision tokens with the reference latents). Wire the SAME bundle into Powder Image Conditioning (Edit mode) so the model attends to exactly what the encoder described. Positive side only, except where the family needs both branches (Qwen Image 2.1). Ignored with a warning on text-only encoders (SDXL/T5)."}),
                # Written by the on-prompt handler (stamp_consumer_modes), hidden
                # in the UI: the mode of the Image Conditioning that consumes the
                # same bundle. It lives here so ComfyUI's cache sees it change.
                "consumer_mode": ("STRING", {"default": ""}),
                "prompt_format": (["text", "ideogram4"], {"default": "text"}),
                "layout": ("STRING", {"default": "", "forceInput": True}),
                "layout_width": ("INT", {"default": 0, "forceInput": True}),
                "layout_height": ("INT", {"default": 0, "forceInput": True}),
            },
            # `graph`, not `prompt`: the positive text already owns that name.
            "hidden": {"graph": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "STRING", "STRING")
    RETURN_NAMES = ("positive_conditioning", "negative_conditioning", "final_positive", "final_negative")
    OUTPUT_IS_LIST = (True, True, True, True)
    FUNCTION = "encode"
    CATEGORY = "e2go"

    def encode(self, clip, prompt, negative_prompt=None,
               style=None, lora_info=None, use_cache=None, cache_mode=None,
               references=None, consumer_mode=None, graph=None, unique_id=None, prompt_format=None,
               layout=None, layout_width=None, layout_height=None):
        # INPUT_IS_LIST: every input arrives wrapped, the bundle included.
        if isinstance(references, list):
            references = references[0] if references else None
        if isinstance(consumer_mode, list):
            consumer_mode = consumer_mode[0] if consumer_mode else None
        if isinstance(graph, list):
            graph = graph[0] if graph else None
        if isinstance(unique_id, list):
            unique_id = unique_id[0] if unique_id else None
        profile = profile_for_clip(clip[0] if isinstance(clip, list) and clip else clip)
        # t2i: the canvas is wired as edited_image for the edit scenarios of
        # the same graph, but there is no picture being edited — showing the
        # (placeholder) canvas as Picture 1 would condition the prompt on it.
        # Extras stay: a style plate is a deliberate reference in any mode.
        # The stamped input when the prompt came through the server's /prompt;
        # the graph itself for direct calls.
        mode = consumer_mode or _bundle_consumer_mode(graph, unique_id)
        if mode == "Generate" and isinstance(references, dict):
            references = dict(references, edited=None)
        vl_images = _prepare_vl_images(references, profile.vl_max_pixels)
        keep_vision = None
        if vl_images and profile.refs_in_slots:
            keep_vision = not _latents_replace_vision(graph, unique_id, mode)
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


        mix_mode = "token"
        mix = 1.0
        mix_parts: list = []  # per_style: [{"prefix", "suffix", "strength"}]
        if style is not None:
            si_str = style[0] if isinstance(style, list) else style
            try:
                si = json.loads(si_str) if si_str else {}
                style_prefix = si.get("prefix", "")
                style_suffix = si.get("suffix", "")
                style_negative = si.get("negative", "")
                style_position = si.get("position", "wrap")
                if not isinstance(style_prefix, str):
                    style_prefix = ""
                if not isinstance(style_suffix, str):
                    style_suffix = ""
                if not isinstance(style_negative, str):
                    style_negative = ""

                mix_mode = si.get("mix_mode", "token")
                if mix_mode not in ("token", "node", "per_style"):
                    mix_mode = "token"

                try:
                    mix = float(si.get("mix", 1.0))
                    if mix != mix:  # NaN guard -- float("nan") survives float()
                        mix = 1.0
                except (TypeError, ValueError):
                    mix = 1.0


                mix = max(0.0, min(1.5, mix))

                raw_parts = si.get("parts") or []
                if isinstance(raw_parts, list):
                    for part in raw_parts:
                        if not isinstance(part, dict):
                            continue  # garbage entry, skip rather than fail the whole style
                        try:
                            w = float(part.get("strength", 1.0))
                        except (TypeError, ValueError):
                            continue
                        if w != w:  # NaN: same guard as mix — min/max would keep 1.5
                            w = 1.0
                        w = max(0.0, min(1.5, w))
                        p_prefix = part.get("prefix", "")
                        p_suffix = part.get("suffix", "")
                        if not isinstance(p_prefix, str):
                            p_prefix = ""
                        if not isinstance(p_suffix, str):
                            p_suffix = ""


                        if w < 1e-3 or not (p_prefix.strip() or p_suffix.strip()):
                            continue
                        mix_parts.append({
                            "prefix": p_prefix,
                            "suffix": p_suffix,
                            "strength": w,
                        })
            except Exception as e:


                got = str(si_str)
                preview = got[:60] + ("…" if len(got) > 60 else "")
                warn(f"style: expected the JSON from Powder Styler's \"style\" output, "
                     f"got {preview!r} ({e}) — styles NOT applied. If this is the "
                     f"styler's \"style_text\" output, rewire it to \"style\".")


        if (mix_mode == "per_style" and len(mix_parts) == 1
                and abs(mix_parts[0]["strength"] - 1.0) < 1e-3
                and mix_parts[0]["prefix"] == style_prefix
                and mix_parts[0]["suffix"] == style_suffix):
            mix_parts = []


        need_mix = (
            (mix_mode == "node" and abs(mix - 1.0) >= 1e-3
             and bool(style_prefix.strip() or style_suffix.strip()))
            or (mix_mode == "per_style" and len(mix_parts) > 0)
        )

        # Parse lora_info: trigger_position + triggers array (validated below
        # once we know the prompt list length).
        raw_li: dict = {}
        if lora_info is not None:
            li_str = lora_info[0] if isinstance(lora_info, list) else lora_info
            try:
                parsed = json.loads(li_str) if li_str else {}
                raw_li = parsed if isinstance(parsed, dict) else {}
            except Exception as e:
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


        if has_negatives and isinstance(prompt, list) and len(negative_prompt) < len(prompt) and len(negative_prompt) > 1:
            warn(f"negative_prompt list ({len(negative_prompt)}) shorter than prompt list ({len(prompt)}) — "
                 f"missing entries repeat the last negative")

        # ----- build final prompt / negative lists --------------------------
        n = len(prompt)
        format_name = prompt_format[0] if isinstance(prompt_format, list) and prompt_format else prompt_format
        assemble = _assemble_prompt
        if format_name == 'ideogram4':
            from ._ideogram_prompt import assemble
        final_prompts = []
        final_negatives = []
        # Unstyled ("base") and per-style-variant texts, only built when a
        # mix path is active -- these feed the SAME dedup pass as final_prompts
        # below, so caching sees one coherent unique-positive set.
        base_prompts = []
        variant_texts = [[] for _ in mix_parts]
        for i in range(n):
            p = prompt[i]
            if layout and layout[0]:
                from ._layout_prompt import compile_layout, assemble_moss, assemble_flux3
                compiled = compile_layout(layout[0], p,
                                          layout_width[0] if layout_width else None,
                                          layout_height[0] if layout_height else None)
                if compiled is not None:
                    p = compiled
                    if json.loads(layout[0]).get('target') == 'moss':
                        assemble = assemble_moss
                    elif json.loads(layout[0]).get('target') == 'flux3':
                        assemble = assemble_flux3
                    else:
                        from ._ideogram_prompt import assemble
            trig = ""
            if i < len(triggers):
                t = triggers[i]
                trig = t if t and t.strip() else ""

            final_prompts.append(assemble(p, trig, style_prefix, style_suffix, trigger_position, style_position))

            if need_mix:
                base_prompts.append(assemble(p, trig, "", "", trigger_position, style_position))
                if mix_mode == "per_style":
                    for k, part in enumerate(mix_parts):
                        variant_texts[k].append(
                            assemble(p, trig, part["prefix"], part["suffix"], trigger_position, style_position)
                        )

            neg = ""
            if has_negatives and negative_prompt:


                j = i if i < len(negative_prompt) else len(negative_prompt) - 1
                neg = negative_prompt[j] if negative_prompt[j] else ""
            final_negatives.append(_assemble_negative(neg, style_negative))

        # ----- per-index CLIP mapping ---------------------------------------
        # Expand clip list to match prompt length (last element repeated)
        clip_per_prompt = []
        for i in range(len(final_prompts)):
            clip_per_prompt.append(clip[i] if i < len(clip) else clip[-1])

        mode_str = "with triggers" if triggers else "simple"
        log(f"[PowderConditioner] === START ({mode_str}) ===")
        log(f"[PowderConditioner] Total prompts: {len(final_prompts)}, negatives: {len(final_negatives)}")


        skip_styled_encode = need_mix and mix_mode == "per_style"

        # For positives
        unique_pos: dict[tuple, int] = {}  # (clip_id, text) → index into unique lists
        unique_pos_clips = []
        unique_pos_texts = []
        pos_mapping: list[int] = []  # final_prompts[i] → index in unique lists

        if not skip_styled_encode:
            for i, text in enumerate(final_prompts):
                key = (id(clip_per_prompt[i]), text)
                if key not in unique_pos:
                    unique_pos[key] = len(unique_pos_clips)
                    unique_pos_clips.append(clip_per_prompt[i])
                    unique_pos_texts.append(text)
                pos_mapping.append(unique_pos[key])

        # Register base/variant texts into the SAME unique_pos dedup dict, so
        # a base or variant that happens to equal some styled text (or one
        # another) shares one encode -- and so caching sees them at all.
        base_mapping: list[int] = []
        variant_mappings: list[list[int]] = [[] for _ in mix_parts]

        if need_mix:
            for i, text in enumerate(base_prompts):
                key = (id(clip_per_prompt[i]), text)
                if key not in unique_pos:
                    unique_pos[key] = len(unique_pos_clips)
                    unique_pos_clips.append(clip_per_prompt[i])
                    unique_pos_texts.append(text)
                base_mapping.append(unique_pos[key])

            for k in range(len(mix_parts)):
                for i, text in enumerate(variant_texts[k]):
                    key = (id(clip_per_prompt[i]), text)
                    if key not in unique_pos:
                        unique_pos[key] = len(unique_pos_clips)
                        unique_pos_clips.append(clip_per_prompt[i])
                        unique_pos_texts.append(text)
                    variant_mappings[k].append(unique_pos[key])

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

        # The negative sees the images only where the profile says so: on
        # slot families both branches must carry the same slots (the core
        # node encodes both with the images); elsewhere it would double the
        # vision cost to tell the model what the image is not.
        pos_results_unique, pos_enc, pos_hits = _encode_side(
            unique_pos_clips, unique_pos_texts, effective_mode, "positive",
            images=vl_images, keep_vision=keep_vision)
        neg_images = vl_images if profile.negative_sees_images else None
        neg_results_unique, neg_enc, neg_hits = _encode_side(
            unique_neg_clips, unique_neg_texts, effective_mode, "negative",
            images=neg_images, keep_vision=keep_vision)
        encoded_count = pos_enc + neg_enc
        cache_hits = pos_hits + neg_hits

        # ----- fan results back out to full lists ---------------------------
        # per_style (skip_styled_encode): the joint styled text was never
        # registered, so every positive is produced by the mix loop below.
        if skip_styled_encode:
            positive_results = [None] * len(final_prompts)
        else:
            positive_results = [pos_results_unique[pos_mapping[i]] for i in range(len(final_prompts))]
        negative_results = [neg_results_unique[neg_mapping[i]] for i in range(len(final_negatives))]

        # ----- apply conditioning-level style strength -----------------------
        # Negatives are NEVER touched: "style strength" is a positive-prompt
        # concept (see Powder Styler's `strength` doc comment) -- weakening
        # the negative alongside would silently change what the user typed.
        if need_mix:
            for i in range(len(final_prompts)):
                base_i = pos_results_unique[base_mapping[i]]
                if mix_mode == "node":
                    positive_results[i] = _blend_conditioning(positive_results[i], base_i, mix)
                elif mix_mode == "per_style":
                    # parts are pre-clamped and inert-filtered at parse time
                    variants = [(pos_results_unique[variant_mappings[k][i]], part["strength"])
                                for k, part in enumerate(mix_parts)]
                    positive_results[i] = _superpose_deltas(base_i, variants)

        total_time = time.time() - start_time
        log(f"[PowderConditioner] Encoded: {encoded_count}, Cache hits: {cache_hits}")
        log(f"[PowderConditioner] Done in {total_time:.1f}s")

        total_uniques = len(unique_pos_texts) + len(unique_neg_texts)
        if total_uniques > 0:
            cache_pct = round(100.0 * cache_hits / total_uniques)
            cache_label = {
                "auto": "auto",
                "aggressive": "force",
                "disabled": "off",
            }.get(effective_mode, effective_mode)
            mix_log = ""
            if need_mix and mix_mode == "node":
                mix_log = f" | mix=node:{mix:g}"
            elif need_mix and mix_mode == "per_style":
                mix_log = f" | mix=per-style x{len(mix_parts)}"
            info(f"[PowderConditioner] {len(final_prompts)} prompts | {encoded_count} encoded, {cache_hits} cached ({cache_pct}%) | mode={cache_label} | {total_time:.1f}s{mix_log}")

        if layout and layout[0]:
            layout_data = json.loads(layout[0])
            if layout_data.get('enabled'):
                stamp = [layout_data.get('target'), layout_data.get('width'), layout_data.get('height')]
                source = link_source(graph, (graph.get(str(unique_id), {}).get('inputs', {}).get('layout'))) if isinstance(graph, dict) else None
                origin = source[0] if source and graph.get(source[0], {}).get('class_type') == 'PowderCanvas' else None
                layout_meta = {'e2go_layout': stamp}
                if origin is not None:
                    layout_meta['e2go_layout_source'] = origin
                positive_results = [[[tensor, {**meta, **layout_meta}] for tensor, meta in cond] for cond in positive_results]
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
    CATEGORY = "e2go"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, trigger, **_kwargs):
        return trigger  # only re-runs when trigger changes

    def clear(self, trigger):
        count = _conditioning_cache.clear()
        log(f"[ClearConditioningCache] Cleared {count} entries (trigger={trigger})")
        info(f"[ClearConditioningCache] cleared {count} cached encoding{'s' if count != 1 else ''}")
        return {}


class PowderCacheStats:
    """Logs current cache sizes. Useful for debugging cache behavior."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stats",)
    FUNCTION = "report"
    CATEGORY = "e2go"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, *_args, **_kwargs):
        return float("NaN")

    def report(self):
        # Local imports to avoid circular dependencies if module structure changes.
        from .powder_lora import _lora_cache
        from ._styles import get_styles

        with _clip_hash_refs_lock:
            _clip_hash_refs_snapshot = list(_clip_hash_refs)
        live_clip_refs = sum(1 for ref, _ in _clip_hash_refs_snapshot if ref() is not None)

        stats = {
            "lora_raw_cache": _lora_cache.stats(),
            "conditioning_cache": _conditioning_cache.stats(),
            "clip_hash_refs": live_clip_refs,
            "styles_loaded": len(get_styles()[0]),
        }
        report_str = json.dumps(stats, indent=2)
        log(f"[PowderCacheStats]\n{report_str}")
        info(
            f"[PowderCacheStats] cond={stats['conditioning_cache']['size']}/{stats['conditioning_cache']['maxsize']} | "
            f"loras={stats['lora_raw_cache']['size']}/{stats['lora_raw_cache']['maxsize']} | "
            f"styles={stats['styles_loaded']}"
        )
        return {"ui": {"text": [report_str]}, "result": (report_str,)}


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
