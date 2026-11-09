"""ComfyUI sampling with model profiles, batch similarity and optional mask-aware refinement."""

import math

from ._log import info, warn
from ._families import family_of, image_model_of, MODEL_PROFILES, check_model_profile
from .powder_inpaint import compute_steps


_FALLBACK_SAMPLERS = ["er_sde"]
_FALLBACK_SCHEDULERS = ["simple"]


_NO_BOOST_SAMPLERS = ("uni_pc", "uni_pc_bh2", "ddim", "dpm_fast", "dpm_adaptive")


def flux2_mu(seq_len, steps):
    """Compute the empirical Flux.2 sigma shift from token count and sampling steps."""
    a1, b1 = 8.73809524e-05, 1.89833333
    a2, b2 = 0.00016927, 0.45666666
    m_200 = a2 * seq_len + b2
    if seq_len > 4300:
        return float(m_200)
    m_10 = a1 * seq_len + b1
    a = (m_200 - m_10) / 190.0
    return float(a * steps + (m_200 - 200.0 * a))


def _flux2_seq_len(samples, ds=None):
    """Return the Flux.2 token count, accounting for rescaling of empty latents."""
    if getattr(samples, "ndim", 0) != 4:
        return None
    h, w = int(samples.shape[-2]), int(samples.shape[-1])
    if ds is not None and ds != 16 and not samples.any():
        h, w = round(h * ds / 16), round(w * ds / 16)
    return h * w if h > 0 and w > 0 else None


def native_recipe_hint(model, steps, sampler_name):
    """One line when the hub's Krea2-turbo defaults meet Qwen Image 2.1.

    Its official path (core templates) is 25 steps, euler/simple, cfg 1; ten
    er_sde steps come out dirty there and nothing else in the graph says why.
    Nothing is changed: steps are the user's widget and auto_steps counts
    from it.
    """
    recipe = family_of(model).recipe
    if recipe is not None and (int(steps) < recipe.steps * 0.6 or sampler_name != recipe.sampler):
        info(f"[PowderSampler] {image_model_of(model)} official recipe: {recipe.steps} steps, "
             f"{recipe.sampler}/{recipe.scheduler}, cfg {recipe.cfg:g} — "
             f"the hub is at {int(steps)} steps / {sampler_name}")


def apply_flux2_shift(model, latent, steps):
    """Clone compatible Flux.2 models with an image-size-dependent sigma shift; return other models unchanged."""
    if not family_of(model).frame_sized_shift or not isinstance(latent, dict):
        return model
    model_config = model.model.model_config
    seq_len = _flux2_seq_len(latent.get("samples"), latent.get("downscale_ratio_spacial"))
    if seq_len is None:
        return model
    mu = flux2_mu(seq_len, int(steps))
    try:
        import comfy.model_sampling as model_sampling

        class _Flux2Sampling(model_sampling.ModelSamplingFlux, model_sampling.CONST):
            pass

        patched = _Flux2Sampling(model_config)
        patched.set_parameters(shift=mu)
        out = model.clone()
        out.add_object_patch("model_sampling", patched)
    except Exception as e:
        warn(f"[PowderSampler] Flux.2 sigma shift could not be applied ({e}) — the schedule "
             f"remains fixed; large images may show grain")
        return model
    info(f"[PowderSampler] Flux.2: seq_len={seq_len}, sigma shift mu={mu:.3f} "
         f"(the model configuration uses a fixed shift)")
    return out


def _sampler_lists():
    try:
        import comfy.samplers
        return comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS
    except Exception:
        return _FALLBACK_SAMPLERS, _FALLBACK_SCHEDULERS


