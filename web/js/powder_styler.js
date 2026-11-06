import { cursorScope, installCursorControls } from "./e2go_cursor_ui.js";
import { app } from "../../../scripts/app.js";
import { TOGGLE_ROW_HEIGHT, drawToggleButton } from "./e2go_hide_utils.js";
import { api } from "../../../scripts/api.js";
import { widgetPointerX, redrawNodeWidgets, noop, hideNamedWidget, scheduleReHide, styleBoolToggle, widgetTextColor, widgetSecondaryTextColor, widgetDisabledTextColor, widgetFont, markSeparator, setWidgetVisible } from "./e2go_hide_utils.js";
import { installNameKeyedPersistence } from "./e2go_persistence.js";
import { getStyleLibrary, openStyleModal, openStylePicker } from "./powder_styler_modal.js";

const CONFIG_WIDGET_NAME = "style_config";

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
    node.selectedStyles ||= [];
    node.styleRowWidgets ||= [];
}

function syncConfig(node) {
    const cfg = findWidget(node, CONFIG_WIDGET_NAME);
    if (cfg) cfg.value = JSON.stringify(node.selectedStyles || []);
    (node.styleRowWidgets || []).forEach((w, i) => {
        w.tooltip = node.selectedStyles?.[i]?.name || "Style";
    });
    updateButtonLabel(node);
    redrawNodeWidgets(node);
}

function updateButtonLabel(node) {
    if (!node._stylesButton) return;
    const n = (node.selectedStyles || []).length;
    node._stylesButton.name = node._stylesOffline
        ? "Styles (offline)"
        : `\u{1F3A8} Styles… (${n})`;
}

// --- selected-style rows (interactive: hit zones for toggle/P/N/remove) -----

let _libraryNames = null; // Set<string> of known style names, filled by Task 5's library load
let _libraryNumbers = null; // Map<name, 1-based global alphabetical index> — UI-only numbering
function setLibraryNames(names, numbers) {
    _libraryNames = names;
    _libraryNumbers = numbers || null;
}

function removeRowWidgets(node) {
    for (const w of node.styleRowWidgets || []) {
        const at = node.widgets.indexOf(w);
        if (at >= 0) node.widgets.splice(at, 1);
    }
    node.styleRowWidgets = [];
}

function rowZones(width) {

    return {
        toggle: [0, 38],
        prev: [40, 58],
        next: [width - 136, width - 120],
        str: [width - 118, width - 76],
        pos: [width - 74, width - 52],
        neg: [width - 52, width - 30],
        remove: [width - 26, width],
    };
}

// Cycle through the selected category (or the full library), wrapping at the ends.
function cycleStyle(node, item, dir) {
    const names = node._sweepNames;
    if (!names?.length) return;

    const taken = new Set((node.selectedStyles || [])
        .filter((s) => s !== item)
        .map((s) => s.name));
    const at = names.indexOf(item.name);
    let next = at < 0
        ? (dir > 0 ? 0 : names.length - 1)
        : (at + dir + names.length) % names.length;
    for (let hops = 0; hops < names.length && taken.has(names[next]); hops++) {
        next = (next + dir + names.length) % names.length;
    }
    if (taken.has(names[next])) return; // every name taken — leave as is
    item.name = names[next];
    syncConfig(node);
}


function rowStrengthActive(node) {
    return findWidget(node, "strength_mode")?.value === "cond mix — per style";
}

// Same native canvas.prompt pattern as powder_lora.js's editStrength; the
// row may die while the dialog is open — re-check before committing.
function editStyleStrength(node, item, event) {
    const canvas = app.canvas;
    if (!canvas?.prompt) return;
    canvas.prompt("Style strength (blend weight, 0..1.5; 1.0 = full style)",
        Number.isFinite(item.strength) ? item.strength : 1.0, (val) => {

            const n = Number(String(val).trim().replace(",", "."));
            if (!Number.isFinite(n)) return; // reject → keep old value
            if (!node.selectedStyles?.includes(item)) {
                console.info("[PowderStyler] row removed while dialog was open — edit dropped");
                return;
            }

            item.strength = Math.max(0, Math.min(1.5, Math.round(n * 100) / 100));
            syncConfig(node);
            redrawNodeWidgets(node);
        }, event ?? null);
}

