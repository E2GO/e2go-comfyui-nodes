import { app } from "../../../scripts/app.js";
// api.fetchApi, not bare fetch: it prefixes the frontend's api_base, so the
// trigger fetch still resolves when ComfyUI is served under a sub-path (reverse
// proxy). Every custom route is mirrored under /api by server.py's add_routes.
import { api } from "../../../scripts/api.js";
import { trackWidgetDraw, widgetPointerX, redrawNodeWidgets, noop, hideNamedWidget, scheduleReHide, widgetTextColor, widgetSecondaryTextColor, widgetDisabledTextColor, widgetFont, setWidgetVisible } from "./e2go_hide_utils.js";
import { openLoraModal, getLoraLibrary, invalidateTriggerTooltip } from "./powder_lora_modal.js";

import { TOGGLE_ROW_HEIGHT, drawToggleButton } from "./e2go_hide_utils.js";
const CONFIG_WIDGET_NAME = "lora_config";
const sharedTriggers = new Map();
const triggerRevisions = new Map();
const triggerSaves = new Map();
function triggerKey(name) { return name.replaceAll("\\", "/"); }
function applySharedTrigger(node, name, value) {
    for (const entry of node.selectedLoras || []) {
        if (triggerKey(entry.lora) === triggerKey(name)) { entry.trigger = value; entry.manualTrigger = true; }
    }
    syncConfig(node);
}
function publishSharedTrigger(graph, name, value, seen = new Set()) {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes || []) {
        if (node.comfyClass === "PowderLoraLoader") applySharedTrigger(node, name, value);
        if (node.subgraph) publishSharedTrigger(node.subgraph, name, value, seen);
    }
}

