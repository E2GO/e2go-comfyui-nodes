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

# ---------------------------------------------------------------------------
# Font cache  (font_path, size) → ImageFont
# ---------------------------------------------------------------------------
_FONT_CACHE: dict = {}


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
                "save_json": ("BOOLEAN", {"default": True}),
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
                    save_json, filename_prefix, subfolder,
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
        save_json = save_json[0] if isinstance(save_json, list) else save_json
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

        if num_loras > 0 and len(images) > 0:
            num_prompts = len(images) // num_loras
        else:
            num_prompts = len(images) if images else 1

        display_prompts = prompt_list[:num_prompts] if prompt_list else []

        log(f"[PowderGridSaver] === START ===")
        log(f"[PowderGridSaver] Model: {model_display_name or 'Not detected'}")
        log(f"[PowderGridSaver] Images: {len(images)}, Loras: {num_loras}, Prompts: {num_prompts}")
        log(f"[PowderGridSaver] Layout: {layout}, Order: {combination_order}, Mode: {lora_mode}")

        output_dir = folder_paths.get_output_directory()
        if subfolder:
            output_dir = os.path.join(output_dir, subfolder)
            os.makedirs(output_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        saved_paths = []

        # Convert tensors to PIL — with .detach() and size validation
        pil_images = []
        target_size = None
        for img_tensor in images:
            if len(img_tensor.shape) == 4:
                img_tensor = img_tensor[0]
            img_np = (img_tensor.detach().cpu().numpy() * 255).astype(np.uint8)
            pil_img = Image.fromarray(img_np)

            if target_size is None:
                target_size = (pil_img.width, pil_img.height)
            elif (pil_img.width, pil_img.height) != target_size:
                warn(f"Image size mismatch: {pil_img.size} vs {target_size}, resizing")
                pil_img = pil_img.resize(target_size, Image.LANCZOS)

            pil_images.append(pil_img)

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

        final_path = os.path.join(output_dir, f"{filename_prefix}_{timestamp}.png")
        final_grid.save(final_path, "PNG")
        saved_paths.append(final_path)
        json_data["files"].append(os.path.basename(final_path))
        log(f"[PowderGridSaver] Saved grid: {os.path.basename(final_path)}")

        if save_json:
            json_path = os.path.join(output_dir, f"{filename_prefix}_{timestamp}.json")
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
        info = {"sampler": None, "scheduler": None, "steps": None, "cfg": None, "seed": None}
        if not prompt:
            return info
        try:
            sampler_nodes = ["KSampler", "KSamplerAdvanced", "SamplerCustom"]
            for node_id, node_data in prompt.items():
                if isinstance(node_data, dict):
                    class_type = node_data.get("class_type", "")
                    if class_type in sampler_nodes:
                        inputs = node_data.get("inputs", {})
                        info["sampler"] = inputs.get("sampler_name")
                        info["scheduler"] = inputs.get("scheduler")
                        info["steps"] = inputs.get("steps")
                        info["cfg"] = inputs.get("cfg")
                        info["seed"] = inputs.get("seed")
                        break
        except Exception as e:
            warn(f"Could not extract workflow info: {e}")
        return info

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