// Shared hit-zone dispatch for both onPointerDown and the w.mouse fallback.
// `x` is node-local (0..width), matching what litegraph passes to w.mouse.
function rowHit(node, index, x, event = null) {
    const item = node.selectedStyles[index];
    if (!item) return false;
    const width = node.styleRowWidgets?.[index]?._e2goDrawWidth || node.size?.[0] || 300;
    const z = rowZones(width);
    const within = ([a, b]) => x >= a && x < b;

    if (within(z.remove)) {
        node.selectedStyles.splice(index, 1);
        applyLayout(node); // rebuilds rows with fresh indices
    } else if (within(z.neg)) {
        item.use_negative = !item.use_negative;
        syncConfig(node);
    } else if (within(z.pos)) {
        item.use_positive = !item.use_positive;
        syncConfig(node);
    } else if (within(z.str)) {
        // ×w is a PER-STYLE blend weight — inert in node mode (one style_mix
        // for the whole set), so the editor only opens where it matters. The
        // click is still consumed: falling through would toggle the row.
        if (rowStrengthActive(node)) editStyleStrength(node, item, event);
    } else if (within(z.next)) {
        cycleStyle(node, item, +1);
    } else if (within(z.prev)) {
        cycleStyle(node, item, -1);
    } else if (within(z.toggle)) {
        item.on = !item.on;
        syncConfig(node);
    } else if (x >= z.prev[1] && x < z.next[0]) {
        openStylePicker(node, {
            current: item.name,
            title: "Choose style",
            category: findWidget(node, "style_category")?.value,
            onPick: (name) => {
                if (!node.selectedStyles?.includes(item)) return;
                if (node.selectedStyles.some(other => other !== item && other.name === name)) return;
                item.name = name;
                syncConfig(node);
            },
        });
    }
    app.graph?.setDirtyCanvas(true, true);
    return true;
}

function makeRowWidget(node, index, existing) {
    const w = existing || node.addWidget("text", `style_row_${index}`, "", noop);
    if (existing) node.widgets.push(w);
    w.tooltip = node.selectedStyles[index]?.name || "Style";
    w.serialize = false;
    // Frontend 1.45.x routes "text" widget clicks through processWidgetClick,
    // which converts them to a concrete TextWidget (opening an inline editor) and
    // never reaches w.mouse. A non-registered custom type makes
    // toConcreteWidget(w, node, false) return undefined so the w.mouse fallback
    // fires; onPointerDown (below) short-circuits the conversion directly. The
    // custom draw() is still called by drawWidgets regardless of type.
    w.type = "e2go_style_row";
    w.computeSize = () => [Math.max(node.size?.[0] || 300, 300), TOGGLE_ROW_HEIGHT];

    w.draw = function (ctx, _n, width, posY) {
        posY += (TOGGLE_ROW_HEIGHT - 22) / 2;
        w._e2goDrawWidth = width;
        const item = node.selectedStyles[index];
        if (!item) return;
        const missing = _libraryNames && !_libraryNames.has(item.name);
        const z = rowZones(width);

        ctx.font = widgetFont(12);
        drawToggleButton(ctx, 6, posY - 3, 30, 28, item.on);
        ctx.save();
        ctx.fillStyle = "#292c30";
        ctx.strokeStyle = "#535960";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(40, posY - 3, Math.max(0, z.next[1] - 40), 28, 6);
        ctx.fill(); ctx.stroke(); ctx.restore();

        ctx.fillStyle = widgetSecondaryTextColor();
        ctx.fillText("◄", z.prev[0] + 3, posY + 15);
        ctx.fillText("►", z.next[0] + 3, posY + 15);

        // Name — off rows use secondary (#999, readable) rather than disabled
        // (#666, too dark here); missing files render red.
        ctx.fillStyle = missing
            ? "#c06a6a"
            : item.on ? widgetTextColor() : widgetSecondaryTextColor();
        const num = _libraryNumbers?.get(item.name);
        const namePart = num != null ? `#${num} ${item.name}` : item.name;
        const label = missing ? `${namePart} (missing)` : namePart;
        const maxW = Math.max(0, z.next[0] - 68);
        let text = label;
        while (text.length > 4 && ctx.measureText(text).width > maxW) {
            text = text.slice(0, -2);
        }
        if (text !== label) text += "…";
        ctx.fillText(text, 62, posY + 15);

        // Strength ×w — dimmed at the neutral 1.0, accented when it will
        // actually wrap the positive parts in (text:w).
        if (rowStrengthActive(node)) {
            const sVal = Number.isFinite(item.strength) ? item.strength : 1.0;
            const neutral = Math.abs(sVal - 1.0) < 0.001;
            ctx.fillStyle = neutral ? widgetDisabledTextColor() : "#d1c08f"; // semantic: weighting active
            ctx.fillText(`×${(Math.round(sVal * 100) / 100).toString()}`, z.str[0] + 3, posY + 15);
        }

        // P / N — semantic hue markers (green = positive on, red = negative on);
        // off-state falls back to the theme disabled color.
        const positiveActive = item.on && item.use_positive && findWidget(node, "use_positive")?.value !== false;
        const negativeActive = item.on && item.use_negative && findWidget(node, "use_negative")?.value !== false;
        ctx.fillStyle = positiveActive ? "#8fd18f" : widgetDisabledTextColor(); // semantic: positive on
        ctx.fillText(item.use_positive ? "P+" : "P-", z.pos[0] + 2, posY + 15);
        ctx.fillStyle = negativeActive ? "#d18f8f" : widgetDisabledTextColor(); // semantic: negative on
        ctx.fillText(item.use_negative ? "N+" : "N-", z.neg[0] + 2, posY + 15);
        w.tooltip = `${item.name}\nStyle: ${item.on ? "enabled" : "disabled"}. Positive: ${positiveActive ? "active" : "inactive"}. Negative: ${negativeActive ? "active" : "inactive"}.\nCheck: enable/disable style. Name: choose style. Arrows: previous/next style. P/N: local positive/negative switches; global switches above also apply. Weight: editable in per-style mode. x: remove.`;
        ctx.fillStyle = widgetSecondaryTextColor();
        ctx.fillText("✕", z.remove[0] + 6, posY + 15);
    };

    // Preferred path on 1.45.x: a truthy return short-circuits the TextWidget
    // conversion in processWidgetClick. Args are (pointer, node, canvas); derive
    // node-local x from canvas.graph_mouse exactly like the else-branch feeds w.mouse.
    w.onPointerDown = function (pointer, _n, canvas) {
        const x = widgetPointerX(pointer, node, canvas, w);
        return rowHit(node, index, x);
    };

    // Fallback for frontend versions that reach w.mouse (pos is node-local).
    w.mouse = function (event, pos, _node) {
        if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
        return rowHit(node, index, pos[0], event);
    };

    return w;
}

