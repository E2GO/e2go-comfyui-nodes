"""Resolve image dimensions and allocate model-compatible empty latents."""
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from ._log import warn


def parse_ratio(text):
    """Parse a "W:H" ratio string (used for the preset combo values).

    Raises ValueError with the expected format on any malformed input.
    """
    parts = str(text).strip().split(":")
    if len(parts) != 2:
        raise ValueError(
            f"Powder Resolution: aspect ratio must be W:H (e.g. 16:9), got {text!r}"
        )
    try:
        w_r, h_r = float(parts[0]), float(parts[1])
    except ValueError:
        raise ValueError(
            f"Powder Resolution: aspect ratio must be W:H (e.g. 16:9), got {text!r}"
        ) from None
    if w_r <= 0 or h_r <= 0:
        raise ValueError(
            f"Powder Resolution: aspect ratio parts must be positive (W:H), got {text!r}"
        )
    return w_r, h_r


def compute_dimensions(w_r, h_r, megapixel, divisible_by):
    """Compute (width, height) from ratio + megapixels, rounded to divisible_by.

    Reproduces FluxResolutionNode exactly: int() truncation of dimension*ratio,
    then round-to-nearest multiple.
    """
    round_to = int(divisible_by)
    total_pixels = float(megapixel) * 1_000_000
    dimension = (total_pixels / (w_r * h_r)) ** 0.5
    width = int(dimension * w_r)
    height = int(dimension * h_r)
    width = round(width / round_to) * round_to
    height = round(height / round_to) * round_to
    if width <= 0 or height <= 0:
        # Extreme ratio + tiny target collapses a side to 0 after rounding
        # (reference crashes with ZeroDivisionError here; we fail readably).
        raise ValueError(
            f"Powder Resolution: computed size {width}x{height} — ratio too "
            f"extreme for the requested size; increase megapixel"
        )
    return width, height


_ASPECT_RATIOS = [
    "1:1 (Perfect Square)",
    "2:3 (Classic Portrait)", "3:4 (Golden Ratio)", "3:5 (Elegant Vertical)",
    "4:5 (Artistic Frame)", "5:7 (Balanced Portrait)", "5:8 (Tall Portrait)",
    "7:9 (Modern Portrait)", "9:16 (Slim Vertical)", "9:19 (Tall Slim)",
    "9:21 (Ultra Tall)", "9:32 (Skyline)",
    "3:2 (Golden Landscape)", "4:3 (Classic Landscape)", "5:3 (Wide Horizon)",
    "5:4 (Balanced Frame)", "7:5 (Elegant Landscape)", "8:5 (Cinematic View)",
    "9:7 (Artful Horizon)", "16:9 (Panorama)", "19:9 (Cinematic Ultrawide)",
    "21:9 (Epic Ultrawide)", "32:9 (Extreme Ultrawide)",
]
_MEGAPIXELS = [f"{i / 10:.1f}" for i in range(1, 26)]  # "0.1" .. "2.5"
# label -> (latent channels, spatial compression); labels are saved in workflows
_LATENT_TYPES = {"SD3/Flux (16ch)": (16, 8), "SDXL/SD1 (4ch)": (4, 8), "Qwen 2.1 (64ch /16)": (64, 16),
                 "Flux2/MOSS (128ch /16)": (128, 16)}


