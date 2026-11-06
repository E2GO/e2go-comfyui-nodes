"""Build sigma schedules matching ComfyUI KSampler, including partial denoise and penultimate-sigma rules."""


_DISCARD_PENULTIMATE = {"dpm_2", "dpm_2_ancestral", "uni_pc", "uni_pc_bh2"}


def _calc(model, sampler_name, scheduler, steps):
    import torch
    import comfy.samplers
    discard = sampler_name in _DISCARD_PENULTIMATE
    if discard:
        steps += 1
    sigmas = comfy.samplers.calculate_sigmas(
        model.get_model_object("model_sampling"), scheduler, steps)
    if discard:
        sigmas = torch.cat([sigmas[:-2], sigmas[-1:]])
    return sigmas


def build_sigmas(model, sampler_name, scheduler, steps, denoise):
    """Build the sigma schedule used by the stock KSampler."""
    import torch
    if denoise is None or denoise > 0.9999:
        return _calc(model, sampler_name, scheduler, steps)
    if denoise <= 0.0:
        return torch.FloatTensor([])
    new_steps = int(steps / denoise)
    sigmas = _calc(model, sampler_name, scheduler, new_steps)
    return sigmas[-(steps + 1):]