function rebuildRows(node) {
    const previous = [...(node.styleRowWidgets || [])];
    removeRowWidgets(node);
    for (let i = 0; i < (node.selectedStyles || []).length; i++) {
        node.styleRowWidgets.push(makeRowWidget(node, i, previous[i]));
    }
}

// --- layout ------------------------------------------------------------------

function reorderWidgets(node) {
    const ordered = [];
    // Serializable inputs keep INPUT_TYPES relative order across the ordered
    // array (base four here, sweep trio below) — widgets_values is position-based.
    for (const name of ["style_position", "use_positive", "use_negative", CONFIG_WIDGET_NAME]) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }
    if (node._stylesButton) ordered.push(node._stylesButton);
    const category = findWidget(node, "style_category");
    if (category) ordered.push(category);
    for (const w of node.styleRowWidgets || []) ordered.push(w);

    for (const name of ["strength_mode", "style_mix"]) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }

    const sweepSeparator = findWidget(node, "sweep_separator");
    if (sweepSeparator) ordered.push(sweepSeparator);
    for (const name of ["style_sweep", "sweep_from", "sweep_to"]) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }
    const sweepReset = findWidget(node, "↺ Reset");
    const sweepProgress = findWidget(node, "sweep_progress");
    if (sweepReset) ordered.push(sweepReset);
    if (sweepProgress) ordered.push(sweepProgress);

    const remaining = (node.widgets || []).filter((w) => !ordered.includes(w));
    node.widgets = [...ordered, ...remaining];
}

