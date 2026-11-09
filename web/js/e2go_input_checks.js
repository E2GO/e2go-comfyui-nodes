// Conservative checks: unknown upstream results are left to execution.
const maskCache = new WeakMap();
const input = (node, name) => node.inputs?.find(i => i.name === name);
const linked = (node, name) => input(node, name)?.link != null;
const value = (node, name) => node.widgets?.find(w => w.name === name)?.value;

function source(node, name) {
    const graph = node.graph;
    const id = input(node, name)?.link;
    const link = graph?.links?.get?.(id) ?? graph?.links?.[id];
    const upstream = graph?.getNodeById(link?.origin_id);
    // A bypassed node's editor is not the data that will actually be used.
    return upstream && !upstream.mode ? upstream : null;
}

function canvasState(node, name) {
    const upstream = source(node, name);
    if (upstream?.comfyClass !== "PowderCanvas" || linked(upstream, "image")) return null;
    const state = upstream._e2goCanvasState;
    return state && !state.bgPending ? state : null;
}

function emptyMask(state) {
    if (!state.mask) return true;
    const cached = maskCache.get(state);
    if (cached?.dirty === state.dirty && cached.mask === state.mask) return cached.empty;
    // Inspect every pixel; downscaling can miss a tiny painted region.
    const bytes = state.mask.getContext("2d").getImageData(0, 0, state.mask.width, state.mask.height).data;
    let empty = true;
    for (let i = 3; i < bytes.length; i += 4) {
        if (bytes[i]) { empty = false; break; }
    }
    maskCache.set(state, { dirty: state.dirty, mask: state.mask, empty });
    return empty;
}

export function imageInputChecks(node) {
    if (node.mode === 2 || node.mode === 4) return [];
    if (linked(node, "mode")) return []; // The runtime mode has not been evaluated yet.
    const mode = value(node, "mode");
    const generated = mode === "Generate";
    const edit = ["Edit", "Edit — whole image", "Edit — masked region"].includes(mode);
    const notices = [];
    const add = (id, severity, message) => notices.push({ id, severity, message });
    const outputLinked = name => node.outputs?.find(o => o.name === name)?.links?.length > 0;
    const state = canvasState(node, "pixels");
    if (!generated && (!linked(node, "pixels") || (state && !(state.width > 0 && state.height > 0)))) {
        add("image", "error", "Image required. Load an image into Canvas, or select Generate.");
    }
    if (!generated && !linked(node, "vae")) {
        add("vae", "error", "VAE required. Connect the VAE used by your model.");
    }
    if (generated && !linked(node, "t2i_latent") && (!linked(node, "model") || !linked(node, "pixels"))) {
        add("latent", "error", "Generate needs t2i_latent, or a model and Canvas connected for the image size.");
    }
    if (!generated) {
        if (!linked(node, "ignore_mask") && value(node, "ignore_mask")) {
            add("ignored_mask", "warning", "Ignore input mask is on. The whole image can change; the painted mask is kept.");
        } else if (!linked(node, "ignore_mask") && mode === "Repair") {
            const mask = canvasState(node, "mask");
            if (mask && emptyMask(mask)) add("empty_mask", "warning", "No painted mask. Repair will process the whole image. Paint the area to repair.");
        }
        if (!outputLinked("denoise")) {
            add("denoise_link", "warning", "Denoise output is not connected. Connect it to the sampler to apply this value.");
        } else if (value(node, "denoise") === 0 && !linked(node, "denoise")) {
            add("zero_denoise", "warning", "Denoise is 0. The sampler will not add new detail. Increase it to make changes.");
        }
        if (((!linked(node, "crop_to_mask") && value(node, "crop_to_mask") !== "off") || mode === "Repair") && !outputLinked("stitch")) {
            add("stitch", "warning", "Crop has no stitch connection. Connect stitch to Canvas Review to restore the full image.");
        }
    }
    const refs = source(node, "references");
    if (!generated && !edit && refs?.comfyClass === "PowderReferences" && refs.inputs?.some(i => /^image_\d+$/.test(i.name) && i.link != null)) {
        add("references", "warning", "This node does not add the reference bundle to image conditioning in this mode. Use Edit for that. The text encoder may still use references.");
    }
    return notices;
}
