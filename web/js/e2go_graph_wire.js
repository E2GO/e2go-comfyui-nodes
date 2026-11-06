

/** graph.links is a Map on current frontends, a plain object on older ones. */
function getLink(graph, id) {
    if (!graph || id == null) return null;
    const links = graph.links;
    if (!links) return null;
    return (typeof links.get === "function" ? links.get(id) : links[id]) ?? null;
}


export function resyncInputLinks(node) {
    const out = { fixed: 0, cleared: 0 };
    const inputs = node && node.inputs;
    if (!Array.isArray(inputs)) return out;
    // Clearing is only safe once the registry is actually populated. During a
    // workflow load there is a window where slots already carry their restored
    // link ids while graph.links is still empty — clearing there would wipe
    // every connection the node legitimately has. An empty registry means "I
    // cannot judge", not "these links are dead".
    const links = node.graph && node.graph.links;
    const known = !links ? 0
        : (typeof links.size === "number" ? links.size : Object.keys(links).length);
    inputs.forEach((s, idx) => {
        if (s.link == null) return;
        const link = getLink(node.graph, s.link);
        if (!link) {
            if (known > 0) { s.link = null; out.cleared++; }
            return;
        }
        // The unambiguous corruption signal: this slot points at a wire that
        // belongs to somebody else. A healthy link always names this very node
        // as its target, at load time and at any other time — so no ordering
        // caveat applies here and the id can be dropped on sight. This is the
        // phantom the screenshots caught: a dead id was reused for a fresh
        // link, and the slot silently adopted a wire running to another node,
        // which the canvas then drew into the switcher.
        if (node.id != null && link.target_id != null
                && String(link.target_id) !== String(node.id)) {
            s.link = null; out.cleared++; return;
        }
        if (link.target_slot !== idx) { link.target_slot = idx; out.fixed++; }
    });
    return out;
}

/**
 * The type feeding an input slot, read through the source node's output.
 *
 * Lives here for the same reason reorderInputs does: the switcher's copy read
 * `node.graph?.links?.[id]`, undefined for a Map, so it answered `"*"` for
 * EVERY wire on current frontends. A channel bound by dragging into the `+`
 * acceptor therefore came out untyped — wrong colour and label, an untyped
 * output, and "reuse the free channel of the same type" never matching, so
 * every bind burned a fresh column out of the eight available.
 * Returns "*" when anything is unknown, which is the neutral wildcard the
 * caller already treats as "no type yet".
 */
export function originTypeOfInput(node, slotIndex) {
    const inp = node && node.inputs && node.inputs[slotIndex];
    const link = inp ? getLink(node.graph, inp.link) : null;
    if (!link) return "*";
    const src = node.graph && node.graph.getNodeById
        ? node.graph.getNodeById(link.origin_id) : null;
    const out = src && src.outputs ? src.outputs[link.origin_slot] : null;
    return (out && typeof out.type === "string" && out.type) || "*";
}


export function repairLinkIdCounter(graph) {
    if (!graph) return null;
    const links = graph.links;
    if (!links) return null;
    const ids = (typeof links.keys === "function" ? [...links.keys()]
                                                  : Object.keys(links).map(Number))
        .filter((n) => Number.isFinite(n));
    if (!ids.length) return null;
    const max = Math.max(...ids);
    const before = graph.last_link_id;
    if (typeof before === "number" && before >= max) return { before, max, after: before };
    graph.last_link_id = max;
    return { before, max, after: max };
}


export function isDeliberateSlotDrop(slotPos, pointer, tolerance = 30) {
    const ok = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    if (!ok(slotPos) || !ok(pointer)) return true;
    const dx = pointer[0] - slotPos[0], dy = pointer[1] - slotPos[1];
    return dx * dx + dy * dy <= tolerance * tolerance;
}


