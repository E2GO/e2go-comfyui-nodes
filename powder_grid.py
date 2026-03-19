"""
PowderGridSaver - Grid assembly with progressive saving and JSON metadata.
"""

import os
import json
import platform
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from datetime import datetime
import folder_paths
import torch

from ._log import log, warn
from ._styles import load_styles_from_directory, get_styles_dir, deduplicate_tags

# ---------------------------------------------------------------------------
# Font cache  (font_path, size) → ImageFont
# ---------------------------------------------------------------------------
_FONT_CACHE: dict = {}

# ---------------------------------------------------------------------------
# Style cache (shared with PowderStyler format)
# ---------------------------------------------------------------------------
_ALL_STYLES: list = []
_STYLES_BY_NAME: dict = {}


def _ensure_styles_loaded():
    global _ALL_STYLES, _STYLES_BY_NAME
    if not _ALL_STYLES:
        _ALL_STYLES = load_styles_from_directory(get_styles_dir())
        _STYLES_BY_NAME = {s["name"]: s for s in _ALL_STYLES}


class PowderGridSaver:
    """Assembles images into a labelled grid and saves PNG + optional JSON."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "layout": (["Horizontal (Loras as columns)", "Vertical (Loras as rows)"],),
                "gap": ("INT", {"default": 10, "min": 0, "max": 100, "step": 1}),
                "background": (["Dark", "Light"],),
                "show_model_name": ("BOOLEAN", {"default": True}),
                "show_lora_names": ("BOOLEAN", {"default": True}),
                "show_prompts": ("BOOLEAN", {"default": True}),
                "prompt_max_chars": ("INT", {"default": 100, "min": 10, "max": 500, "step": 10}),
                "font_size": ("INT", {"default": 36, "min": 12, "max": 100, "step": 2}),
                "show_style_prompt": ("BOOLEAN", {"default": False}),
                "save_json": ("BOOLEAN", {"default": True}),
                "add_model_to_filename": ("BOOLEAN", {"default": True}),
                "filename_prefix": ("STRING", {"default": "grid"}),
                "subfolder": ("STRING", {"default": "grids"}),
            },
            "optional": {
                "lora_info": ("STRING", {"forceInput": True}),
                "prompts": ("STRING", {"forceInput": True}),
                "negative_prompts": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("grid_image", "saved_paths")
    OUTPUT_NODE = True
    FUNCTION = "create_grid"
    CATEGORY = "e2go_nodes"

    @classmethod
    def IS_CHANGED(cls, *_args, **_kwargs):
        return float("NaN")

    @classmethod
    def VALIDATE_INPUTS(cls, layout, background, **kwargs):
        """Accept boolean values from new ComfyUI frontend for 2-option combos."""
        return True

    def create_grid(self, images, layout, gap, background, show_model_name,
                    show_lora_names, show_prompts, prompt_max_chars, font_size,
                    show_style_prompt, save_json, add_model_to_filename,
                    filename_prefix, subfolder,
                    lora_info=None, prompts=None, negative_prompts=None, prompt=None, extra_pnginfo=None):

        # Unpack scalars
        layout = layout[0] if isinstance(layout, list) else layout
        gap = gap[0] if isinstance(gap, list) else gap
        background = background[0] if isinstance(background, list) else background

        # ComfyUI new frontend converts 2-option combos to boolean toggles
        if isinstance(layout, bool) or layout in ("True", "False", "true", "false"):
            layout = "Horizontal (Loras as columns)" if str(layout).lower() == "true" else "Vertical (Loras as rows)"
        if isinstance(background, bool) or background in ("True", "False", "true", "false"):
            background = "Dark" if str(background).lower() == "true" else "Light"
        show_model_name = show_model_name[0] if isinstance(show_model_name, list) else show_model_name
        show_lora_names = show_lora_names[0] if isinstance(show_lora_names, list) else show_lora_names
        show_prompts = show_prompts[0] if isinstance(show_prompts, list) else show_prompts
        prompt_max_chars = prompt_max_chars[0] if isinstance(prompt_max_chars, list) else prompt_max_chars
        font_size = font_size[0] if isinstance(font_size, list) else font_size
        show_style_prompt = show_style_prompt[0] if isinstance(show_style_prompt, list) else show_style_prompt
        save_json = save_json[0] if isinstance(save_json, list) else save_json
        add_model_to_filename = add_model_to_filename[0] if isinstance(add_model_to_filename, list) else add_model_to_filename
        filename_prefix = filename_prefix[0] if isinstance(filename_prefix, list) else filename_prefix
        subfolder = subfolder[0] if isinstance(subfolder, list) else subfolder

        workflow_prompt = prompt[0] if isinstance(prompt, list) else prompt
        model_display_name = self._extract_model_from_prompt(workflow_prompt)
        workflow_info = self._extract_workflow_info(workflow_prompt)

        # Parse lora_info
        lora_names = []
        lora_strengths = []
        combination_order = "Loras first"
        lora_mode = "single"
        original_loras = []

        if lora_info:
            lora_info_str = lora_info[0] if isinstance(lora_info, list) else lora_info
            try:
                info = json.loads(lora_info_str) if lora_info_str else {}
                if isinstance(info, dict):
                    lora_names = info.get("loras", [])
                    lora_strengths = info.get("strengths", [])
                    combination_order = info.get("combination_order", "Loras first")
                    lora_mode = info.get("mode", "single")
                    original_loras = info.get("original_loras", lora_names)
                    if not isinstance(lora_names, list):
                        lora_names = []
                    if not isinstance(lora_strengths, list):
                        lora_strengths = []
                else:
                    warn(f"Invalid lora_info type: {type(info)}")
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

        output_dir = folder_paths.get_output_directory()
        if subfolder:
            output_dir = os.path.join(output_dir, subfolder)
            os.makedirs(output_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

        # Build filename base: optionally prepend sanitized model name
        if add_model_to_filename and model_display_name:
            safe_model = model_display_name.replace(" ", "_")
            safe_model = "".join(c for c in safe_model if c.isalnum() or c in "_-.")
            file_base = f"{safe_model}_{filename_prefix}_{timestamp}"
        else:
            file_base = f"{filename_prefix}_{timestamp}"

        saved_paths = []

        # Convert tensors to PIL — unpack batches, .detach() and size validation
        pil_images = []
        target_size = None
        for img_tensor in images:
            # Unpack batch dimension: [B, H, W, C] → B individual [H, W, C] frames
            if len(img_tensor.shape) == 4:
                frames = [img_tensor[i] for i in range(img_tensor.shape[0])]
            else:
                frames = [img_tensor]

            for frame in frames:
                img_np = (frame.detach().cpu().numpy() * 255).astype(np.uint8)
                pil_img = Image.fromarray(img_np)

                if target_size is None:
                    target_size = (pil_img.width, pil_img.height)
                elif (pil_img.width, pil_img.height) != target_size:
                    warn(f"Image size mismatch: {pil_img.size} vs {target_size}, resizing")
                    pil_img = pil_img.resize(target_size, Image.LANCZOS)

                pil_images.append(pil_img)

        # Calculate grid dimensions AFTER unpacking batches
        total_images = len(pil_images)
        if num_loras > 0 and total_images > 0:
            num_prompts = total_images // num_loras
        else:
            num_prompts = total_images if total_images else 1

        display_prompts = prompt_list[:num_prompts] if prompt_list else []

        # Extract style info from workflow
        style_info = self._extract_style_from_workflow(workflow_prompt)

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
        log(f"[PowderGridSaver] Images: {total_images}, Loras: {num_loras}, Prompts: {num_prompts}")
        log(f"[PowderGridSaver] Layout: {layout}, Order: {combination_order}, Mode: {lora_mode}")

        if not pil_images:
            warn("No images!")
            return (images[0:1] if images else [], "")

        if not lora_names and not display_prompts:
            num_cols = int(np.ceil(np.sqrt(len(pil_images))))
            num_rows = int(np.ceil(len(pil_images) / num_cols))
            num_loras = num_cols
            num_prompts = num_rows

        is_horizontal = "Horizontal" in layout
        is_loras_first = "Loras first" in combination_order

        lora_labels = self._prepare_lora_labels(lora_names, lora_strengths)
        display_negatives = negative_list[:num_prompts] if negative_list else []

        json_data = {
            "timestamp": timestamp,
            "model": model_display_name,
            "sampler": workflow_info.get("sampler"),
            "scheduler": workflow_info.get("scheduler"),
            "steps": workflow_info.get("steps"),
            "cfg": workflow_info.get("cfg"),
            "seed": workflow_info.get("seed"),
            "layout": layout,
            "combination_order": combination_order,
            "mode": lora_mode,
            "loras": original_loras if original_loras else lora_names,
            "strengths": lora_strengths,
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

        final_grid = self._create_grid(
            pil_images, lora_labels, display_prompts,
            is_horizontal, is_loras_first,
            num_loras, num_prompts,
            gap, background, show_lora_names, show_prompts,
            prompt_max_chars, font_size,
            model_display_name if show_model_name else None,
        )

        final_path = os.path.join(output_dir, f"{file_base}.png")
        final_grid.save(final_path, "PNG")
        saved_paths.append(final_path)
        json_data["files"].append(os.path.basename(final_path))
        log(f"[PowderGridSaver] Saved grid: {os.path.basename(final_path)}")

        if save_json:
            json_path = os.path.join(output_dir, f"{file_base}.json")
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(json_data, f, indent=2, ensure_ascii=False)
            saved_paths.append(json_path)
            log(f"[PowderGridSaver] Saved: {os.path.basename(json_path)}")

        log(f"[PowderGridSaver] Total saved: {len(saved_paths)} files")

        # Convert final_grid PIL → tensor directly (no re-read from disk)
        final_np = np.array(final_grid).astype(np.float32) / 255.0
        final_tensor = torch.from_numpy(final_np).unsqueeze(0)
        return (final_tensor, "\n".join(saved_paths))

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
                     prompt_max_chars, font_size, model_name=None):

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

        total_width = row_label_width + num_cols * img_width + (num_cols - 1) * gap + gap * 2
        total_height = title_height + header_height + num_rows * img_height + (num_rows - 1) * gap + gap * 2

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
                y_center = title_height + header_height + gap + row_idx * (img_height + gap) + img_height // 2
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
                continue

            x = row_label_width + gap + col * (img_width + gap)
            y = title_height + header_height + gap + row * (img_height + gap)

            grid_img.paste(pil_img, (x, y))

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
            cache_key = (font_path, font_size)
            if cache_key in _FONT_CACHE:
                return _FONT_CACHE[cache_key]
            try:
                font = ImageFont.truetype(font_path, font_size)
                _FONT_CACHE[cache_key] = font
                return font
            except Exception:
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

    def _extract_model_from_prompt(self, prompt):
        if not prompt:
            return None
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

    def _extract_workflow_info(self, prompt):
        """Extract generation settings by scanning all nodes for known parameter names.

        Works with any node type (KSampler, Flux split nodes, custom nodes, etc.).
        Follows linked inputs (up to 4 hops) to resolve values from source nodes.
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

        try:
            for node_id, node_data in prompt.items():
                if not isinstance(node_data, dict):
                    continue
                class_type = node_data.get("class_type", "")
                inputs = node_data.get("inputs", {})

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
                    if priority > best_priority[info_key]:
                        info[info_key] = value
                        best_priority[info_key] = priority

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

        # Scan all literal inputs of the source node for a plausible value
        # (e.g. a KSamplerSelect node outputs sampler_name but stores it
        #  in its own input also called sampler_name)
        for key, val in source_inputs.items():
            if isinstance(val, list):
                continue
            # Return the first literal from the source node — it likely
            # holds the value that the node outputs.
            # Only do this for single-output simple nodes.
            if len(source_inputs) == 1:
                return val

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
            except (json.JSONDecodeError, Exception):
                config = []

            _ensure_styles_loaded()

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

                style = _STYLES_BY_NAME.get(name)
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
