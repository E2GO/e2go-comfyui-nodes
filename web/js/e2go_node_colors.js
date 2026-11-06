import { app } from "../../../scripts/app.js";

// Fixed E2GO header colors, independent of ComfyUI's named color presets.
const PALETTE = {
    prompt: "#305548",
    style: "#51436B",
    image: "#28565C",
    generation: "#344F73",
    routing: "#675032",
    output: "#634553",
    utility: "#46515E",
};

const NODE_GROUPS = {
    PowderPromptList: "prompt",
    PowderPromptWildcard: "prompt",
    PowderLoraLoader: "style",
    PowderStyler: "style",
    PowderCanvas: "image",
    PowderReferences: "image",
    PowderImageConditioning: "image",
    PowderResolution: "image",
    PowderConditioner: "generation",
    PowderSampler: "generation",
    PowderInpaintSamplerSelect: "generation",
    PowderSwitcher: "routing",
    PowderCanvasReview: "output",
    PowderGridSaver: "output",
    ClearConditioningCache: "utility",
    PowderCacheStats: "utility",
};

function applyHeaderColor(node, type) {
    const group = NODE_GROUPS[type];
    if (!group) return;
    node.color = PALETTE[group];
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "e2go_nodes.SemanticHeaderColors",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_GROUPS[nodeData.name]) return;
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            applyHeaderColor(this, nodeData.name);
            return result;
        };
    },
    nodeCreated(node) {
        applyHeaderColor(node, node.comfyClass || node.type);
    },
});