def _pil2tensor(image):
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def _make_preview(width, height, resolution, ratio_display):
    """1024x1024 schematic: grey grid, red aspect box, dim captions.

    Ported from controlaltai FluxResolutionNode.create_preview_image so the
    node has zero external dependencies. Falls back to the default PIL font
    when arial.ttf is unavailable.
    """
    preview_size = (1024, 1024)
    image = Image.new("RGB", preview_size, (0, 0, 0))
    draw = ImageDraw.Draw(image)

    grid_color = "#333333"
    for x in range(0, preview_size[0], 50):
        draw.line([(x, 0), (x, preview_size[1])], fill=grid_color)
    for y in range(0, preview_size[1], 50):
        draw.line([(0, y), (preview_size[0], y)], fill=grid_color)

    box_w = 800
    box_h = int(box_w * (height / width))
    if box_h > 800:
        box_h = 800
        box_w = int(box_h * (width / height))
    x_off = (preview_size[0] - box_w) // 2
    y_off = (preview_size[1] - box_h) // 2
    draw.rectangle([(x_off, y_off), (x_off + box_w, y_off + box_h)],
                   outline="red", width=4)

    text_y = y_off + box_h // 2
    try:
        draw.text((preview_size[0] // 2, text_y), f"{width}x{height}",
                  fill="red", anchor="mm", font=ImageFont.truetype("arial.ttf", 48))
        draw.text((preview_size[0] // 2, text_y + 60), f"({ratio_display})",
                  fill="red", anchor="mm", font=ImageFont.truetype("arial.ttf", 36))
        draw.text((preview_size[0] // 2, y_off + box_h + 60),
                  f"Resolution: {resolution}", fill="white", anchor="mm",
                  font=ImageFont.truetype("arial.ttf", 32))
    except Exception:
        draw.text((preview_size[0] // 2, text_y), f"{width}x{height}",
                  fill="red", anchor="mm")
        draw.text((preview_size[0] // 2, text_y + 60), f"({ratio_display})",
                  fill="red", anchor="mm")
        draw.text((preview_size[0] // 2, y_off + box_h + 60),
                  f"Resolution: {resolution}", fill="white", anchor="mm")

    return _pil2tensor(image)


class PowderResolution:
    """
    Preset/manual resolution -> empty latent, in one node.

    Widget order = the JS section layout: Presets (aspect_ratio, megapixel),
    Custom ratio (custom_ratio, ratio_x, ratio_y), Custom size (custom_mode,
    width, height, round_custom), Latent (batch_size, latent_type),
    Fine-tuning (divisible_by). Priority: custom_mode > custom_ratio > preset.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (_ASPECT_RATIOS, {"default": "2:3 (Classic Portrait)"}),
                "megapixel": (_MEGAPIXELS, {"default": "2.0"}),
                "custom_ratio": ("BOOLEAN", {"default": False,
                                             "label_on": "Enable", "label_off": "Disable"}),
                "ratio_x": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 32.0, "step": 0.05}),
                "ratio_y": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 32.0, "step": 0.05}),
                "custom_mode": ("BOOLEAN", {"default": False}),
                "width": ("INT", {"default": 960, "min": 16, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 1656, "min": 16, "max": 8192, "step": 8}),
                "round_custom": ("BOOLEAN", {"default": False}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
                "latent_type": ([*_LATENT_TYPES, "Auto (connected model)"], {"default": "SD3/Flux (16ch)"}),
                "divisible_by": (["8", "16", "32", "64"], {"default": "64"}),
            },
            "optional": {"model": ("MODEL",)},
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "STRING", "IMAGE")
    RETURN_NAMES = ("LATENT", "width", "height", "resolution", "preview")
    FUNCTION = "generate"
    CATEGORY = "e2go"
    OUTPUT_NODE = True

    def generate(self, aspect_ratio, megapixel, custom_ratio, ratio_x, ratio_y,
                 custom_mode, width, height, round_custom,
                 batch_size, latent_type, divisible_by, model=None):
        dimensions = 2
        if latent_type == "Auto (connected model)":
            lf = getattr(getattr(model, 'model', None), 'latent_format', None)
            dimensions = int(getattr(lf, 'latent_dimensions', 2))
            if lf is None or dimensions not in (2, 3):
                raise ValueError('Resolution Auto requires a connected image model with a 2D or single-frame 3D latent format.')
            channels = int(lf.latent_channels)
            ds = int(getattr(lf, 'spacial_downscale_ratio', 8))
        else:
            channels, ds = _LATENT_TYPES[latent_type]
        # a snap finer than the latent grid would promise a size the latent
        # floors away (divisible_by 8 on a /16 type)
        divisible_by = max(int(divisible_by), ds)
        if custom_mode:


            out_w, out_h = int(width), int(height)
            if round_custom:  # the user opted into snapping
                r = int(divisible_by)
                out_w = round(out_w / r) * r
                out_h = round(out_h / r) * r
                if out_w <= 0 or out_h <= 0:
                    raise ValueError(
                        f"Powder Resolution: manual size {width}x{height} "
                        f"rounds to zero at divisible_by={r}; increase the "
                        f"dimension or lower divisible_by"
                    )
            elif out_w % ds or out_h % ds:
                snapped_w, snapped_h = (out_w // ds) * ds, (out_h // ds) * ds
                warn(f"[PowderResolution] custom {out_w}x{out_h} is not /{ds}; "
                     f"the latent grid forces {snapped_w}x{snapped_h} — "
                     f"outputs snapped to match (enable round_custom to "
                     f"choose the rounding)")
                out_w, out_h = snapped_w, snapped_h
            ratio_display = "custom"
        elif custom_ratio:
            w_r, h_r = float(ratio_x), float(ratio_y)
            if w_r <= 0 or h_r <= 0:
                raise ValueError(
                    f"Powder Resolution: ratio_x/ratio_y must be positive, "
                    f"got {ratio_x}:{ratio_y}"
                )
            ratio_display = f"{w_r:g}:{h_r:g}"
            out_w, out_h = compute_dimensions(w_r, h_r, megapixel, divisible_by)
        else:
            ratio_display = aspect_ratio.split(" ")[0]
            w_r, h_r = parse_ratio(ratio_display)
            out_w, out_h = compute_dimensions(w_r, h_r, megapixel, divisible_by)

        if out_w < ds or out_h < ds:
            raise ValueError(f"Powder Resolution: size {out_w}x{out_h} is smaller than the /{ds} latent grid; increase width and height.")

        device = None
        try:  # match EmptySD3LatentImage's device choice when inside ComfyUI
            import comfy.model_management as mm
            device = mm.intermediate_device()
        except Exception:
            pass  # tests run outside ComfyUI -> default CPU
        shape = [batch_size, channels] + ([1] if dimensions == 3 else []) + [out_h // ds, out_w // ds]
        latent = torch.zeros(shape,
                             device=device)

        resolution = f"{out_w} x {out_h}"
        preview = _make_preview(out_w, out_h, resolution, ratio_display)
        badge = f"{out_w} × {out_h} ({ratio_display})"
        return {"ui": {"text": [badge], "latent_format": [f"{channels}ch /{ds} · batch {batch_size}"]},
                # like core EmptyLatentImage: the sampler rescales an empty latent
                # for a model on another grid (a /8 type on Qwen Image 2.1)
                "result": ({"samples": latent, "downscale_ratio_spacial": ds}, out_w, out_h, resolution, preview)}


NODE_CLASS_MAPPINGS = {
    "PowderResolution": PowderResolution,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderResolution": "Powder Resolution",
}
