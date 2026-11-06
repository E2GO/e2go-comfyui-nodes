"""Lazily route a selected group of aligned channels."""

MAX_GROUPS = 16
MAX_CHANNELS = 8


class AnyType(str):
    """Wildcard type: equals every other type so ComfyUI never rejects a
    connection or a mismatched-type validation."""
    def __ne__(self, other):
        return False


ANY = AnyType("*")


class PowderSwitcher:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for g in range(MAX_GROUPS):
            for c in range(MAX_CHANNELS):
                optional[f"g{g}_c{c}"] = (ANY, {"lazy": True})
        return {
            "required": {
                # 1-based active group; driven by the JS radio toggles.
                "active_group": ("INT", {"default": 1, "min": 1, "max": MAX_GROUPS}),
            },
            "optional": optional,
        }

    RETURN_TYPES = tuple(ANY for _ in range(MAX_CHANNELS))
    RETURN_NAMES = tuple(f"out_{c}" for c in range(MAX_CHANNELS))
    FUNCTION = "route"
    CATEGORY = "e2go"

    def check_lazy_status(self, active_group=1, **kwargs):
        # kwargs holds ONLY connected inputs (unconnected optionals never reach
        # input_data_all). Request the active group's connected-but-unevaluated
        # channels (value None); skip already-evaluated (non-None). Never name an
        # input with no link — that is exactly the t2i_latent NodeInputError.
        g = max(0, min(MAX_GROUPS - 1, int(active_group) - 1))
        prefix = f"g{g}_c"                       # trailing "c" blocks g1/g10 collisions
        return [k for k in kwargs if k.startswith(prefix) and kwargs[k] is None]

    def route(self, active_group=1, **kwargs):
        g = max(0, min(MAX_GROUPS - 1, int(active_group) - 1))
        values = tuple(kwargs.get(f"g{g}_c{c}") for c in range(MAX_CHANNELS))
        # Missing channels must stop only their consumers, rather than send
        # None into a string/model/image node and fail there with a TypeError.
        try:
            from comfy_execution.graph_utils import ExecutionBlocker
        except ImportError:
            return values  # Standalone use outside ComfyUI.
        return tuple(ExecutionBlocker(None) if value is None else value for value in values)


NODE_CLASS_MAPPINGS = {"PowderSwitcher": PowderSwitcher}
NODE_DISPLAY_NAME_MAPPINGS = {"PowderSwitcher": "Powder Switcher"}
