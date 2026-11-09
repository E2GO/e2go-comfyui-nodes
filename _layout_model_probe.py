"""Read architecture signatures from safetensors headers, never weight tensors."""
import json
import struct
from functools import lru_cache
from pathlib import Path


def family_from_keys(keys):
    # Same distinguishing keys as ComfyUI model_detection, including packaged checkpoints.
    for prefix in ('', 'model.diffusion_model.', 'diffusion_model.', 'transformer.'):
        has = lambda name: prefix + name in keys
        if has('txtfusion.projector.weight') and has('first.weight'):
            return 'krea2'
        if has('embed_image_indicator.weight') and has('input_proj.weight'):
            return 'ideogram4'
        if has('shared_block_modulation.weight') and has('layers.0.proj.ffn_up_gate.weight'):
            return 'moss_image'
        if has('content_mode_blocks.image.0.attn_out.weight') and has('single_stream_modulations.txt.lin.weight'):
            return 'flux3'
    return None


@lru_cache(maxsize=64)
def _read_header(path, mtime_ns, size):
    with open(path, 'rb') as file:
        raw = file.read(8)
        if len(raw) != 8:
            return None
        length = struct.unpack('<Q', raw)[0]
        if not 2 <= length <= min(16 * 1024 * 1024, size - 8):
            return None
        header = json.loads(file.read(length))
    return family_from_keys(header) if isinstance(header, dict) else None


def probe_layout_model(category, name):
    import folder_paths
    if category not in ('diffusion_models', 'checkpoints') or not isinstance(name, str):
        raise ValueError('Unsupported model source.')
    if name not in folder_paths.get_filename_list(category):
        raise ValueError('Select a registered model file.')
    resolved = folder_paths.get_full_path(category, name)
    if not resolved:
        raise ValueError('Model file is unavailable.')
    path = Path(resolved)
    if path.suffix.lower() != '.safetensors':
        return None
    stat = path.stat()
    try:
        return _read_header(str(path), stat.st_mtime_ns, stat.st_size)
    except (OSError, ValueError, UnicodeError):
        return None
