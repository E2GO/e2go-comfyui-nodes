"""What the package knows about a model family, in one place.

Keyed by `unet_config["image_model"]`. A family not listed here gets
DEFAULT: no special reference handling, no sigma shift, no recipe hint —
the behaviour every unknown model has always had.
"""
from typing import NamedTuple, Optional


class Recipe(NamedTuple):
    steps: int
    sampler: str
    scheduler: str
    cfg: float


class Family(NamedTuple):
    # the DiT splices reference latents into the encoder's image slots, so the
    # encoder drops its vision spans and both branches must see the images
    refs_in_slots: bool = False
    # sigma shift follows the frame size (Flux2Scheduler's empirical mu)
    frame_sized_shift: bool = False
    # the official sampling recipe, when the hub's turbo defaults go wrong on it
    recipe: Optional[Recipe] = None
    # Some cores expose reference tokens but leave their routing disabled.
    reference_method: Optional[str] = None


DEFAULT = Family()
FAMILIES = {
    "krea2": Family(reference_method="index"),
    "qwen_image21": Family(refs_in_slots=True, recipe=Recipe(25, "euler", "simple", 1.0)),
    "flux2": Family(frame_sized_shift=True),
    "moss_image": Family(recipe=Recipe(50, "euler", "sgm_uniform", 3.0)),
}

# Explicit recipes, shared by the sampler UI and compatibility checks.
# Selecting one changes visible sampler widgets only, never loader weights.
MODEL_PROFILES = {
    'SDXL': dict(family=None, adm_in_channels=2816, channels=4, downscale=8,
        encoder='Checkpoint CLIP-L + CLIP-G', vae='Checkpoint SDXL VAE',
        settings=dict(steps=30, cfg=6.0, sampler_name='dpmpp_2m', scheduler='karras', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Z-Image Base': dict(family='lumina2', model_dim=3840, channels=16, downscale=8,
        encoder='Qwen3 4B / lumina2', vae='Flux AE', shift=3.0, multiplier=1.0,
        settings=dict(steps=25, cfg=4.0, sampler_name='res_multistep', scheduler='simple', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Z-Image Turbo': dict(family='lumina2', model_dim=3840, channels=16, downscale=8,
        encoder='Qwen3 4B / lumina2', vae='Flux AE', shift=3.0, multiplier=1.0,
        settings=dict(steps=8, cfg=1.0, sampler_name='res_multistep', scheduler='simple', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Flux 2 Klein Base': dict(family='flux2', channels=128, downscale=16,
        encoder='Qwen3 8B / flux2', vae='Flux2 VAE',
        settings=dict(steps=20, cfg=5.0, sampler_name='euler', scheduler='simple', auto_steps=True, flux2_shift='auto', inpaint_boost='off')),
    'Flux 2 Klein Distilled': dict(family='flux2', channels=128, downscale=16,
        encoder='Qwen3 8B / flux2', vae='Flux2 VAE',
        settings=dict(steps=4, cfg=1.0, sampler_name='euler', scheduler='simple', auto_steps=True, flux2_shift='auto', inpaint_boost='off')),
    'Flux 3 Klein Base': dict(family='flux3', channels=128, downscale=16,
        encoder='Qwen3 VL 4B / flux3', vae='Flux2 VAE',
        settings=dict(steps=50, cfg=3.5, sampler_name='euler', scheduler='simple', auto_steps=True, flux2_shift='model', inpaint_boost='off')),
    'Boogu Base': dict(family='boogu', channels=16, downscale=8,
        encoder='Qwen3 VL 8B / boogu', vae='Flux AE',
        settings=dict(steps=25, cfg=4.0, sampler_name='dpmpp_2m', scheduler='simple', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Boogu Edit': dict(family='boogu', channels=16, downscale=8,
        encoder='Qwen3 VL 8B / boogu', vae='Flux AE',
        settings=dict(steps=25, cfg=3.5, sampler_name='dpmpp_2m', scheduler='simple', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Boogu Turbo': dict(family='boogu', channels=16, downscale=8,
        encoder='Qwen3 VL 8B / boogu', vae='Flux AE',
        settings=dict(steps=4, cfg=1.0, sampler_name='lcm', scheduler='sgm_uniform', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Ideogram 4': dict(family='ideogram4', channels=128, downscale=16,
        encoder='Qwen3 VL 8B / ideogram4', vae='Flux2 VAE',
        settings=dict(steps=20, cfg=7.0, sampler_name='euler', scheduler='ideogram4', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'MOSS SFT': dict(family='moss_image', channels=128, downscale=16,
        encoder='Qwen3.5 9B / moss_image', vae='Flux2 VAE', shift=5.0, multiplier=1.0,
        settings=dict(steps=50, cfg=3.0, sampler_name='euler', scheduler='sgm_uniform', auto_steps=False, flux2_shift='model', inpaint_boost='off')),
    'Krea2 Turbo': dict(family='krea2', channels=16, downscale=8, latent_ndims=(4, 5),
        encoder='Qwen3 VL 4B / krea2', vae='Wan2.1 VAE',
        settings=dict(steps=8, cfg=1.0, sampler_name='euler', scheduler='simple', auto_steps=True, flux2_shift='model', inpaint_boost='off')),
    'Qwen 2.1': dict(family='qwen_image21', channels=64, downscale=16,
        encoder='Qwen3 VL 8B / qwen_image', vae='Qwen Image 2.1 VAE',
        settings=dict(steps=25, cfg=1.0, sampler_name='euler', scheduler='simple', auto_steps=True, flux2_shift='model', inpaint_boost='off')),
}


def check_model_profile(model, latent, name):
    if name == 'Manual':
        return
    profile = MODEL_PROFILES[name]
    if image_model_of(model) != profile['family']:
        raise ValueError(f'{name}: the connected model has a different family. Select Manual or the matching profile.')
    if 'adm_in_channels' in profile and model.model.model_config.unet_config.get('adm_in_channels') != profile['adm_in_channels']:
        raise ValueError(f'{name}: connect an SDXL base checkpoint, not SD1 or an SDXL refiner.')
    if 'model_dim' in profile and model.model.model_config.unet_config.get('dim') != profile['model_dim']:
        raise ValueError(f'{name}: expected Z-Image weights, not another Lumina-family model.')
    samples = latent['samples']
    if samples.ndim not in profile.get('latent_ndims', (4,)) or samples.shape[1] != profile['channels']:
        raise ValueError(f"{name}: expected {profile['channels']} latent channels /{profile['downscale']}. Check Resolution and VAE.")
    actual_ds = latent.get('downscale_ratio_spacial')
    if actual_ds is not None and actual_ds != profile['downscale']:
        raise ValueError(f"{name}: latent spatial scale must be /{profile['downscale']}.")
    if 'multiplier' in profile:
        sampling = model.get_model_object('model_sampling')
        if getattr(sampling, 'multiplier', None) != profile['multiplier'] or getattr(sampling, 'shift', None) != profile['shift']:
            raise ValueError(f"{name} requires Shift {profile['shift']:g} and multiplier {profile['multiplier']:g}. Use core defaults or the matching ModelSamplingAuraFlow; ModelSamplingSD3 is incompatible.")


def image_model_of(model):
    """unet_config["image_model"] of a ModelPatcher, or None when unreadable."""
    try:
        return model.model.model_config.unet_config.get("image_model")
    except AttributeError:
        return None


def family_of(model):
    return FAMILIES.get(image_model_of(model), DEFAULT)