// Pre-feature saves have decorations (separators/buttons, serialize:false
// ignored on save) tacked onto the tail of the positional widgets_values —
// the two NEW head widgets added by the cond-mix wave (strength_mode,
// style_mix) inherit whatever landed in their slot (null / a row string),
// which then fails backend combo validation on Queue. Mirrors the SPEC +
// sanitizeInputs pattern in powder_image_cond.js:39-74.
const HEAD_SPEC = {
    repeat_last: { ok: v => typeof v === "boolean", def: false },
    style_category: { ok: v => typeof v === "string" && v.length > 0, def: "All styles" },
    on_exhausted: { ok: v => ["stop", "loop"].includes(v), def: "stop" },
    strength_mode: {
        // Legacy "token weights" saves repair to node mode — at mix 1.0
        // that is byte-identical to the old plain styled prompt.
        ok: (v) => ["cond mix — node", "cond mix — per style"].includes(v),
        def: "cond mix — node",
    },
    style_mix: {
        ok: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1.5,
        def: 1.0,
    },
};

// The real serializable inputs, INPUT_TYPES order — the wire format for both
// e2goInputs and the rewritten positional widgets_values (decorations — row
// widgets, separators, the button — cost no slot).
const REAL_INPUT_ORDER = ["style_position", "use_positive", "use_negative", CONFIG_WIDGET_NAME,
    "strength_mode", "style_mix", "style_sweep", "sweep_from", "sweep_to", "cursor_scope", "on_exhausted", "style_category", "repeat_last"];

// Repair pass for the head widgets: a saved name-keyed value wins when sane,
// else the current (possibly shifted) live value when sane, else default.
function sanitizeHeadWidgets(node, saved) {
    const fixed = [];
    for (const name of Object.keys(HEAD_SPEC)) {
        const w = findWidget(node, name);
        const spec = HEAD_SPEC[name];
        if (!w) continue;
        const savedVal = saved && name in saved ? saved[name] : undefined;
        const pick = savedVal !== undefined && spec.ok(savedVal) ? savedVal
            : (spec.ok(w.value) ? w.value : spec.def);
        if (w.value !== pick) fixed.push(`${name}: ${JSON.stringify(w.value)} -> ${JSON.stringify(pick)}`);
        w.value = pick;
    }
    if (fixed.length) console.warn("[e2go] PowderStyler repaired shifted widget values:", fixed.join(", "));
    return fixed;
}


function syncMixWidgets(node) {
    const modeW = findWidget(node, "strength_mode");
    const mode = modeW?.value ?? "cond mix — node";
    const mixW = findWidget(node, "style_mix");
    if (mixW) mixW.disabled = mode !== "cond mix — node";
    const sweep = !!findWidget(node, "style_sweep")?.value;
    for (const name of ["sweep_from", "sweep_to", "sweep_progress", "↺ Reset"]) setWidgetVisible(findWidget(node, name), sweep);
    requestResize(node);
    app.graph?.setDirtyCanvas(true, true);
}

function applyLayout(node) {
    hideNamedWidget(node, CONFIG_WIDGET_NAME);
    rebuildRows(node);
    reorderWidgets(node);
    syncConfig(node);
    requestResize(node);
}

// --- restore -----------------------------------------------------------------

function selectionFromOldSlots(slotsData) {
    const out = [];
    for (const s of slotsData || []) {
        const name = s?.style || "None";
        if (name === "None") continue;
        out.push({
            name,
            on: s.enabled ?? true,
            use_positive: s.usePositive ?? true,
            use_negative: s.useNegative ?? true,
            strength: 1.0, // pre-strength saves: neutral
        });
    }
    return out;
}

function selectionFromConfigWidget(node) {
    try {
        // Prefer the pre-layout snapshot: nodeCreated's rAF runs syncConfig("[]")
        // before onConfigure's restoreFromInfo, clobbering the positionally-restored
        // widget value this fallback relies on.
        const snap = node._e2goPreLayoutConfig;
        const raw = snap != null ? snap : findWidget(node, CONFIG_WIDGET_NAME)?.value;
        const parsed = JSON.parse(raw || "[]");
        if (!Array.isArray(parsed)) return [];
        return selectionFromConfigWidgetShape(parsed);
    } catch {
        return [];
    }
}

function selectionFromConfigWidgetShape(arr) {
    return arr
        .filter((x) => x && typeof x === "object" && x.name && x.name !== "None")
        .map((x) => ({
            name: x.name,
            on: x.on ?? true,
            use_positive: x.use_positive ?? true,
            use_negative: x.use_negative ?? true,
            strength: Number.isFinite(x.strength) ? Math.max(0, Math.min(1.5, x.strength)) : 1.0,
        }));
}