def _restore_outside_mask(out, latent_in):
    """Restore latent cells outside the noise mask without attenuating partially masked samples."""
    mask = latent_in.get("noise_mask") if isinstance(latent_in, dict) else None
    samples = out.get("samples") if isinstance(out, dict) else None
    src = latent_in.get("samples") if isinstance(latent_in, dict) else None
    if mask is None or not hasattr(samples, "shape") or not hasattr(src, "shape"):
        return out
    if tuple(samples.shape) != tuple(src.shape):


        info(f"[PowderSampler] latent channels matched the model through "
             f"fix_empty_latent_channels ({tuple(src.shape)} -> "
             f"{tuple(samples.shape)}) — outside-mask restoration "
             f"skipped because the shapes differ")
        return out
    try:
        import comfy.utils
        keep = (comfy.utils.reshape_mask(mask, samples.shape) > 0).to(
            device=samples.device, dtype=samples.dtype)
    except Exception as e:
        warn(f"[PowderSampler] outside-mask restoration skipped ({e})")
        return out
    src = src.to(device=samples.device, dtype=samples.dtype)
    leak = float(((samples - src).abs() * (1.0 - keep)).max())
    if leak > 1e-4:
        info(f"[PowderSampler] outside-mask leak {leak:.4f} — outside-mask "
             f"cells restored from the input latent")
    out = dict(out)
    out["samples"] = samples * keep + src * (1.0 - keep)
    return out


def _slerp_noise(a, b, t):
    """Spherically interpolate noise tensors while preserving their magnitude."""
    import torch
    if t <= 0.0:
        return a
    if t >= 1.0:
        return b
    af, bf = a.flatten().float(), b.flatten().float()
    na, nb = af.norm(), bf.norm()
    if na == 0 or nb == 0:
        return a * (1.0 - t) + b * t
    dot = torch.dot(af / na, bf / nb).clamp(-1.0, 1.0)
    omega = torch.acos(dot)
    so = torch.sin(omega)
    if float(so.abs()) < 1e-6:
        return a * (1.0 - t) + b * t
    return (torch.sin((1.0 - t) * omega) / so) * a + (torch.sin(t * omega) / so) * b


def apply_similarity(noise, similarity):
    """Blend batch noise toward the first frame. Zero preserves independent noise; one shares the reference noise."""
    try:
        s = float(similarity)
    except (TypeError, ValueError):
        return noise
    if noise is None or not (s > 0.0) or getattr(noise, "shape", (0,))[0] < 2:
        return noise
    out = noise.clone()
    for i in range(1, noise.shape[0]):
        out[i] = _slerp_noise(noise[0], noise[i], 1.0 - s)
    return out


