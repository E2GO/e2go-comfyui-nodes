/**
 * e2go widget hiding utilities.
 *
 * Widget values remain available to serialization while their controls and
 * unconnected sockets are hidden. Connected inputs retain a visible row.
 *
 * What this module DOES provide:
 * - hideConfigWidget: applies LiteGraph-level hiding (type, draw, computeSize)
 *   which helps in some rendering scenarios
 * - scheduleReHide: graph-scoped timers for re-hiding after async renders
 * - rehideAllE2goNodes: batch re-hide after graph configure
 */

import { app } from "../../../scripts/app.js";

export function noop() {}

export const CUSTOM_ROW_HEIGHT = 26;

// Vue draws legacy widgets in individual canvases with their own origin and
// zoom. Classic widgets use node-local graph coordinates instead.
const widgetDraws = new WeakMap();

// Nodes 2.0 and the properties panel share one widget but own separate canvases.
// Its single triggerDraw callback only refreshes the most recently mounted view.
export function trackWidgetDraw(widget, ctx, node, width, y, height) {
    const canvas = ctx.canvas;
    if (!canvas?.isConnected || canvas === app.canvas?.canvas) return;
    let views = widgetDraws.get(widget);
    if (!views) widgetDraws.set(widget, views = new Map());
    for (const c of views.keys()) if (!c.isConnected) views.delete(c);
    views.set(canvas, { ctx, args: [node, width, y, height], transform: ctx.getTransform() });
}

export function widgetPointerX(pointer, node, canvas, widget) {
    const event = pointer?.eDown ?? pointer?.event;
    const target = event?.target;
    if (target?.tagName === "CANVAS" && (widgetDraws.get(widget)?.has(target) || target.closest?.("[data-widget-name]"))) {
        const rect = target.getBoundingClientRect();
        const width = widgetDraws.get(widget)?.get(target)?.args[1] || rect.width;
        widget._e2goDrawWidth = width;
        return (event.clientX - rect.left) * width / rect.width;
    }
    return (canvas?.graph_mouse?.[0] ?? 0) - (node.pos?.[0] ?? 0);
}

export function redrawNodeWidgets(node) {
    for (const widget of node.widgets || []) {
        widget.triggerDraw?.();
        const views = widgetDraws.get(widget);
        for (const [canvas, view] of views || []) {
            if (!canvas.isConnected) { views.delete(canvas); continue; }
            const { ctx, args, transform } = view;
            ctx.save();
            ctx.resetTransform();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(transform);
            widget.draw?.(ctx, ...args);
            ctx.restore();
        }
    }
    node.setDirtyCanvas?.(true, true);
}

// ── Theme-reactive canvas colors ────────────────────────────────────
//
// Native LiteGraph widgets color their text from mutable globals on the
// LiteGraph namespace (exposed as `window.LiteGraph`, assigned in the
// frontend's GraphView chunk). Color palettes / themes overwrite these
// constants at runtime when the user switches theme, so our custom draws
// MUST read them LIVE at draw time — never capture at module load, or a
// mid-session theme change leaves our text the wrong color.
//
// Native getters observed in the frontend bundle:
//   text_color()          -> LiteGraph.WIDGET_TEXT_COLOR           (default #DDD)
//   secondary_text_color()-> LiteGraph.WIDGET_SECONDARY_TEXT_COLOR (default #999)
//   disabledTextColor()   -> LiteGraph.WIDGET_DISABLED_TEXT_COLOR  (default #666)
// Canonical widget font:  `normal ${NODE_SUBTEXT_SIZE}px ${NODE_FONT}`
//   (NODE_SUBTEXT_SIZE = 12, NODE_FONT = "Inter")

function _lg() {
    return (typeof window !== "undefined" && window.LiteGraph) || null;
}

/** Primary widget text color (theme-reactive). Fallback #ddd. */
export function widgetTextColor() {
    return _lg()?.WIDGET_TEXT_COLOR || "#ddd";
}

