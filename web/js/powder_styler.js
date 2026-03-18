import { app } from "../../../scripts/app.js";
import { noop, hideNamedWidget, scheduleReHide } from "./e2go_hide_utils.js";

const MAX_SLOTS = 20;
const CONFIG_WIDGET_NAME = "style_config";

function requestResize(node) {
    const graphRef = app.graph;
    requestAnimationFrame(() => {
        if (app.graph !== graphRef) return;
        try {
            node.setSize([node.size?.[0] || 340, node.computeSize()[1]]);
        } catch {}
        app.graph?.setDirtyCanvas(true, true);
    });
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function markSeparator(widget, title, node) {
    widget.disabled = true;
    widget.computeSize = () => [Math.max(node.size?.[0] || 280, 280), 24];
    widget.draw = function (ctx, _node, width, posY) {
        ctx.fillStyle = "#aaaaaa";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.fillText(title, width / 2, posY + 16);
        ctx.textAlign = "left";
    };
}

function ensureState(node) {
    node.styleSlotCount = Math.max(1, Math.min(MAX_SLOTS, node.styleSlotCount || 1));
    node.styleWidgets ||= {};
}

function syncConfig(node) {
    const cfg = findWidget(node, CONFIG_WIDGET_NAME);
    if (!cfg) return;
    if (!node.styleWidgets) return;

    const data = [];
    for (let i = 1; i <= node.styleSlotCount; i++) {
        const w = node.styleWidgets[i];
        if (!w) continue;
        data.push({
            name: w.style?.value || "None",
            on: w.enabled?.value ?? true,
            use_positive: w.usePositive?.value ?? true,
            use_negative: w.useNegative?.value ?? true,
        });
    }
    cfg.value = JSON.stringify(data);
}

function removeSlotWidgets(node, index) {
    const slot = node.styleWidgets[index];
    if (!slot) return;
    for (const widget of Object.values(slot)) {
        const at = node.widgets.indexOf(widget);
        if (at >= 0) node.widgets.splice(at, 1);
    }
    delete node.styleWidgets[index];
}

function ensureSlot(node, index) {
    if (node.styleWidgets[index]) return node.styleWidgets[index];

    const slot = {};

    const separator = node.addWidget("text", "", "", noop);
    separator.name = `style_${index}_separator`;
    markSeparator(separator, `\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Style ${index} \u2550\u2550\u2550\u2550\u2550\u2550\u2550`, node);
    slot.separator = separator;

    const enabled = node.addWidget("toggle", "Enabled", true, () => syncConfig(node));
    enabled.name = `style_${index}_enabled`;
    slot.enabled = enabled;

    const style = node.addWidget("combo", "Style", "None", () => syncConfig(node), {
        values: node.styleList || ["None"],
    });
    style.name = `style_${index}_style`;
    slot.style = style;

    const usePositive = node.addWidget("toggle", "Use Positive", true, () => syncConfig(node));
    usePositive.name = `style_${index}_use_positive`;
    slot.usePositive = usePositive;

    const useNegative = node.addWidget("toggle", "Use Negative", true, () => syncConfig(node));
    useNegative.name = `style_${index}_use_negative`;
    slot.useNegative = useNegative;

    node.styleWidgets[index] = slot;
    return slot;
}

function reorderWidgets(node) {
    const ordered = [];

    // MUST match INPUT_TYPES order — widgets_values is position-based
    const baseNames = ["style_position", "use_positive", "use_negative", CONFIG_WIDGET_NAME];
    for (const name of baseNames) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }

    const toggleAll = findWidget(node, "toggle_all");
    const addBtn = findWidget(node, "+ Add Style");
    const removeBtn = findWidget(node, "- Remove Style");
    if (toggleAll) ordered.push(toggleAll);
    if (addBtn) ordered.push(addBtn);
    if (removeBtn) ordered.push(removeBtn);

    for (let i = 1; i <= node.styleSlotCount; i++) {
        const slot = ensureSlot(node, i);
        ordered.push(slot.separator, slot.enabled, slot.style, slot.usePositive, slot.useNegative);
    }

    const remaining = (node.widgets || []).filter((w) => !ordered.includes(w));
    node.widgets = [...ordered, ...remaining];
}