class PowderSampler:
    @classmethod
    def INPUT_TYPES(cls):
        samplers, schedulers = _sampler_lists()
        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "latent": ("LATENT",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                 "control_after_generate": True}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 100,
                                  "tooltip": "Full-run step count (Krea2 Turbo: 8). With auto_steps, the effective count is scaled by denoise; otherwise exactly this many steps are used."}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0,
                                  "step": 0.1, "round": 0.01}),
                "sampler_name": (samplers, {"default": "euler"}),
                "scheduler": ([*schedulers, "ideogram4"], {"default": "simple"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                      "tooltip": "Connect denoise from Powder Image Conditioning to use the value selected for the editing mode."}),
                "auto_steps": ("BOOLEAN", {"default": True,
                                           "tooltip": "Effective steps = max(1, ceil(steps × denoise)). For example, 8 × 0.5 = 4. Disable for an exact manual step count."}),
                "inpaint_boost": (["off", "soft", "seams", "max"], {
                    "default": "soft",
                    "tooltip": "Mask refinement: soft adjusts the mask schedule; "
                               "seams also refines boundaries; max adds RePaint resampling. "
                               "Requires a noise mask in the latent."}),
                "similarity": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0,
                                        "step": 0.05,
                                        "tooltip": "Similarity between frames in one batch. 0 keeps independent noise; 1 shares the first frame noise. Final similarity also depends on the sampler. Has no effect with batch_size=1."}),
                "flux2_shift": (["auto", "model"], {"default": "auto",
                    "tooltip": "Flux.2 sigma shift. Auto derives mu from image size, as Flux2Scheduler does. Model uses the fixed model configuration. Has no effect on other model families."}),
            },
            "optional": {"model_profile": (["Manual", *MODEL_PROFILES], {"default": "Manual",
                "tooltip": "Profile validates model/latent compatibility. Apply profile copies the recipe into visible widgets. Manual preserves existing settings; loaders are never changed."}),
                "model_negative": ("MODEL", {"tooltip": "Ideogram 4 unconditional model. Required for Ideogram; leave disconnected for other families. Ideogram uses its native schedule, zero conditioning and late CFG 3 from 70%."}),
                "ideogram_mode": (["Standard", "First sigma +0.005 (experimental)"], {"default": "Standard",
                    "tooltip": "Ideogram only. Standard keeps the native schedule. The experimental mode adds 0.005 to the first sampled sigma without changing the step count. It can help with gray placeholders, but may change composition or introduce artifacts. It does not change the prompt or model weights; other model families ignore it."})},
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "sample"
    CATEGORY = "e2go"

    def sample(self, model, positive, negative, latent, seed, steps, cfg,
               sampler_name, scheduler, denoise, auto_steps,
               inpaint_boost="soft", similarity=0.0, flux2_shift="auto",
               prompt=None, unique_id=None, model_profile="Manual", model_negative=None,
               ideogram_mode="Standard"):
        check_model_profile(model, latent, model_profile)


        if prompt is not None and unique_id is not None:
            inputs = (prompt.get(str(unique_id)) or {}).get("inputs", {})
            if isinstance(inputs.get("steps"), list):
                raise ValueError(
                    "PowderSampler: wired steps are unsupported; "
                    "the sampler already scales steps by denoise. Set "
                    "base steps in the widget")
        if not math.isfinite(float(denoise)) or float(denoise) <= 0.0:


            warn("[PowderSampler] denoise is non-positive or non-finite; passing the latent through without sampling")
            return (latent,)
        ideogram = image_model_of(model) == "ideogram4"
        layout_conditions = [entry for entry in positive if isinstance(entry, (list, tuple)) and len(entry) == 2 and isinstance(entry[1], dict) and entry[1].get('e2go_layout')]
        for _tensor, metadata in layout_conditions:
            stamp = metadata.get('e2go_layout')
            if stamp:
                target, width, height = stamp
                from ._layout_prompt import layout_model_error, send_layout_status
                compatibility_error = layout_model_error(target, image_model_of(model))
                send_layout_status(metadata.get('e2go_layout_source'), target, compatibility_error)
                if compatibility_error:
                    raise ValueError(compatibility_error)
                scale = latent.get('downscale_ratio_spacial')
                if scale is None:
                    scale = getattr(getattr(getattr(model, 'model', None), 'latent_format', None), 'spacial_downscale_ratio', 16)
                actual = (latent['samples'].shape[-1] * scale, latent['samples'].shape[-2] * scale)
                if actual != (width, height):
                    raise ValueError(f'Canvas Layout is {width}x{height}, but the sampled image is {actual[0]}x{actual[1]}. Match the layout size; cropped inpainting needs a layout of the crop.')
        if layout_conditions:
            positive = [[tensor, {k: v for k, v in metadata.items() if k not in ('e2go_layout', 'e2go_layout_source')}] for tensor, metadata in positive]
        if ideogram and (model_negative is None or image_model_of(model_negative) != "ideogram4"):
            raise ValueError("Powder Sampler: connect an Ideogram 4 unconditional model to model_negative.")
        if not ideogram and (model_negative is not None or scheduler == "ideogram4"):
            raise ValueError("Powder Sampler: model_negative and the ideogram4 schedule require an Ideogram 4 model.")
        native_recipe_hint(model, steps, sampler_name)
        effective = compute_steps(steps, denoise, auto_steps)
        # Edit latents carry a salt (powder_inpaint.EDIT_SEED_SALT): the noise
        # must not repeat the noise the edited picture was generated from.
        salt = int(latent.get("seed_salt", 0)) if isinstance(latent, dict) else 0
        if salt:
            seed = (int(seed) + salt) & 0xffffffffffffffff
        if ideogram:
            if ideogram_mode not in ("Standard", "First sigma +0.005 (experimental)"):
                raise ValueError("Powder Sampler: choose a supported Ideogram sampling mode.")
            out = self._sample_ideogram(model, model_negative, positive, latent, seed,
                                        effective, cfg, sampler_name, denoise,
                                        inpaint_boost, similarity, ideogram_mode)
            return (_restore_outside_mask(out, latent),)


        if flux2_shift != "model":
            model = apply_flux2_shift(model, latent, effective)

        def _stock():
            import nodes
            return nodes.common_ksampler(model, seed, effective, cfg, sampler_name,
                                         scheduler, positive, negative, latent,
                                         denoise=float(denoise))

        try:
            var = float(similarity)
        except (TypeError, ValueError):
            var = 0.0
        if var != var:
            var = 0.0


        def _boost_fallback():


            if var > 0.0:
                info(f"[PowderSampler] boost failed, similarity={var:g} — "
                     f"falling back through the similarity-aware sampling path")
                return self._sample_plain(model, positive, negative, latent, seed,
                                          effective, cfg, sampler_name, scheduler,
                                          denoise, var, _stock)
            return _stock()

        boosted = not (inpaint_boost == "off" or latent.get("noise_mask") is None
                       or sampler_name in _NO_BOOST_SAMPLERS)
        if boosted:
            out = self._sample_boosted(model, positive, negative, latent, seed,
                                       effective, cfg, sampler_name, scheduler,
                                       denoise, inpaint_boost, _boost_fallback, var)
        elif var > 0.0:


            info(f"[PowderSampler] similarity={var:g}: steps {int(steps)}->{effective}, "
                 f"denoise={float(denoise):g}, {sampler_name}/{scheduler}, seed={int(seed)}")
            out = self._sample_plain(model, positive, negative, latent, seed,
                                     effective, cfg, sampler_name, scheduler,
                                     denoise, var, _stock)
        else:
            info(f"[PowderSampler] steps {int(steps)}->{effective} (auto={bool(auto_steps)}), "
                 f"denoise={float(denoise):g}, {sampler_name}/{scheduler}, "
                 f"cfg={float(cfg):g}, seed={int(seed)}")
            out = _stock()


        return (_restore_outside_mask(out[0], latent),)

    def _sample_ideogram(self, model, model_negative, positive, latent, seed,
                         steps, cfg, sampler_name, denoise, inpaint_boost, similarity,
                         ideogram_mode="Standard"):
        import comfy.sample
        import comfy.samplers
        import nodes
        from types import SimpleNamespace
        from comfy_extras.nodes_ideogram4 import ideogram4_sigmas
        from comfy_extras.nodes_custom_sampler import CFGOverride, DualModelGuider, SamplerCustomAdvanced
        from .powder_boost import PowderInpaintSampler, resolve_profile

        # Match the native workflow; ComfyUI owns dual-model loading and cleanup.
        model = CFGOverride.execute(model, 3.0, 0.7, 1.0)[0]
        negative = nodes.ConditioningZeroOut().zero_out(positive)[0]
        guider = DualModelGuider.execute(model, positive, cfg, model_negative, negative)[0]
        prepared = latent.copy()
        prepared["samples"] = comfy.sample.fix_empty_latent_channels(
            model, latent["samples"], latent.get("downscale_ratio_spacial"),
            latent.get("downscale_ratio_temporal"))
        prepared.pop("downscale_ratio_spacial", None)
        prepared.pop("downscale_ratio_temporal", None)
        height, width = prepared["samples"].shape[-2:]
        total = max(steps, int(steps / min(float(denoise), 1.0)))
        sigmas = ideogram4_sigmas(total, width * 16, height * 16, 0.0, 1.75)[-(steps + 1):]
        if ideogram_mode == "First sigma +0.005 (experimental)":
            sigmas = sigmas.clone()
            sigmas[0] += 0.005
        sampler = comfy.samplers.sampler_object(sampler_name)
        if inpaint_boost != "off" and latent.get("noise_mask") is not None and sampler_name not in _NO_BOOST_SAMPLERS:
            sampler = PowderInpaintSampler(sampler, resolve_profile(inpaint_boost))
        noise = SimpleNamespace(seed=seed, generate_noise=lambda lat: apply_similarity(
            comfy.sample.prepare_noise(lat["samples"], seed, lat.get("batch_index")), similarity))
        info(f"[PowderSampler] Ideogram 4: {steps} steps, cfg={cfg:g} -> 3 at 70%, seed={seed}")
        return SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, prepared)[0]

    def _sample_plain(self, model, positive, negative, latent, seed, steps, cfg,
                      sampler_name, scheduler, denoise, similarity, stock):
        """Sample with prepared batch noise and optional similarity, falling back to the stock path on unsupported configurations."""
        try:
            import comfy.sample
            import comfy.utils
            import latent_preview
            latent_image = comfy.sample.fix_empty_latent_channels(
                model, latent["samples"],
                latent.get("downscale_ratio_spacial", None),
                latent.get("downscale_ratio_temporal", None))
            noise = comfy.sample.prepare_noise(latent_image, seed,
                                               latent.get("batch_index"))
            noise = apply_similarity(noise, similarity)
            callback = latent_preview.prepare_callback(model, steps)
            samples = comfy.sample.sample(
                model, noise, steps, cfg, sampler_name, scheduler,
                positive, negative, latent_image, denoise=float(denoise),
                noise_mask=latent.get("noise_mask"), callback=callback,
                disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=seed)
            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out.pop("downscale_ratio_temporal", None)
            out["samples"] = samples
            return (out,)
        except Exception as e:
            warn(f"[PowderSampler] similarity failed ({e}) — using the stock sampling path")
            return stock()

    def _sample_boosted(self, model, positive, negative, latent, seed, steps,
                        cfg, sampler_name, scheduler, denoise, preset, stock,
                        similarity=0.0):
        """Sample with mask refinement and segmented replay. Preserve batch similarity when falling back from an unsupported boost path."""
        try:
            import torch
            import comfy.sample
            import comfy.samplers
            from .powder_boost import PowderInpaintSampler, extra_steps, resolve_profile
            from .powder_sigmas import build_sigmas

            base_sampler = comfy.samplers.ksampler(sampler_name)
            if not hasattr(base_sampler, "sampler_function"):


                warn(f"[PowderSampler] boost: sampler {sampler_name} does not expose "
                     "sampler_function; using the stock sampling path")
                return stock()

            profile = resolve_profile(preset)
            latent_image = comfy.sample.fix_empty_latent_channels(
                model, latent["samples"],
                latent.get("downscale_ratio_spacial", None),
                latent.get("downscale_ratio_temporal", None))
            noise = comfy.sample.prepare_noise(latent_image, seed,
                                               latent.get("batch_index"))
            noise = apply_similarity(noise, similarity)
            sigmas = build_sigmas(model, sampler_name, scheduler, steps, denoise)
            sampler = PowderInpaintSampler(base_sampler, profile)
            extra = extra_steps(len(sigmas) - 1, profile)
            info(f"[PowderSampler] boost={preset}: steps {int(steps)}"
                 f"{f'+{extra}' if extra else ''}, denoise={float(denoise):g}, "
                 f"{sampler_name}/{scheduler}, seed={int(seed)}")
            import latent_preview
            callback = latent_preview.prepare_callback(model, len(sigmas) - 1)
            import comfy.utils
            samples = comfy.sample.sample_custom(
                model, noise, cfg, sampler, sigmas, positive, negative,
                latent_image, noise_mask=latent["noise_mask"], callback=callback,
                disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=seed)
            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out.pop("downscale_ratio_temporal", None)
            out["samples"] = samples
            return (out,)
        except Exception as e:
            warn(f"[PowderSampler] boost failed ({e}) — using the stock sampling path")
            return stock()


