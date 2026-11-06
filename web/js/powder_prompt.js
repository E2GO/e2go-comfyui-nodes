import { app } from "../../../scripts/app.js";
import { installTextResizing, arrangeTextHandles } from "./e2go_text_resize.js";
import { setWidgetVisible, styleBoolToggle, hideConfigWidget as hideConfigWidgetUtil, widgetSecondaryTextColor, widgetFont, markSeparator } from "./e2go_hide_utils.js";

const MAX_SLOTS = 20;
const CONFIG_WIDGET_NAME = "prompt_config";

function noop() {}

const hideWidget = hideConfigWidgetUtil;
const showWidget = widget => setWidgetVisible(widget, true);

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
    separator.serialize = false; // documentation of intent — platform ignores this on save
    markSeparator(separator, `═══════ Prompt ${index} ═══════`, node, 280);

    const enabled = node.addWidget("toggle", "Enabled", true, () => syncPromptConfig(node));
    enabled.name = `prompt_${index}_enabled`;

    styleBoolToggle(node, enabled.name);

    node.separatorWidgets[index] = separator;
    node.enabledWidgets[index] = enabled;
}

function reorderWidgets(node) {
    const ordered = [];

    // NOTE: this does NOT match INPUT_TYPES order — INPUT_TYPES declares all
    // prompt_N_text widgets then all negative_N_text widgets, while this
    // interleaves per-slot text/negative pairs with decoration widgets
    // (separators, toggles, buttons). widgets_values is position-based, so
    // any save this file produces is positionally scrambled; restore safety
    // comes entirely from the name-keyed data captured in onSerialize
    // (promptTexts/negativeTexts/promptSlotsData), not from position.
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
    arrangeTextHandles(node);
}

function hideConfigPermanently(widget) {
    hideConfigWidgetUtil(widget);
}

