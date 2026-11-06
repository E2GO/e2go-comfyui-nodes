


export function installNameKeyedPersistence(node, opts = {}) {
    const inputNames = opts.inputNames
        || (node.widgets || []).map((w) => w.name);
    if (!opts.inputNames) {

        const deco = (node.widgets || [])
            .filter((w) => w.serialize === false).map((w) => w.name);
        if (deco.length) console.warn(
            "[e2go] installNameKeyedPersistence: snapshot already contains "
            + `decorations (${deco.join(", ")}) — call BEFORE decorating, or `
            + "pass opts.inputNames");
    }
    const findW = (name) => node.widgets?.find((w) => w.name === name);
    const rewrite = opts.rewritePositional !== false;

    const prevOnSerialize = node.onSerialize;
    node.onSerialize = function (o) {
        try { prevOnSerialize?.apply(this, arguments); } catch {}
        if (!o) return;
        const vals = {};
        for (const name of inputNames) {
            const w = findW(name);
            if (w) vals[name] = opts.sanitize ? opts.sanitize(name, w.value) : w.value;
        }
        o.e2goInputs = vals;
        if (rewrite) o.widgets_values = inputNames.map((name) => vals[name]);
    };

    const prevOnConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        try { opts.onConfigureStart?.(); } catch {}
        try { return prevOnConfigure?.apply(this, arguments); }
        finally {
            try { opts.onConfigureEnd?.(); } catch {}

            let saved = (info && typeof info.e2goInputs === "object"
                && info.e2goInputs) || null;
            if (!saved && opts.legacyAlign && Array.isArray(info?.widgets_values)) {
                try { saved = opts.legacyAlign(info.widgets_values, inputNames) || null; }
                catch { saved = null; }
            }
            const restore = () => {
                if (saved && opts.applyValues !== false) {
                    for (const name of inputNames) {
                        if (name in saved) {
                            const w = findW(name);
                            if (w) w.value = saved[name]; // value only; no callbacks
                        }
                    }
                }
                try { opts.afterRestore?.(saved); } catch {}
                // window.app fallback: node.graph can be unset mid-restore
                // (this codebase hedges the same way elsewhere).
                try {
                    (node.graph
                        || (typeof window !== "undefined" && window.app?.graph)
                        || null)?.setDirtyCanvas(true, true);
                } catch {}
            };
            // Clipboard cloning configures and serializes a temporary node in
            // the same turn. Its values must be restored before serialization.
            if (saved || opts.afterRestore) {
                restore();
                requestAnimationFrame(restore);
            }
        }
    };

    return { inputNames, findW };
}


export function alignPrefixWithTrailingSlot(vals, inputNames, ok) {
    if (!Array.isArray(vals) || !vals.length) return null;
    if (vals.length > inputNames.length + 1) return null;
    const out = vals.slice();
    if (out.length === inputNames.length + 1) out.pop();
    else if (!ok(inputNames[out.length - 1], out[out.length - 1])) out.pop();
    if (!out.length) return null;
    const map = {};
    for (let i = 0; i < out.length; i++) {
        if (!ok(inputNames[i], out[i])) return null;
        map[inputNames[i]] = out[i];
    }
    return map;
}

/**
 * Legacy align, mid-list-decoration shape (PowderImageCond): the positional
 * array is a PREFIX of inputNames, possibly with ONE extra slot at `anchor`
 * — where the old Fine-tuning separator sat in the live list when the save
 * was written. Every mapped value must pass ok(name, value) or the whole
 * candidate is rejected: a mis-guessed alignment that happens to type-check
 * everywhere is exactly the silent-swap corruption this exists to prevent,
 * so on doubt this returns null and the caller's plain repair pass runs
 * instead.
 *
 * @param {any[]} vals positional widgets_values from the save
 * @param {string[]} inputNames the real inputs, INPUT_TYPES order
 * @param {number} anchor index the old separator was spliced at (< 0 = none)
 * @param {(name: string, value: any) => boolean} ok validity per name
 * @returns {object|null} name map, or null when no candidate validates
 */
export function alignWithAnchorSlot(vals, inputNames, anchor, ok) {
    if (!Array.isArray(vals) || !vals.length) return null;
    if (vals.length > inputNames.length + 1) return null;
    const tryMap = (arr) => {
        if (arr.length > inputNames.length) return null;
        const m = {};
        for (let i = 0; i < arr.length; i++) {
            if (!ok(inputNames[i], arr[i])) return null;
            m[inputNames[i]] = arr[i];
        }
        return m;
    };
    const dropped = anchor >= 0 && vals.length > anchor
        ? vals.slice(0, anchor).concat(vals.slice(anchor + 1)) : null;
    // The file's own bytes pick the order: a ""/null at the anchor IS the
    // serialized separator, so that interpretation goes first.
    const sepish = dropped && (vals[anchor] === "" || vals[anchor] == null);
    for (const cand of (sepish ? [dropped, vals] : [vals, dropped])) {
        if (!cand) continue;
        const m = tryMap(cand);
        if (m) return m;
    }
    return null;
}
