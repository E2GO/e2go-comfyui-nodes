"""Prepare image conditioning, masks, reference latents and crop-stitch context for generation and editing."""

import math
import torch

from ._log import info, warn
from .powder_references import bundle_source, link_source, profile_for_model, unpack_references
from ._families import family_of


# PowderImageConditioning.RETURN_NAMES.index("stitch") — kept as a constant
# (rather than hard-coded below) so a future reorder of RETURN_NAMES fails a
# test loudly instead of silently breaking stitch-link detection.
_STITCH_SLOT = 5


def _stitch_consumed(prompt, unique_id):
    """True if any graph node links to our stitch output (slot _STITCH_SLOT).

    Unknown graph shape (no hidden prompt / id) -> True: stay silent rather
    than nag on API runs that strip hidden inputs.
    """
    if not isinstance(prompt, dict) or not prompt or unique_id is None:
        return True
    uid = str(unique_id)
    for node in prompt.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        for v in (inputs or {}).values():
            if (isinstance(v, list) and len(v) == 2
                    and str(v[0]) == uid and v[1] == _STITCH_SLOT):
                return True
    return False


def _refs_reach_the_text_encoder(prompt, unique_id=None):
    """Does some PowderConditioner in this graph take THIS node's reference bundle?

    The one failure mode this reference system can still have is a half-wired
    bundle: the model attends to images the text encoder never saw, so the
    prompt's "the same coat" refers to nothing. The JS auto-wire closes it on
    a live edit; this is the backstop for graphs assembled by hand or by API.

    Silent (True) when there is no PowderConditioner at all — the user is on a
    different text path and we have nothing useful to say — and when the graph
    shape is unknown, so API runs that strip hidden inputs never nag.
    """
    if not isinstance(prompt, dict) or not prompt:
        return True
    # Same lookup the conditioner uses for its consumer: a DIFFERENT bundle on
    # the conditioner is as half-wired as none. Without a readable bundle of
    # our own (no unique_id) any bundle there counts.
    mine = bundle_source(prompt, unique_id)
    seen_conditioner = False
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "PowderConditioner":
            continue
        seen_conditioner = True
        theirs = link_source(prompt, (node.get("inputs") or {}).get("references"))
        if theirs is not None and (mine is None or theirs == mine):
            return True
    return not seen_conditioner


def _apply_differential_diffusion(model):
    """Patch the model with DD; on any failure warn and pass through.

    Patches directly (clone + set_model_denoise_mask_function with the stock
    forward) instead of calling the node wrapper — the wrapper API changed
    between ComfyUI versions (apply() -> v3 execute()/NodeOutput), while the
    forward math is the stable part.
    """
    try:
        import inspect
        from comfy_extras.nodes_differential_diffusion import DifferentialDiffusion
        # Probe the signature at PATCH time: the lambda runs lazily at
        # SAMPLING time (outside this try), so an unknown `strength` kwarg
        # there would abort the run mid-generation instead of warning here.
        # v3 forward is a classmethod taking strength; classic v1 is an
        # instance method without it — bind an instance and branch once.
        dd = DifferentialDiffusion()
        params = inspect.signature(DifferentialDiffusion.forward).parameters
        if "strength" in params:
            fn = lambda *args, **kwargs: dd.forward(*args, **kwargs, strength=1.0)
        else:  # classic v1 forward(self, sigma, denoise_mask, extra_options)
            fn = dd.forward
        m = model.clone()
        m.set_model_denoise_mask_function(fn)
        return m
    except Exception as e:  # comfy_extras absent (tests) or API drift
        warn(f"[PowderInpaint] differential diffusion unavailable ({e}) — model passed through")
        return model


def compute_steps(base, denoise, auto):
    """Auto: budget the selected fraction of a full trajectory, at least one step.

    KSampler already truncates the schedule for denoise. Increasing the
    executed steps by 1/denoise densified that tail a second time; real Krea2
    probes reproduced blotchy output at 20 steps versus a clean four-step
    pass. Manual mode retains the exact requested number of executed steps.
    Shared with Grid metadata and the frontend's e2go_steps.js.
    """
    base = max(1, int(base))
    if isinstance(auto, str):

        auto = auto.strip().lower() not in ("false", "0", "off", "no", "")
    if not auto:
        return base
    d = float(denoise)
    if d != d:  # NaN can arrive via a wired denoise input — math.ceil(NaN) raises
        d = 1.0
    d = min(1.0, max(0.0, d))
    return max(1, math.ceil(base * d))


# Above this render/source pixel ratio the crop is genuinely being upscaled
# (1.1 leaves room for grid rounding); below this denoise the model does not
# get enough of the trajectory to rebuild what the upscale smeared.
_UPSCALE_RATIO = 1.1
_UPSCALE_SAFE_DENOISE = 0.9

# Below this render/source pixel ratio the region is genuinely being rendered
# smaller than itself (0.9 leaves room for grid rounding).
_DOWNSCALE_WARN_RATIO = 0.9

# A capped 1:1 render below this many megapixels is too small for any current
# model to put detail into — the cap protected the user from mottling and
# handed them mush instead, so say so out loud rather than in an info line.
_SMALL_RENDER_MP = 0.3


def _cure(sizing):
    """Describe a size adjustment appropriate for the selected crop-sizing mode."""
    return "crop_width/crop_height" if sizing == "fixed" else "crop_megapixels"


