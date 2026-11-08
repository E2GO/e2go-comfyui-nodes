"""
PowderGridSaver - Grid assembly with progressive saving and JSON metadata.
"""

import os
import re
import json
import platform
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from datetime import datetime
import torch

from ._log import log, info, warn
from ._styles import get_styles, deduplicate_tags
from .powder_inpaint import compute_steps

# ---------------------------------------------------------------------------
# Font cache  (font_path, size) → ImageFont
# ---------------------------------------------------------------------------
_FONT_CACHE: dict = {}

# Paths that have already failed to load (missing/corrupt file), keyed by
# path only — not (path, size). Font load failures are file-level (the file
# doesn't exist or isn't a valid font), not size-dependent, so a path that
# fails at one size is assumed to fail at every size. Avoids re-attempting
# the same bad path 3-4x per render (once per distinct font_size used).
_FONT_FAILED_PATHS: set = set()


_MAX_COMPONENT = 64


def _sanitize_component(text):
    """Filename-safe subset of *text*: alnum, _-. ; spaces become _.
    Leading dots are stripped so '..' can't survive as a component.
    Truncated to _MAX_COMPONENT characters."""
    out = "".join(c if (c.isalnum() or c in "_-.") else "_" if c == " " else ""
                  for c in str(text))
    return out.lstrip(".")[:_MAX_COMPONENT]


