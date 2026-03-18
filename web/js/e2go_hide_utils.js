/**
 * e2go widget hiding utilities.
 *
 * NOTE: ComfyUI v0.17 Vue frontend reads widget.value directly for BOTH
 * canvas rendering AND prompt building. We cannot hide the value without
 * breaking functionality. The config widget will show JSON text on the node.
 * This is a known limitation until a proper Vue-compatible hiding mechanism
 * is found.
 *
 * What this module DOES provide:
 * - hideConfigWidget: applies LiteGraph-level hiding (type, draw, computeSize)
 *   which helps in some rendering scenarios
 * - scheduleReHide: graph-scoped timers for re-hiding after async renders
 * - rehideAllE2goNodes: batch re-hide after graph configure
 */

import { app } from "../../../scripts/app.js";

export function noop() {}

/**
 * Apply LiteGraph-level hiding to a config widget.
 * The widget value stays as-is (real JSON) for functionality.
 */
export function hideConfigWidget(widget) {
    if (!widget) return;
    widget.type = "converted-widget";
    widget.computeSize = () => [0, -4];
    widget.draw = noop;
    widget.hidden = true;
    widget.isVisible = () => false;
    widget._e2goHide = true;
}

/**
 * Find a widget by name on a node and hide it.
 */
export function hideNamedWidget(node, widgetName) {
    const w = node.widgets?.find(w => w.name === widgetName);
    if (w) hideConfigWidget(w);
    return w;
}

/**
 * Schedule re-hiding at multiple time points to survive async re-renders.
 * Callbacks are scoped to the current graph to prevent cross-tab contamination.
 */
export function scheduleReHide(node, widgetName, afterFn) {
    const graphRef = app.graph;
    for (const delay of [0, 50, 150, 300, 600, 1200, 2500]) {
        setTimeout(() => {
            if (app.graph !== graphRef) return;
            hideNamedWidget(node, widgetName);
            if (afterFn) afterFn(node);
        }, delay);
    }
}

// ── Global graph hooks ──────────────────────────────────────────────

const CONFIG_MAP = {
    "PowderLoraLoader": "lora_config",
    "PowderStyler": "style_config",
    "PowderPromptList": "prompt_config",
};

function rehideAllE2goNodes() {
    const graph = app.graph;
    if (!graph?._nodes) return;
    for (const node of graph._nodes) {
        const widgetName = CONFIG_MAP[node.comfyClass];
        if (widgetName) {
            hideNamedWidget(node, widgetName);
        }
    }
}

app.registerExtension({
    name: "e2go_nodes.GlobalConfigHider",

    async afterConfigureGraph() {
        const graphRef = app.graph;
        rehideAllE2goNodes();
        for (const delay of [50, 200, 500, 1000, 2000]) {
            setTimeout(() => {
                if (app.graph !== graphRef) return;
                rehideAllE2goNodes();
            }, delay);
        }
    },
});
