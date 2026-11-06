

/** Auto budgets the denoise fraction of a full trajectory; manual is exact. */
export function effectiveSteps(steps, denoise, auto) {
    const base = Math.max(1, Math.trunc(Number(steps) || 1));
    if (typeof auto === "string") {

        auto = !["false", "0", "off", "no", ""].includes(auto.trim().toLowerCase());
    }
    if (!auto) return base;
    let d = Number(denoise);
    if (Number.isNaN(d)) d = 1.0;
    d = Math.min(1.0, Math.max(0.0, d));
    return Math.max(1, Math.ceil(base * d));
}


export const BOOST_MIRROR = {
    off: null, soft: null,
    seams: { band: { at: 0.55, back: 0.15 } },
    max: { k: 2, lo: 0.35, hi: 0.65, band: { at: 0.55, back: 0.15 } },
};


function pyRound(v) {
    const f = Math.floor(v);
    const diff = v - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}


export function boostExtraSteps(nSteps, preset) {
    const m = BOOST_MIRROR[preset];
    if (!m) return 0;
    const clamp = (p) => Math.max(0, Math.min(nSteps, pyRound(nSteps * p)));
    let extra = 0;
    if (m.k > 1) {
        const lo = clamp(m.lo), hi = clamp(m.hi);
        if (hi > lo) extra += (m.k - 1) * (hi - lo);
    }

    if (m.band && nSteps > 1) {
        const at = Math.max(1, Math.min(nSteps - 1, clamp(m.band.at)));
        const back = Math.max(0, at - Math.max(1, pyRound(nSteps * m.band.back)));
        if (back < at) extra += at - back;
    }
    return extra;
}


export function stepsHintText(steps, denoise, auto, preset) {
    const d = Number(denoise);
    if (!(d > 0)) return `⏸ skip @ d${d.toFixed ? d.toFixed(2) : d} — latent unchanged`;
    const eff = effectiveSteps(steps, d, auto);
    const extra = preset ? boostExtraSteps(eff, preset) : 0;
    const term = extra > 0 ? `+${extra}` : "";
    const tag = preset && preset !== "off" ? ` · ${preset}` : "";
    return `→ ${eff}${term} steps @ d${d.toFixed(2)}${tag}`;
}