def _warn_upscaled_crop(cw, ch, tw, th, denoise, sizing="auto"):
    """Explain the quality tradeoff when a small crop is enlarged for sampling."""
    try:
        d = float(denoise)
    except (TypeError, ValueError):
        return
    if d != d:
        d = 1.0
    if tw * th <= cw * ch * _UPSCALE_RATIO or d >= _UPSCALE_SAFE_DENOISE:
        return
    warn(f"[PowderImageCond] crop_to_mask renders {tw}x{th} from a {cw}x{ch} "
         f"region ({(tw * th / float(cw * ch)) ** 0.5:.2f}x upscale) at denoise "
         f"{d:g} — an upscaled crop that is only partially denoised comes back "
         f"mottled (flat areas fill with latent-grid patches). Raise denoise to "
         f"{_UPSCALE_SAFE_DENOISE:g}+, or bring the render size down to the "
         f"region's own {cw}x{ch} via {_cure(sizing)}.")


def _warn_downscaled_crop(cw, ch, tw, th, sizing="auto"):
    """Explain the detail loss when a crop is reduced for sampling."""
    if tw * th >= cw * ch * _DOWNSCALE_WARN_RATIO:
        return
    warn(f"[PowderImageCond] crop_to_mask renders {tw}x{th} from a {cw}x{ch} "
         f"region ({(tw * th / float(cw * ch)) ** 0.5:.2f}x) — the masked area "
         f"is generated below its own resolution and the stitch scales it back "
         f"up, so it returns softer than the source. Raise {_cure(sizing)} to "
         f"render it 1:1 ({'about %.1f MP' % (cw * ch / 1e6) if sizing != 'fixed' else '%dx%d' % (cw, ch)}).")


def _warn_capped_render_too_small(cw, ch, denoise):
    """Warn when the capped render is too small for a detailed local edit."""
    if cw * ch >= _SMALL_RENDER_MP * 1e6:
        return
    warn(f"[PowderImageCond] the masked region is only {cw}x{ch} "
         f"({cw * ch / 1e6:.2f} MP) and denoise {float(denoise):g} keeps the "
         f"render at 1:1, so there is very little for the model to work with. "
         f"Raise denoise to {_UPSCALE_SAFE_DENOISE:g}+ to let crop_to_mask "
         f"render this region larger, or expand the mask.")


def _render_scale(w, h, megapixels, denoise):
    """Compute a render scale within the pixel budget, accounting for denoise."""
    scale = math.sqrt(max(0.01, float(megapixels)) * 1_000_000.0 / float(w * h))
    try:
        d = float(denoise)
    except (TypeError, ValueError):
        d = 1.0
    if d != d:
        d = 1.0
    capped = scale > 1.0 and d < _UPSCALE_SAFE_DENOISE
    return (1.0 if capped else scale), capped


def _vae_encode(vae, pixels):
    """Encode pixels and normalize the image latent shape returned by the VAE."""
    try:
        return vae.encode(pixels)
    except RuntimeError as e:
        raise ValueError(
            f"PowderImageCond: VAE failed to encode a {pixels.shape[2]}x{pixels.shape[1]} "
            f"image — this VAE needs a larger input ({e})") from e


def _model_patch_size(model):
    """Spatial (ph, pw) latent patch of the diffusion model; (1, 1) if unknown.

    Patch-based DiTs pack a ph x pw block of LATENT cells into one token, so
    the smallest thing they can preserve or repaint is that block, not a
    latent cell. Krea2 names the attribute `patch` (int), the Flux family
    `patch_size` (int or a [t, h, w] list on video models); UNet models have
    neither and get (1, 1), which turns every alignment below into a no-op.
    """
    try:
        dm = getattr(getattr(model, "model", None), "diffusion_model", None)
        if dm is None:
            return (1, 1)
        for attr in ("patch_size", "patch"):
            v = getattr(dm, attr, None)
            if isinstance(v, bool) or v is None:
                continue
            if isinstance(v, int):
                return (max(1, v), max(1, v))
            if isinstance(v, (tuple, list)) and len(v) >= 2:
                return (max(1, int(v[-2])), max(1, int(v[-1])))
    except (TypeError, ValueError, AttributeError):
        pass
    return (1, 1)


def _token_aligned_mask(mask, ds, ph, pw):
    """Align a sampling mask to model token boundaries so partially covered tokens remain editable."""
    lh, lw = mask.shape[-2] // ds, mask.shape[-1] // ds
    if lh < 1 or lw < 1:
        return None
    m = torch.nn.functional.interpolate(mask, size=(lh, lw), mode="area")
    if (ph, pw) != (1, 1):
        # ceil_mode: the latent grid need not divide by the patch — the model
        # pads it up, so the trailing partial block is a real token too.
        m = torch.nn.functional.max_pool2d(m, (ph, pw), stride=(ph, pw),
                                           ceil_mode=True)
        m = m.repeat_interleave(ph, -2).repeat_interleave(pw, -1)[..., :lh, :lw]
    return m


def _grow_mask(mask, radius):
    """Dilate a [B,1,H,W] mask by `radius` px (separable max-pool).

    The redraw band (krea2-anypaint's `boundary_redraw_px`): instead of only
    blending our own pixels across the seam afterwards, hand the MODEL a ring
    of context around the mask and let it rebuild the transition. Feathering
    matches tone; only regeneration can carry a line, fold or edge across the
    boundary. The two compose — the band moves the seam outward to where the
    content already agrees, `stitch_blend` then hides what is left of it.

    Separable (two 1D passes) because max is separable and the naive square
    kernel is O(k^2) per pixel. Even separable it stays O(k) per pixel per
    axis, so a wide band on a large frame is billions of operations on a
    CPU-side mask — above 32 px the dilation moves to a downsampled copy
    instead. The band's outer edge then lands within `f` pixels of the exact
    one, which is invisible on a feature whose whole point is approximate.
    """
    r = int(radius)
    if r <= 0:
        return mask
    f = 1
    while r // f > 32:
        f *= 2
    if f == 1:
        return _dilate_exact(mask, r)
    h, w = mask.shape[-2], mask.shape[-1]
    small = torch.nn.functional.max_pool2d(mask, f, stride=f, ceil_mode=True)
    small = _dilate_exact(small, max(1, int(round(r / f))))
    return torch.nn.functional.interpolate(small, size=(h, w), mode="nearest")


