// Local/model-specific templates may narrow the task menu. This is a UI
// declaration of their supported wiring, not automatic checkpoint detection.
import { app } from "../../../scripts/app.js";

const MODES = ["Generate", "Repaint", "Edit", "Edit (native)", "Repair"];
function applyTaskMenu(node) {
    if (node.comfyClass !== "PowderImageConditioning") return;
    const requested = node.properties?.powderAllowedModes;
    if (!Array.isArray(requested)) return;
    const allowed = MODES.filter(mode => requested.includes(mode));
    const widget = node.widgets?.find(w => w.name === "mode");
    if (!widget || !allowed.length) return;
    widget.options = { ...widget.options, values: allowed };
    // Do not silently change a saved task: a mismatched value must remain
    // visible for review, while the menu offers the supported alternatives.
}

app.registerExtension({
    name: "e2go_nodes.WorkflowTaskMenu",
    loadedGraphNode: applyTaskMenu,
});