def _resolve_output_dir(base, subfolder):
    """Join *subfolder* under *base*; any escape (.. or absolute) falls back
    to *base* with a warning — mirrors core SaveImage's containment rule."""
    if not subfolder:
        return base
    base_abs = os.path.abspath(base)
    raw = str(subfolder)
    # An absolute / drive-qualified subfolder is an escape by definition, and it
    # must be rejected BEFORE the per-segment cap below: splitting r"C:\Windows\
    # Temp" into segments strips its absoluteness, so os.path.join would quietly
    # produce base\Windows\Temp — contained, hence invisible to the check, but
    # not what the user asked for (caught by test_resolve_output_dir_stays_inside_base).
    drive_qualified = os.path.isabs(raw) or bool(os.path.splitdrive(raw)[0])
    # Cap every segment: one 300-char folder name blows the path limit just as
    # well as a long filename. ".." survives the cap unchanged, so the
    # containment check below still catches that escape.
    parts = [] if drive_qualified else [
        p[:_MAX_COMPONENT] for p in raw.replace("\\", "/").split("/") if p]


    _MAX_SEGMENTS = 8
    _MAX_SUBFOLDER_LEN = 160
    if len(parts) > _MAX_SEGMENTS:
        warn(f"[PowderGridSaver] subfolder has {len(parts)} segments — "
             f"keeping the first {_MAX_SEGMENTS}")
        parts = parts[:_MAX_SEGMENTS]
    while parts and len("/".join(parts)) > _MAX_SUBFOLDER_LEN:
        warn(f"[PowderGridSaver] subfolder path too long — dropping "
             f"deepest segment {parts[-1]!r}")
        parts = parts[:-1]
    candidate = os.path.abspath(os.path.join(base_abs, *parts)) if parts else base_abs
    try:
        base_real = os.path.realpath(base_abs)
        inside = (os.path.commonpath([base_abs, candidate]) == base_abs
                  and os.path.commonpath([base_real, os.path.realpath(candidate)]) == base_real)
    except ValueError:  # different drives on Windows
        inside = False
    if drive_qualified or not inside:
        warn(f"[PowderGridSaver] subfolder {subfolder!r} escapes the output "
             f"directory — saving to the output root instead")
        return base_abs
    for part in parts:
        if part in (".", ".."):
            continue
        if (re.search(r'[<>:"|?*\x00-\x1f]', part)
                or part.rstrip(" .") != part
                or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", part)):
            raise ValueError("Grid subfolder contains an invalid or reserved filename component.")
    return candidate


def _grid_dims(total_images, num_loras):
    """Prompt-row count: ceil so an indivisible image count grows the grid
    instead of silently dropping the tail frames."""
    if num_loras > 0 and total_images > 0:
        num_prompts = -(-total_images // num_loras)  # ceil div
        if total_images % num_loras:
            warn(f"[PowderGridSaver] {total_images} images with {num_loras} "
                 f"LoRA rows — grid padded to {num_prompts} prompt rows, "
                 f"last cells left empty")
        return num_prompts
    return total_images if total_images else 1


def _unwrap(value):
    """INPUT_IS_LIST=True wraps every scalar input in a 1-element list.

    Returns the first element for a non-empty list, ``value`` unchanged for
    a non-list, and ``None`` for an empty list.
    """
    if isinstance(value, list):
        return value[0] if value else None
    return value


class PowderGridSaver:
    """Assembles images into a labelled grid and saves PNG + optional JSON."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                # --- Layout ---
                "layout": (["Horizontal (Loras as columns)", "Vertical (Loras as rows)"],),
                "background": (["Dark", "Light"],),
                "gap": ("INT", {"default": 10, "min": 0, "max": 100, "step": 1}),
                "font_size": ("INT", {"default": 36, "min": 12, "max": 100, "step": 2}),
                # --- Display ---
                "show_model_name": ("BOOLEAN", {"default": True}),
                "show_lora_names": ("BOOLEAN", {"default": True}),
                "show_prompts": ("BOOLEAN", {"default": True}),
                "prompt_max_chars": ("INT", {"default": 100, "min": 10, "max": 500, "step": 10}),
                "show_seed": ("BOOLEAN", {"default": False}),
                "show_style_prompt": ("BOOLEAN", {"default": False}),
                # --- Save ---
                "filename_prefix": ("STRING", {"default": "grid"}),
                "subfolder": ("STRING", {"default": "grids"}),
                "add_model_to_filename": ("BOOLEAN", {"default": True}),
                "save_json": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "lora_info": ("STRING", {"forceInput": True}),
                "prompts": ("STRING", {"forceInput": True}),
                "negative_prompts": ("STRING", {"forceInput": True}),
                "seed": ("INT", {"forceInput": True}),
                "style_metadata": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("grid_image", "saved_paths")
    OUTPUT_NODE = True
    FUNCTION = "create_grid"
    CATEGORY = "e2go"

    @classmethod
    def IS_CHANGED(cls, *_args, **_kwargs):
        return float("NaN")

    @classmethod
    def VALIDATE_INPUTS(cls, layout, background, **kwargs):
        """Accept boolean values from new ComfyUI frontend for 2-option combos."""
        return True

    def create_grid(self, images, layout, background, gap, font_size,
                    show_model_name, show_lora_names, show_prompts, prompt_max_chars,
                    show_seed, show_style_prompt,
                    filename_prefix, subfolder, add_model_to_filename, save_json,
                    lora_info=None, prompts=None, negative_prompts=None, seed=None, prompt=None, extra_pnginfo=None,
                    unique_id=None, style_metadata=None):

        # Unpack scalars (INPUT_IS_LIST wraps every scalar param in a list)
        layout = _unwrap(layout)
        gap = _unwrap(gap)
        background = _unwrap(background)

        # ComfyUI new frontend converts 2-option combos to boolean toggles
        if isinstance(layout, bool) or layout in ("True", "False", "true", "false"):
            layout = "Horizontal (Loras as columns)" if str(layout).lower() == "true" else "Vertical (Loras as rows)"
        if isinstance(background, bool) or background in ("True", "False", "true", "false"):
            background = "Dark" if str(background).lower() == "true" else "Light"
        show_model_name = _unwrap(show_model_name)
        show_lora_names = _unwrap(show_lora_names)
        show_prompts = _unwrap(show_prompts)
        prompt_max_chars = _unwrap(prompt_max_chars)
        font_size = _unwrap(font_size)
        show_seed = _unwrap(show_seed)
        show_style_prompt = _unwrap(show_style_prompt)
        save_json = _unwrap(save_json)
        add_model_to_filename = _unwrap(add_model_to_filename)
        filename_prefix = _unwrap(filename_prefix)
        subfolder = _unwrap(subfolder)

        import folder_paths  # lazy
        prompt_list_raw = prompt if isinstance(prompt, list) else [prompt]
        workflow_prompt = prompt_list_raw[0]
        uid = unique_id[0] if isinstance(unique_id, list) and unique_id else unique_id
        branch = self._image_branch(workflow_prompt, uid)
        model_display_name = self._extract_model_from_prompt(branch)
        workflow_info = self._extract_workflow_info(workflow_prompt, uid)

        # Seeds: prefer explicit input, fall back to workflow extraction
        if seed is not None:
            seed_list = seed if isinstance(seed, list) else [seed]
        else:
            wf_seed = workflow_info.get("seed")
            seed_list = [wf_seed] if wf_seed is not None else []

        # Parse lora_info
        lora_names = []
        lora_strengths = []
        combination_order = "Loras first"
        lora_mode = "single"
        original_loras = []
        original_strengths = []

        if lora_info:
            lora_info_str = lora_info[0] if isinstance(lora_info, list) else lora_info
            try:
                lora_info_data = json.loads(lora_info_str) if lora_info_str else {}
                if isinstance(lora_info_data, dict):
                    lora_names = lora_info_data.get("loras", [])
                    lora_strengths = lora_info_data.get("strengths", [])
                    combination_order = lora_info_data.get("combination_order", "Loras first")
                    lora_mode = lora_info_data.get("mode", "single")
                    original_loras = lora_info_data.get("original_loras", lora_names)
                    original_strengths = lora_info_data.get("original_strengths", lora_strengths)
                    if not isinstance(lora_names, list):
                        lora_names = []
                    if not isinstance(lora_strengths, list):
                        lora_strengths = []
                else:
                    warn(f"Invalid lora_info type: {type(lora_info_data)}")
            except json.JSONDecodeError as e:
                warn(f"lora_info JSON error: {e}")
            except Exception as e:
                warn(f"lora_info error: {e}")

        if lora_mode == "stack" and len(lora_names) > 1:
            combined_name = " + ".join(lora_names)
            lora_names = [combined_name]
            lora_strengths = [1.0]

        prompt_list = []
        if prompts:
            prompt_list = prompts if isinstance(prompts, list) else [prompts]

        negative_list = []
        if negative_prompts:
            negative_list = negative_prompts if isinstance(negative_prompts, list) else [negative_prompts]

        num_loras = len(lora_names) if lora_names else 1

        base_output_dir = folder_paths.get_output_directory()
        output_dir = _resolve_output_dir(base_output_dir, subfolder)
        if output_dir != os.path.abspath(base_output_dir):
            os.makedirs(output_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

        safe_prefix = _sanitize_component(filename_prefix) or "grid"
        # Build filename base: optionally prepend sanitized model name
        if add_model_to_filename and model_display_name:
            safe_model = _sanitize_component(model_display_name)
            file_base = f"{safe_model}_{safe_prefix}_{timestamp}"
        else:
            file_base = f"{safe_prefix}_{timestamp}"

        saved_paths = []

        # Convert tensors to PIL — unpack batches, .detach() and size validation
        pil_images = []
        target_size = None
        # Track which source tensor (and which batch item within it) each
        # frame came from, so seeds can be attributed per-tensor rather than
        # collapsed to seed_list[0] for every image.
        frame_tensor_idx = []
        frame_batch_idx = []
        for t_idx, img_tensor in enumerate(images):
            # Unpack batch dimension: [B, H, W, C] → B individual [H, W, C] frames
            if len(img_tensor.shape) == 4:
                frames = [img_tensor[i] for i in range(img_tensor.shape[0])]
            else:
                frames = [img_tensor]

            for b_idx, frame in enumerate(frames):
                # Clamp to [0, 1] before scaling to uint8 range — otherwise
                # out-of-range float values (>1.0 or <0.0) wrap mod-256
                # instead of clamping, corrupting saved pixels.
                img_np = (frame.detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8)
                pil_img = Image.fromarray(img_np)

                if target_size is None:
                    target_size = (pil_img.width, pil_img.height)
                elif (pil_img.width, pil_img.height) != target_size:
                    warn(f"Image size mismatch: {pil_img.size} vs {target_size}, resizing")
                    pil_img = pil_img.resize(target_size, Image.LANCZOS)

                pil_images.append(pil_img)
                frame_tensor_idx.append(t_idx)
                frame_batch_idx.append(b_idx)

        # Calculate grid dimensions AFTER unpacking batches
        total_images = len(pil_images)
        num_prompts = _grid_dims(total_images, num_loras)

        def axis_labels(values):
            if not values:
                return []
            batch = max(frame_batch_idx, default=0) + 1
            expanded = len(values) == len(images) and num_loras > 1
            labels = []
            for index in range(num_prompts):
                prompt_index = index // batch
                source_index = prompt_index * num_loras if expanded and "Prompts first" in combination_order else prompt_index
                labels.append(values[source_index % len(values)])
            return labels
        display_prompts = axis_labels(prompt_list)

        # Build per-image seed info with batch index
        # When batch_size > 1, ComfyUI generates the full batch from one seed
        # (torch.manual_seed(seed) → randn([batch, C, H, W])).
        # Individual batch items don't have separate seeds — they are
        # reproducible only as "seed + batch index within the run".
        # The REAL batch size comes from the unpacked tensors (frame_batch_idx
        # tracked at unpack time) — not from the prompt count, which is a grid
        # dimension and previously produced fabricated [i/N] labels.
        batch_size = (max(frame_batch_idx) + 1) if frame_batch_idx else 1
        base_seed = seed_list[0] if seed_list else None

        all_seeds = []          # one entry per image (its source tensor's seed)
        all_batch_indices = []  # which item in the batch (0-based)
        if base_seed is not None:
            for img_i in range(total_images):
                t_idx = frame_tensor_idx[img_i] if img_i < len(frame_tensor_idx) else 0
                if seed_list:
                    img_seed = seed_list[t_idx] if t_idx < len(seed_list) else seed_list[-1]
                else:
                    img_seed = base_seed
                all_seeds.append(img_seed)
                all_batch_indices.append(
                    frame_batch_idx[img_i] if img_i < len(frame_batch_idx) else 0)

        # Extract style info from workflow
        style_info = self._extract_style_from_workflow(branch)
        if style_metadata:
            encoded = _unwrap(style_metadata)
            try:
                actual_style = json.loads(encoded)
                if isinstance(actual_style, dict):
                    style_info = {"names": [], "prefix": "", "suffix": "", "negative": "", "position": "wrap", **actual_style}
            except (TypeError, json.JSONDecodeError):
                warn("Grid: invalid style_metadata; style labels omitted")
                style_info = None

        # Modify display prompts based on style switch
        if style_info and style_info["names"] and display_prompts:
            if show_style_prompt:
                # Full style text: assemble prefix + prompt + suffix
                styled = []
                for p in display_prompts:
                    pos = style_info["position"]
                    pfx = style_info["prefix"]
                    sfx = style_info["suffix"]
                    if pos == "before":
                        parts = [pfx, sfx, p]
                    elif pos == "after":
                        parts = [p, pfx, sfx]
                    else:  # wrap
                        parts = [pfx, p, sfx]
                    styled.append(", ".join(part for part in parts if part and part.strip()))
                display_prompts = styled
            else:
                # Style name only
                names_str = ", ".join(style_info["names"])
                display_prompts = [f"{p} [{names_str}]" for p in display_prompts]

        log(f"[PowderGridSaver] === START ===")
        log(f"[PowderGridSaver] Model: {model_display_name or 'Not detected'}")
        log(f"[PowderGridSaver] Images: {total_images}, Loras: {num_loras}, Prompts: {num_prompts}, Batch: {batch_size}")
        log(f"[PowderGridSaver] Seed: {base_seed}")
        log(f"[PowderGridSaver] Layout: {layout}, Order: {combination_order}, Mode: {lora_mode}")

        if not pil_images:
            warn("No images!")
            empty_tensor = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            return {"ui": {"images": []}, "result": (empty_tensor, "")}

        if not lora_names and not display_prompts:
            num_cols = int(np.ceil(np.sqrt(len(pil_images))))
            num_rows = int(np.ceil(len(pil_images) / num_cols))
            num_loras = num_cols
            num_prompts = num_rows

        is_horizontal = "Horizontal" in layout
        is_loras_first = "Loras first" in combination_order

        lora_labels = self._prepare_lora_labels(lora_names, lora_strengths)
        display_negatives = axis_labels(negative_list)

        json_data = {
            "timestamp": timestamp,
            "model": model_display_name,
            "sampler": workflow_info.get("sampler"),
            "scheduler": workflow_info.get("scheduler"),
            "steps": workflow_info.get("steps"),
            "cfg": workflow_info.get("cfg"),
            "seed": base_seed,
            "batch_size": batch_size,
            "seeds": all_seeds,
            "batch_indices": all_batch_indices,
            "layout": layout,
            "combination_order": combination_order,
            "mode": lora_mode,
            "loras": original_loras if original_loras else lora_names,
            "strengths": original_strengths if lora_mode == "stack" else lora_strengths,
            "prompts": display_prompts,
            "negative_prompts": display_negatives,
            "style_names": style_info["names"] if style_info else [],
            "style_text": ", ".join(p for p in [style_info.get("prefix", ""), style_info.get("suffix", "")] if p) if style_info else "",
            "style_negative": style_info["negative"] if style_info else "",
            "style_position": style_info["position"] if style_info else "",
            "num_images": len(pil_images),
            "image_size": [pil_images[0].width, pil_images[0].height] if pil_images else [0, 0],
            "files": [],
        }

        # Build seed labels for the grid renderer
        seed_labels = None
        if show_seed and base_seed is not None:
            if batch_size > 1:
                seed_labels = [
                    f"Seed: {all_seeds[i]} [{all_batch_indices[i]+1}/{batch_size}]"
                    for i in range(total_images)
                ]
            else:
                seed_labels = [f"Seed: {value}" for value in all_seeds]

        grid_images = pil_images
        if not is_loras_first and batch_size > 1 and num_loras > 1:
            indices = sorted(range(total_images), key=lambda i: (frame_tensor_idx[i] // num_loras, frame_batch_idx[i], frame_tensor_idx[i] % num_loras))
            grid_images = [pil_images[i] for i in indices]
            if seed_labels:
                seed_labels = [seed_labels[i] for i in indices]
        final_grid = self._create_grid(
            grid_images, lora_labels, display_prompts,
            is_horizontal, is_loras_first,
            num_loras, num_prompts,
            gap, background, show_lora_names, show_prompts,
            prompt_max_chars, font_size,
            model_display_name if show_model_name else None,
            seed_labels,
        )


        base_candidate = file_base
        collision_counter = 1
        while (os.path.lexists(os.path.join(output_dir, f"{file_base}.png"))
               or os.path.lexists(os.path.join(output_dir, f"{file_base}.json"))):
            file_base = f"{base_candidate}_{collision_counter}"
            collision_counter += 1

        final_path = os.path.join(output_dir, f"{file_base}.png")
        with open(final_path, "xb") as stream:
            final_grid.save(stream, "PNG")
        saved_paths.append(final_path)
        json_data["files"].append(os.path.basename(final_path))
        log(f"[PowderGridSaver] Saved grid: {os.path.basename(final_path)}")

        if save_json:
            json_path = os.path.join(output_dir, f"{file_base}.json")
            with open(json_path, "x", encoding="utf-8") as f:
                json.dump(json_data, f, indent=2, ensure_ascii=False)
            saved_paths.append(json_path)
            log(f"[PowderGridSaver] Saved: {os.path.basename(json_path)}")

        log(f"[PowderGridSaver] Total saved: {len(saved_paths)} files")
        info(f"[PowderGrid] {num_loras}×{num_prompts} grid, {total_images} image{'s' if total_images != 1 else ''}, saved as {os.path.basename(final_path)}")

        # Convert final_grid PIL → tensor directly (no re-read from disk)
        final_np = np.array(final_grid).astype(np.float32) / 255.0
        final_tensor = torch.from_numpy(final_np).unsqueeze(0)
        relative_dir = os.path.relpath(output_dir, base_output_dir)
        preview = {"filename": os.path.basename(final_path),
                   "subfolder": "" if relative_dir == "." else relative_dir.replace(os.sep, "/"),
                   "type": "output"}
        return {"ui": {"images": [preview]}, "result": (final_tensor, "\n".join(saved_paths))}

    def _prepare_lora_labels(self, lora_names, lora_strengths):
        labels = []
        for i, name in enumerate(lora_names):
            if i < len(lora_strengths):
                strength = lora_strengths[i]
                if strength != 1.0:
                    if strength == int(strength):
                        strength_str = str(int(strength))
                    else:
                        strength_str = f"{strength:.2f}".rstrip("0").rstrip(".")
                    labels.append(f"{name}\n({strength_str})")
                else:
                    labels.append(name)
            else:
                labels.append(name)
        return labels

    def _create_grid(self, pil_images, lora_labels, prompt_list,
                     is_horizontal, is_loras_first,
                     num_loras, num_prompts,
                     gap, background, show_lora_names, show_prompts,
                     prompt_max_chars, font_size, model_name=None,
                     seed_labels=None):

        if is_horizontal:
            num_cols = num_loras
            num_rows = num_prompts
            col_labels = lora_labels if show_lora_names else []
            row_labels = [self._truncate(p, prompt_max_chars) for p in prompt_list] if show_prompts else []
        else:
            num_cols = num_prompts
            num_rows = num_loras
            col_labels = [self._truncate(p, prompt_max_chars) for p in prompt_list] if show_prompts else []
            row_labels = lora_labels if show_lora_names else []

        img_width = pil_images[0].width
        img_height = pil_images[0].height

        font = self._load_font(font_size)
        title_font = self._load_font(int(font_size * 1.3))

        temp_img = Image.new("RGB", (1, 1))
        temp_draw = ImageDraw.Draw(temp_img)

        # Seed display: always per-cell when labels are provided
        seed_font = self._load_font(max(12, font_size * 2 // 3))
        seed_label_height = 0
        if seed_labels:
            # Measure the tallest possible seed label
            sample_label = seed_labels[0] if seed_labels else "Seed: 0"
            sb = temp_draw.textbbox((0, 0), sample_label, font=seed_font)
            seed_label_height = sb[3] - sb[1] + 10

        title_height = 0
        if model_name:
            title_bbox = temp_draw.textbbox((0, 0), model_name, font=title_font)
            title_height = title_bbox[3] - title_bbox[1] + 30

        max_row_label_width = min(300, img_width // 2)

        col_labels_wrapped = []
        max_header_lines = 1
        if col_labels:
            for label in col_labels:
                lines = self._wrap_text(label, font, img_width - 20, temp_draw)
                col_labels_wrapped.append(lines)
                max_header_lines = max(max_header_lines, len(lines))

        row_labels_wrapped = []
        row_label_width = 0
        if row_labels:
            for label in row_labels:
                lines = self._wrap_text(label, font, max_row_label_width, temp_draw)
                row_labels_wrapped.append(lines)
                for line in lines:
                    bbox = temp_draw.textbbox((0, 0), line, font=font)
                    row_label_width = max(row_label_width, bbox[2] - bbox[0])
            row_label_width += 30

        line_height = font_size + 5
        header_height = (line_height * max_header_lines + 20) if col_labels_wrapped else 0

        if background == "Dark":
            bg_color = (32, 32, 32)
            text_color = (220, 220, 220)
        else:
            bg_color = (240, 240, 240)
            text_color = (32, 32, 32)

        cell_height = img_height + seed_label_height
        total_width = row_label_width + num_cols * img_width + (num_cols - 1) * gap + gap * 2
        total_height = title_height + header_height + num_rows * cell_height + (num_rows - 1) * gap + gap * 2

        grid_img = Image.new("RGB", (total_width, total_height), bg_color)
        draw = ImageDraw.Draw(grid_img)

        if model_name and title_height > 0:
            title_bbox = draw.textbbox((0, 0), model_name, font=title_font)
            title_text_width = title_bbox[2] - title_bbox[0]
            title_x = (total_width - title_text_width) // 2
            draw.text((title_x, 10), model_name, fill=text_color, font=title_font)

        if col_labels_wrapped:
            for col_idx, lines in enumerate(col_labels_wrapped):
                x_center = row_label_width + gap + col_idx * (img_width + gap) + img_width // 2
                for line_idx, line in enumerate(lines):
                    bbox = draw.textbbox((0, 0), line, font=font)
                    text_width = bbox[2] - bbox[0]
                    y = title_height + 10 + line_idx * line_height
                    draw.text((x_center - text_width // 2, y), line, fill=text_color, font=font)

        if row_labels_wrapped:
            for row_idx, lines in enumerate(row_labels_wrapped):
                y_center = title_height + header_height + gap + row_idx * (cell_height + gap) + img_height // 2
                total_text_height = len(lines) * line_height
                y_start = y_center - total_text_height // 2
                for line_idx, line in enumerate(lines):
                    y = y_start + line_idx * line_height
                    draw.text((gap, y), line, fill=text_color, font=font)

        for img_idx, pil_img in enumerate(pil_images):
            if is_horizontal:
                if is_loras_first:
                    col = img_idx // num_prompts if num_prompts > 0 else img_idx
                    row = img_idx % num_prompts if num_prompts > 0 else 0
                else:
                    row = img_idx // num_loras if num_loras > 0 else img_idx
                    col = img_idx % num_loras if num_loras > 0 else 0
            else:
                if is_loras_first:
                    row = img_idx // num_prompts if num_prompts > 0 else img_idx
                    col = img_idx % num_prompts if num_prompts > 0 else 0
                else:
                    col = img_idx // num_loras if num_loras > 0 else img_idx
                    row = img_idx % num_loras if num_loras > 0 else 0

            if col >= num_cols or row >= num_rows:
                # _grid_dims ceils, so this is unreachable unless the layout
                # math regresses — if it ever fires, say so instead of
                # silently losing the user's image.
                warn(f"[PowderGridSaver] frame {img_idx} fell outside the "
                     f"{num_rows}x{num_cols} grid — layout bug, frame skipped")
                continue

            x = row_label_width + gap + col * (img_width + gap)
            y = title_height + header_height + gap + row * (cell_height + gap)

            grid_img.paste(pil_img, (x, y))

            # Per-cell seed label below image
            if seed_labels and img_idx < len(seed_labels):
                label = seed_labels[img_idx]
                sb = draw.textbbox((0, 0), label, font=seed_font)
                sw = sb[2] - sb[0]
                seed_x = x + (img_width - sw) // 2
                seed_y = y + img_height + 4
                draw.text((seed_x, seed_y), label, fill=text_color, font=seed_font)

        return grid_img

    def _load_font(self, font_size):
        """Load font with cross-platform fallbacks and caching."""
        font_paths = []

        node_dir = os.path.dirname(os.path.abspath(__file__))
        bundled_font = os.path.join(node_dir, "fonts", "DejaVuSans.ttf")
        if os.path.exists(bundled_font):
            font_paths.append(bundled_font)

        system = platform.system()

        if system == "Windows":
            font_paths.extend([
                "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/segoeui.ttf",
                "C:/Windows/Fonts/tahoma.ttf",
            ])
        elif system == "Darwin":
            font_paths.extend([
                "/System/Library/Fonts/Helvetica.ttc",
                "/System/Library/Fonts/SFNSText.ttf",
                "/Library/Fonts/Arial.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf",
            ])
        else:
            font_paths.extend([
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                "/usr/share/fonts/TTF/DejaVuSans.ttf",
                "/usr/share/fonts/dejavu/DejaVuSans.ttf",
            ])

        for font_path in font_paths:
            if font_path in _FONT_FAILED_PATHS:
                continue
            cache_key = (font_path, font_size)
            if cache_key in _FONT_CACHE:
                return _FONT_CACHE[cache_key]
            try:
                font = ImageFont.truetype(font_path, font_size)
                _FONT_CACHE[cache_key] = font
                return font
            except Exception:
                _FONT_FAILED_PATHS.add(font_path)
                continue

        warn("No suitable font found, using default (may be small)")
        try:
            return ImageFont.load_default(size=font_size)
        except TypeError:
            return ImageFont.load_default()

    def _truncate(self, text, max_chars):
        if not text:
            return ""
        text = str(text).strip()
        if len(text) <= max_chars:
            return text
        return text[:max_chars - 3] + "..."

    def _image_branch(self, prompt, unique_id):
        if not prompt or unique_id is None:
            return prompt
        root = prompt.get(str(unique_id), {}).get("inputs", {}).get("images")
        queue = [str(root[0])] if isinstance(root, list) and len(root) == 2 else []
        branch = {}
        while queue:
            nid = queue.pop(0)
            if nid in branch or nid not in prompt:
                continue
            node = prompt[nid]
            branch[nid] = node
            inputs = node.get("inputs", {})
            if node.get("class_type") == "PowderSwitcher":
                group = inputs.get("active_group", 1)
                if isinstance(group, list):
                    continue  # dynamic selection cannot be inferred from the saved graph
                inputs = {k: v for k, v in inputs.items() if k.startswith(f"g{int(group)-1}_c")}
            queue.extend(str(v[0]) for v in inputs.values() if isinstance(v, list) and len(v) == 2)
        return branch

    def _extract_model_from_prompt(self, prompt):
        if not prompt:
            return None
        sampler = next((n for n in prompt.values() if n.get("class_type") in self._SAMPLER_CLASSES), None)
        if sampler:
            link = sampler.get("inputs", {}).get("model")
            chain = {}
            while isinstance(link, list) and len(link) == 2:
                nid, output = str(link[0]), link[1]
                if nid in chain or nid not in prompt:
                    break
                node = prompt[nid]
                chain[nid] = node
                inputs = node.get("inputs", {})
                if node.get("class_type") == "PowderSwitcher":
                    group = inputs.get("active_group", 1)
                    if isinstance(group, list):
                        break
                    link = inputs.get(f"g{int(group)-1}_c{output}")
                else:
                    link = inputs.get("model")
            prompt = chain
        try:
            checkpoint_loaders = [
                "CheckpointLoaderSimple",
                "CheckpointLoader",
                "UNETLoader",
                "unCLIPCheckpointLoader",
            ]
            for node_id, node_data in prompt.items():
                if isinstance(node_data, dict):
                    class_type = node_data.get("class_type", "")
                    if class_type in checkpoint_loaders:
                        inputs = node_data.get("inputs", {})
                        ckpt_name = inputs.get("ckpt_name") or inputs.get("unet_name") or inputs.get("model_name")
                        if ckpt_name:
                            return os.path.splitext(os.path.basename(ckpt_name))[0]
        except Exception as e:
            warn(f"Could not extract model name: {e}")
        return None


    _SAMPLER_CLASSES = {"PowderSampler", "KSampler", "KSamplerAdvanced",
                        "SamplerCustom", "SamplerCustomAdvanced"}

    def _find_upstream_sampler(self, prompt, start_id):
        """Find the nearest upstream sampler by breadth-first traversal."""
        if not prompt or start_id is None:
            return None
        start = str(start_id)
        seen = set()
        queue = [start]
        while queue:
            nid = queue.pop(0)
            if nid in seen:
                continue
            seen.add(nid)
            node = prompt.get(nid)
            if not isinstance(node, dict):
                continue
            if nid != start and node.get("class_type") in self._SAMPLER_CLASSES:
                return nid
            for v in (node.get("inputs") or {}).values():
                if isinstance(v, list) and len(v) == 2:
                    queue.append(str(v[0]))
        return None

    def _extract_workflow_info(self, prompt, unique_id=None):
        """Extract generation settings by scanning all nodes for known parameter names.

        Works with any node type (KSampler, Flux split nodes, custom nodes, etc.).
        Follows linked inputs (up to 4 hops) to resolve values from source nodes.
        With unique_id, the sampler found upstream of OUR node outranks the rest.
        """
        info = {"sampler": None, "scheduler": None, "steps": None, "cfg": None, "seed": None}
        if not prompt:
            return info

        # (param_name → (info_key, priority))  higher priority wins
        param_map = {
            "sampler_name": ("sampler", 1),
            "scheduler":    ("scheduler", 1),
            "steps":        ("steps", 1),
            "cfg":          ("cfg", 1),
            "guidance":     ("cfg", 0),
            "seed":         ("seed", 1),
            "noise_seed":   ("seed", 0),
        }
        best_priority = {k: -1 for k in info}

        # Scheduler nodes that don't expose a "scheduler" param —
        # the scheduler is implied by the node class itself.
        # (class_type → human-readable scheduler name, priority)
        scheduler_node_map = {
            "Flux2Scheduler":     ("flux2", 0),
            "BasicScheduler":     ("basic", 0),
            "ExponentialScheduler": ("exponential", 0),
            "PolyexponentialScheduler": ("polyexponential", 0),
            "LaplaceScheduler":   ("laplace", 0),
            "SDTurboScheduler":   ("sd_turbo", 0),
        }


        upstream_sampler = self._find_upstream_sampler(prompt, unique_id)
        try:
            for node_id, node_data in prompt.items():
                if not isinstance(node_data, dict):
                    continue
                class_type = node_data.get("class_type", "")
                inputs = node_data.get("inputs", {})
                boost = 2 if str(node_id) == upstream_sampler else 0

                # Standard param-based extraction
                for param_name, (info_key, priority) in param_map.items():
                    if param_name not in inputs:
                        continue
                    value = inputs[param_name]
                    if isinstance(value, list):
                        resolved = self._resolve_linked_param(prompt, value, param_name)
                        if resolved is not None:
                            value = resolved
                        else:
                            continue
                    if priority + boost > best_priority[info_key]:
                        info[info_key] = value
                        best_priority[info_key] = priority + boost

                # Fallback: detect scheduler from node class_type
                if class_type in scheduler_node_map:
                    sched_name, sched_priority = scheduler_node_map[class_type]
                    if sched_priority > best_priority["scheduler"]:
                        # Use explicit "scheduler" input if present, otherwise node name
                        sched_val = inputs.get("scheduler")
                        if sched_val and not isinstance(sched_val, list):
                            info["scheduler"] = sched_val
                        else:
                            info["scheduler"] = sched_name
                        best_priority["scheduler"] = sched_priority


                if class_type == "PowderSampler" and 2 + boost > best_priority["steps"]:
                    raw_steps = inputs.get("steps")
                    if isinstance(raw_steps, (int, float)) and not isinstance(raw_steps, bool):
                        den = inputs.get("denoise", 1.0)
                        if isinstance(den, list):
                            den = self._resolve_linked_param(prompt, den, "denoise")
                        auto = inputs.get("auto_steps", True)
                        if isinstance(den, (int, float)) and not isinstance(den, bool) \
                                and isinstance(auto, bool):
                            info["steps"] = compute_steps(int(raw_steps), float(den), auto)
                        else:
                            info["steps"] = int(raw_steps)
                        best_priority["steps"] = 2 + boost
        except Exception as e:
            warn(f"Could not extract workflow info: {e}")
        return info

    def _resolve_linked_param(self, prompt, link, param_name, depth=0):
        """Follow a link ["node_id", slot] to find a literal value.

        Looks for *param_name* in the source node's inputs.  If found as a
        literal, returns it.  If found as another link, follows recursively
        (up to 4 hops).  Also checks all inputs of the source node for any
        literal matching the same param_name.
        """
        if depth > 4 or not isinstance(link, list) or len(link) < 2:
            return None
        source_id = str(link[0])
        source_node = prompt.get(source_id)
        if not isinstance(source_node, dict):
            return None
        source_inputs = source_node.get("inputs", {})

        # Direct match: source node has the same param name
        if param_name in source_inputs:
            val = source_inputs[param_name]
            if not isinstance(val, list):
                return val
            return self._resolve_linked_param(prompt, val, param_name, depth + 1)


        if len(source_inputs) == 1:
            for val in source_inputs.values():
                if not isinstance(val, list):
                    return val
                return self._resolve_linked_param(prompt, val, param_name, depth + 1)

        return None

    def _extract_style_from_workflow(self, workflow_prompt):
        """Extract style info from PowderStyler node in the workflow graph."""
        if not workflow_prompt:
            return None

        for node_id, node_data in workflow_prompt.items():
            if not isinstance(node_data, dict):
                continue
            if node_data.get("class_type") != "PowderStyler":
                continue

            inputs = node_data.get("inputs", {})
            if inputs.get("style_sweep"):
                # Cursor position is execution state, not recoverable from the graph.
                warn("Grid: connect Styler style_info to style_metadata for sweep labels")
                return None
            style_config_str = inputs.get("style_config", "[]")
            style_position_str = inputs.get("style_position", "Wrap prompt")
            use_positive = inputs.get("use_positive", True)
            use_negative = inputs.get("use_negative", True)

            # Skip linked values
            if isinstance(style_config_str, list):
                continue

            try:
                config = json.loads(style_config_str) if style_config_str else []
                if not isinstance(config, list):
                    config = []
            except Exception:
                config = []

            _all_styles, styles_by_name = get_styles()

            style_names = []
            all_prefixes = []
            all_suffixes = []
            all_negatives = []

            for item in config:
                if not isinstance(item, dict):
                    continue
                name = item.get("name", "None")
                enabled = item.get("on", True)
                slot_use_positive = item.get("use_positive", True)
                slot_use_negative = item.get("use_negative", True)

                if not enabled or name == "None":
                    continue

                style_names.append(name)

                style = styles_by_name.get(name)
                if not style:
                    continue

                if use_positive and slot_use_positive:
                    if style["prefix"]:
                        all_prefixes.append(style["prefix"])
                    if style["suffix"]:
                        all_suffixes.append(style["suffix"])

                if use_negative and slot_use_negative and style["negative"]:
                    all_negatives.append(style["negative"])

            if not style_names:
                return None

            prefix = deduplicate_tags(", ".join(all_prefixes))
            suffix = deduplicate_tags(", ".join(all_suffixes))
            negative = deduplicate_tags(", ".join(all_negatives))

            pos_map = {"Before prompt": "before", "After prompt": "after"}
            position = pos_map.get(style_position_str, "wrap")

            return {
                "names": style_names,
                "prefix": prefix,
                "suffix": suffix,
                "negative": negative,
                "position": position,
            }

        return None

    def _wrap_text(self, text, font, max_width, draw):
        if not text:
            return [""]
        words = text.split()
        lines = []
        current_line = ""
        for word in words:
            test_line = f"{current_line} {word}".strip()
            bbox = draw.textbbox((0, 0), test_line, font=font)
            if bbox[2] - bbox[0] <= max_width:
                current_line = test_line
            else:
                if current_line:
                    lines.append(current_line)
                current_line = word
        if current_line:
            lines.append(current_line)
        return lines if lines else [""]


NODE_CLASS_MAPPINGS = {
    "PowderGridSaver": PowderGridSaver,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderGridSaver": "Powder Grid Saver",
}