/** Secondary/caption widget text color (theme-reactive). Fallback #999. */
export function widgetSecondaryTextColor() {
    return _lg()?.WIDGET_SECONDARY_TEXT_COLOR || "#999";
}

/** Disabled/dimmed widget text color (theme-reactive). Fallback #666. */
export function widgetDisabledTextColor() {
    return _lg()?.WIDGET_DISABLED_TEXT_COLOR || "#666";
}

/**
 * Canonical widget font string, matching how native widgets compose theirs.
 * @param {number} [sizePx=12] pixel size (native subtext size is 12).
 */
export function widgetFont(sizePx = 12) {
    const family = _lg()?.NODE_FONT || "Arial";
    return `normal ${sizePx}px ${family}`;
}

/**
 * Turn a text widget into a drawn section separator: disabled, fixed-height,
 * left-aligned label and a thin rule. The ONE copy of what used to live
 * verbatim in six node files. setWidgetVisible preserves the custom drawing.
 * @param {number} [minWidth=320] the node's minimum content width.
 */
export function markSeparator(widget, title, node, minWidth = 320) {
    const label = title.replace(/^[═\s]+|[═\s]+$/g, "");
    widget.disabled = true;
    widget.computeSize = () => [Math.max(node.size?.[0] || minWidth, minWidth), 24];
    widget.draw = function (ctx, _node, width, posY) {
        ctx.save();
        ctx.fillStyle = widgetSecondaryTextColor();
        ctx.font = widgetFont(11);
        ctx.textAlign = "left";
        ctx.fillText(label, 18, posY + 16);
        const start = 18 + ctx.measureText(label).width + 12;
        if (start < width - 18) {
            ctx.globalAlpha *= 0.3;
            ctx.strokeStyle = widgetSecondaryTextColor();
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(start, posY + 12);
            ctx.lineTo(width - 18, posY + 12);
            ctx.stroke();
        }
        ctx.restore();
    };
}

/**
 * Apply LiteGraph-level hiding to a config widget.
 * The widget value stays as-is (real JSON) for functionality.
 */
export function hideConfigWidget(widget) {
    if (!widget) return;
    if (widgetHasConnection(widget)) {
        setWidgetVisible(widget, true);
        return;
    }
    if (!widget._e2goVisibility) {
        widget._e2goVisibility = { type: widget.type, draw: widget.draw, computeSize: widget.computeSize };
    }
    // Record the original type so a later show can restore it (harmless for
    // permanent-hide callers; required by powder_prompt.js's re-show path).
    if (!widget._origType && widget.type !== "converted-widget" && widget.type !== "e2go-hidden") {
        widget._origType = widget.type;
    }
    // Nodes 2.0 deliberately renders converted-widget as a socket-only row,
    // even when hidden. Extension-hidden controls must not pretend to be
    // converted inputs; keep their real sockets and indices untouched.
    widget.type = "e2go-hidden";
    widget.computeSize = () => [0, -4];
    widget.draw = noop;
    widget.hidden = true;
    widget.isVisible = () => false;
    widget._e2goHide = true;
}

// Reversible visibility for mode-dependent controls, including custom drawings.
export function setWidgetVisible(widget, visible) {
    if (!widget) return;
    visible = visible || widgetHasConnection(widget);
    if (!visible) {
        if (!widget._e2goVisibility) {
            widget._e2goVisibility = { type: widget.type, draw: widget.draw, computeSize: widget.computeSize };
        }
        hideConfigWidget(widget);
    } else if (widget._e2goVisibility) {
        for (const [key, value] of Object.entries(widget._e2goVisibility)) {
            if (value !== undefined) widget[key] = value;
            else delete widget[key];
        }
        widget.hidden = false;
        widget._e2goHide = false;
        delete widget.isVisible;
        delete widget._e2goVisibility;
    }
}

function widgetHasConnection(widget) {
    return widget._node?.inputs?.some(input => input.widget?.name === widget.name && input.link != null) || false;
}