def _dilate_exact(mask, r):
    k = 2 * r + 1
    m = torch.nn.functional.max_pool2d(mask, (1, k), stride=1, padding=(0, r))
    return torch.nn.functional.max_pool2d(m, (k, 1), stride=1, padding=(r, 0))


def _blank_masked(pixels, mask):
    """Erase the masked region from a reference, filling with the kept median.

    An edit reference showing the very object the prompt asks to replace
    argues against the prompt. Median of the PRESERVED pixels (not the stock
    0.5 gray) keeps the fill neutral to the frame's own exposure — gray is
    only neutral on a mid-gray image (krea2-anypaint's `prepare_canvas`).

    A mask that covers everything leaves nothing to take a median from; the
    reference is then passed through untouched rather than filled with a
    made-up color.
    """
    out = pixels.clone()
    m = mask.reshape(mask.shape[0], mask.shape[-2], mask.shape[-1])
    for b in range(out.shape[0]):
        keep = m[min(b, m.shape[0] - 1)] < 0.5
        if not bool(keep.any()):
            continue
        for i in range(min(3, out.shape[-1])):
            ch = out[b, :, :, i]
            ch[~keep] = ch[keep].median()
    return out


def _fit_reference(pixels, megapixels, ds):
    """Downscale (never upscale) a reference image and snap it to the VAE grid.

    Returns (pixels, changed). reference_latents ride in the attention
    sequence for every step of every batch item, so their cost is quadratic
    in area — a 4 MP source doubles the sequence a 1 MP one would build.
    Both upstream implementations cap here (ostris: 1 MP ref latents / 384 px
    VLM, anypaint: 384 px) and neither ever upscales, because a reference
    larger than the model was trained on buys nothing.

    The grid snap matters for EXTRA references, which arrive at whatever size
    the user's image happens to be: an off-grid reference leaves the padding
    to the VAE's own rounding, and the token count then disagrees with the
    size we logged. Snapping (a resize, never a pad — black bars would be
    content to the model) keeps it predictable. Sources are already aligned,
    so this is a no-op for them and the caller still reuses their latent.
    """
    h, w = int(pixels.shape[1]), int(pixels.shape[2])
    budget = max(0.1, float(megapixels)) * 1_000_000.0
    scale = min(1.0, math.sqrt(budget / float(h * w)))
    nh = max(ds, int(round(h * scale / ds)) * ds)
    nw = max(ds, int(round(w * scale / ds)) * ds)
    if (nh, nw) == (h, w):
        return pixels, False
    out = torch.nn.functional.interpolate(
        pixels.movedim(-1, 1), size=(nh, nw), mode="bicubic",
        antialias=nh * nw < h * w).movedim(1, -1).clamp(0.0, 1.0)
    return out, True


