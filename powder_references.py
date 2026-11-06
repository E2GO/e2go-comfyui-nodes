"""PowderReferences — the reference set, built once and given to both sides.

Edit models read a reference twice, through two different doors:

* the TEXT encoder sees it (Qwen3-VL behind Krea2 / Qwen-Image-Edit, Gemma
  behind LTX) so the prompt's "the same coat, in red" has a referent;
* the DIFFUSION model sees it as `reference_latents` — VAE-encoded tokens
  appended to the image sequence.

Stock ComfyUI wires those separately (TextEncodeQwenImageEditPlus takes
image1..image3 AND a vae, and does both jobs inside one node). We can't: our
text side (PowderConditioner) runs before the VAE is in scope and caches its
output, while the image side (PowderImageConditioning) already holds the VAE.
Wiring the same three images into both nodes by hand is six wires and a silent
failure mode — the encoder describing one set while the model attends to
another.

So the set is a value: this node collects the images, and both consumers take
the same POWDER_REFS bundle. Two wires, and the two doors cannot disagree.

The bundle carries PIXELS, not latents: the consumers know their own budgets
(384 px for a VL encoder, ~1 MP for reference latents) and only the image side
has a VAE.
"""

import inspect
from typing import NamedTuple

import torch

from ._families import family_of
from ._log import info, warn


# Four is where the useful ceiling sits in practice: Qwen-Image-Edit-Plus and
# ostris's edit nodes stop at three, Kontext-multi at four, and every token
# spent on a reference is a token the attention pays for on every step.
_MAX_REFS = 4

_OVER_LIMIT_WARNED = set()


class RefProfile(NamedTuple):
    refs_in_slots: bool
    vl_max_pixels: int
    negative_sees_images: bool


DEFAULT_PROFILE = RefProfile(refs_in_slots=False, vl_max_pixels=384 * 384, negative_sees_images=False)
SLOT_PROFILE = RefProfile(refs_in_slots=True, vl_max_pixels=1024 * 1024, negative_sees_images=True)


def tokenizer_params(clip):
    """Parameter names of this CLIP's tokenize_with_weights, or an empty set.

    Checked on the tokenizer, not on CLIP.tokenize: the latter forwards
    **kwargs to everything and accepts anything syntactically.
    """
    try:
        return frozenset(inspect.signature(clip.tokenizer.tokenize_with_weights).parameters)
    except (AttributeError, TypeError, ValueError):
        return frozenset()


def profile_for_clip(clip):
    return SLOT_PROFILE if "keep_vision" in tokenizer_params(clip) else DEFAULT_PROFILE


def profile_for_model(model):
    return SLOT_PROFILE if family_of(model).refs_in_slots else DEFAULT_PROFILE


def link_source(graph, link):
    """[node_id, slot] a prompt link really comes from, looking through Powder Switchers.

    A bundle routed through a switcher on one side only is still the same
    bundle; an unreadable (wired) active_group ends the walk where it stands.
    """
    seen = set()
    while isinstance(link, list) and len(link) == 2 and link[0] not in seen:
        seen.add(link[0])
        node = graph.get(str(link[0]))
        if not isinstance(node, dict) or node.get("class_type") != "PowderSwitcher":
            return [str(link[0]), link[1]]
        inputs = node.get("inputs") or {}
        group = inputs.get("active_group", 1)
        if not isinstance(group, int):
            return [str(link[0]), link[1]]
        link = inputs.get(f"g{group - 1}_c{link[1]}")
    return None


def bundle_source(graph, node_id):
    """Where the `references` input of a prompt node comes from, or None."""
    if not isinstance(graph, dict) or node_id is None:
        return None
    node = graph.get(str(node_id))
    if not isinstance(node, dict):
        return None
    return link_source(graph, (node.get("inputs") or {}).get("references"))


def _frames(img):
    """IMAGE tensor -> list of single-frame slices, or [] if it isn't one."""
    if img is None:
        return []
    if not hasattr(img, "shape") or img.ndim != 4 or img.shape[0] < 1:
        warn("[PowderReferences] an input is not an IMAGE tensor — skipped")
        return []
    return [img[i:i + 1, :, :, :3] for i in range(img.shape[0])]


def pack_references(images, edited=None):
    """[IMAGE|None, ...] -> the POWDER_REFS bundle. Order is meaningful.

    Gaps are closed, not preserved: a user who fills slots 1 and 3 means "two
    references", not "reference 2 is missing". Multi-frame IMAGE inputs are
    kept whole here and split by the consumers — a batch of frames wired into
    one slot is a legitimate way to pass several references at once.

    `edited` is the image being edited, kept SEPARATE from the extras because
    the two consumers need it differently — see vl_sequence().
    """
    refs = []
    for img in images:
        refs.extend(_frames(img))
    ed = _frames(edited)
    return {"images": refs, "edited": ed[0] if ed else None}