export function reorderInputs(node) {
    const inputs = node.inputs || [];
    const rank = (s) => {
        let m = /^g(\d+)_c(\d+)$/.exec(s.name);
        if (m) return [+m[1], 0, +m[2]];          // channel: group, then col
        m = /^g(\d+)_add$/.exec(s.name);
        if (m) return [+m[1], 1, 0];              // acceptor sits after its channels
        return [1e9, 9, 0];                       // anything else last (defensive)
    };
    const order = inputs.map((_, i) => i).sort((a, b) => {
        const ra = rank(inputs[a]), rb = rank(inputs[b]);
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    });
    if (order.every((v, i) => v === i)) return;   // already sorted — no-op
    node.inputs = order.map((i) => inputs[i]);
    resyncInputLinks(node);
}

/** BFS forward along output links; first node whose comfyClass is in classNames. */
export function findDownstream(startNode, graph, classNames) {
    if (!startNode || !graph) return null;
    const want = new Set(classNames);
    const seen = new Set([startNode.id]);
    const queue = [startNode];
    while (queue.length) {
        const n = queue.shift();
        for (const out of n.outputs || []) {
            for (const linkId of out.links || []) {
                const link = getLink(graph, linkId);
                if (!link) continue;
                const target = graph.getNodeById(link.target_id);
                if (!target || seen.has(target.id)) continue;
                seen.add(target.id);
                if (want.has(target.comfyClass)) return target;
                queue.push(target);
            }
        }
    }
    return null;
}

/**
 * Splice the review into the decode's IMAGE edge:
 * decode.IMAGE -> review.images, and every OTHER consumer of decode.IMAGE is
 * re-pointed to review.images (so SaveImage & co receive the STITCHED frames).
 *
 * Refuses (returns 0 consumers) when review.images is already fed by a
 * DIFFERENT node — that is the user's own wiring, never fight it.
 * Idempotent: a second call finds no non-review consumers and changes nothing.
 */
export function insertReviewIntoDecodeEdge(decode, review, graph) {
    const outIdx = (decode.outputs || []).findIndex((o) => o.type === "IMAGE" || o.name === "IMAGE");
    const imagesIn = (review.inputs || []).findIndex((i) => i.name === "images");
    const imagesOut = (review.outputs || []).findIndex((o) => o.name === "images");
    if (outIdx === -1 || imagesIn === -1 || imagesOut === -1) return 0;
    const cur = getLink(graph, review.inputs[imagesIn].link);
    if (cur && cur.origin_id !== decode.id) return 0; // fed elsewhere — user's choice
    // Snapshot consumers BEFORE rewiring (connect mutates the links array).
    const consumers = [...(decode.outputs[outIdx].links || [])]
        .map((id) => getLink(graph, id))
        .filter(Boolean)
        .map((l) => ({ target: graph.getNodeById(l.target_id), slot: l.target_slot }))
        .filter((c) => c.target && c.target !== review);
    if (!cur) decode.connect(outIdx, review, imagesIn);
    for (const c of consumers) review.connect(imagesOut, c.target, c.slot);
    return consumers.length;
}

/**
 * The full crop-chain auto-plumb, run when crop_to_mask switches on (and on
 * workflow load with crop already on):
 * 1. find the Review (BFS downstream, fallback: any in the graph); when none
 *    exists and makeReview is given, CREATE one (the graph may simply not
 *    have a Review — the user must not need to add nodes by hand);
 * 2. wire cond.stitch -> review.stitch unless already wired;
 * 3. find the VAEDecode downstream and splice the Review into its IMAGE edge.
 * Every step is idempotent; missing pieces degrade to warnings in the caller.
 */