function applyLayout(node) {
    hideNamedWidget(node, CONFIG_WIDGET_NAME);
    reorderWidgets(node);
    syncConfig(node);
    requestResize(node);
}

function restoreFromInfo(node, info) {
    ensureState(node);

    const slotCount = Math.max(1, Math.min(MAX_SLOTS, info?.styleSlotCount || 1));
    node.styleSlotCount = slotCount;
    for (let i = 1; i <= slotCount; i++) ensureSlot(node, i);

    const slots = info?.styleSlotsData || [];
    for (let i = 1; i <= slotCount; i++) {
        const data = slots[i - 1] || {};
        const slot = node.styleWidgets[i];
        if (!slot) continue;
        slot.style.value = data.style || "None";
        slot.enabled.value = data.enabled ?? true;
        slot.usePositive.value = data.usePositive ?? true;
        slot.useNegative.value = data.useNegative ?? true;
    }

    applyLayout(node);
    scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
}

async function loadStyleList(node) {
    try {
        const response = await fetch("/powder_styler/get_styles");
        const data = await response.json();
        if (!Array.isArray(data?.styles)) return;
        node.styleList = ["None", ...data.styles];
        for (let i = 1; i <= node.styleSlotCount; i++) {
            const widget = node.styleWidgets[i]?.style;
            if (widget) widget.options.values = node.styleList;
        }
        app.graph?.setDirtyCanvas(true, true);
    } catch (err) {
        console.warn("[PowderStyler] Failed to load style list:", err);
    }
}

app.registerExtension({
    name: "e2go_nodes.PowderStyler",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowderStyler") return;

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            ensureState(this);
            syncConfig(this);
            origOnSerialize?.apply(this, arguments);

            info.styleSlotCount = this.styleSlotCount;
            info.styleSlotsData = [];
            for (let i = 1; i <= this.styleSlotCount; i++) {
                const w = this.styleWidgets[i];
                if (!w) continue;
                info.styleSlotsData.push({
                    style: w.style?.value || "None",
                    enabled: w.enabled?.value ?? true,
                    usePositive: w.usePositive?.value ?? true,
                    useNegative: w.useNegative?.value ?? true,
                });
            }
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            hideNamedWidget(this, CONFIG_WIDGET_NAME);
            requestAnimationFrame(() => restoreFromInfo(this, info));
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            origGetExtraMenuOptions?.apply(this, arguments);
            options.unshift({
                content: "Remove Last Style Slot",
                callback: () => {
                    if ((this.styleSlotCount || 1) <= 1) return;
                    removeSlotWidgets(this, this.styleSlotCount);
                    this.styleSlotCount -= 1;
                    applyLayout(this);
                },
            });
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderStyler") return;

        hideNamedWidget(node, CONFIG_WIDGET_NAME);

        requestAnimationFrame(() => {
            ensureState(node);
            hideNamedWidget(node, CONFIG_WIDGET_NAME);

            const toggleAll = node.addWidget("toggle", "Toggle All", true, (value) => {
                for (let i = 1; i <= node.styleSlotCount; i++) {
                    const slot = node.styleWidgets[i];
                    if (slot?.enabled) slot.enabled.value = value;
                }
                syncConfig(node);
            });
            toggleAll.name = "toggle_all";

            const addBtn = node.addWidget("button", null, null, () => {
                if (node.styleSlotCount >= MAX_SLOTS) return;
                node.styleSlotCount += 1;
                ensureSlot(node, node.styleSlotCount);
                applyLayout(node);
            });
            addBtn.name = "+ Add Style";

            const removeBtn = node.addWidget("button", null, null, () => {
                if (node.styleSlotCount <= 1) return;
                removeSlotWidgets(node, node.styleSlotCount);
                node.styleSlotCount -= 1;
                applyLayout(node);
            });
            removeBtn.name = "- Remove Style";

            ensureSlot(node, 1);
            applyLayout(node);
            loadStyleList(node);
            scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
        });
    },
});
