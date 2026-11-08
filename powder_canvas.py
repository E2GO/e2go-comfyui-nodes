"""Canvas image and mask inputs, persistent snapshots and reviewed image outputs."""

import hashlib
import json
import os

import numpy as np
import torch
from PIL import Image

from ._log import info, log, warn
from ._files import plain_filename

CANVAS_SUBFOLDER = "e2go_canvas"


def _canvas_dir() -> str:
    import folder_paths  # lazy: not available outside ComfyUI
    root = os.path.realpath(folder_paths.get_input_directory())
    d = os.path.join(root, CANVAS_SUBFOLDER)
    if os.path.realpath(d) != d:
        raise ValueError("Canvas storage cannot redirect outside its asset directory")
    os.makedirs(d, exist_ok=True)
    return d


def _resolve(name: str) -> str | None:
    """Path inside input/e2go_canvas/ for a config filename, or None.

    The frontend writes plain PNG filenames. Reject malformed paths rather
    than interpreting them, and reject file links outside the asset directory.
    """
    if not plain_filename(name) or not name.lower().endswith(".png"):
        return None
    root = os.path.realpath(_canvas_dir())
    path = os.path.join(root, name)
    if os.path.islink(path) or os.path.dirname(os.path.realpath(path)) != root:
        return None
    return path if os.path.isfile(path) else None


def _load_image(path: str) -> torch.Tensor | None:
    """PNG -> [1, H, W, 3] float32 0..1, or None if unreadable.

    A truncated/corrupt file must degrade like a missing one — a raise here
    aborts the whole queue with a traceback, the exact failure the
    placeholder logic in run() exists to avoid."""
    try:
        img = Image.open(path).convert("RGB")
        arr = np.asarray(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr)[None, ...]
    except Exception as e:
        warn(f"[PowderCanvas] {path} unreadable: {e} — falling back to the raw input image")
        return None


def _load_mask(path: str) -> torch.Tensor | None:
    """PNG -> [1, H, W] float32 0..1 (luminance; white = inpaint), or None."""
    try:
        img = Image.open(path).convert("L")
        arr = np.asarray(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr)[None, ...]
    except Exception as e:
        warn(f"[PowderCanvas] mask {path} unreadable: {e} — emitting empty mask")
        return None