function restoreFromInfo(node, info) {
    ensureState(node);

    if (Array.isArray(info?.e2goSelection)) {
        node.selectedStyles = selectionFromConfigWidgetShape(info.e2goSelection);
    } else if (Array.isArray(info?.styleSlotsData)) {
        node.selectedStyles = selectionFromOldSlots(info.styleSlotsData);
    } else {
        node.selectedStyles = selectionFromConfigWidget(node);
    }


    const sweep = info?.sweepInputs;
    if (sweep) {
        for (const name of ["style_sweep", "sweep_from", "sweep_to"]) {
            if (name in sweep) {
                const w = findWidget(node, name);
                if (w) w.value = sweep[name];
            }
        }
    }

    applyLayout(node);
    sanitizeHeadWidgets(node, info?.headInputs || null); // Finding 1: repair pre-feature/shifted strength_mode + style_mix
    syncMixWidgets(node); // safety net: also cover the case where the double-rAF below races ahead of this restore
    scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);
    node._e2goPreLayoutConfig = undefined; // consumed; later calls read live state
}

// --- style library / sweep combos -------------------------------------------

// Attaches the modal single-select picker to a sweep combo widget. Mirrors
// the frontend-1.45.x dispatch used by the row widgets above: onPointerDown
// runs before the native combo dropdown and a truthy return short-circuits
// it. Unlike the row widgets these stay ordinary INPUT_TYPES combo widgets —
// no type/mouse changes — so returning false here (offline) always falls
// back to the native dropdown, which still works off whatever values
// populateSweepCombos managed to set (or the INPUT_TYPES defaults).
//
// Offline guard: node._stylesOffline is undefined until the first
// getStyleLibrary() fetch resolves (set true/false by populateSweepCombos).
// We only bail out to the native combo on a *confirmed* failure
// (=== true); the "not yet loaded" (undefined) case still intercepts and
// opens the picker, which awaits the same cached library promise the button
// uses (openStyleModal does the same for the button click) — so the first
// click right after node creation still gets the modal instead of a stale
// native list, at the cost of a brief empty-modal flash while the fetch is
// in flight.
// Live "N in range" counter: same semantics as the backend's
// _build_sweep_range (inclusive endpoints, direction-agnostic, null when an
// endpoint is missing from the library).
function updateSweepRangeCount(node) {
    const names = node._sweepNames || [];
    const i = names.indexOf(findWidget(node, "sweep_from")?.value);
    const j = names.indexOf(findWidget(node, "sweep_to")?.value);
    node._sweepRangeCount = i < 0 || j < 0 ? null : Math.abs(i - j) + 1;
    app.graph?.setDirtyCanvas(true, true);
}

function syncStyleCategory(node) {
    if (!node._styleLibrary) return;
    const category = findWidget(node, "style_category")?.value || "All styles";
    const names = node._styleLibrary
        .filter(s => category === "All styles" || s.category === category)
        .map(s => s.name);
    node._sweepNames = names;
    for (const key of ["sweep_from", "sweep_to"]) {
        const w = findWidget(node, key);
        if (!w) continue;
        w.options ||= {};
        w.options.values = names.length ? names : ["None"];
        if (!names.includes(w.value)) {
            w.value = (key === "sweep_from" || category === "All styles" ? names[0] : names.at(-1)) || "None";
        }
    }
    node._sweepProgress = null;
    updateSweepRangeCount(node);
}

function wireSweepPicker(node, widgetName, title) {
    const w = findWidget(node, widgetName);
    if (!w) return;
    w.onPointerDown = function (pointer, _node, canvas) {
        const x = widgetPointerX(pointer, node, canvas, w);
        const width = node.size?.[0] || 300;
        if (x >= 10 && x <= width - 10 && (x < 40 || x > width - 40)) {
            const names = node._sweepNames || [];
            if (!names.length) return false;
            const dir = x < 40 ? -1 : 1;
            const at = names.indexOf(w.value);
            w.value = names[at < 0 ? (dir > 0 ? 0 : names.length - 1)
                : (at + dir + names.length) % names.length];
            node._sweepProgress = null;
            updateSweepRangeCount(node);
            return true;
        }
        if (node._stylesOffline === true) return false;
        openStylePicker(node, {
            current: w.value,
            title,
            category: findWidget(node, "style_category")?.value,
            onPick: (name) => {
                w.value = name;
                updateSweepRangeCount(node);
                redrawNodeWidgets(node);
            },
        });
        return true;
    };
    // Native-dropdown fallback path must refresh the counter too.
    const prevCb = w.callback;
    w.callback = function () {
        prevCb?.apply(this, arguments);
        updateSweepRangeCount(node);
    };
}

