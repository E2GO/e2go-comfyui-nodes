import { app } from "../../../scripts/app.js";
import { noop, hideNamedWidget, scheduleReHide } from "./e2go_hide_utils.js";

const MAX_SLOTS = 20;
const CONFIG_WIDGET_NAME = "lora_config";

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
    node.loraSlotCount = Math.max(1, Math.min(MAX_SLOTS, node.loraSlotCount || 1));
    node.loraWidgets ||= {};
}

function syncConfig(node) {
    const cfg = findWidget(node, CONFIG_WIDGET_NAME);
    if (!cfg) return;
    if (!node.loraWidgets) return;

    const data = [];
    for (let i = 1; i <= node.loraSlotCount; i++) {
        const w = node.loraWidgets[i];
        if (!w) continue;
        data.push({
            name: w.lora?.value || "None",
            on: w.enabled?.value ?? true,
            strength_model: w.modelStr?.value ?? 1.0,
            strength_clip: w.clipStr?.value ?? 1.0,
            trigger: w.trigger?.value || "",
            use_trigger: w.useTrigger?.value ?? true,
        });
    }
    cfg.value = JSON.stringify(data);
}

function updateClipStrLock(node) {
    const disableClip = !!findWidget(node, "disable_clip")?.value;

    for (let i = 1; i <= node.loraSlotCount; i++) {
        const clip = node.loraWidgets[i]?.clipStr;
        if (!clip) continue;
        clip.disabled = disableClip;
        clip.label = disableClip ? "Clip Str \u{1F512} (=0)" : "Clip Str";
        clip.name = `lora_${i}_clip_str`;
    }
    app.graph?.setDirtyCanvas(true, true);
}

function removeSlotWidgets(node, index) {
    const slot = node.loraWidgets[index];
    if (!slot) return;
    for (const widget of Object.values(slot)) {
        const at = node.widgets.indexOf(widget);
        if (at >= 0) node.widgets.splice(at, 1);
    }
    delete node.loraWidgets[index];
}

function ensureSlot(node, index) {
    if (node.loraWidgets[index]) return node.loraWidgets[index];

    const slot = {};

    const separator = node.addWidget("text", "", "", noop);
    separator.name = `lora_${index}_separator`;
    markSeparator(separator, `\u2550\u2550\u2550\u2550\u2550\u2550\u2550 LoRA ${index} \u2550\u2550\u2550\u2550\u2550\u2550\u2550`, node);
    slot.separator = separator;

    const enabled = node.addWidget("toggle", "Enabled", true, () => syncConfig(node));
    enabled.name = `lora_${index}_enabled`;
    slot.enabled = enabled;

    const lora = node.addWidget("combo", "LoRA", "None", () => {
        syncConfig(node);
        const selected = lora.value;
        if (!selected || selected === "None") return;
        fetch(`/powder_lora/get_trigger?lora=${encodeURIComponent(selected)}`)
            .then((r) => r.json())
            .then((data) => {
                if (slot.trigger && data?.trigger) {
                    slot.trigger.value = data.trigger;
                    syncConfig(node);
                    app.graph?.setDirtyCanvas(true, true);
                }
            })
            .catch((err) => console.warn("[PowderLora] Failed to fetch trigger:", err));
    }, { values: node.loraList || ["None"] });
    lora.name = `lora_${index}_lora`;
    slot.lora = lora;

    const trigger = node.addWidget("text", "Trigger", "", () => syncConfig(node));
    trigger.name = `lora_${index}_trigger`;
    slot.trigger = trigger;

    const useTrigger = node.addWidget("toggle", "Use Trigger", true, () => syncConfig(node));
    useTrigger.name = `lora_${index}_use_trigger`;
    slot.useTrigger = useTrigger;

    const modelStr = node.addWidget("number", "Model Str", 1.0, () => syncConfig(node), {
        min: -10,
        max: 10,
        step: 0.01,
        precision: 2,
    });
    modelStr.name = `lora_${index}_model_str`;
    slot.modelStr = modelStr;

    const clipStr = node.addWidget("number", "Clip Str", 1.0, () => syncConfig(node), {
        min: -10,
        max: 10,
        step: 0.01,
        precision: 2,
    });
    clipStr.name = `lora_${index}_clip_str`;
    slot.clipStr = clipStr;

    node.loraWidgets[index] = slot;
    return slot;
}

function reorderWidgets(node) {
    const ordered = [];

    // MUST match INPUT_TYPES order — widgets_values is position-based
    const baseNames = ["mode", "combination_order", CONFIG_WIDGET_NAME, "disable_clip", "trigger_position", "prompt", "negative_prompt"];
    for (const name of baseNames) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }

    const toggleAll = findWidget(node, "toggle_all");
    const addBtn = findWidget(node, "+ Add Lora");
    const removeBtn = findWidget(node, "- Remove Lora");
    if (toggleAll) ordered.push(toggleAll);
    if (addBtn) ordered.push(addBtn);
    if (removeBtn) ordered.push(removeBtn);

    for (let i = 1; i <= node.loraSlotCount; i++) {
        const slot = ensureSlot(node, i);
        ordered.push(slot.separator, slot.enabled, slot.lora, slot.trigger, slot.useTrigger, slot.modelStr, slot.clipStr);
    }

    const remaining = (node.widgets || []).filter((w) => !ordered.includes(w));
    node.widgets = [...ordered, ...remaining];
}