export function autoWireCropChain(condNode, graph, makeReview) {
    const result = { review: null, decode: null, rewired: 0, stitchWired: false, created: false };
    if (!condNode || !graph) return result;
    // Find the decode BEFORE adding wires so the search space is the user's graph.
    const decode = findDownstream(condNode, graph, ["VAEDecode", "VAEDecodeTiled"]);
    const stitchFree = (n) => (n.inputs?.find((i) => i.name === "stitch")?.link ?? null) == null;

    let review = findDownstream(condNode, graph, ["PowderCanvasReview"])
        || (graph._nodes || []).find((n) => n.comfyClass === "PowderCanvasReview" && stitchFree(n))
        || null;
    if (!review && typeof makeReview === "function") {
        review = makeReview(graph, decode) || null;
        result.created = !!review;
    }
    result.review = review;
    result.decode = decode;
    if (!review) return result;
    const stitchOut = (condNode.outputs || []).findIndex((o) => o.name === "stitch");
    if (stitchOut !== -1 && !condNode.outputs[stitchOut].links?.length) {
        const stitchIn = (review.inputs || []).findIndex((i) => i.name === "stitch");
        // Never displace an existing stitch feed — that is another chain's
        // wiring (same ownership rule insertReviewIntoDecodeEdge follows).
        if (stitchIn !== -1 && (review.inputs[stitchIn].link ?? null) == null) {
            condNode.connect(stitchOut, review, stitchIn);
            result.stitchWired = true;
        }
    }
    if (decode) result.rewired = insertReviewIntoDecodeEdge(decode, review, graph);
    return result;
}

/**
 * Wire PowderImageConditioning's `denoise` output into the hub sampler's
 * `denoise` widget-input. The cond is searched among the hub's DIRECT input
 * origins only (v1 scope). Ownership rules as everywhere in this file: a
 * foreign feed is never displaced, re-runs are no-ops.
 * Returns {cond, wired, reason}.
 */

export function resolveDenoiseSource(hubNode, graph) {
    if (!hubNode || !graph) return null;
    const inp = (hubNode.inputs || []).find((i) => i.name === "denoise");
    let link = getLink(graph, inp?.link);
    const seen = new Set();
    while (link) {
        const origin = graph.getNodeById(link.origin_id);
        if (!origin || seen.has(origin.id)) return null;
        seen.add(origin.id);
        if (origin.comfyClass === "Reroute") {
            link = getLink(graph, origin.inputs?.[0]?.link);
            continue;
        }
        if (origin.outputs?.[link.origin_slot]?.name !== "denoise") return null;
        const w = (origin.widgets || []).find((v) => v.name === "denoise");
        return w && Number.isFinite(w.value) ? w.value : null;
    }
    return null;
}

/**
 * A reference bundle has to reach BOTH doors: the diffusion model (as
 * reference latents, via Powder Image Conditioning) and the text encoder (as
 * VL images, via Powder Conditioner). Wired to only one, the graph looks
 * finished and the model attends to images the encoder never saw.
 *
 * Called from the image-conditioning side because that is where the user
 * naturally drops the wire (the references belong to the edit). Walks back
 * through `positive` — the conditioner is always upstream of it — and mirrors
 * the same source into the conditioner's own `references` input.
 *
 * Never steals a socket that already holds someone else's wire ("foreign"),
 * and re-running is a no-op ("already").
 */
export function autoWireReferences(condNode, graph) {
    const result = { conditioner: null, wired: false, reason: null, edited: null };
    if (!condNode || !graph) { result.reason = "no-graph"; return result; }
    const refIn = (condNode.inputs || []).findIndex((i) => i.name === "references");
    if (refIn === -1) { result.reason = "no-references-input"; return result; }
    const srcLink = getLink(graph, condNode.inputs[refIn].link);
    if (!srcLink) { result.reason = "unwired"; return result; }
    result.edited = wireEditedImage(condNode, graph, srcLink);

    let target = null;
    const seen = new Set();
    for (const name of ["positive", "negative"]) {
        const inp = (condNode.inputs || []).find((i) => i.name === name);
        let link = getLink(graph, inp?.link);
        while (link) {
            const origin = graph.getNodeById(link.origin_id);
            if (!origin || seen.has(origin.id)) break;       // dead id / cycle
            seen.add(origin.id);
            if (origin.comfyClass === "PowderConditioner") { target = origin; break; }
            if (origin.comfyClass === "Reroute") {
                link = getLink(graph, origin.inputs?.[0]?.link);
                continue;
            }
            break;
        }
        if (target) break;
    }
    result.conditioner = target;
    if (!target) { result.reason = "no-conditioner"; return result; }

    const tIn = (target.inputs || []).findIndex((i) => i.name === "references");
    if (tIn === -1) { result.reason = "no-target-input"; return result; }
    const cur = getLink(graph, target.inputs[tIn].link);
    if (cur) {
        const same = cur.origin_id === srcLink.origin_id;
        result.wired = same;
        result.reason = same ? "already" : "foreign";
        return result;
    }
    const src = graph.getNodeById(srcLink.origin_id);
    if (!src) { result.reason = "dead-source"; return result; }
    src.connect(srcLink.origin_slot, target, tIn);
    result.wired = true;
    return result;
}