def _crop_box(mask, sizing, megapixels, width, height, context_percent, ds,
              denoise=1.0):
    """Mask bbox -> (x, y, w, h, tw, th): crop rect in source coords + target size.

    (x, y, w, h) is the region cut from the source (grid-aligned, clamped);
    (tw, th) is the resolution the generation runs at. None = empty mask or
    the image is smaller than one VAE grid cell (nothing sane to crop).
    On images not a multiple of ds in size, up to ds-1 border pixels may
    fall outside any possible crop.
    """
    H, W = int(mask.shape[-2]), int(mask.shape[-1])
    if W < ds or H < ds:
        return None
    flat = mask.reshape(-1, H, W).amax(dim=0)
    # Hipass threshold (CropAndStitch practice): near-black brush residue
    # must not inflate the bbox to the whole image. Feather tails below the
    # threshold are re-captured by the context margin.
    ys, xs = torch.nonzero(flat > 0.05, as_tuple=True)
    if ys.numel() == 0:
        return None
    x0, x1 = float(xs.min()), float(xs.max()) + 1.0
    y0, y1 = float(ys.min()), float(ys.max()) + 1.0
    # context margin: percent of the bbox size, per side
    mx = (x1 - x0) * context_percent / 100.0
    my = (y1 - y0) * context_percent / 100.0
    x0, x1, y0, y1 = x0 - mx, x1 + mx, y0 - my, y1 + my
    if sizing == "fixed" and width > 0 and height > 0:
        # grow the shorter dimension toward the target aspect — capture more
        # context rather than distort on resize. Use asymmetric growth: when
        # one side hits the image edge, push overflow onto the opposite side.
        target = width / height
        w, h = x1 - x0, y1 - y0
        if w / h < target:
            grow = (h * target - w) / 2.0
            x0, x1 = x0 - grow, x1 + grow
            # asymmetric: if a side goes out of bounds, shift to the other
            if x0 < 0:
                x1 -= x0
                x0 = 0
            if x1 > W:
                x0 -= (x1 - W)
                x1 = W
        else:
            grow = (w / target - h) / 2.0
            y0, y1 = y0 - grow, y1 + grow
            if y0 < 0:
                y1 -= y0
                y0 = 0
            if y1 > H:
                y0 -= (y1 - H)
                y1 = H
    # clamp to the image, snap the SIZE up to the grid, then position to
    # maximize mask-bbox coverage (not centered)
    x0i, y0i = max(0, int(x0)), max(0, int(y0))
    x1i, y1i = min(W, int(math.ceil(x1))), min(H, int(math.ceil(y1)))
    w = min(max(ds, ((x1i - x0i + ds - 1) // ds) * ds), (W // ds) * ds)
    h = min(max(ds, ((y1i - y0i + ds - 1) // ds) * ds), (H // ds) * ds)
    # position to contain the bbox: start at x0i, but slide to stay in bounds
    x = max(0, min(x0i, W - w))
    y = max(0, min(y0i, H - h))
    if sizing == "fixed" and width > 0 and height > 0:
        tw = max(ds, (int(width) // ds) * ds)
        th = max(ds, (int(height) // ds) * ds)
        # NKD practice: when border clamping kept the bbox from reaching the
        # target aspect, re-derive the render size from the ACTUAL bbox
        # aspect at the same pixel budget — a uniform scale beats stretching
        # to the exact WxH (the 2% tolerance absorbs grid rounding).
        if abs(w / h - tw / th) > 0.02:
            scale = math.sqrt(float(tw * th) / float(w * h))
            tw = max(ds, round(w * scale / ds) * ds)
            th = max(ds, round(h * scale / ds) * ds)
    else:
        scale, _ = _render_scale(w, h, megapixels, denoise)
        tw = max(ds, round(w * scale / ds) * ds)
        th = max(ds, round(h * scale / ds) * ds)
    return (int(x), int(y), int(w), int(h), int(tw), int(th))


MODES = ("Generate", "Repaint", "Edit", "Edit (native)", "Repair")
EDIT_SEED_SALT = 0x45444954  # "EDIT"
# Legacy combo values (pre-merge saves / API prompts) map onto the pair.
_LEGACY_MODES = {
    "Inpaint": "Repaint",
    "Img2Img": "Repaint",
    "Edit — whole image": "Edit",
    "Edit — masked region": "Edit",
}
# Repair is Repaint with the numbers pre-set by the frontend (denoise 0.9,
# crop_to_mask auto): a one-click way to redo a broken hand or a torn edge
# without remembering three widgets. Server-side there is nothing to branch on.
_MODE_ALIASES = {"Repair": "Repaint"}

# Session-scoped so a 40-image queue says it once, not forty times.
_NO_MODEL_WARNED = False


def _warn_missing_model():
    """Warn once when model-dependent image conditioning cannot be configured."""
    global _NO_MODEL_WARNED
    if _NO_MODEL_WARNED:
        return
    _NO_MODEL_WARNED = True
    warn("[PowderImageCond] the `model` input is not connected — three things are "
         "silently off: Differential Diffusion (seamless_mask_blend has no effect), "
         "concat=auto (falls back to on), and the token-aligned noise mask for patch "
         "models (Flux/Krea2), whose mask edge is what usually shows as a seam. Run "
         "the model through this node: loader -> model in, model out -> sampler.")


class PowderImageConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE", {"lazy": True}),
                "pixels": ("IMAGE", {"lazy": True}),
                "mask": ("MASK", {"lazy": True}),
                "mode": (list(MODES), {"default": "Repaint",
                         "tooltip": "Generate: text-to-image; ignores canvas and mask, uses t2i_latent (required for video VAEs such as Krea). Repaint: ordinary img2img; describe the final image, start at denoise 0.5. Edit: instruction editing with compatible edit weights; builds the reference here. Edit (native): instruction editing when an upstream native encoder already supplies references, e.g. Boogu Edit or ReferenceMultiLatent; keeps that conditioning without adding duplicate references. Edit normally uses denoise 1. In all image modes a painted mask limits the area; an empty mask edits the whole image. Repair: Repaint with a crop around the mask."}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64,
                                       "tooltip": "N variants: the latent is repeated N times (video-VAE safe). Wire PowderCanvas's batch_size output here."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                      "tooltip": "Passthrough dial: wire the denoise OUTPUT to the sampler. Auto-set on mode change (Generate/Edit 1.0, Repaint 0.6, Repair 0.9) — override freely."}),
                "seamless_mask_blend": ("BOOLEAN", {"default": True,
                                                    "tooltip": "Differential Diffusion: gray mask levels set per-pixel edit strength, feathered edges blend seamlessly. Needs the model input; no-op in unmasked modes."}),
                "concat": (["auto", "on", "off"], {"default": "auto",
                           "tooltip": "Masked-pixels concat branch for dedicated inpaint models. auto: decided by the connected model (on when unknown). off saves a full VAE encode."}),
                "hard_concat_mask": ("BOOLEAN", {"default": False,
                                                 "tooltip": "True = stock InpaintModelConditioning behavior (hard 0/1 concat mask). False keeps feathered edges."}),
                "ignore_mask": ("BOOLEAN", {"default": False,
                                            "tooltip": "One-off whole-image pass while KEEPING the painted mask: treats the mask as empty without clearing it on the canvas."}),
            },
            "optional": {
                # These five are real widgets (not sockets) — kept in
                # "optional" ONLY so that API prompts exported before
                # crop-to-mask existed still validate (encode() supplies
                # Python defaults for all five; behavior is unchanged).
                # Placed first among "optional" so the required-then-optional
                # widgets_values ordering matches pre-crop saved prompts.
                "crop_to_mask": (["off", "auto", "fixed"], {"default": "off",
                    "tooltip": "Generate the masked region as its own canvas: crop the mask bbox (+context), run at the target size, then stitch back via Powder Canvas Review's stitch input. auto: size from the crop_megapixels BUDGET and the bbox aspect, capped at 1:1 below denoise 0.9. fixed: exact crop_width x crop_height (bbox grows to that aspect, no distortion; when image borders make that aspect unreachable, the render size adapts to the bbox aspect at the same pixel budget instead of stretching)."}),
                "crop_megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16.0, "step": 0.1,
                    "tooltip": "auto crop: an UPPER pixel budget for the crop canvas (1.0 ≈ SDXL/FLUX native). The render never exceeds the masked region's own size while denoise is below 0.9 — a partially denoised upscale comes back mottled — so raising this above the region only matters at denoise 0.9+. Setting it BELOW the region renders the area smaller than itself and the stitch scales it back up, which returns soft."}),
                "crop_width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8,
                    "tooltip": "fixed crop: exact generation width."}),
                "crop_height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8,
                    "tooltip": "fixed crop: exact generation height."}),
                "context_percent": ("FLOAT", {"default": 20.0, "min": 0.0, "max": 200.0, "step": 5.0,
                    "tooltip": "Context margin around the mask bbox, percent of its size per side — the model needs surroundings to match style and light."}),
                "stitch_blend": ("INT", {"default": 16, "min": 0, "max": 64, "step": 1,
                    "tooltip": "Paste-back feather in pixels: the seam between the stitched region and the original fades over this width, hiding resize softness and tonal steps. 0 = hard edge."}),
                "mask_grow": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Redraw band, in pixels of the SOURCE image: widen the mask so the MODEL repaints a ring around it. stitch_blend only blends our own pixels across the seam — it matches tone but cannot carry a line, fold or edge across the boundary; a band lets the model rebuild the transition itself. Widens the crop box too, so the band is inside the generated area. Needs a painted mask. Try 16 on a 1 MP frame, more on a large one. 0 = off."}),
                "reference_megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16.0, "step": 0.1,
                    "tooltip": "Edit mode: size cap for the EXTRA references from Powder References, downscale only. Those are read for composition and subject, so a character sheet at 1 MP is enough and a bigger one only lengthens the attention sequence on every step. The SOURCE is never capped — it is the frame being edited, and a reference coarser than the render comes back as grain and invented detail."}),
                "blank_reference": ("BOOLEAN", {"default": False,
                    "tooltip": "Edit mode with a mask: erase the masked region from the reference (filled with the median of the kept pixels) so the model is not shown the very thing the prompt asks it to replace. Off = the reference is the untouched source."}),
                "references": ("POWDER_REFS", {
                    "tooltip": "Extra reference images from Powder References (Edit mode only): a character sheet, a product shot, a style plate. They are appended AFTER the source, so the model reads them as 'Picture 2, Picture 3, ...'. Wire the same bundle into Powder Conditioner so the text encoder describes the same set the model attends to."}),
                "model": ("MODEL",),
                "t2i_latent": ("LATENT", {"lazy": True}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "MODEL", "FLOAT", "POWDER_STITCH")
    RETURN_NAMES = ("positive", "negative", "latent", "model", "denoise", "stitch")
    FUNCTION = "encode"
    CATEGORY = "e2go"

    def check_lazy_status(self, positive, negative, vae=None, pixels=None, mask=None,
                          mode="Repaint", batch_size=1, denoise=1.0,
                          seamless_mask_blend=True, concat="auto",
                          hard_concat_mask=False, ignore_mask=False,
                          crop_to_mask="off", crop_megapixels=1.0, crop_width=1024,
                          crop_height=1024, context_percent=20.0,
                          model=None, **kwargs):


        mode = _LEGACY_MODES.get(mode, mode)
        mode = _MODE_ALIASES.get(mode, mode)
        if mode == "Generate":
            needed = []
            # Ask for t2i_latent ONLY when it is connected (present) and not yet
            # evaluated (None). Unconnected -> skip; encode() then builds an
            # empty latent sized from the model/canvas. pixels is always
            # requested for that size fallback (the canvas OUTPUT_NODE runs
            # regardless of mode).
            if "t2i_latent" in kwargs and kwargs["t2i_latent"] is None:
                needed.append("t2i_latent")
            if "t2i_latent" not in kwargs and pixels is None:
                needed.append("pixels")
            return needed
        return [n for n, v in (("pixels", pixels), ("vae", vae), ("mask", mask)) if v is None]

    def encode(self, positive, negative, vae=None, pixels=None, mask=None, mode="Repaint",
               batch_size=1, denoise=1.0,
               seamless_mask_blend=True, concat="auto",
               hard_concat_mask=False, ignore_mask=False,
               crop_to_mask="off", crop_megapixels=1.0, crop_width=1024,
               crop_height=1024, context_percent=20.0, stitch_blend=16,
               mask_grow=0, reference_megapixels=1.0, blank_reference=False,
               references=None, model=None, t2i_latent=None,
               prompt=None, unique_id=None,
               auto_steps=None, sampler_steps=None):


        import node_helpers  # lazy: not available outside ComfyUI
        mode = _LEGACY_MODES.get(mode, mode)
        if mode != 'Generate' and getattr(pixels, '_e2go_empty_canvas', False):
            raise ValueError('Canvas is empty. Load an image before Repaint, Edit or Repair.')
        # Repair is a spot fix in its own crop; the frontend pre-sets this when
        # the mode is picked, an API prompt may not.
        if mode == "Repair" and crop_to_mask == "off":
            crop_to_mask = "auto"
        mode = _MODE_ALIASES.get(mode, mode)
        if mode == "Generate":


            n = max(1, int(batch_size))
            out_latent = {}
            if t2i_latent is not None:


                out_latent = dict(t2i_latent)
                samples = t2i_latent["samples"]
                if samples.shape[0] == 1 and n > 1:
                    samples = samples.repeat((n,) + (1,) * (samples.ndim - 1))
            else:
                lf = getattr(getattr(model, "model", None), "latent_format", None)
                if lf is None:
                    raise ValueError(
                        "PowderImageCond: Generate needs either t2i_latent or a connected model "
                        "(its latent_format sizes the empty latent)")
                if pixels is None:
                    raise ValueError(
                        "PowderImageCond: Generate without t2i_latent needs pixels (the canvas) for the size")
                # comfy/latent_formats.py names it spacial_downscale_ratio
                # (8 base, 16 Flux2, 32 LTXV...); older forks used
                # downscale_ratio — check both before the /8 fallback.
                ds_lf = int(getattr(lf, "spacial_downscale_ratio", None)
                            or getattr(lf, "downscale_ratio", 8))
                if int(getattr(lf, "latent_dimensions", 2)) != 2:
                    raise ValueError(
                        "PowderImageCond: Generate fallback supports 2D image latents only — "
                        "connect a proper empty latent to t2i_latent for video models")
                height, width = pixels.shape[1:3]
                if height < ds_lf or width < ds_lf:
                    raise ValueError(
                        f"PowderImageCond: canvas size {width}x{height} is smaller "
                        f"than the /{ds_lf} latent grid; increase width and height")


                try:
                    import comfy.model_management as _mm
                    dev = _mm.intermediate_device()
                except Exception:
                    dev = None
                samples = torch.zeros(
                    (n, int(lf.latent_channels), pixels.shape[1] // ds_lf, pixels.shape[2] // ds_lf),
                    device=dev)
                # Keep the pixel scale if this empty latent is later sampled
                # with a different model, as Powder Resolution does.
                out_latent["downscale_ratio_spacial"] = ds_lf
            info(f"[PowderImageCond] mode=Generate, batch={n}, denoise={float(denoise):g}, "
                 f"t2i={'ext' if t2i_latent is not None else 'auto'}")
            out_latent["samples"] = samples
            return (positive, negative, out_latent, model, float(denoise), {"active": False})
        if model is None:
            _warn_missing_model()
        reference_latent = mode == "Edit"
        # The mask itself decides regional vs whole-image: any painted pixel
        # attaches it as the sampling noise mask; an empty mask means the
        # whole frame is fair game (img2img / whole-image edit).
        has_mask = bool(not ignore_mask and mask is not None and float(mask.max()) > 0.0)
        noise_mask = has_mask
        if ignore_mask and mask is not None:
            # "Treat the mask as empty" must hold for EVERY consumer: the
            # concat features (blanked pixels + concat_mask) as well as the
            # sampler's noise_mask. Zeroing here makes that structural.
            mask = torch.zeros_like(mask)
        # --- resolve the concat mode -------------------------------------
        if concat == "auto":
            if model is not None:
                # Dedicated inpaint models declare concat_keys on the base model.
                concat_on = bool(getattr(getattr(model, "model", None), "concat_keys", ()))
            else:
                concat_on = True  # unknown model: stay stock-compatible
        else:
            concat_on = concat == "on"

        # --- geometry: like the stock node, but the grid follows the VAE's
        # actual spatial compression (4/8/16/32...) instead of a hardcoded 8.
        # Same API the core VAEEncodeForInpaint uses; fallback 8 for old VAEs.
        try:
            ds = int(vae.spacial_compression_encode())
        except (AttributeError, TypeError):
            ds = 8
        x = (pixels.shape[1] // ds) * ds
        y = (pixels.shape[2] // ds) * ds
        if x < ds or y < ds:


            raise ValueError(
                f"PowderImageCond: input {pixels.shape[2]}x{pixels.shape[1]} is smaller "
                f"than one VAE grid cell ({ds}px) — nothing to sample")
        mask = torch.nn.functional.interpolate(
            mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])),
            size=(pixels.shape[1], pixels.shape[2]), mode="bilinear")
        # Match each source frame with its mask before concat or cropping.
        # A singleton input is shared; larger batches repeat cyclically.
        count = max(pixels.shape[0], mask.shape[0])
        if pixels.shape[0] != count:
            pixels = pixels[torch.arange(count, device=pixels.device) % pixels.shape[0]]
        if mask.shape[0] != count:
            mask = mask[torch.arange(count, device=mask.device) % mask.shape[0]]
        # Redraw band BEFORE anything reads the mask: the crop box must contain
        # the band, the stitch must paste it back (otherwise we blend the
        # original straight over the transition the model just rebuilt), and
        # the concat/noise masks must agree with both.
        if has_mask and int(mask_grow) > 0:
            mask = _grow_mask(mask, mask_grow)
        # full-frame (pre-grid-trim) mask: the stitch context rides alongside
        # orig_pixels, which also stays pre-trim below — same coordinate space.
        full_mask = mask

        orig_pixels = pixels
        pixels = orig_pixels.clone()
        x_offset = y_offset = 0
        if pixels.shape[1] != x or pixels.shape[2] != y:
            x_offset = (pixels.shape[1] % ds) // 2   # row trim (pixels dim 1)
            y_offset = (pixels.shape[2] % ds) // 2   # col trim (pixels dim 2)


            info(f"[PowderImageCond] input {pixels.shape[2]}x{pixels.shape[1]} is not a "
                 f"multiple of the VAE grid ({ds}) — sampling at {y}x{x}; the stitch "
                 f"output restores the original size (wire it to Powder Canvas Review)")
            pixels = pixels[:, x_offset:x + x_offset, y_offset:y + y_offset, :]
            mask = mask[:, :, x_offset:x + x_offset, y_offset:y + y_offset]

        # --- crop-to-mask: the masked region becomes its own canvas -------
        stitch = {"active": False}
        if crop_to_mask != "off" and has_mask:
            box = _crop_box(mask.amax(dim=0), crop_to_mask, crop_megapixels,
                            crop_width, crop_height, context_percent, ds,
                            denoise)
            if box is None:
                warn("[PowderImageCond] crop_to_mask: mask/image unusable — full-frame fallback")
            else:
                cx, cy, cw, ch, tw, th = box
                # bbox is in trimmed-space (cx=col, cy=row); offset into the
                # full (pre-trim) space that stitch["source"]/["mask"] use.
                stitch = {"active": True, "source": orig_pixels.clone(),
                          "bbox": (cx + y_offset, cy + x_offset, cw, ch),
                          "mask": full_mask.squeeze(1).clone(),
                          "crop_size": (tw, th),
                          "blend": max(0, int(stitch_blend))}
                if not _stitch_consumed(prompt, unique_id):
                    warn("[PowderImageCond] crop_to_mask is ON but the stitch output "
                         "is not connected — the decoded result will be the CROP, "
                         "not the full image. Wire stitch -> Powder Canvas Review.")
                pixels = pixels[:, cy:cy + ch, cx:cx + cw, :]
                mask = mask[:, :, cy:cy + ch, cx:cx + cw]
                if (ch, cw) != (th, tw):
                    # Direction-aware resample, same rule the stitch already
                    # uses: antialiased on the way down (kills the "visible
                    # pixels" aliasing), plain bicubic on the way up. bicubic
                    # overshoots -> clamp back into range.
                    down = th * tw < ch * cw
                    pixels = torch.nn.functional.interpolate(
                        pixels.movedim(-1, 1), size=(th, tw), mode="bicubic",
                        antialias=down).movedim(1, -1).clamp(0.0, 1.0)
                    mask = torch.nn.functional.interpolate(
                        mask, size=(th, tw), mode="bilinear", antialias=down)
                    _warn_upscaled_crop(cw, ch, tw, th, denoise, crop_to_mask)
                    _warn_downscaled_crop(cw, ch, tw, th, crop_to_mask)
                # .clone() — the concat branch below mutates `pixels` in
                # place (blank-to-0.5 loop); orig_pixels must not alias it,
                # or the source/reference encode would see the blanked image.
                orig_pixels = pixels.clone()
                info(f"[PowderImageCond] crop {cw}x{ch}@({cx},{cy}) -> {tw}x{th} "
                     f"— the model sees only this region, so the prompt describes it, not the whole frame")
                if crop_to_mask == "auto" and _render_scale(
                        cw, ch, crop_megapixels, denoise)[1]:
                    _warn_capped_render_too_small(cw, ch, denoise)
                    info(f"[PowderImageCond] crop_megapixels {float(crop_megapixels):g} "
                         f"would upscale this region; capped to 1:1 because denoise "
                         f"{float(denoise):g} is below {_UPSCALE_SAFE_DENOISE:g} — a "
                         f"partially denoised upscale comes back mottled")


        if (not stitch["active"]
                and (orig_pixels.shape[1] != pixels.shape[1]
                     or orig_pixels.shape[2] != pixels.shape[2])):
            if has_mask:
                stitch = {"active": True, "source": orig_pixels.clone(),
                          "bbox": (y_offset, x_offset, y, x),
                          "mask": full_mask.squeeze(1).clone(),
                          "crop_size": (y, x),
                          "blend": max(0, int(stitch_blend))}
            else:
                stitch = {"active": True,
                          "cover": (orig_pixels.shape[1], orig_pixels.shape[2])}
            if not _stitch_consumed(prompt, unique_id):
                warn(f"[PowderImageCond] input was trimmed to the VAE grid — wire "
                     f"stitch -> Powder Canvas Review to get the original "
                     f"{orig_pixels.shape[2]}x{orig_pixels.shape[1]} back")
            # Encode the sampled latent from the TRIMMED clean pixels (clone:
            # the concat branch below mutates `pixels` in place): the decoded
            # frames then align exactly with the paste box above. Encoding the
            # pre-trim source instead would leave the frame size to the VAE's
            # own internal rounding — off-by-offset paste misalignment.
            orig_pixels = pixels.clone()

        # A noise mask preserves LATENTS, not pixels: even an untouched latent
        # changes on a lossy VAE round trip. Composite full-frame inpainting as
        # well as cropped inpainting so Review restores the original background.
        if has_mask and not stitch["active"]:
            h, w = pixels.shape[1:3]
            stitch = {"active": True, "source": orig_pixels.clone(),
                      "bbox": (0, 0, w, h), "mask": full_mask.squeeze(1).clone(),
                      "crop_size": (w, h), "blend": max(0, int(stitch_blend))}
            if not _stitch_consumed(prompt, unique_id):
                warn("[PowderImageCond] wire stitch -> Powder Canvas Review to preserve "
                     "the original pixels outside the mask after VAE decoding")

        # --- concat branch (only when the model actually consumes it) -----
        if concat_on:
            concat_mask = mask.round() if hard_concat_mask else mask
            m = (1.0 - concat_mask).squeeze(1)
            for i in range(3):
                pixels[:, :, :, i] -= 0.5
                pixels[:, :, :, i] *= m
                pixels[:, :, :, i] += 0.5
            concat_latent = _vae_encode(vae, pixels)
            values = {"concat_latent_image": concat_latent, "concat_mask": concat_mask}
            positive = node_helpers.conditioning_set_values(positive, values)
            negative = node_helpers.conditioning_set_values(negative, values)

        orig_latent = _vae_encode(vae, orig_pixels)

        # --- edit-model reference (built-in VAEEncode + ReferenceLatent) ----
        # Core semantics (comfy_extras/nodes_edit_model.py): append the source
        # latent under "reference_latents". PRE-batch latent on purpose — one
        # reference guides every batch variant.
        extra_refs = unpack_references(references)
        if extra_refs and not reference_latent:
            # Silently dropping a wired bundle is the worst outcome: the graph
            # LOOKS like it carries references and the model never sees them.
            warn(f"[PowderImageCond] {len(extra_refs)} reference image(s) are wired but "
                 f"mode={mode} ignores them — reference_latents only mean something to "
                 f"an edit model. Switch mode to Edit, or unwire the references.")
        if reference_latent:


            ref_pixels = orig_pixels
            blanked = bool(blank_reference) and has_mask
            if blanked:
                ref_pixels = _blank_masked(ref_pixels, mask)
                # A second encode only when the reference actually differs from
                # the sampled latent — the common case still costs one.
                ref_latent = _vae_encode(vae, ref_pixels)
                info(f"[PowderImageCond] reference {ref_pixels.shape[2]}x"
                     f"{ref_pixels.shape[1]}, masked region blanked")
            else:
                ref_latent = orig_latent
            # The SOURCE stays Picture 1 — it is the image being edited, and
            # every edit model puts the edited frame first. Extras follow in
            # the order Powder References packed them.
            ref_latents = [ref_latent]
            extra_px = 0
            if extra_refs and not _refs_reach_the_text_encoder(prompt, unique_id):
                warn("[PowderImageCond] the references are wired here but not into "
                     "Powder Conditioner — the model will attend to images the text "
                     "encoder never saw, so a prompt like 'the same coat' has no "
                     "referent. Wire the SAME Powder References output into the "
                     "conditioner's references input.")
            for i, extra in enumerate(extra_refs):
                fitted, _changed = _fit_reference(
                    extra.to(device=orig_pixels.device, dtype=orig_pixels.dtype),
                    reference_megapixels, ds)
                ref_latents.append(_vae_encode(vae, fitted))
                extra_px += int(fitted.shape[1]) * int(fitted.shape[2])
                info(f"[PowderImageCond] reference {i + 2}: "
                     f"{fitted.shape[2]}x{fitted.shape[1]}")
            # Token share, not just sizes: pixel area is proportional to token
            # count whatever the patch size, so this is the number that says
            # "why did sampling slow down". References are attended to on
            # EVERY step, and the sequence they extend is per batch item.
            # EXTRAS only: the source now always matches the render, so counting
            # it would fire this line on every single Edit and say nothing.
            canvas_px = int(orig_pixels.shape[1]) * int(orig_pixels.shape[2])
            share = extra_px / max(1, canvas_px)
            if share >= 0.5:
                info(f"[PowderImageCond] the EXTRA references extend the attention "
                     f"sequence by ~{share * 100:.0f}% of the render itself (on top of "
                     f"the source), on every step and every batch item — if steps "
                     f"crawl, lower reference_megapixels, the batch, or the render size")
            # Families that splice latents INTO the vision slots (Qwen Image
            # 2.1) need slot i to be the latent of the picture the encoder saw
            # at slot i. The encoder records the slots on the conditioning;
            # a count mismatch means the source was not shown as Picture 1
            # (edited_image unwired) and slot 1 would receive the wrong image.
            slots = positive[0][1].get("image_slots") if positive and len(positive[0]) > 1 else None
            if isinstance(slots, list) and len(slots) != len(ref_latents):
                raise ValueError(
                    f"PowderImageCond: the text encoder saw {len(slots)} reference image(s) "
                    f"but {len(ref_latents)} reference latent(s) are going in — on this model "
                    f"they are spliced by position. Wire Powder Canvas's image into Powder "
                    f"References' edited_image so the encoder sees the source as Picture 1.")
            if slots is None and profile_for_model(model).refs_in_slots:
                warn("[PowderImageCond] Edit on a model that splices reference latents into "
                     "the prompt, but the text encoder never saw the source — the latent goes "
                     "AFTER the text, unlike the core Qwen 2.1 node. Wire Powder Canvas's image "
                     "into Powder References' edited_image and the bundle into Powder Conditioner.")
            # Both branches, like ReferenceLatent in the core Klein edit
            # blueprint: with the reference on positive only, CFG > 1
            # extrapolates "with reference minus WITHOUT reference" and burns
            # the frame. At cfg == 1 ComfyUI never evaluates uncond, so this
            # costs nothing there.
            values = {"reference_latents": ref_latents}
            positive = node_helpers.conditioning_set_values(
                positive, values, append=True)
            negative = node_helpers.conditioning_set_values(
                negative, values, append=True)
            reference_method = family_of(model).reference_method
            if reference_method is not None:
                routing = {"reference_latents_method": reference_method}
                positive = node_helpers.conditioning_set_values(positive, routing)
                negative = node_helpers.conditioning_set_values(negative, routing)

        # --- latent-space batch (ndim-agnostic: works for 5D video latents)
        n = max(1, int(batch_size))
        if n > 1:
            orig_latent = orig_latent.repeat((n,) + (1,) * (orig_latent.ndim - 1))

        out_latent = {"samples": orig_latent}
        if reference_latent or mode == "Edit (native)":
            # Powder Sampler offsets its noise seed by this. An edit whose
            # noise equals the noise the source was generated from (same seed,
            # same size) comes back as an overcooked copy of the source.
            out_latent["seed_salt"] = EDIT_SEED_SALT
        if noise_mask:
            # Token alignment: hand a patch DiT a mask it can actually honour.
            # Latent resolution on purpose — ComfyUI's reshape_mask resizes the
            # noise mask to the latent shape anyway, so an already-latent mask
            # passes through untouched instead of being bilinear-smeared back
            # across the token boundaries we just squared off.
            ph, pw = _model_patch_size(model)
            if (ph, pw) != (1, 1):
                aligned = _token_aligned_mask(mask, ds, ph, pw)
                if aligned is not None:
                    mask = aligned
                    info(f"[PowderImageCond] noise mask aligned to the model's "
                         f"{ph}x{pw} latent patch ({aligned.shape[-1]}x{aligned.shape[-2]} tokens)")


            if n > 1 and mask.shape[0] > 1:
                mask = mask.repeat((n,) + (1,) * (mask.ndim - 1))
            out_latent["noise_mask"] = mask

        # --- optional Differential Diffusion patch ------------------------
        out_model = model
        if model is not None and seamless_mask_blend:
            out_model = _apply_differential_diffusion(model)

        scope = "region" if has_mask else "whole"
        info(f"[PowderImageCond] {pixels.shape[2]}x{pixels.shape[1]}, mode={mode}({scope}), batch={n}, "
             f"concat={'on' if concat_on else 'off'}, blend={bool(model is not None and seamless_mask_blend)}, "
             f"ref={bool(reference_latent)}, denoise={float(denoise):g}")
        return (positive, negative, out_latent, out_model, float(denoise), stitch)


NODE_CLASS_MAPPINGS = {
    "PowderImageConditioning": PowderImageConditioning,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderImageConditioning": "Powder Image Conditioning",
}