// Frontend 1.55 creates sockets for native widgets, but its slot renderer and
// hit testing do not check widget visibility. Hidden widgets retain stale Y
// positions, producing orphan dots and stealing hits from other rows.
// Keep the input array and slot indices intact for workflow/link compatibility.
function guardHiddenWidgetSlots(node) {
    const hidden = slot => {
        if (!slot?.widget || slot.link != null) return false;
        const widget = node.widgets?.find(w => w.name === slot.widget.name);
        return !!widget?._e2goHide;
    };
    const inputPos = node.getInputPos;
    if (inputPos) node.getInputPos = function (index) {
        return hidden(this.inputs[index]) ? [NaN, NaN] : inputPos.apply(this, arguments);
    };
    const slotPosition = node.getSlotPosition;
    if (slotPosition) node.getSlotPosition = function (index, input) {
        return input && hidden(this.inputs[index]) ? [NaN, NaN] : slotPosition.apply(this, arguments);
    };
    const inputSlotPos = node.getInputSlotPos;
    if (inputSlotPos) node.getInputSlotPos = function (slot) {
        return hidden(slot) ? [NaN, NaN] : inputSlotPos.apply(this, arguments);
    };
    const connectionPos = node.getConnectionPos;
    node.getConnectionPos = function (input, index, out) {
        if (input && hidden(this.inputs[index])) {
            const result = out || [0, 0]; result[0] = result[1] = NaN; return result;
        }
        return connectionPos.apply(this, arguments);
    };
    const drawSlots = node.drawSlots;
    if (drawSlots) node.drawSlots = function () {
        const all = this._concreteInputs;
        if (!all) return drawSlots.apply(this, arguments);
        this._concreteInputs = all.filter(slot => !hidden(slot));
        try { return drawSlots.apply(this, arguments); }
        finally { this._concreteInputs = all; }
    };
    const arrange = node.arrange;
    if (arrange) node.arrange = function () {
        for (const widget of this.widgets || []) {
            if (widget._e2goHide && widgetHasConnection(widget)) setWidgetVisible(widget, true);
        }
        const result = arrange.apply(this, arguments);
        // NaN is a no-hit sentinel, not persisted layout geometry.
        for (const slot of this.inputs || []) {
            if (hidden(slot) && slot.boundingRect) {
                for (let i = 0; i < 4; i++) slot.boundingRect[i] = 0;
            }
        }
        return result;
    };
}

export const TOGGLE_ROW_HEIGHT = 38;

export function drawToggleButton(ctx, x, y, width, height, on, hover = false) {
    ctx.save();
    ctx.fillStyle = on ? "#315c45" : hover ? "#353a3f" : "#292c30";
    ctx.strokeStyle = on ? "#6ca883" : hover ? "#92999f" : "#535960";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, Math.min(6, height / 4));
    ctx.fill();
    ctx.stroke();
    const cy = y + height / 2;
    ctx.strokeStyle = on ? "#b6ecc8" : widgetSecondaryTextColor();
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (on) {
        ctx.moveTo(x + 11, cy);
        ctx.lineTo(x + 15, cy + 4);
        ctx.lineTo(x + 23, cy - 5);
    } else {
        ctx.moveTo(x + 11, cy);
        ctx.lineTo(x + 22, cy);
        ctx.moveTo(x + 18, cy - 4);
        ctx.lineTo(x + 22, cy);
        ctx.lineTo(x + 18, cy + 4);
    }
    ctx.stroke();
    ctx.restore();
}

