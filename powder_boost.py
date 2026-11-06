"""Mask-aware sampling profiles, seam refinement and RePaint resampling."""
import inspect
from dataclasses import dataclass


@dataclass(frozen=True)
class BoostProfile:
    mask_dilate: int
    mask_blur: int
    band_width: int
    band_at: float
    band_back: float
    repaint_k: int
    repaint_lo: float
    repaint_hi: float


    band_s_noise: float = 1.0
    repaint_s_noise: float = 1.0


PRESETS = {
    "off":   BoostProfile(0, 0, 0, 0.0, 0.0, 0, 0.0, 0.0),
    "soft":  BoostProfile(3, 2, 0, 0.0, 0.0, 0, 0.0, 0.0),
    "seams": BoostProfile(3, 2, 2, 0.55, 0.15, 0, 0.0, 0.0),
    "max":   BoostProfile(3, 2, 2, 0.55, 0.15, 2, 0.35, 0.65),
}


def resolve_profile(preset):
    return PRESETS[preset]


def _step_of(progress, n_steps):
    return max(0, min(n_steps, round(n_steps * float(progress))))


def band_window(n_steps, profile):
    """Return the seam replay interval (back, at), or None when disabled."""
    if profile.band_width <= 0 or n_steps <= 1:
        return None


    at = max(1, min(n_steps - 1, _step_of(profile.band_at, n_steps)))
    back = max(0, at - max(1, round(n_steps * profile.band_back)))
    return (back, at) if back < at else None


def plan_segments(n_steps, profile):
    """Split a sigma schedule into replay and ordinary sampling segments."""
    cuts = {0, n_steps}
    band_step = None
    win = band_window(n_steps, profile)
    if win is not None:
        band_step = win[1]
        cuts.add(band_step)
    rep_lo = rep_hi = None
    if profile.repaint_k > 1:
        rep_lo = _step_of(profile.repaint_lo, n_steps)
        rep_hi = _step_of(profile.repaint_hi, n_steps)
        if rep_hi > rep_lo:
            cuts.update(range(rep_lo, rep_hi + 1))
    edges = sorted(c for c in cuts if 0 <= c <= n_steps)
    segs = []
    for lo, hi in zip(edges, edges[1:]):
        in_window = rep_lo is not None and rep_hi is not None \
            and rep_lo <= lo and hi <= rep_hi
        segs.append({
            "lo": lo, "hi": hi,
            "repeats": profile.repaint_k if in_window else 1,
            "band_after": band_step is not None and hi == band_step,
        })
    return segs


def extra_steps(n_steps, profile):
    """Count extra model steps introduced by the boost profile."""
    rep = sum((s["repeats"] - 1) * (s["hi"] - s["lo"])
              for s in plan_segments(n_steps, profile))
    win = band_window(n_steps, profile)
    return rep + (win[1] - win[0] if win is not None else 0)


def _spatial_view(m):
    """Flatten leading batch dimensions for spatial mask operations and return a shape-restoring function."""
    h, w = m.shape[-2], m.shape[-1]
    return m.reshape(-1, 1, h, w), m.shape


def _dilate(m, r):
    import torch.nn.functional as F
    return F.max_pool2d(m, kernel_size=2 * r + 1, stride=1, padding=r) if r > 0 else m


def _erode(m, r):
    return 1.0 - _dilate(1.0 - m, r)


def _blur(m, r):
    import torch.nn.functional as F
    if r <= 0:
        return m
    k = 2 * r + 1
    return F.avg_pool2d(m, kernel_size=k, stride=1, padding=r)


def soften_mask(mask, progress, profile):
    """Dilate and blur the mask in latent-space pixels."""
    import torch
    flat, shape = _spatial_view(mask)
    fade = max(0.0, 1.0 - float(progress))
    dil = round(profile.mask_dilate * fade)
    blur = round(profile.mask_blur * fade)
    if dil == 0 and blur == 0:
        return mask
    out = _blur(_dilate(flat, dil), blur).clamp(0.0, 1.0)
    out = torch.maximum(out, flat)
    return out.reshape(shape)