class PowderInpaintSamplerSelect:
    """Create a mask-aware SAMPLER for ComfyUI custom sampling workflows."""
    @classmethod
    def INPUT_TYPES(cls):
        samplers, _ = _sampler_lists()
        names = [s for s in samplers if s not in _NO_BOOST_SAMPLERS]
        return {"required": {
            "sampler_name": (names, {"default": "er_sde"}),
            "inpaint_boost": (["off", "soft", "seams", "max"], {"default": "soft"}),
        }}

    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "build"
    CATEGORY = "e2go"

    def build(self, sampler_name, inpaint_boost):
        import comfy.samplers
        from .powder_boost import PowderInpaintSampler, resolve_profile
        try:
            base_sampler = comfy.samplers.ksampler(sampler_name)
        except Exception as e:


            raise ValueError(
                f"PowderInpaintSamplerSelect: unknown sampler "
                f"'{sampler_name}'; this workflow may target a different "
                f"ComfyUI version ({e})") from e
        return (PowderInpaintSampler(base_sampler, resolve_profile(inpaint_boost)),)


NODE_CLASS_MAPPINGS = {
    "PowderSampler": PowderSampler,
    "PowderInpaintSamplerSelect": PowderInpaintSamplerSelect,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PowderSampler": "Powder Sampler",
    "PowderInpaintSamplerSelect": "Powder Inpaint Sampler",
}