class PowderCanvas:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_config": ("STRING", {"default": "{}", "multiline": True}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
            },
            "optional": {
                "image": ("IMAGE",),
                "layout_config": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "STRING")
    RETURN_NAMES = ("image", "mask", "batch_size", "layout")
    FUNCTION = "run"
    CATEGORY = "e2go"

    # Output node: refreshes its background preview on every full queue and is
    # a valid partial-execution target ("Execute to selected output nodes" /
    # the editor's Refresh button).
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, canvas_config="{}", batch_size=1, image=None, layout_config="{}"):
        try:
            cfg = json.loads(canvas_config or "{}")
            pixels = str(cfg.get("hash", "")) if isinstance(cfg, dict) else ""
            return pixels if layout_config in ('', '{}') else pixels + ':' + hashlib.sha256(layout_config.encode()).hexdigest()
        except (json.JSONDecodeError, TypeError):
            return ""

    def run(self, canvas_config="{}", batch_size=1, image=None, layout_config="{}"):
        try:
            cfg = json.loads(canvas_config or "{}")
            if not isinstance(cfg, dict):
                cfg = {}
        except (json.JSONDecodeError, TypeError):
            warn("[PowderCanvas] malformed canvas_config, ignoring")
            cfg = {}

        base = None
        if image is not None:
            if image.shape[0] > 1:
                warn(f"[PowderCanvas] batch of {image.shape[0]} on input — using first image (batches are out of scope)")
            base = image[:1]

        out_img = None
        placeholder = False
        comp_path = _resolve(cfg.get("composite"))
        snapshot = str(cfg.get("hash", "")).split(":")
        if len(snapshot) == 4:
            for key, digest in zip(("composite", "mask"), snapshot[2:]):
                path = _resolve(cfg.get(key))
                if not path:
                    raise ValueError(f"Canvas {key} snapshot is missing. Reopen the canvas and queue again.")
                with open(path, "rb") as stream:
                    hasher = hashlib.sha256()
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        hasher.update(chunk)
                    actual = hasher.hexdigest()
                if actual != digest:
                    raise ValueError(f"Canvas {key} snapshot is damaged. Reopen the canvas and queue again.")
        if comp_path:
            out_img = _load_image(comp_path)


            if out_img is not None:
                try:
                    dims = str(cfg.get("hash", "")).split(":")[1]
                    exp_w, exp_h = (int(v) for v in dims.split("x"))
                    if (out_img.shape[2], out_img.shape[1]) != (exp_w, exp_h):
                        warn(f"[PowderCanvas] composite on disk is {out_img.shape[2]}x{out_img.shape[1]} "
                             f"but the editor uploaded {exp_w}x{exp_h} — another node/tab may have "
                             f"overwritten it; re-open the canvas and re-queue")
                except (IndexError, ValueError):
                    pass  # legacy/absent hash — nothing to verify
        composite_lost = False
        if out_img is None and cfg.get("composite"):
            # The config references paint work whose file is gone (input-dir
            # cleanup, moved install). Falling back silently would repaint
            # the whole image and mystify the user — say what happened.
            warn("[PowderCanvas] composite missing from input/e2go_canvas — "
                 "using raw input, EMPTY mask (paint work not applied); "
                 "re-open the canvas and re-queue to re-upload")
            composite_lost = True
        if out_img is None:
            if base is None:
                # Empty canvas and no image input: a hard error here aborts the
                # whole queue with a scary traceback dialog. Emit a black
                # placeholder instead — downstream runs predictably, and the
                # editor stays empty (no bg preview is sent for placeholders).
                warn("[PowderCanvas] empty canvas, no image input — emitting a black 1024x1024 placeholder")
                out_img = torch.zeros((1, 1024, 1024, 3), dtype=torch.float32)
                # Keep the preview/Generate fallback, but never treat it as a
                # real uploaded image in an editing consumer.
                out_img._e2go_empty_canvas = True
                placeholder = True
            else:
                out_img = base

        h, w = int(out_img.shape[1]), int(out_img.shape[2])
        out_mask = torch.zeros((1, h, w), dtype=torch.float32)


        mask_path = None if composite_lost else _resolve(cfg.get("mask"))
        if mask_path:
            m = _load_mask(mask_path)
            if m is None:
                pass  # unreadable: warned in _load_mask, empty mask stands
            elif m.shape[1] == h and m.shape[2] == w:
                out_mask = m
            else:
                warn(f"[PowderCanvas] mask {m.shape[2]}x{m.shape[1]} != composite {w}x{h} — emitting empty mask")


        n = max(1, int(batch_size))

        # Deliberately NOT "images": the frontend renders a native in-node
        # preview for ui.images, which duplicated the editor. A custom key is
        # invisible to the stock preview but still reaches node.onExecuted.
        # Placeholders send NO bg — the editor must keep its empty-state hint,
        # not adopt a black frame as the background.
        # Without an image input the only picture is the editor's OWN composite
        # (background + paint): echoing it back made the editor adopt it as
        # the background, burning the paint layers into it.
        ui = {} if base is None else {"e2go_canvas_bg": self._save_preview(base)}
        # info-level so every execution is visible in the server log at the
        # default E2GO_LOG_LEVEL — log() only prints at debug level.
        info(f"[PowderCanvas] out {w}x{h}, batch_size={n}, mask nonzero={bool(out_mask.any())}"
             + (" [PLACEHOLDER]" if placeholder else ""))
        # batch_size passthrough output: lets the graph sync other batchers
        # (e.g. the t2i EmptySD3Latent branch) to the canvas setting.
        return {"ui": ui, "result": (out_img, out_mask, n, layout_config)}

    def _save_preview(self, img: torch.Tensor) -> list:
        """Save the editor background to temp and describe it for ui.e2go_canvas_bg."""
        import folder_paths  # lazy: not available outside ComfyUI


        try:
            arr = (img[0].clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
            out_dir = folder_paths.get_temp_directory()
            full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                "e2go_canvas_bg", out_dir, arr.shape[1], arr.shape[0]
            )
            fname = f"{filename}_{counter:05}_.png"
            Image.fromarray(arr).save(os.path.join(full_folder, fname))
            return [{"filename": fname, "subfolder": subfolder, "type": "temp"}]
        except Exception as e:
            warn(f"[PowderCanvas] bg preview save failed: {e} — editor keeps its current background")
            return []