const BOOLEAN_LABELS = {
    disable_clip: "Bypass LoRA CLIP",
    use_positive: "Use positive style",
    use_negative: "Use negative style",
    style_sweep: "Cycle styles",
    repeat_last: "Repeat last selection",
    auto_steps: "Scale steps by denoise",
    use_cache: "Use conditioning cache",
    seamless_mask_blend: "Blend mask edges",
    hard_concat_mask: "Hard conditioning mask",
    ignore_mask: "Ignore input mask",
    blank_reference: "Blank reference",
    custom_ratio: "Custom aspect ratio",
    custom_mode: "Custom image size",
    round_custom: "Round custom size",
    show_model_name: "Show model name",
    show_lora_names: "Show LoRA names",
    show_prompts: "Show prompts",
    show_seed: "Show seed",
    show_style_prompt: "Show style prompt",
    add_model_to_filename: "Model name in filename",
    save_json: "Save JSON metadata",
};

const BOOLEAN_HELP = {
    disable_clip: "ON: skip LoRA CLIP weights. Model weights still apply. OFF: use each LoRA's CLIP weight.",
    use_positive: "Include the positive text of enabled styles. Each style also has its own P switch.",
    use_negative: "Include the negative text of enabled styles. Each style also has its own N switch.",
    repeat_last: "Repeat the last selection on each Queue. Turn off to continue advancing. This does not freeze the seed or the generated image.",
    style_sweep: "Advance through the selected style range on Queue. Repeat last selection pauses advancement.",
};

// Preserve native boolean click handling and serialization.
export function styleBoolToggle(node, widgetName) {
    const w = node.widgets?.find((x) => x.name === widgetName);
    if (!w || w._e2goBoolStyled) return w;
    w._e2goBoolStyled = true;
    w.label = BOOLEAN_LABELS[widgetName] || w.label || widgetName.replaceAll("_", " ");
    const help = BOOLEAN_HELP[widgetName] || w.tooltip || w.options?.tooltip || "Click the row to toggle this option.";
    w.tooltip = help;
    const callback = w.callback;
    w.callback = function (...args) {
        const result = callback?.apply(this, args);
        redrawNodeWidgets(node);
        return result;
    };
    w.draw = function (ctx, _n, width, posY, H) {
        trackWidgetDraw(this, ctx, _n, width, posY, H);
        const h = H || 20;
        const on = !!this.value;
        ctx.save();
        ctx.globalAlpha = this.disabled ? 0.4 : 1;
        drawToggleButton(ctx, 15, posY + 1, Math.max(0, width - 30), h - 2, on);
        ctx.font = widgetFont(12);
        ctx.fillStyle = on ? widgetTextColor() : widgetSecondaryTextColor();
        ctx.save();
        ctx.beginPath();
        ctx.rect(49, posY, Math.max(0, width - 106), h);
        ctx.clip();
        ctx.fillText(this.label || this.name, 49, posY + h / 2 + 4);
        ctx.restore();
        ctx.font = widgetFont(10);
        ctx.textAlign = "right";
        ctx.fillText(on ? "ON" : "OFF", width - 23, posY + h / 2 + 3);
        ctx.restore();
    };
    return w;
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

            if (!node.graph || node.graph.getNodeById?.(node.id) !== node) return;
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


function collectNodes(graph, out = [], visited = new Set()) {
    if (!graph || visited.has(graph)) return out;
    visited.add(graph);
    for (const node of graph._nodes || []) {
        out.push(node);
        if (node.subgraph) collectNodes(node.subgraph, out, visited);
    }
    return out;
}

function rehideAllE2goNodes() {
    for (const node of collectNodes(app.graph)) {
        const widgetName = CONFIG_MAP[node.comfyClass];
        if (widgetName) {
            hideNamedWidget(node, widgetName);
        }
    }
}

app.registerExtension({
    name: "e2go_nodes.GlobalConfigHider",

    // Package-wide toggle language: EVERY boolean widget on a Powder node
    // renders as a full-row selection button — one hook so
    // new nodes and forgotten widgets can't drift back to the stock pill.
    nodeCreated(node) {
        if (!String(node.comfyClass || "").startsWith("Powder")) return;
        guardHiddenWidgetSlots(node);
        for (const w of node.widgets || []) {
            if (w.type === "toggle") styleBoolToggle(node, w.name);
        }
    },

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