def seam_band(mask, width):
    """Extract a narrow band around the mask boundary."""
    flat, shape = _spatial_view(mask)
    hard = (flat > 0.5).float()
    band = (_dilate(hard, width) - _erode(hard, width)).clamp(0.0, 1.0)
    band = (band > 0.5).float()
    return band.reshape(shape)


def renoise(x, sigma_from, sigma_to, eps, flow):
    """Return selected pixels to a higher noise level. Flow models interpolate with noise; diffusion models add the variance required by the target sigma."""
    sf, st = float(sigma_from), float(sigma_to)
    if st <= sf:
        return x
    if flow:
        a = (1.0 - st) / (1.0 - sf)
        coeff = max(0.0, st * st - (a * sf) ** 2) ** 0.5
        return x * a + eps * coeff
    scale = (st * st - sf * sf) ** 0.5
    return x + eps * scale


class PowderInpaintSampler:
    """Wrap a ComfyUI sampler with mask preparation and optional seam/RePaint replay. Without a noise mask, sampling passes through unchanged."""

    def __init__(self, base_sampler, profile):
        self.base = base_sampler
        self.profile = profile

    @staticmethod
    def _detect_flow(ms):
        """Detect flow-based sampling from the wrapped model."""
        try:
            import comfy.model_sampling
            return isinstance(ms, comfy.model_sampling.CONST)
        except Exception:
            return float(ms.sigma_max) <= 1.0 + 1e-6

    def _wrap_mask_fn(self, model_options, sigmas):
        """Compose a mask callback with the existing sampler callback."""
        prof = self.profile
        if prof.mask_dilate == 0 and prof.mask_blur == 0:
            return model_options
        base_fn = model_options.get("denoise_mask_function")
        n = max(1, len(sigmas) - 1)
        sig_list = [float(s) for s in sigmas]

        def fn(sigma, denoise_mask, extra_options):
            if base_fn is not None:
                denoise_mask = base_fn(sigma, denoise_mask, extra_options)


            s = float(sigma.flatten()[0]) if hasattr(sigma, "flatten") \
                else float(sigma)

            i = min(range(len(sig_list)), key=lambda j: abs(sig_list[j] - s))
            return soften_mask(denoise_mask, i / n, prof)

        out = dict(model_options)
        out["denoise_mask_function"] = fn
        return out

    def sample(self, model_wrap, sigmas, extra_args, callback, noise,
               latent_image=None, denoise_mask=None, disable_pbar=False):
        import torch
        import comfy.samplers
        prof = self.profile
        boosted = denoise_mask is not None and prof != PRESETS["off"]

        extra_args = dict(extra_args)
        extra_args["denoise_mask"] = denoise_mask


        raw_model_options = extra_args.get("model_options", {})
        if boosted:
            extra_args["model_options"] = self._wrap_mask_fn(
                raw_model_options, sigmas)

        model_k = comfy.samplers.KSamplerX0Inpaint(model_wrap, sigmas)
        model_k.latent_image = latent_image
        if self.base.inpaint_options.get("random", False):
            gen = torch.manual_seed(extra_args.get("seed", 41) + 1)
            model_k.noise = torch.randn(noise.shape, generator=gen,
                                        device="cpu").to(noise.dtype).to(noise.device)
        else:
            model_k.noise = noise

        ms = model_wrap.inner_model.model_sampling


        flow = self._detect_flow(ms)


        noise_scale = float(getattr(ms, "noise_scale", 1.0))
        max_den = float(sigmas[0]) >= float(ms.sigma_max) * 0.99999
        x = ms.noise_scaling(sigmas[0], noise, latent_image, max_den)

        n = len(sigmas) - 1
        segs = plan_segments(n, prof) if boosted else \
            [{"lo": 0, "hi": n, "repeats": 1, "band_after": False}]
        band = seam_band(denoise_mask, prof.band_width) \
            if boosted and prof.band_width > 0 else None


        seed = int(extra_args.get("seed") or 0) & 0xFFFFFFFFFFFFFFFF
        total = n + (extra_steps(n, prof) if boosted else 0)


        _ns_get = None
        total_calls = sum(seg["repeats"] for seg in segs)
        if total_calls > 1 and "noise_sampler" not in self.base.extra_options:
            try:
                sig = inspect.signature(self.base.sampler_function)
                if "noise_sampler" in sig.parameters:
                    import comfy.k_diffusion.sampling as _k_sampling
                    try:
                        mk = _k_sampling.BrownianTreeNoiseSampler
                        pos = sigmas[sigmas > 0]
                        smin, smax = float(pos.min()), float(sigmas.max())


                        cpu = not getattr(self.base.sampler_function,
                                          "__name__", "").endswith("_gpu")


                        trees = {0: mk(x, smin, smax, seed=seed, cpu=cpu)}

                        def _ns_for(rep, _trees=trees, _mk=mk, _x=x,
                                   _smin=smin, _smax=smax, _cpu=cpu,
                                   _seed=seed):
                            if rep not in _trees:
                                rep_seed = (_seed + rep * 0x9E3779B97F4A7C15) \
                                    & 0xFFFFFFFFFFFFFFFF
                                _trees[rep] = _mk(_x, _smin, _smax,
                                                  seed=rep_seed, cpu=_cpu)
                            return _trees[rep]
                        _ns_get = _ns_for
                    except Exception:
                        ns = _k_sampling.default_noise_sampler(x, seed=seed)
                        _ns_get = lambda rep, _ns=ns: _ns
            except Exception:
                pass

        done = 0
        last_denoised = None
        def seg_callback(info):
            nonlocal done, last_denoised
            last_denoised = info.get("denoised")
            if callback is not None:
                callback(done, info["denoised"], info["x"], total)
            done += 1

        for si, seg in enumerate(segs):
            seg_sig = sigmas[seg["lo"]:seg["hi"] + 1]
            for rep in range(seg["repeats"]):
                if rep:


                    gen = torch.Generator(device="cpu")
                    gen.manual_seed((seed * 1000003 + si * 101 + rep)
                                     & 0xFFFFFFFFFFFFFFFF)
                    eps = torch.randn(x.shape, generator=gen,
                                      device="cpu").to(x.dtype).to(x.device) \
                        * (prof.repaint_s_noise * noise_scale)
                    up = renoise(x, float(seg_sig[-1]), float(seg_sig[0]),
                                 eps, flow)
                    if denoise_mask is not None:
                        m = denoise_mask if denoise_mask.dim() == x.dim() \
                            else denoise_mask.unsqueeze(1)
                    else:
                        m = 1.0
                    x = up * m + x * (1.0 - m)


                ns_kwargs = {"noise_sampler": _ns_get(rep)} \
                    if _ns_get is not None else {}
                x = self.base.sampler_function(
                    model_k, x, seg_sig, extra_args=dict(extra_args),
                    callback=seg_callback, disable=disable_pbar,
                    **self.base.extra_options, **ns_kwargs)
            win = band_window(n, prof) if seg["band_after"] else None
            if win is not None and band is not None:
                back, at = win
                gen = torch.Generator(device="cpu")
                gen.manual_seed((seed * 1000003 + 777 + si)
                                 & 0xFFFFFFFFFFFFFFFF)
                eps = torch.randn(x.shape, generator=gen,
                                  device="cpu").to(x.dtype).to(x.device) \
                    * (prof.band_s_noise * noise_scale)
                melted = renoise(x, float(sigmas[at]), float(sigmas[back]),
                                 eps, flow)
                b = band if band.dim() == x.dim() else band.unsqueeze(1)


                anchor = comfy.samplers.KSamplerX0Inpaint(model_wrap, sigmas)
                anchor.latent_image = last_denoised if last_denoised is not None \
                    else latent_image
                anchor.noise = model_k.noise
                replay_args = dict(extra_args)
                replay_args["denoise_mask"] = b
                replay_args["model_options"] = raw_model_options


                ns_band = {"noise_sampler": _ns_get(10000 + si)} \
                    if _ns_get is not None else {}
                replayed = self.base.sampler_function(
                    anchor, melted * b + x * (1.0 - b), sigmas[back:at + 1],
                    extra_args=replay_args, callback=seg_callback,
                    disable=disable_pbar,
                    **self.base.extra_options, **ns_band)
                x = replayed * b + x * (1.0 - b)

        return ms.inverse_noise_scaling(sigmas[-1], x)