def _save_batch_previews(images: "torch.Tensor") -> list:
    """Save every batch frame to temp; ui-payload entries for the frontend."""
    import folder_paths  # lazy: not available outside ComfyUI
    out = []
    out_dir = folder_paths.get_temp_directory()
    for i in range(images.shape[0]):
      try:
        arr = (images[i].clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            "e2go_canvas_review", out_dir, arr.shape[1], arr.shape[0]
        )
        fname = f"{filename}_{counter:05}_.png"
        Image.fromarray(arr).save(os.path.join(full_folder, fname))
        out.append({"filename": fname, "subfolder": subfolder, "type": "temp"})
      except Exception as e:
        warn(f"[PowderCanvasReview] preview save failed for frame {i}: {e} — frame skipped")
    return out


def _feather_mask(mask: "torch.Tensor", radius: int) -> "torch.Tensor":
    """Gaussian-blur a [N, H, W] mask by ~radius px (separable, reflect pad).

    Reflect padding (AGSoft practice) keeps the blur from darkening the mask
    near borders the way zero padding would. sigma = radius / 3 is the shared
    convention across Impact / AGSoft.
    """
    r = int(radius)
    if r <= 0 or r >= min(mask.shape[-2], mask.shape[-1]):
        return mask
    sigma = max(r / 3.0, 0.5)
    xs = torch.arange(2 * r + 1, dtype=mask.dtype, device=mask.device) - r
    g = torch.exp(-(xs * xs) / (2.0 * sigma * sigma))
    g = g / g.sum()
    m = torch.nn.functional.pad(mask.unsqueeze(1), (r, r, r, r), mode="reflect")
    m = torch.nn.functional.conv2d(m, g.view(1, 1, 1, -1))
    m = torch.nn.functional.conv2d(m, g.view(1, 1, -1, 1))
    return m.squeeze(1)