async function populateSweepCombos(node) {
    try {
        const lib = await getStyleLibrary();
        const names = lib.styles.map((s) => s.name);

        setLibraryNames(new Set(names), new Map(lib.styles.map((s) => [s.name, s.num])));
        node._styleLibrary = lib.styles;
        const category = findWidget(node, "style_category");
        if (category) {
            category.options ||= {};
            const categories = [...new Set(lib.styles.map(s => s.category).filter(Boolean))].sort();
            category.options.values = ["All styles", ...categories];
            // Keep a missing saved category explicit; never silently sweep all styles.
            if (category.value && !category.options.values.includes(category.value)) {
                category.options.values.push(category.value);
            }
        }
        node._stylesOffline = false;
        syncStyleCategory(node);
        updateSweepRangeCount(node);
        updateButtonLabel(node);
        redrawNodeWidgets(node);
    } catch (err) {
        console.warn("[PowderStyler] Failed to load style list:", err);
        node._stylesOffline = true;
        updateButtonLabel(node);
    }
}

// --- extension ---------------------------------------------------------------

app.registerExtension({
    name: "e2go_nodes.PowderStyler",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowderStyler") return;

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            ensureState(this);
            syncConfig(this);
            origOnSerialize?.apply(this, arguments);

            // Custom state only — the widget values ride in e2goInputs, written
            // by installNameKeyedPersistence (nodeCreated below), whose wrapper
            // runs AFTER this method and collects the post-syncConfig values.
            // Legacy sweepInputs/headInputs are no longer written: old saves
            // still restore through them (restoreFromInfo), and an OLD build
            // loading a NEW save falls back to the positional widgets_values,
            // which the helper rewrites in this very order — aligned either way.
            info.e2goSelection = (this.selectedStyles || []).map((x) => ({ ...x }));
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            hideNamedWidget(this, CONFIG_WIDGET_NAME);
            restoreFromInfo(this, info);
            requestAnimationFrame(() => restoreFromInfo(this, info));
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderStyler") return;
        installCursorControls(node, "styles");


        installNameKeyedPersistence(node, {
            inputNames: REAL_INPUT_ORDER,
            sanitize: (name, v) => {
                const spec = HEAD_SPEC[name];
                return spec && !spec.ok(v) ? spec.def : v;
            },
            // strength_mode may arrive with the restored value only here —
            // re-sync the style_mix disabled state it drives.
            afterRestore: saved => {
                const repeat = findWidget(node, "repeat_last");
                if (repeat) repeat.value = saved?.repeat_last === true;
                syncMixWidgets(node); syncStyleCategory(node);
            },
        });

        hideNamedWidget(node, CONFIG_WIDGET_NAME);

        for (const bn of ["use_positive", "use_negative", "style_sweep"]) styleBoolToggle(node, bn);

        // SYNCHRONOUS (see powder_resolution.js:162): the frontend captures
        // widget callbacks right after nodeCreated — wireSweepPicker's
        // callback wrap must not wait for the rAF or the native-dropdown
        // fallback path never refreshes the "N in range" counter.
        wireSweepPicker(node, "sweep_from", "Sweep from…");
        wireSweepPicker(node, "sweep_to", "Sweep to…");
        const categoryW = findWidget(node, "style_category");
        if (categoryW) {
            const cb = categoryW.callback;
            categoryW.callback = function () { cb?.apply(this, arguments); syncStyleCategory(node); };
        }

        // Same synchronous-wrap requirement as wireSweepPicker above: the
        // frontend captures widget callbacks right after nodeCreated.
        const modeW = findWidget(node, "strength_mode");
        const sweepW = findWidget(node, "style_sweep");
        if (sweepW) {
            const cb = sweepW.callback;
            sweepW.callback = function () { cb?.apply(this, arguments); syncMixWidgets(node); };
        }
        if (modeW) {
            const prevModeCb = modeW.callback;
            modeW.callback = function () {
                if (typeof prevModeCb === "function") { try { prevModeCb.apply(this, arguments); } catch {} }
                syncMixWidgets(node);
            };
        }

        requestAnimationFrame(() => {
            ensureState(node);
            hideNamedWidget(node, CONFIG_WIDGET_NAME);

            const btn = node.addWidget("button", "\u{1F3A8} Styles… (0)", null, () => {
                if (node._stylesOffline) return;
                openStyleModal(node);
            });
            btn.serialize = false;
            node._stylesButton = btn;
            node._e2goApplyLayout = () => applyLayout(node);

            node._e2goLibraryRefreshed = () => { populateSweepCombos(node); };

            const sweepSeparator = node.addWidget("text", "", "", noop);
            sweepSeparator.name = "sweep_separator";
            sweepSeparator.serialize = false;
            markSeparator(sweepSeparator, "═══ Style Sweep ═══", node, 280);

            const resetBtn = node.addWidget("button", "↺ Reset", null, () => {
                try {
                    // api.fetchApi, not bare fetch: it prefixes the frontend's
                    // api_base, so the call still resolves when ComfyUI is
                    // served under a sub-path (reverse proxy). Every custom
                    // route is mirrored under /api by server.py's add_routes.
                    api.fetchApi("/e2go/styles/cursor/reset", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: String(node.id), scope: cursorScope(node) }),
                    }).then((res) => {

                        if (!res.ok) console.warn(`[PowderStyler] cursor reset HTTP ${res.status}`);
                    }).catch((e) => console.warn("[PowderStyler] cursor reset failed:", e));
                } catch {}

                node.selectedStyles = [];
                applyLayout(node);
                node._sweepProgress = "0 / ?";
                redrawNodeWidgets(node);
            });
            resetBtn.name = "↺ Reset";
            resetBtn.label = "Reset sweep and clear styles";
            resetBtn.tooltip = "Restart the sweep and remove all selected styles";
            resetBtn.serialize = false;

            const progress = node.addWidget("text", "sweep_progress", "", noop);
            progress.serialize = false;
            progress.disabled = true;
            node._sweepProgress = "—";
            progress.computeSize = () => [Math.max(node.size?.[0] || 280, 280), 20];
            progress.draw = function (ctx, _node, width, posY) {
                ctx.fillStyle = widgetTextColor();
                ctx.font = widgetFont(12);
                ctx.textAlign = "center";
                const range = node._sweepRangeCount != null ? `  ·  ${node._sweepRangeCount} in range` : "";
                ctx.fillText((node._sweepProgress || "—") + range, width / 2, posY + 14);
                ctx.textAlign = "left";
            };

            const prevOnExecuted = node.onExecuted;
            node.onExecuted = function (message) {
                if (typeof prevOnExecuted === "function") {
                    try { prevOnExecuted.apply(this, arguments); } catch {}
                }
                try {
                    const ni = Array.isArray(message?.next_index) ? message.next_index[0] : undefined;
                    const total = Array.isArray(message?.total) ? message.total[0] : undefined;
                    if (typeof ni === "number" && typeof total === "number") {
                        node._sweepProgress = `${ni} / ${total} - ${message.status?.[0] || ""}`;
                    }
                    redrawNodeWidgets(node);
                } catch (e) {
                    console.warn("[e2go styler] onExecuted:", e);
                }
            };

            // Snapshot before applyLayout's syncConfig overwrites style_config with
            // "[]" — onConfigure's later restore reads this if it lacks e2goSelection.
            node._e2goPreLayoutConfig = findWidget(node, CONFIG_WIDGET_NAME)?.value;

            applyLayout(node);
            populateSweepCombos(node);
            scheduleReHide(node, CONFIG_WIDGET_NAME, requestResize);

            // Double-rAF (mirrors powder_image_cond.js's syncCropWidgets):
            // runs after this rAF's own layout AND after onConfigure's
            // restoreFromInfo rAF (queued at node-creation time, same tick),
            // so a workflow restored with a cond-mix mode shows/hides
            // style_mix correctly instead of defaulting to hidden.
            const graphRef = app.graph;
            requestAnimationFrame(() => {
                if (app.graph !== graphRef) return;
                requestAnimationFrame(() => {
                    if (app.graph !== graphRef) return;
                    syncMixWidgets(node);
                });
            });
        });
    },
});