def unpack_references(bundle, limit=_MAX_REFS):
    """POWDER_REFS -> list of single-frame IMAGE tensors. Tolerates None/junk.

    Consumers call this instead of reaching into the dict so a malformed
    bundle (an ANY-typed reroute forwarding the wrong value) degrades to "no
    references" instead of raising deep inside a VAE encode.
    """
    if not isinstance(bundle, dict):
        return []
    images = bundle.get("images")
    if not isinstance(images, (list, tuple)):
        return []
    out = [im for im in images
           if hasattr(im, "shape") and getattr(im, "ndim", 0) == 4]
    if len(out) > limit:
        # Session-scoped (the _NO_MODEL_WARNED pattern): both consumers call
        # this on every queue item, and a 40-image run must not print the
        # same truncation forty times per side.
        key = (len(out), limit)
        if key not in _OVER_LIMIT_WARNED:
            _OVER_LIMIT_WARNED.add(key)
            warn(f"[PowderReferences] {len(out)} references supplied, using the "
                 f"first {limit} — each one is attended to on every step, and no "
                 f"current edit model is trained past {limit}")
        out = out[:limit]
    return out


def vl_sequence(bundle, limit=_MAX_REFS + 1):
    """POWDER_REFS -> what the TEXT encoder should see, in model numbering.

    The two doors must agree on which picture is which. The image side builds
    `reference_latents = [the edited image] + extras`, so the edited image is
    Picture 1 there — and a text encoder shown only the extras would call the
    first extra "Picture 1" while the model calls it Picture 2. A prompt
    saying "the object in the second image" would then mean two different
    things at once.

    So the edited image leads here too, when it is wired. It is a separate
    slot rather than just `image_1` because the IMAGE side must NOT take it
    from the bundle: it already holds that picture, correctly cropped,
    blanked and capped, and adding it again would attend to it twice.
    """
    if not isinstance(bundle, dict):
        return []


    seq = unpack_references(bundle)
    edited = bundle.get("edited")
    if hasattr(edited, "shape") and getattr(edited, "ndim", 0) == 4:
        seq = [edited] + seq
    return seq[:limit]


def has_edited(bundle):
    """Is the edited image wired? Consumers warn about the numbering if not."""
    ed = isinstance(bundle, dict) and bundle.get("edited")
    return bool(hasattr(ed, "shape") and getattr(ed, "ndim", 0) == 4)


class PowderReferences:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            # Explicit empty "required": some frontend/validation paths index
            # it directly instead of .get()-ing it.
            "required": {},
            "optional": {
                "edited_image": ("IMAGE", {
                    "tooltip": "The picture being edited — wire Powder Canvas's image output here. It becomes Picture 1 for the TEXT encoder, matching the model, which always reads the edited image first. Without it the encoder numbers the extras from 1 while the model numbers them from 2, and a prompt saying 'the second image' means two different things. The image side ignores this slot: it already holds that picture, cropped and capped."}),
                **{
                    f"image_{i}": ("IMAGE", {
                        "tooltip": f"Reference {i} — Picture {i + 1} in a prompt (the edited image is Picture 1). "
                                   f"A multi-frame batch here counts as several references. Empty slots are "
                                   f"skipped, so you can leave gaps."})
                    for i in range(1, _MAX_REFS + 1)
                },
            },
        }

    RETURN_TYPES = ("POWDER_REFS",)
    RETURN_NAMES = ("references",)
    FUNCTION = "pack"
    CATEGORY = "e2go"
    DESCRIPTION = ("Collect the reference images once and give the same set to both "
                   "sides: Powder Conditioner (the text encoder LOOKS at them) and "
                   "Powder Image Conditioning in Edit mode (the model ATTENDS to them "
                   "as reference latents). Wiring them separately lets the two drift "
                   "apart.")

    def pack(self, edited_image=None, **kwargs):
        bundle = pack_references(
            [kwargs.get(f"image_{i}") for i in range(1, _MAX_REFS + 1)],
            edited=edited_image)
        n = len(bundle["images"])
        if n == 0 and has_edited(bundle):
            info("[PowderReferences] only the edited image — the text encoder sees it as Picture 1 in Edit/Repaint, nothing extra for the image side")
        elif n == 0:
            info("[PowderReferences] no images connected — consumers behave as if unwired")
        else:
            sizes = ", ".join(f"{im.shape[2]}x{im.shape[1]}" for im in bundle["images"][:_MAX_REFS])
            info(f"[PowderReferences] {n} reference(s): {sizes}"
                 f"{' + the edited image as Picture 1' if has_edited(bundle) else ''}")
            if not has_edited(bundle):
                warn("[PowderReferences] edited_image is not connected — the text encoder "
                     "will number the references from Picture 1 while the model numbers "
                     "them from Picture 2 (it reads the edited image first). Wire Powder "
                     "Canvas's image output into edited_image so a prompt that says "
                     "'the second image' means the same thing to both.")
        return (bundle,)


NODE_CLASS_MAPPINGS = {"PowderReferences": PowderReferences}
NODE_DISPLAY_NAME_MAPPINGS = {"PowderReferences": "Powder References"}