function requestResize(node) {
    const graphRef = app.graph;
    requestAnimationFrame(() => {
        if (app.graph !== graphRef) return;
        try {
            node.setSize([node.size?.[0] || 340, node.computeSize()[1]]);
        } catch {}
        redrawNodeWidgets(node);
    });
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function ensureState(node) {
    node.selectedLoras ||= [];
    node.loraRowWidgets ||= [];
}

// selectedLoras entry fields stay JS-shaped (lora/enabled/modelStr/clipStr/
// trigger/useTrigger). syncConfig maps them to the Python names the backend's
// config parser reads (powder_lora.py: name/on/strength_model/strength_clip/
// trigger/use_trigger).
function syncConfig(node) {
    const cfg = findWidget(node, CONFIG_WIDGET_NAME);
    if (cfg) {
        cfg.value = JSON.stringify(
            (node.selectedLoras || []).map((e) => ({
                name: e.lora || "None",
                on: e.enabled ?? true,
                strength_model: Number.isFinite(e.modelStr) ? e.modelStr : 1.0,
                strength_clip: Number.isFinite(e.clipStr) ? e.clipStr : 1.0,
                trigger: e.trigger || "",
                use_trigger: e.useTrigger ?? true,
            }))
        );
    }
    updateButtonLabel(node);
    redrawNodeWidgets(node);
}

function updateButtonLabel(node) {
    if (!node._lorasButton) return;
    const n = (node.selectedLoras || []).length;
    node._lorasButton.name = node._lorasOffline
        ? "LoRAs (offline)"
        : `\u{1F300} LoRAs… (${n})`;
}

// --- selected-lora rows (interactive: enabled / M / C / T / remove) ----------

let _libraryNames = null; // Set<string> of known lora names, for "missing" render
function setLibraryNames(names) { _libraryNames = names; }

function fmtStr(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "1";
    // Two-decimal round, trailing zeros trimmed ("1", "0.85", "-1.5").
    return String(Number(n.toFixed(2)));
}

function removeRowWidgets(node) {
    for (const w of node.loraRowWidgets || []) {
        const at = node.widgets.indexOf(w);
        if (at >= 0) node.widgets.splice(at, 1);
    }
    node.loraRowWidgets = [];
}

function rowZones(width) {
    const strengthWidth = Math.min(80, Math.max(58, (width - 140) / 2));
    // Right-aligned hit zones: [S] [C] [T] [+] [✕]; name fills the middle.
    return {
        toggle: [0, 38],
        model: [width - 72 - 2 * strengthWidth, width - 72 - strengthWidth],
        clip: [width - 72 - strengthWidth, width - 72],
        trigger: [width - 72, width - 48],
        duplicate: [width - 48, width - 24],
        remove: [width - 24, width],
    };
}

function strengthHit(node, item, field, label, zone, x, event) {
    const direction = x < zone[0] + 15 ? -1 : x >= zone[1] - 15 ? 1 : 0;
    if (!direction) return editStrength(node, item, field, label, event);
    const step = event?.shiftKey ? 0.01 : 0.05;
    item[field] = Math.max(-10, Math.min(10, Math.round((item[field] + direction * step) * 100) / 100));
    syncConfig(node);
}
function drawStrength(ctx, zone, y, value, disabled) {
    ctx.save();
    ctx.fillStyle = disabled ? widgetSecondaryTextColor() : widgetTextColor();
    ctx.textAlign = "center";
    if (!disabled) {
        ctx.fillText("\u25c0", zone[0] + 8, y + 15);
        ctx.fillText("\u25b6", zone[1] - 8, y + 15);
    }
    ctx.fillText(disabled ? "--" : fmtStr(value), (zone[0] + zone[1]) / 2, y + 15);
    ctx.restore();
}

// Opens the native LiteGraph canvas prompt for a strength value. The frontend
// bundle defines LGraphCanvas.prototype.prompt(title, value, callback, event,
// multiline) (verified in api-*.js: `n.prompt("Value", this.value, cb, e)`).
// window.prompt is intentionally NOT used.
function editStrength(node, item, field, label, event) {
    const canvas = app.canvas;
    const cb = (val) => {

        const n = Number(String(val).trim().replace(",", "."));
        if (!Number.isFinite(n)) return; // reject → keep old value
        // Check row identity at COMMIT time: duplicate names are valid, and a row may be removed
        // (✕, modal toggle-off, workflow reload) while the dialog was open —
        // mutating the stale closure object would silently drop the edit.
        const live = node.selectedLoras?.includes(item) ? item : null;
        if (!live) {
            console.info("[PowderLora] row removed while dialog was open — edit dropped");
            return;
        }
        live[field] = Math.max(-10, Math.min(10, n));
        syncConfig(node);
        redrawNodeWidgets(node);
    };
    if (canvas?.prompt) {
        canvas.prompt(label, item[field], cb, event ?? null);
    }
}

// Basename for the trigger-dialog title: text after the last path separator
// (loras may be stored/selected with subfolder prefixes, e.g. "sdxl/foo.safetensors").
function loraBasename(name) {
    const s = String(name || "");
    const at = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return at >= 0 ? s.slice(at + 1) : s;
}

// Opens the canvas prompt (multiline=true — verified supported: the bundle's
// prompt() renders a <textarea> when the 5th arg is truthy, and Escape closes
// without invoking the callback, so cancel is a true no-op) to edit a lora's
// trigger words. `bindUseTrigger` is set when this dialog was opened from the
// T zone turning ON with an empty trigger: on save, useTrigger follows whether
// the saved text is non-empty; plain name-zone edits never touch useTrigger.
function editTrigger(node, item, event, bindUseTrigger) {
    const canvas = app.canvas;
    const title = `Trigger words — ${loraBasename(item.lora)}`;
    const cb = async (val) => {
        const trimmed = String(val ?? "").trim();
        if (!node.selectedLoras?.includes(item)) return;
        const key = triggerKey(item.lora);
        const revision = (triggerRevisions.get(key) || 0) + 1;
        triggerRevisions.set(key, revision);
        const previous = triggerSaves.get(key) || Promise.resolve();
        const save = previous.catch(() => {}).then(async () => {
            const response = await api.fetchApi("/powder_lora/set_trigger", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lora: item.lora, trigger: trimmed }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
        triggerSaves.set(key, save);
        try {
            await save;
            if (triggerRevisions.get(key) !== revision) return;
            sharedTriggers.set(key, trimmed);
            invalidateTriggerTooltip(item.lora);
            publishSharedTrigger(app.graph, item.lora, trimmed);
            applySharedTrigger(node, item.lora, trimmed);
            if (bindUseTrigger && node.selectedLoras?.includes(item)) item.useTrigger = !!trimmed;
            syncConfig(node);
        } catch (error) {
            window.alert(`Trigger was not saved for all workflows. Restart ComfyUI if it was just updated, then try again. (${error.message})`);
        } finally {
            if (triggerSaves.get(key) === save) triggerSaves.delete(key);
        }
    };
    if (canvas?.prompt) {
        canvas.prompt(title, item.trigger || "", cb, event ?? null, true);
    }
}

// Shared hit-zone dispatch for both onPointerDown and the w.mouse fallback.
// `x` is node-local (0..width), matching what litegraph passes to w.mouse.
function rowHit(node, index, x, event) {
    const item = node.selectedLoras[index];
    if (!item) return false;
    const width = node.loraRowWidgets?.[index]?._e2goDrawWidth || node.size?.[0] || 300;
    const z = rowZones(width);
    const clipDisabled = !!findWidget(node, "disable_clip")?.value;

    if (x >= z.remove[0]) {
        node.selectedLoras.splice(index, 1);
        applyLayout(node); // rebuilds rows with fresh indices
    } else if (x >= z.duplicate[0]) {
        const copy = { ...item };
        node.selectedLoras.splice(index + 1, 0, copy);
        applyLayout(node);
        if (!copy.trigger && !copy.manualTrigger) node._e2goFetchTrigger?.(copy);
    } else if (x >= z.trigger[0]) {
        if (!item.trigger) {
            // Turning ON with no trigger text yet — open the edit dialog instead
            // of silently enabling an empty trigger; save binds useTrigger to
            // whether the saved text is non-empty.
            editTrigger(node, item, event, true);
            return true; // no dirty/syncConfig here — dialog is async, cb handles it
        }
        item.useTrigger = !item.useTrigger;
        syncConfig(node);
    } else if (x >= z.clip[0]) {
        if (clipDisabled) return true; // clip strength ignored by backend
        strengthHit(node, item, "clipStr", "Clip strength", z.clip, x, event);
    } else if (x >= z.model[0]) {
        strengthHit(node, item, "modelStr", "Model strength", z.model, x, event);
    } else if (x < z.toggle[1]) {
        item.enabled = !item.enabled;
        syncConfig(node);
    } else {
        editTrigger(node, item, event, false);
        return true;
    }
    app.graph?.setDirtyCanvas(true, true);
    return true;
}

function makeRowWidget(node, index, existing) {
    const w = existing || node.addWidget("text", `lora_row_${index}`, "", noop);
    if (existing) node.widgets.push(w);
    w.serialize = false;
    w.tooltip = "Check/arrow: enable LoRA; name: edit trigger words; S: model strength; C: CLIP strength; T: use trigger; +: duplicate; x: remove";
    w.tooltip = `${node.selectedLoras[index]?.lora || "LoRA"}\n${w.tooltip}`;
    // Non-registered custom type: makes toConcreteWidget return undefined so
    // the w.mouse fallback fires on frontends that route text clicks through
    // processWidgetClick; onPointerDown short-circuits the conversion directly.
    // draw() is still called by drawWidgets regardless of type. (Same trick as
    // powder_styler.js rows.)
    w.type = "e2go_lora_row";
    w.computeSize = () => [Math.max(node.size?.[0] || 300, 300), TOGGLE_ROW_HEIGHT];

    w.draw = function (ctx, _n, width, posY) {
        trackWidgetDraw(this, ctx, _n, width, posY);
        posY += (TOGGLE_ROW_HEIGHT - 22) / 2;
        w._e2goDrawWidth = width;
        const item = node.selectedLoras[index];
        if (!item) return;
        const missing = _libraryNames && !_libraryNames.has(item.lora);
        const clipDisabled = !!findWidget(node, "disable_clip")?.value;
        const z = rowZones(width);
        ctx.font = widgetFont(12);

        drawToggleButton(ctx, 6, posY - 3, 30, 28, item.enabled);
        ctx.save();
        ctx.fillStyle = "#292c30";
        ctx.strokeStyle = "#535960";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(40, posY - 3, Math.max(0, z.model[0] - 48), 28, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = widgetSecondaryTextColor();
        ctx.fillText("✎", z.model[0] - 26, posY + 15);
        ctx.restore();

        // Name (truncated), red when the file is gone.
        const label = missing ? `${item.lora} (missing)` : item.lora;
        ctx.fillStyle = missing ? "#c06a6a" : item.enabled ? widgetTextColor() : widgetSecondaryTextColor();

        const maxW = Math.max(0, z.model[0] - 84);
        let text = label;
        while (text.length && ctx.measureText(text + (text !== label ? "…" : "")).width > maxW) {
            text = text.slice(0, -1);
        }
        if (text && text !== label) text += "…";
        ctx.fillText(text, 48, posY + 15);

        drawStrength(ctx, z.model, posY, item.modelStr, false);
        drawStrength(ctx, z.clip, posY, item.clipStr, clipDisabled);

        // T (use-trigger) — three states: bright green when on with trigger text,
        // dim green when on but trigger is empty (armed but nothing to send),
        // theme-disabled when off. Green hue is semantic (on-state).
        ctx.fillStyle = item.useTrigger
            ? (item.trigger ? "#8fd18f" : "#5c8f5c") // semantic: trigger on / armed-empty
            : widgetDisabledTextColor();
        ctx.fillText(!item.trigger ? "T?" : item.useTrigger ? "T+" : "T-", z.trigger[0] + 2, posY + 15);
        w.tooltip = `${item.lora}\nLoRA: ${item.enabled ? "enabled" : "disabled"}. CLIP: ${clipDisabled ? "bypassed" : fmtStr(item.clipStr)}.\nTrigger: ${item.trigger || "not set"} (${item.useTrigger ? "enabled" : "disabled"}).\nCheck/arrow: enable LoRA. Name/pencil: edit trigger words. T?: add trigger. T+/T-: toggle trigger. Weight arrows: +/-0.05 (Shift: 0.01). Click value: enter weight. +: duplicate. x: remove.`;
        ctx.fillStyle = widgetTextColor();
        ctx.fillText("+", z.duplicate[0] + 6, posY + 15);

        // ✕ remove
        ctx.fillStyle = widgetSecondaryTextColor();
        ctx.fillText("✕", z.remove[0] + 4, posY + 15);
    };

    // Preferred path on modern frontends: a truthy return short-circuits the
    // TextWidget conversion. Args are (pointer, node, canvas); derive node-local
    // x from canvas.graph_mouse exactly like the w.mouse else-branch.
    w.onPointerDown = function (pointer, _n, canvas) {
        const x = widgetPointerX(pointer, node, canvas, w);
        return rowHit(node, index, x, pointer?.eDown ?? pointer?.event ?? null);
    };

    // Fallback for frontends that reach w.mouse (pos is node-local).
    w.mouse = function (event, pos, _node) {
        if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
        return rowHit(node, index, pos[0], event);
    };

    return w;
}

// Non-interactive header row drawn above the lora rows: captions "model" /
// "clip" / "trig" centered over the same rowZones() the rows use, so the
// legend stays aligned across resizes. serialize:false + disabled, matching
// the other drawn-only decorations in this file (button/config widgets).
function makeLegendWidget(node) {
    const w = node.addWidget("text", "lora_legend", "", noop);
    w.serialize = false;
    w.disabled = true;
    w.type = "e2go_lora_legend";
    w.computeSize = () => [Math.max(node.size?.[0] || 300, 300), 20];

    w.draw = function (ctx, _n, width, posY) {
        trackWidgetDraw(this, ctx, _n, width, posY);
        const clipDisabled = !!findWidget(node, "disable_clip")?.value;
        const z = rowZones(width);
        // Match native widget labels exactly: NODE_FONT size 12 + secondary
        // color. The earlier illegibility was the 11px Arial metric, not the
        // hue; native labels at this size/color read fine.
        ctx.font = widgetFont(12);
        ctx.textAlign = "center";

        const modelCenter = (z.model[0] + z.model[1]) / 2;
        const clipCenter = (z.clip[0] + z.clip[1]) / 2;
        const trigCenter = (z.trigger[0] + z.trigger[1]) / 2;

        // Primary text color: match native widget labels (~#DDD), which is what
        // the user's native pill labels render at. Live-browser check showed
        // secondary (#999) read noticeably dimmer than native labels here.
        ctx.fillStyle = widgetTextColor();
        ctx.fillText("model", modelCenter, posY + 13);
        // Dimmed for disable_clip: secondary (#999) — visibly dimmer than the
        // active captions but still readable (disabled #666 was too dark here).
        ctx.fillStyle = clipDisabled ? widgetSecondaryTextColor() : widgetTextColor();
        ctx.fillText("clip", clipCenter, posY + 13);
        ctx.fillStyle = widgetTextColor();
        ctx.fillText("trig", trigCenter, posY + 13);

        ctx.textAlign = "left"; // restore default alignment for subsequent widgets
    };

    return w;
}

function rebuildRows(node) {
    const previous = [...(node.loraRowWidgets || [])];
    removeRowWidgets(node);
    for (let i = 0; i < (node.selectedLoras || []).length; i++) {
        node.loraRowWidgets.push(makeRowWidget(node, i, previous[i]));
    }

    const hasRows = (node.selectedLoras || []).length > 0;
    if (hasRows && !node._loraLegendWidget) {
        node._loraLegendWidget = makeLegendWidget(node);
    } else if (!hasRows && node._loraLegendWidget) {
        const at = node.widgets.indexOf(node._loraLegendWidget);
        if (at >= 0) node.widgets.splice(at, 1);
        node._loraLegendWidget = null;
    }
}

// --- layout ------------------------------------------------------------------

function reorderWidgets(node) {
    const ordered = [];
    // MUST match INPUT_TYPES order — widgets_values is position-based. The
    // optional prompt/negative_prompt are forceInput sockets (not widgets), so
    // they are absent here by design.
    for (const name of ["mode", "combination_order", CONFIG_WIDGET_NAME, "disable_clip", "trigger_position"]) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }
    if (node._lorasButton) ordered.push(node._lorasButton);
    if (node._loraLegendWidget) ordered.push(node._loraLegendWidget);
    for (const w of node.loraRowWidgets || []) ordered.push(w);

    const remaining = (node.widgets || []).filter((w) => !ordered.includes(w));
    node.widgets = [...ordered, ...remaining];
}

function applyLayout(node) {
    setWidgetVisible(findWidget(node, "combination_order"), String(findWidget(node, "mode")?.value).startsWith("Single"));
    hideNamedWidget(node, CONFIG_WIDGET_NAME);
    rebuildRows(node);
    reorderWidgets(node);
    syncConfig(node);
    requestResize(node);
}

// --- restore -----------------------------------------------------------------

function normalizeEntry(x) {
    return {
        lora: typeof x.lora === "string" && x.lora ? x.lora : "None",
        enabled: x.enabled ?? true,
        modelStr: Number.isFinite(x.modelStr) ? x.modelStr : 1.0,
        clipStr: Number.isFinite(x.clipStr) ? x.clipStr : 1.0,
        trigger: typeof x.trigger === "string" ? x.trigger : "",
        useTrigger: x.useTrigger ?? true,
    };
}

// Priority 1 (new) and 2 (old slot format) share the JS field names; both are
// filtered of empty "None" placeholders and normalized.
function selectionFromJsShape(arr) {
    return (arr || [])
        .filter((x) => x && typeof x === "object" && x.lora && x.lora !== "None")
        .map(normalizeEntry);
}

// A3 fallback tier — parse the `lora_config` JSON (Python field names) into JS
// entries. Preserves parseConfigSnapshot/legacyEntryToSlotData semantics from
// the previous slot-based file, now feeding the flat selection list.
function legacyEntryToJsShape(item) {
    return {
        lora: typeof item.name === "string" && item.name ? item.name : "None",
        enabled: item.on ?? true,
        modelStr: Number.isFinite(item.strength_model) ? item.strength_model : 1.0,
        clipStr: Number.isFinite(item.strength_clip) ? item.strength_clip : 1.0,
        trigger: typeof item.trigger === "string" ? item.trigger : "",
        useTrigger: item.use_trigger ?? true,
    };
}

function selectionFromConfigSnapshot(node) {
    // Prefer the pre-layout snapshot: nodeCreated's rAF runs applyLayout()/
    // syncConfig() before onConfigure's restore, clobbering the positionally-
    // restored widget value this fallback relies on.
    const snap = node._e2goPreLayoutConfig;
    const raw = snap != null ? snap : findWidget(node, CONFIG_WIDGET_NAME)?.value;
    let parsed;
    try {
        parsed = JSON.parse(raw || "[]");
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter((x) => x && typeof x === "object")
        .map(legacyEntryToJsShape)
        .filter((e) => e.lora && e.lora !== "None");
}

function restoreFromInfo(node, info) {
    ensureState(node);

    if (Array.isArray(info?.e2goLoraSelection)) {
        node.selectedLoras = selectionFromJsShape(info.e2goLoraSelection);
    } else if (Array.isArray(info?.loraSlotsData)) {
        node.selectedLoras = selectionFromJsShape(info.loraSlotsData);
    } else {
        node.selectedLoras = selectionFromConfigSnapshot(node);
    }

    for (const entry of node.selectedLoras) {
        const key = triggerKey(entry.lora);
        if (sharedTriggers.has(key)) entry.trigger = sharedTriggers.get(key);
        node._e2goFetchTrigger?.(entry);
    }
    applyLayout(node);
    scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
    node._e2goPreLayoutConfig = undefined; // consumed; later calls read live state
}

// --- lora library ------------------------------------------------------------

async function populateLoraLibrary(node) {
    try {
        const lib = await getLoraLibrary();
        const names = (lib.loras || []).map((l) => l.name);
        setLibraryNames(new Set(names));
        node._lorasOffline = false;
        updateButtonLabel(node);
        redrawNodeWidgets(node);
    } catch (err) {
        console.warn("[PowderLora] Failed to load lora list:", err);
        node._lorasOffline = true;
        updateButtonLabel(node);
    }
}

// --- extension ---------------------------------------------------------------

app.registerExtension({
    name: "e2go_nodes.PowderLoraLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowderLoraLoader") return;

        const origMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const result = origMenu?.apply(this, arguments);
            if (this.selectedLoras?.length) {
                options.push({
                    content: "Edit LoRA trigger words",
                    submenu: { options: this.selectedLoras.map(item => ({
                        content: item.lora,
                        callback: () => editTrigger(this, item, null, false),
                    })) },
                });
                options.push({
                    content: "Only this LoRA",
                    submenu: { options: this.selectedLoras.map(item => ({
                        content: item.lora,
                        callback: () => {
                            if (!this.selectedLoras.includes(item)) return;
                            for (const entry of this.selectedLoras) entry.enabled = entry === item;
                            syncConfig(this);
                            app.graph?.setDirtyCanvas(true, true);
                        },
                    })) },
                });
            }
            return result;
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            ensureState(this);
            syncConfig(this);
            origOnSerialize?.apply(this, arguments);

            // Name-keyed persistence: widgets_values is position-based and this
            // ComfyUI serializes every widget by index (serialize:false ignored),
            // so the row/button decorations scramble positional restore. Deep-copy
            // the JS-shaped entries. NOT installNameKeyedPersistence
            // (e2go_persistence.js): this node persists a selection ARRAY, not
            // widget values — there is no name-keyed widget map to share.
            info.e2goLoraSelection = (this.selectedLoras || []).map((x) => ({ ...x }));
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            hideNamedWidget(this, CONFIG_WIDGET_NAME);
            requestAnimationFrame(() => restoreFromInfo(this, info));
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderLoraLoader") return;
        const mode = findWidget(node, "mode");
        if (mode) {
            const callback = mode.callback;
            mode.callback = function () { callback?.apply(this, arguments); applyLayout(node); };
        }

        hideNamedWidget(node, CONFIG_WIDGET_NAME);

        // SYNCHRONOUS wrap (see powder_resolution.js:162): the frontend
        // captures widget callbacks right after nodeCreated — a rAF-attached
        // wrapper is never invoked, so toggling disable_clip didn't re-dim
        // the C column until some other redraw happened.
        {
            const disableClip = findWidget(node, "disable_clip");
            if (disableClip) {
                const original = disableClip.callback;
                disableClip.callback = function (value, canvas, n, pos, event) {
                    const result = original?.call(this, value, canvas, n, pos, event);
                    redrawNodeWidgets(node);
                    return result;
                };
            }
        }

        requestAnimationFrame(() => {
            // Snapshot before applyLayout()'s syncConfig() overwrites lora_config
            // with the current (empty) selection — restoreFromInfo's fallback tier
            // reads this when info has no name-keyed selection.
            node._e2goPreLayoutConfig = findWidget(node, CONFIG_WIDGET_NAME)?.value;

            ensureState(node);
            hideNamedWidget(node, CONFIG_WIDGET_NAME);

            const btn = node.addWidget("button", "\u{1F300} LoRAs… (0)", null, () => {
                if (node._lorasOffline) return;
                openLoraModal(node);
            });
            btn.serialize = false;
            node._lorasButton = btn;

            // Hooks the modal (powder_lora_modal.js) calls on add/close.
            node._e2goApplyLayout = () => applyLayout(node);

            node._e2goLibraryRefreshed = () => { populateLoraLibrary(node); };
            node._e2goFetchTrigger = (entry) => {
                const name = entry?.lora;
                if (!name || name === "None") return;
                const key = triggerKey(name), revision = triggerRevisions.get(key) || 0;
                const pending = triggerSaves.get(key);
                if (pending) { pending.then(() => node._e2goFetchTrigger?.(entry), () => {}); return; }
                return api.fetchApi(`/powder_lora/get_trigger?lora=${encodeURIComponent(name)}`)
                    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                    .then((data) => {
                        if (node.selectedLoras?.includes(entry) && (triggerRevisions.get(key) || 0) === revision
                            && (data?.exists || (data?.trigger && !entry.trigger && !entry.manualTrigger))) {
                            entry.trigger = data.trigger || "";
                            if (data.exists) sharedTriggers.set(key, entry.trigger);
                            syncConfig(node);
                            redrawNodeWidgets(node);
                        }
                    })
                    .catch((err) => console.warn("[PowderLora] Failed to fetch trigger:", err));
            };

            applyLayout(node);
            populateLoraLibrary(node);
            scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
        });
    },
});