def _stitch_frames(images: "torch.Tensor", ctx) -> "torch.Tensor":
    """Blend generated crop frames back into the full-size source.

    ctx is PowderImageConditioning's POWDER_STITCH dict; anything inactive,
    malformed, or size-mismatched passes the frames through untouched (warned
    where it points at a miswired graph, silent where it's the designed
    transparent context).
    """
    if not isinstance(ctx, dict) or not ctx.get("active"):
        return images


    if ctx.get("cover"):
        try:
            H, W = (int(v) for v in ctx["cover"])
        except (TypeError, ValueError) as e:
            warn(f"[PowderCanvasReview] malformed cover context ({e}) — frames passed through")
            return images
        if (images.shape[1], images.shape[2]) == (H, W):
            return images
        down = H * W < images.shape[1] * images.shape[2]
        return torch.nn.functional.interpolate(
            images.movedim(-1, 1), size=(H, W), mode="bicubic",
            antialias=down).movedim(1, -1).clamp(0.0, 1.0)
    try:
        x, y, w, h = (int(v) for v in ctx["bbox"])
        tw, th = (int(v) for v in ctx["crop_size"])
        source, mask = ctx["source"], ctx["mask"]
        # Validate source and mask are tensors with expected dimensions
        if not isinstance(source, torch.Tensor) or source.ndim != 4:
            raise ValueError(f"source must be 4D tensor, got {type(source).__name__} with ndim={getattr(source, 'ndim', '?')}")
        if not isinstance(mask, torch.Tensor) or mask.ndim != 3:
            raise ValueError(f"mask must be 3D tensor, got {type(mask).__name__} with ndim={getattr(mask, 'ndim', '?')}")
        # Validate batch sizes are non-empty
        if source.shape[0] < 1:
            raise ValueError(f"source batch size must be >= 1, got {source.shape[0]}")
        if mask.shape[0] < 1:
            raise ValueError(f"mask batch size must be >= 1, got {mask.shape[0]}")
        # Normalize dtype and device to match images
        source = source.to(device=images.device, dtype=images.dtype)
        mask = mask.to(device=images.device, dtype=images.dtype)
    except (KeyError, TypeError, ValueError) as e:
        warn(f"[PowderCanvasReview] malformed stitch context ({e}) — frames passed through")
        return images
    if (images.shape[1], images.shape[2]) != (th, tw):
        warn(f"[PowderCanvasReview] stitch: frames {images.shape[2]}x{images.shape[1]} "
             f"!= crop {tw}x{th} — passed through unstitched")
        return images
    try:
        n = images.shape[0]


        if (images.shape[1], images.shape[2]) != (h, w):
            down = h * w < images.shape[1] * images.shape[2]
            region = torch.nn.functional.interpolate(
                images.movedim(-1, 1), size=(h, w), mode="bicubic",
                antialias=down).movedim(1, -1).clamp(0.0, 1.0)
        else:
            region = images
        # RGBA VAEs (Qwen Image 2.1) decode four channels while the canvas
        # source is RGB: paste through the source's channel count, and an
        # alpha added the other way round is opaque.
        c = source.shape[-1]
        if region.shape[-1] > c:
            region = region[..., :c]
        elif region.shape[-1] < c:
            region = torch.nn.functional.pad(region, (0, c - region.shape[-1]), value=1.0)
        # Feather the paste seam: the transition spans ~blend px instead of a
        # hard 1px edge, hiding both resample softness and tonal steps.
        # Clamp to a quarter of the bbox's short side (Impact's kernel-clamp
        # practice) so small masks aren't washed out by a wide default blur.
        blend = min(int(ctx.get("blend", 0) or 0), min(w, h) // 4)
        # Preserve the painted contribution, including narrow strokes. Feather
        # only adds the existing surrounding transition; it never dilutes the
        # edit or extends the blur footprint by dilating the source mask.
        m = torch.maximum(mask, _feather_mask(mask, blend)) if blend > 0 else mask
        m = m[torch.arange(n, device=m.device) % m.shape[0]]
        m = m[:, y:y + h, x:x + w].unsqueeze(-1)
        out = source[torch.arange(n, device=source.device) % source.shape[0]].clone()
        out[:, y:y + h, x:x + w, :] = (
            out[:, y:y + h, x:x + w, :] * (1.0 - m) + region * m)
        return out
    except (RuntimeError, IndexError, TypeError) as e:
        warn(f"[PowderCanvasReview] stitch blend failed ({e}) — frames passed through")
        return images


class PowderCanvasReview:
    """Companion output node: delivers generation results back to the paired
    Powder Canvas editor (compare strip: original vs result, adopt/add-layer).

    A direct canvas input would create a graph cycle (canvas -> sampler ->
    canvas), so this separate sink node carries the results through its ui
    payload instead; the frontend routes them to the canvas editor.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"images": ("IMAGE",)},
            "optional": {"stitch": ("POWDER_STITCH", {
                "tooltip": "From Powder Image Conditioning's stitch output: blends crop-to-mask results back into the full image before review."})},
        }


    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "review"
    CATEGORY = "e2go"
    OUTPUT_NODE = True

    def review(self, images, stitch=None):
        images = _stitch_frames(images, stitch)
        entries = _save_batch_previews(images)
        info(f"[PowderCanvasReview] {len(entries)} result frame(s) -> canvas compare"
             + (" [stitched]" if isinstance(stitch, dict) and stitch.get("active") else ""))
        ui = {"e2go_canvas_review": entries}
        if isinstance(stitch, dict) and stitch.get("active") and stitch.get("bbox"):
            ui["e2go_crop_box"] = [list(stitch["bbox"])]
        return {"ui": ui, "result": (images,)}


NODE_CLASS_MAPPINGS = {
    "PowderCanvas": PowderCanvas,
    "PowderCanvasReview": PowderCanvasReview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderCanvas": "Powder Canvas",
    "PowderCanvasReview": "Powder Canvas Review",
}