// Shared by the "- Remove Prompt" button and the "Remove Last Prompt"
// context-menu item — both decrement the slot count and re-layout the
// same way; keeping one implementation avoids the two paths drifting.
function removeLastSlot(node) {
    if ((node.promptSlotCount || 1) <= 1) return;
    node.promptSlotCount -= 1;
    applyVisibility(node);
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
        setWidgetVisible(node.separatorWidgets[i], active);
        setWidgetVisible(node.enabledWidgets[i], active);

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

// Parses the legacy `prompt_config` widget value — preferring the pre-layout
// snapshot (nodeCreated's rAF runs syncPromptConfig() before onConfigure's
// restoreFromInfo, clobbering the positionally-restored widget value this
// fallback relies on; mirrors styler's `_e2goPreLayoutConfig`).
function parseConfigSnapshot(node) {
    const snap = node._e2goPreLayoutConfig;
    const raw = snap != null ? snap : findWidget(node, CONFIG_WIDGET_NAME)?.value;
    try {
        const parsed = JSON.parse(raw || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Highest slot index with a non-empty, non-boolean-leaked text/negative value
// already sitting in the widgets from positional restore.
function highestNonEmptyTextSlot(node) {
    let max = 0;
    for (let i = 1; i <= MAX_SLOTS; i++) {
        const t = node.textWidgets[i]?.value;
        const n = node.negativeWidgets[i]?.value;
        const has =
            (typeof t === "string" && t.length) ||
            (typeof n === "string" && n.length);
        if (has) max = i;
    }
    return max;
}

function restoreFromInfo(node, info) {
    ensureBaseState(node);

    // Priority 1: name-keyed persistence written by onSerialize (present on
    // any save made after the name-keyed scheme shipped).
    const hasNameKeyed =
        Array.isArray(info?.promptSlotsData) || info?.promptTexts != null || info?.negativeTexts != null;

    let slotCount;
    let legacyConfig = null;

    if (hasNameKeyed) {
        slotCount = Math.max(1, Math.min(MAX_SLOTS, info?.promptSlotCount || 1));
    } else {
        // Fallback: pre-name-keyed save (or bare/API-style info). Derive slot
        // count from the parsed legacy config widget, else from the highest
        // populated text/negative widget left by positional restore.
        legacyConfig = parseConfigSnapshot(node);
        slotCount = Math.max(1, Math.min(MAX_SLOTS, legacyConfig.length || highestNonEmptyTextSlot(node) || 1));
    }
    node.promptSlotCount = slotCount;

    for (let i = 1; i <= slotCount; i++) ensurePromptSlot(node, i);

    const promptTexts = info?.promptTexts || {};
    const negativeTexts = info?.negativeTexts || {};
    const slotsData = info?.promptSlotsData || [];

    for (let i = 1; i <= slotCount; i++) {
        const textWidget = node.textWidgets[i];
        const negWidget = node.negativeWidgets[i];
        const enabledWidget = node.enabledWidgets[i];

        if (hasNameKeyed) {
            // Always set text value — prevents stale boolean leakage from widget reordering
            if (textWidget) textWidget.value = typeof promptTexts[i] === "string" ? promptTexts[i] : "";
            if (negWidget) negWidget.value = typeof negativeTexts[i] === "string" ? negativeTexts[i] : "";
            if (enabledWidget && slotsData[i - 1]) enabledWidget.value = slotsData[i - 1].enabled ?? true;
        } else {
            // Fallback: info has no name-keyed data — this is a save that never
            // went through this file's onSerialize (API-format workflow,
            // hand-authored graph) or a degraded/corrupt info blob. prompt_N_text/
            // negative_N_text are real INPUT_TYPES widgets, so positional restore
            // does place values into them — but reorderWidgets interleaves
            // decoration widgets, so any save this file produced is positionally
            // scrambled and already carries promptTexts/negativeTexts/
            // promptSlotsData, winning at priority 1 above. Only sanitise boolean
            // leakage here, never blank a recoverable value.
            for (const w of [textWidget, negWidget]) {
                if (!w) continue;
                if (typeof w.value !== "string") {
                    w.value = "";
                }
            }
            if (enabledWidget && legacyConfig[i - 1]) enabledWidget.value = legacyConfig[i - 1].on ?? true;
        }
    }

    applyVisibility(node);
    node._e2goPreLayoutConfig = undefined; // consumed; later calls read live state
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
                if (typeof textValue === "string" && textValue.length) {
                    promptTexts[i] = textValue;
                }
                if (typeof negValue === "string" && negValue.length) {
                    negativeTexts[i] = negValue;
                }
            }

            info.promptSlotCount = this.promptSlotCount;
            info.promptSlotsData = promptSlotsData;
            info.promptTexts = promptTexts;
            info.negativeTexts = negativeTexts;


            const findW = (name) => this.widgets?.find((w) => w.name === name);
            const order = ["prompt_config"];
            for (let i = 1; i <= MAX_SLOTS; i++) order.push(`prompt_${i}_text`);
            for (let i = 1; i <= MAX_SLOTS; i++) order.push(`negative_${i}_text`);
            info.widgets_values = order.map((name) => findW(name)?.value);
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            // Sanitise text widgets immediately — origOnConfigure may have
            // applied shifted widget values (boolean from toggle → text field)
            ensureBaseState(this);
            for (let i = 1; i <= MAX_SLOTS; i++) {
                for (const w of [this.textWidgets[i], this.negativeWidgets[i]]) {
                    if (w && typeof w.value === "boolean") {
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
                callback: () => removeLastSlot(this),
            });
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderPromptList") return;
        installTextResizing(node, name => /^(prompt|negative)_\d+_text$/.test(name));

        requestAnimationFrame(() => {
            ensureBaseState(node);

            // Snapshot before applyVisibility's syncPromptConfig overwrites
            // prompt_config with defaults — onConfigure's later restore reads
            // this when the save predates the name-keyed scheme.
            node._e2goPreLayoutConfig = findWidget(node, CONFIG_WIDGET_NAME)?.value;

            hideConfigPermanently(findWidget(node, CONFIG_WIDGET_NAME));

            const toggleAll = node.addWidget("toggle", "Toggle All", true, (value) => {
                for (let i = 1; i <= node.promptSlotCount; i++) {
                    if (node.enabledWidgets[i]) node.enabledWidgets[i].value = value;
                }
                syncPromptConfig(node);
            });
            toggleAll.name = "toggle_all";
            styleBoolToggle(node, "toggle_all"); // post-hook creation, see above
            toggleAll.serialize = false; // documentation of intent — platform ignores this on save

            const addBtn = node.addWidget("button", null, null, () => {
                if (node.promptSlotCount >= MAX_SLOTS) return;
                node.promptSlotCount += 1;
                ensurePromptSlot(node, node.promptSlotCount);
                applyVisibility(node);
            });
            addBtn.name = "+ Add Prompt";
            addBtn.serialize = false; // documentation of intent — platform ignores this on save

            const removeBtn = node.addWidget("button", null, null, () => removeLastSlot(node));
            removeBtn.name = "- Remove Prompt";
            removeBtn.serialize = false; // documentation of intent — platform ignores this on save

            // Sanitise any text widgets that may have received boolean values
            for (let i = 1; i <= MAX_SLOTS; i++) {
                for (const w of [node.textWidgets[i], node.negativeWidgets[i]]) {
                    if (w && typeof w.value === "boolean") {
                        w.value = "";
                    }
                }
            }

            ensurePromptSlot(node, 1);
            applyVisibility(node);
        });
    },
});