function applyLayout(node) {
    hideNamedWidget(node, CONFIG_WIDGET_NAME);
    reorderWidgets(node);
    updateClipStrLock(node);
    syncConfig(node);
    requestResize(node);
}

function restoreFromInfo(node, info) {
    ensureState(node);

    const slotCount = Math.max(1, Math.min(MAX_SLOTS, info?.loraSlotCount || 1));
    node.loraSlotCount = slotCount;
    for (let i = 1; i <= slotCount; i++) ensureSlot(node, i);

    const slots = info?.loraSlotsData || [];
    for (let i = 1; i <= slotCount; i++) {
        const data = slots[i - 1] || {};
        const slot = node.loraWidgets[i];
        if (!slot) continue;
        slot.lora.value = data.lora || "None";
        slot.enabled.value = data.enabled ?? true;
        slot.modelStr.value = data.modelStr ?? 1.0;
        slot.clipStr.value = data.clipStr ?? 1.0;
        slot.trigger.value = data.trigger || "";
        slot.useTrigger.value = data.useTrigger ?? true;
    }

    applyLayout(node);
    scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
}

async function loadLoraList(node) {
    try {
        const response = await fetch("/object_info/LoraLoader");
        const data = await response.json();
        const rawList = data?.LoraLoader?.input?.required?.lora_name?.[0];
        if (!Array.isArray(rawList)) return;
        node.loraList = ["None", ...rawList];
        for (let i = 1; i <= node.loraSlotCount; i++) {
            const loraWidget = node.loraWidgets[i]?.lora;
            if (loraWidget) loraWidget.options.values = node.loraList;
        }
        app.graph?.setDirtyCanvas(true, true);
    } catch (err) {
        console.warn("[PowderLora] Failed to load LoRA list:", err);
    }
}

app.registerExtension({
    name: "e2go_nodes.PowderLoraLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowderLoraLoader") return;

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            ensureState(this);
            syncConfig(this);
            origOnSerialize?.apply(this, arguments);

            info.loraSlotCount = this.loraSlotCount;
            info.loraSlotsData = [];
            for (let i = 1; i <= this.loraSlotCount; i++) {
                const w = this.loraWidgets[i];
                if (!w) continue;
                info.loraSlotsData.push({
                    lora: w.lora?.value || "None",
                    enabled: w.enabled?.value ?? true,
                    modelStr: w.modelStr?.value ?? 1.0,
                    clipStr: w.clipStr?.value ?? 1.0,
                    trigger: w.trigger?.value || "",
                    useTrigger: w.useTrigger?.value ?? true,
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
                content: "Remove Last LoRA Slot",
                callback: () => {
                    if ((this.loraSlotCount || 1) <= 1) return;
                    removeSlotWidgets(this, this.loraSlotCount);
                    this.loraSlotCount -= 1;
                    applyLayout(this);
                },
            });
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderLoraLoader") return;

        hideNamedWidget(node, CONFIG_WIDGET_NAME);

        requestAnimationFrame(() => {
            ensureState(node);
            hideNamedWidget(node, CONFIG_WIDGET_NAME);

            const disableClip = findWidget(node, "disable_clip");
            if (disableClip) {
                const original = disableClip.callback;
                disableClip.callback = function (value, canvas, n, pos, event) {
                    const result = original?.call(this, value, canvas, n, pos, event);
                    updateClipStrLock(node);
                    syncConfig(node);
                    return result;
                };
            }

            const toggleAll = node.addWidget("toggle", "Toggle All", true, (value) => {
                for (let i = 1; i <= node.loraSlotCount; i++) {
                    const slot = node.loraWidgets[i];
                    if (slot?.enabled) slot.enabled.value = value;
                }
                syncConfig(node);
            });
            toggleAll.name = "toggle_all";

            const addBtn = node.addWidget("button", null, null, () => {
                if (node.loraSlotCount >= MAX_SLOTS) return;
                node.loraSlotCount += 1;
                ensureSlot(node, node.loraSlotCount);
                applyLayout(node);
            });
            addBtn.name = "+ Add Lora";

            const removeBtn = node.addWidget("button", null, null, () => {
                if (node.loraSlotCount <= 1) return;
                removeSlotWidgets(node, node.loraSlotCount);
                node.loraSlotCount -= 1;
                applyLayout(node);
            });
            removeBtn.name = "- Remove Lora";

            ensureSlot(node, 1);
            applyLayout(node);
            loadLoraList(node);
            scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
        });
    },
});
