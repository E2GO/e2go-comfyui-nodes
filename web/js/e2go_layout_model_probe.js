import { api } from "../../../scripts/api.js";

const kind = n => n?.comfyClass || n?.type;
const value = (n, name) => n.widgets?.find(w => w.name === name)?.value;
const samplerTypes = new Set(["PowderSampler", "KSampler", "KSamplerAdvanced", "SamplerCustom"]);

export function layoutModelSource(canvas) {
    const graph = canvas.graph;
    if (!graph) return null;
    const link = id => graph.links?.get?.(id) ?? graph.links?.[id];
    const reached = new Set(), candidates = [];
    const visit = node => {
        if (!node || reached.has(node.id) || node.mode === 2) return;
        reached.add(node.id);
        if (samplerTypes.has(kind(node)) && node.mode !== 4) candidates.push(node);
        for (const output of node.outputs || []) for (const id of output.links || []) visit(graph.getNodeById(link(id)?.target_id));
    };
    visit(canvas);
    const samplers = candidates.length ? candidates : (graph._nodes || []).filter(n => samplerTypes.has(kind(n)) && n.mode !== 2 && n.mode !== 4);
    const origins = [];
    for (const sampler of samplers) {
        let edge = link(sampler.inputs?.find(i => i.name === "model")?.link);
        const seen = new Set();
        let origin = null;
        while (edge) {
            const node = graph.getNodeById(edge.origin_id);
            if (!node || seen.has(node.id) || node.mode === 2) break;
            seen.add(node.id);
            const type = kind(node);
            if (["UNETLoader", "UnetLoaderGGUF"].includes(type)) {
                origin = { category: "diffusion_models", name: value(node, "unet_name") }; break;
            }
            if (["CheckpointLoaderSimple", "CheckpointLoader"].includes(type)) {
                origin = { category: "checkpoints", name: value(node, "ckpt_name") }; break;
            }
            let input;
            if (type === "PowderSwitcher") {
                const active = node._sw?.groups?.findIndex(g => g.on) ?? (Number(value(node, "active_group")) - 1);
                input = node.inputs?.find(i => i.name === `g${active}_c${edge.origin_slot}`);
            } else if (/reroute/i.test(type || "")) input = node.inputs?.[0];
            else {
                const models = (node.inputs || []).filter(i => i.type === "MODEL" && i.name !== "model_negative" && i.link != null);
                if (models.length === 1) input = models[0];
            }
            edge = link(input?.link);
        }
        if (!origin?.name) return null; // Do not guess through unknown/merged model sources.
        origins.push(origin);
    }
    const unique = new Map(origins.map(o => [JSON.stringify(o), o]));
    return unique.size === 1 ? unique.values().next().value : null;
}

export async function probeLayoutModel(source, target) {
    const query = new URLSearchParams({ ...source, target });
    const response = await api.fetchApi(`/e2go/layout_model?${query}`);
    if (!response.ok) {
        if (response.status === 404) throw new Error("Model compatibility check is unavailable. Restart ComfyUI after updating Powder Nodes.");
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || "Could not check the selected model file.");
    }
    return response.json();
}
