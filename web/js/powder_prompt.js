import { app } from "../../../scripts/app.js";
import { hideConfigWidget as hideConfigWidgetUtil } from "./e2go_hide_utils.js";

const MAX_SLOTS = 20;
const CONFIG_WIDGET_NAME = "prompt_config";

function noop() {}

function hideWidget(widget) {
    if (!widget) return;
    if (!widget._origType && widget.type !== "converted-widget") {
        widget._origType = widget.type;
    }
    widget.type = "converted-widget";
    widget.computeSize = () => [0, -4];
    widget.draw = noop;
    widget.hidden = true;
    widget._e2goHide = true;
}

function showWidget(widget) {
    if (!widget) return;
    widget.hidden = false;
    widget._e2goHide = false;
    if (widget.type === "converted-widget" && widget._origType) {
        widget.type = widget._origType;
    }
    delete widget.computeSize;
    delete widget.draw;
    delete widget.isVisible;
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

function requestResize(node) {
    const graphRef = app.graph;
    requestAnimationFrame(() => {
        if (app.graph !== graphRef) return;
        try {
            node.setSize([node.size?.[0] || 320, node.computeSize()[1]]);
        } catch {}
        app.graph?.setDirtyCanvas(true, true);
    });
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function ensureBaseState(node) {
    node.promptSlotCount = Math.max(1, Math.min(MAX_SLOTS, node.promptSlotCount || 1));
    node.enabledWidgets ||= {};
    node.textWidgets ||= {};
    node.negativeWidgets ||= {};
    node.separatorWidgets ||= {};
    node.promptTexts ||= {};
    node.negativeTexts ||= {};

    for (let i = 1; i <= MAX_SLOTS; i++) {
        node.textWidgets[i] ||= findWidget(node, `prompt_${i}_text`);
        node.negativeWidgets[i] ||= findWidget(node, `negative_${i}_text`);
    }
}

function syncPromptConfig(node) {
    const cfg = findWidget(node, CONFIG_WIDGET_NAME);
    if (!cfg) return;

    const data = [];
    for (let i = 1; i <= node.promptSlotCount; i++) {
        data.push({ on: node.enabledWidgets[i]?.value ?? true });
    }
    cfg.value = JSON.stringify(data);
}

function ensurePromptSlot(node, index) {
    if (node.separatorWidgets[index] && node.enabledWidgets[index]) return;

    const separator = node.addWidget("text", "", "", noop);
    separator.name = `prompt_${index}_separator`;
    markSeparator(separator, `═══════ Prompt ${index} ═══════`, node);

    const enabled = node.addWidget("toggle", "Enabled", true, () => syncPromptConfig(node));
    enabled.name = `prompt_${index}_enabled`;

    node.separatorWidgets[index] = separator;
    node.enabledWidgets[index] = enabled;
}

function reorderWidgets(node) {
    const ordered = [];

    // MUST match INPUT_TYPES order — widgets_values is position-based
    // prompt_config is the only required widget
    const config = findWidget(node, CONFIG_WIDGET_NAME);
    if (config) ordered.push(config);

    const toggleAll = findWidget(node, "toggle_all");
    const addBtn = findWidget(node, "+ Add Prompt");
    const removeBtn = findWidget(node, "- Remove Prompt");
    if (toggleAll) ordered.push(toggleAll);
    if (addBtn) ordered.push(addBtn);
    if (removeBtn) ordered.push(removeBtn);

    for (let i = 1; i <= node.promptSlotCount; i++) {
        ensurePromptSlot(node, i);
        ordered.push(node.separatorWidgets[i]);
        ordered.push(node.enabledWidgets[i]);

        const text = node.textWidgets[i];
        const negative = node.negativeWidgets[i];
        if (text) ordered.push(text);
        if (negative) ordered.push(negative);
    }

    const remaining = (node.widgets || []).filter((w) => !ordered.includes(w));
    node.widgets = [...ordered, ...remaining];
}

function hideConfigPermanently(widget) {
    hideConfigWidgetUtil(widget);
}

function applyVisibility(node) {
    const config = findWidget(node, CONFIG_WIDGET_NAME);
    hideConfigPermanently(config);

    for (let i = 1; i <= MAX_SLOTS; i++) {
        const text = node.textWidgets[i];
        const negative = node.negativeWidgets[i];
        const input = node.inputs?.find((inp) => inp.name === `prompt_${i}_text`);
        const negInput = node.inputs?.find((inp) => inp.name === `negative_${i}_text`);
        const active = i <= node.promptSlotCount;

        if (input) input.hidden = !active;
        if (negInput) negInput.hidden = !active;

        if (text) {
            if (active) showWidget(text);
            else hideWidget(text);
        }
        if (negative) {
            if (active) showWidget(negative);
            else hideWidget(negative);
        }
    }

    reorderWidgets(node);
    syncPromptConfig(node);
    requestResize(node);
}

function restoreFromInfo(node, info) {
    ensureBaseState(node);

    const slotCount = Math.max(1, Math.min(MAX_SLOTS, info?.promptSlotCount || 1));
    node.promptSlotCount = slotCount;

    for (let i = 1; i <= slotCount; i++) ensurePromptSlot(node, i);

    const promptTexts = info?.promptTexts || {};
    const negativeTexts = info?.negativeTexts || {};
    const slotsData = info?.promptSlotsData || [];

    for (let i = 1; i <= slotCount; i++) {
        const textWidget = node.textWidgets[i];
        const negWidget = node.negativeWidgets[i];
        const enabledWidget = node.enabledWidgets[i];

        // Always set text value — prevents stale boolean leakage from widget reordering
        if (textWidget) textWidget.value = typeof promptTexts[i] === "string" ? promptTexts[i] : "";
        if (negWidget) negWidget.value = typeof negativeTexts[i] === "string" ? negativeTexts[i] : "";
        if (enabledWidget && slotsData[i - 1]) enabledWidget.value = slotsData[i - 1].enabled ?? true;
    }

    applyVisibility(node);
}

app.registerExtension({
    name: "e2go_nodes.PowderPromptList",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowderPromptList") return;

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            origOnSerialize?.apply(this, arguments);
            ensureBaseState(this);
            syncPromptConfig(this);

            const promptTexts = {};
            const negativeTexts = {};
            const promptSlotsData = [];

            for (let i = 1; i <= this.promptSlotCount; i++) {
                const textValue = this.textWidgets[i]?.value;
                const negValue = this.negativeWidgets[i]?.value;

                promptSlotsData.push({ enabled: this.enabledWidgets[i]?.value ?? true });
                if (typeof textValue === "string" && textValue.length && !/^(true|false)$/i.test(textValue.trim())) {
                    promptTexts[i] = textValue;
                }
                if (typeof negValue === "string" && negValue.length && !/^(true|false)$/i.test(negValue.trim())) {
                    negativeTexts[i] = negValue;
                }
            }

            info.promptSlotCount = this.promptSlotCount;
            info.promptSlotsData = promptSlotsData;
            info.promptTexts = promptTexts;
            info.negativeTexts = negativeTexts;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            // Sanitise text widgets immediately — origOnConfigure may have
            // applied shifted widget values (boolean from toggle → text field)
            ensureBaseState(this);
            for (let i = 1; i <= MAX_SLOTS; i++) {
                for (const w of [this.textWidgets[i], this.negativeWidgets[i]]) {
                    if (w && typeof w.value === "string" && /^(true|false)$/i.test(w.value.trim())) {
                        w.value = "";
                    }
                }
            }
            requestAnimationFrame(() => restoreFromInfo(this, info));
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            origGetExtraMenuOptions?.apply(this, arguments);
            options.unshift({
                content: "Remove Last Prompt",
                callback: () => {
                    if ((this.promptSlotCount || 1) <= 1) return;
                    this.promptSlotCount -= 1;
                    applyVisibility(this);
                },
            });
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderPromptList") return;

        requestAnimationFrame(() => {
            ensureBaseState(node);
            hideConfigPermanently(findWidget(node, CONFIG_WIDGET_NAME));

            const toggleAll = node.addWidget("toggle", "Toggle All", true, (value) => {
                for (let i = 1; i <= node.promptSlotCount; i++) {
                    if (node.enabledWidgets[i]) node.enabledWidgets[i].value = value;
                }
                syncPromptConfig(node);
            });
            toggleAll.name = "toggle_all";

            const addBtn = node.addWidget("button", null, null, () => {
                if (node.promptSlotCount >= MAX_SLOTS) return;
                node.promptSlotCount += 1;
                ensurePromptSlot(node, node.promptSlotCount);
                applyVisibility(node);
            });
            addBtn.name = "+ Add Prompt";

            const removeBtn = node.addWidget("button", null, null, () => {
                if (node.promptSlotCount <= 1) return;
                node.promptSlotCount -= 1;
                applyVisibility(node);
            });
            removeBtn.name = "- Remove Prompt";

            // Sanitise any text widgets that may have received boolean values
            for (let i = 1; i <= MAX_SLOTS; i++) {
                for (const w of [node.textWidgets[i], node.negativeWidgets[i]]) {
                    if (w && typeof w.value === "string" && /^(true|false)$/i.test(w.value.trim())) {
                        w.value = "";
                    }
                }
            }

            ensurePromptSlot(node, 1);
            applyVisibility(node);
        });
    },
});