/**
 * The edited picture must lead the text encoder's sequence (Picture 1) on
 * every edit model, and on Qwen Image 2.1 the model splices the source latent
 * into that very slot — so the References node's `edited_image` is pulled
 * from the hub's own `pixels` source, through Reroutes, unless it already
 * holds a wire. Returns "wired" | "already" | "foreign" | "no-source" | "cycle" | null
 * (null: the bundle's source has no `edited_image` input).
 */
function wireEditedImage(condNode, graph, bundleLink) {
    // the bundle may arrive through Reroutes — the References node is behind them
    let refs = graph.getNodeById(bundleLink.origin_id);
    const seenRefs = new Set();
    while (refs?.comfyClass === "Reroute" && !seenRefs.has(refs.id)) {
        seenRefs.add(refs.id);
        refs = graph.getNodeById(getLink(graph, refs.inputs?.[0]?.link)?.origin_id);
    }
    const edIn = (refs?.inputs || []).findIndex((i) => i.name === "edited_image");
    if (edIn === -1) return null;
    const pixIn = (condNode.inputs || []).find((i) => i.name === "pixels");
    let link = getLink(graph, pixIn?.link);
    const seen = new Set();
    let origin = null;
    while (link) {
        const node = graph.getNodeById(link.origin_id);
        if (!node || seen.has(node.id)) break;               // dead id / cycle
        seen.add(node.id);
        if (node.comfyClass !== "Reroute") { origin = node; break; }
        link = getLink(graph, node.inputs?.[0]?.link);
    }
    if (!origin || !link) return "no-source";
    const cur = getLink(graph, refs.inputs[edIn].link);
    if (cur) return cur.origin_id === origin.id && cur.origin_slot === link.origin_slot ? "already" : "foreign";
    // a two-pass graph: the pixels come from a pass that itself consumes this
    // bundle — wiring them back in would close a loop
    if (isDownstream(refs, origin, graph)) return "cycle";
    origin.connect(link.origin_slot, refs, edIn);
    return "wired";
}

function isDownstream(startNode, node, graph) {
    const seen = new Set([startNode.id]);
    const queue = [startNode];
    while (queue.length) {
        const n = queue.shift();
        for (const out of n.outputs || []) {
            for (const linkId of out.links || []) {
                const target = graph.getNodeById(getLink(graph, linkId)?.target_id);
                if (!target || seen.has(target.id)) continue;
                if (target.id === node.id) return true;
                seen.add(target.id);
                queue.push(target);
            }
        }
    }
    return false;
}

export function autoWireDenoise(hubNode, graph) {
    const result = { cond: null, wired: false, reason: null };
    if (!hubNode || !graph) { result.reason = "no-graph"; return result; }
    const denIn = (hubNode.inputs || []).findIndex((i) => i.name === "denoise");
    if (denIn === -1) { result.reason = "no-denoise-input"; return result; }
    let cond = null;
    for (const inp of hubNode.inputs || []) {
        const link = getLink(graph, inp.link);
        if (!link) continue;
        const origin = graph.getNodeById(link.origin_id);
        if (origin?.comfyClass === "PowderImageConditioning") { cond = origin; break; }
    }
    result.cond = cond;
    if (!cond) { result.reason = "no-cond"; return result; }
    const denOut = (cond.outputs || []).findIndex((o) => o.name === "denoise");
    if (denOut === -1) { result.reason = "no-denoise-output"; return result; }
    const cur = getLink(graph, hubNode.inputs[denIn].link);
    if (cur && cur.origin_id !== cond.id) { result.reason = "foreign"; return result; }
    if (cur) { result.wired = true; result.reason = "already"; return result; }
    cond.connect(denOut, hubNode, denIn);
    result.wired = true;
    return result;
}
