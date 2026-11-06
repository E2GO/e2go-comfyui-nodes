import { app } from "../../../scripts/app.js";
import { installTextResizing, arrangeTextHandles } from "./e2go_text_resize.js";
// api.fetchApi, not bare fetch: it prefixes the frontend's api_base, so these
// calls still resolve when ComfyUI is served under a sub-path (reverse proxy).
// Every custom route is mirrored under /api by server.py's add_routes.
import { api } from "../../../scripts/api.js";
import { widgetTextColor, widgetSecondaryTextColor, widgetFont, markSeparator, hideNamedWidget, scheduleReHide, setWidgetVisible } from "./e2go_hide_utils.js";
import { installNameKeyedPersistence } from "./e2go_persistence.js";

const NODE_TYPE = "PowderPromptWildcard";
const SENTINEL = "(none)";
const COMBO_WIDGET = "wildcard_file";
const INDEX_WIDGET = "start_index";
const MAX_FILE_BYTES = 1_048_576;
import { cursorScope, installCursorControls } from "./e2go_cursor_ui.js";

// Serializable inputs, in INPUT_TYPES order. Saved/restored BY NAME (below) so
// that decoration widgets interleaved by reorderWidgets can never shift the
// position-based widgets_values on copy/reload (which scrambled start_index to
// NaN and leaked numbers into prefix/suffix).
const INPUT_NAMES = [
    "positive_prompt_list", "negative_prompt_list", "wildcard_file",
    "start_index", "count", "loop", "prefix_text", "suffix_text", "on_exhausted", "repeat_last",
];

function noop() {}

function alignLegacyWildcardInputs(values) {
    // 1.x Git saves predate the file picker; Registry 1.0 adds it and
    // start/count, but neither format has the loop widget introduced in 2.0.
    let names;
    if (values.length === 4 && values.every(value => typeof value === "string")) {
        names = ["positive_prompt_list", "negative_prompt_list", "prefix_text", "suffix_text"];
    } else if (values.length === 7
        && [0, 1, 2, 5, 6].every(index => typeof values[index] === "string")
        && [3, 4].every(index => Number.isInteger(values[index]) && values[index] >= 0)) {
        names = ["positive_prompt_list", "negative_prompt_list", "wildcard_file",
            "start_index", "count", "prefix_text", "suffix_text"];
    } else {
        return null;
    }
    const saved = { wildcard_file: SENTINEL, start_index: 0, count: 0,
        loop: false, on_exhausted: "stop", repeat_last: false };
    names.forEach((name, index) => { saved[name] = values[index]; });
    return saved;
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function requestResize(node) {
    const graphRef = app.graph;
    requestAnimationFrame(() => {
        if (app.graph !== graphRef) return;
        try {
            node.setSize([node.size?.[0] || 360, node.computeSize()[1]]);
        } catch {}
        app.graph?.setDirtyCanvas(true, true);
    });
}

function reorderWidgets(node) {
    const ordered = [];

    const manualSeparator = node._manualPromptsSeparator;
    if (manualSeparator) ordered.push(manualSeparator);

    // MUST match INPUT_TYPES order — widgets_values is position-based
    const baseNames = ["positive_prompt_list", "negative_prompt_list", "wildcard_file"];
    for (const name of baseNames) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }

    if (node._uploadBtn) ordered.push(node._uploadBtn);
    if (node._clearListBtn) ordered.push(node._clearListBtn);

    const restNames = ["start_index", "count", "loop", "prefix_text", "suffix_text"];
    for (const name of restNames) {
        const widget = findWidget(node, name);
        if (widget) ordered.push(widget);
    }

    if (node._wildcardSeparator) ordered.push(node._wildcardSeparator);
    if (node._resetBtn) ordered.push(node._resetBtn);
    if (node._clearPositiveBtn) ordered.push(node._clearPositiveBtn);
    if (node._clearNegativeBtn) ordered.push(node._clearNegativeBtn);
    if (node._clearPrefixBtn) ordered.push(node._clearPrefixBtn);
    if (node._clearSuffixBtn) ordered.push(node._clearSuffixBtn);
    if (node._progress) ordered.push(node._progress);

    const remaining = (node.widgets || []).filter((w) => !ordered.includes(w));
    node.widgets = [...ordered, ...remaining];
    arrangeTextHandles(node);
}

function makeDisplay(rec) {
    return `[${rec.source}] ${rec.name}`;
}

// Last-resort repair for a scrambled positional restore (legacy/round-tripped
// saves that predate the name-keyed e2goInputs, or that a tool stripped it
// from): a positional widgets_values apply can leak the combo SENTINEL into
// prefix_text and turn start_index/count into NaN, which then FAILS the
// backend's INT conversion and the user has to recreate the node. Coerce the
// INT widgets to finite in-range integers and clear text widgets that caught
// a stray sentinel/number.
function sanitizeInputs(node) {
    const end = findWidget(node, "on_exhausted");
    const oldLoop = findWidget(node, "loop");
    if (end) {
        end.options = { ...end.options, values: ["stop", "loop"] };
        if (oldLoop?.value === true) end.value = "loop";
        if (!["stop", "loop"].includes(end.value)) end.value = "stop";
    }
    if (oldLoop) {
        oldLoop.value = false;
        hideNamedWidget(node, "loop");
    }
    for (const [name, def] of [["start_index", 0], ["count", 0]]) {
        const w = findWidget(node, name);
        if (!w) continue;
        const n = Math.floor(Number(w.value));
        w.value = Number.isFinite(n) && n >= 0 ? n : def;
    }
    for (const name of ["prefix_text", "suffix_text",
                        "positive_prompt_list", "negative_prompt_list"]) {
        const w = findWidget(node, name);
        if (!w) continue;
        if (typeof w.value !== "string" || w.value === SENTINEL) w.value = "";
    }
}

function setIndex(node, value) {
    const w = findWidget(node, INDEX_WIDGET);
    if (!w) return;
    w.value = value;
    if (typeof w.callback === "function") {
        try { w.callback(value); } catch {}
    }
}

function resetIndex(node) {
    setIndex(node, 0);
    node._progressText = "Ready — start at 0";
    setWidgetVisible(node._progress, true);
    requestResize(node);
    postCursorReset(node);
    app.graph?.setDirtyCanvas(true, true);
}

function postCursorReset(node) {
    try {
        api.fetchApi("/e2go/wildcards/cursor/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: String(node.id), scope: cursorScope(node) }),
        }).then((res) => {
            // fire-and-forget; the reset button also sets the widget — but a
            // failed reset silently keeps the server cursor, so at least warn
            if (!res.ok) console.warn(`[PowderWildcard] cursor reset HTTP ${res.status}`);
        }).catch((e) => console.warn("[PowderWildcard] cursor reset failed:", e));
    } catch {}
}

async function clearFileList(node) {
    if (!confirm("Delete ALL wildcard .txt files in the e2go folder (including lists you saved there manually)? This cannot be undone.")) return;
    try {
        const resp = await api.fetchApi("/e2go/wildcards/clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true }),   // CSRF guard: server requires json+confirm
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
        console.warn("[e2go wildcard] clear failed:", e);
        window.alert(`Clear failed: ${e.message || e} — nothing was deleted.`);
        return;                     // keep the current selection
    }
    const combo = findWidget(node, COMBO_WIDGET);
    if (combo) combo.value = SENTINEL;      // reset selection to (none)
    await refreshList(node);                // repopulate — e2go entries now gone
    app.graph?.setDirtyCanvas(true, true);
}

async function refreshList(node) {
    try {
        const resp = await api.fetchApi("/e2go/wildcards/list");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const files = Array.isArray(data?.files) ? data.files : [];
        node._wildcardRecords = files;
        const combo = findWidget(node, COMBO_WIDGET);
        if (combo) {
            combo.options = combo.options || {};
            combo.options.values = [SENTINEL, ...files.map(makeDisplay)];
            if (!combo.value) combo.value = SENTINEL;   // do not clobber a restored value
            app.graph?.setDirtyCanvas(true, true);
        }
    } catch (e) {
        console.warn("[e2go wildcard] list failed:", e);
    }
}

function clearField(node, widgetName, options) {
    const w = findWidget(node, widgetName);
    if (!w) return;
    const cur = typeof w.value === "string" ? w.value.trim() : "";
    if (cur && !window.confirm(`Clear ${widgetName}? Current content will be lost.`)) {
        return;
    }
    w.value = "";
    if (typeof w.callback === "function") {
        try { w.callback(""); } catch {}
    }
    if (options?.resetCombo) {
        const combo = findWidget(node, COMBO_WIDGET);
        if (combo) combo.value = SENTINEL;
    }
    app.graph?.setDirtyCanvas(true, true);
}

function pickAndUpload(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.style.display = "none";
    document.body.appendChild(input);
    // Dialog cancelled: no `change` ever fires, so without this every
    // cancelled "Load file…" click leaked one hidden input into the body.
    // (`cancel` fires on <input type=file> since Chrome 113; a change after
    // cancel cannot occur, and the change path's own removal is try-guarded.)
    input.addEventListener("cancel", () => {
        try { document.body.removeChild(input); } catch {}
    }, { once: true });
    input.addEventListener("change", async () => {
        try {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > MAX_FILE_BYTES) {
                window.alert("File too large (>1 MiB).");
                return;
            }
            const text = await file.text();
            const resp = await api.fetchApi("/e2go/wildcards/upload", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: file.name, content: text }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
                throw new Error(err.error || `HTTP ${resp.status}`);
            }
            const result = await resp.json();
            await refreshList(node);
            const combo = findWidget(node, COMBO_WIDGET);
            const disp = makeDisplay(result);
            if (combo && combo.options?.values?.includes(disp)) {
                combo.value = disp;
                if (typeof combo.callback === "function") {
                    try { combo.callback(disp); } catch {}   // wrapped callback resets the cursor
                }
            }
        } catch (e) {
            window.alert(`Upload failed: ${e.message || e}`);
        } finally {
            try { document.body.removeChild(input); } catch {}
        }
    }, { once: true });
    input.click();
}

app.registerExtension({
    name: "e2go_nodes.PowderPromptWildcard",

    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        installCursorControls(node, "wildcards");

        // Name-keyed persistence (e2go_persistence.js): values survive
        // copy/reload regardless of where reorderWidgets places the
        // (serialize:false) decorations. rewritePositional stays OFF here
        // only to keep the HISTORICAL save format byte-stable (the platform's
        // own array, decoration slots included) — e2goInputs + sanitize carry
        // the restore either way; flipping it on is safe but changes what
        // older files' widgets_values look like. The configuring flag guards
        // the cursor reset from firing while ComfyUI applies saved widget
        // values.
        installNameKeyedPersistence(node, {
            inputNames: INPUT_NAMES,
            rewritePositional: false,
            legacyAlign: alignLegacyWildcardInputs,
            onConfigureStart: () => { node._wildcardConfiguring = true; },
            onConfigureEnd: () => { node._wildcardConfiguring = false; },
            afterRestore: saved => {
                const repeat = findWidget(node, "repeat_last");
                if (repeat) repeat.value = saved?.repeat_last === true;
                sanitizeInputs(node);   // repair a scrambled positional restore
                reorderWidgets(node);
            },
        });
        installTextResizing(node, name => ["positive_prompt_list", "negative_prompt_list", "prefix_text", "suffix_text"].includes(name));
        sanitizeInputs(node);

        // SYNCHRONOUS wrap (see powder_resolution.js:162): the frontend
        // converts widgets to concrete classes right after nodeCreated and
        // CAPTURES the callback — a wrapper attached inside a rAF is never
        // invoked, so a native-dropdown pick never reset the cursor (the
        // upload path masked this by invoking combo.callback manually).
        {
            const combo = findWidget(node, COMBO_WIDGET);
            if (combo) {
                node._wildcardCombo = combo;
                const prevCb = combo.callback;
                combo.callback = function (value) {
                    if (typeof prevCb === "function") {
                        try { prevCb.apply(this, arguments); } catch {}
                    }
                    if (!node._wildcardConfiguring) resetIndex(node);
                };
            }
        }
        // Belt-and-braces (same as powder_resolution.js): onWidgetChanged
        // fires even if a future frontend stops calling captured callbacks.
        {
            const prevOnWidgetChanged = node.onWidgetChanged;
            node.onWidgetChanged = function (name, ...rest) {
                if (typeof prevOnWidgetChanged === "function") {
                    try { prevOnWidgetChanged.apply(this, arguments); } catch {}
                }
                if (name === COMBO_WIDGET && !node._wildcardConfiguring) {
                    resetIndex(node);
                }
            };
        }

        requestAnimationFrame(() => {

            const manualSeparator = node.addWidget("text", "═══════ Manual prompts ═══════", "", noop);
            manualSeparator.serialize = false;
            markSeparator(manualSeparator, "═══════ Manual prompts ═══════", node);
            node._manualPromptsSeparator = manualSeparator;

            const upload = node.addWidget("button", "+ Load file...", null, () => pickAndUpload(node));
            upload.serialize = false;
            node._uploadBtn = upload;

            const clearListBtn = node.addWidget("button", "× Clear file list", null,
                () => clearFileList(node));
            clearListBtn.serialize = false;
            node._clearListBtn = clearListBtn;

            const separator = node.addWidget("text", "═══════ Wildcard ═══════", "", noop);
            separator.serialize = false;
            markSeparator(separator, "═══════ Wildcard ═══════", node);
            node._wildcardSeparator = separator;

            const resetBtn = node.addWidget("button", "↺ Reset", null, () => resetIndex(node));
            resetBtn.serialize = false;
            node._resetBtn = resetBtn;

            const clearPositiveBtn = node.addWidget("button", "× Clear positive", null,
                () => clearField(node, "positive_prompt_list", { resetCombo: true }));
            clearPositiveBtn.serialize = false;
            node._clearPositiveBtn = clearPositiveBtn;

            const clearNegativeBtn = node.addWidget("button", "× Clear negative", null,
                () => clearField(node, "negative_prompt_list"));
            clearNegativeBtn.serialize = false;
            node._clearNegativeBtn = clearNegativeBtn;

            const clearPrefixBtn = node.addWidget("button", "× Clear prefix", null,
                () => clearField(node, "prefix_text"));
            clearPrefixBtn.serialize = false;
            node._clearPrefixBtn = clearPrefixBtn;

            const clearSuffixBtn = node.addWidget("button", "× Clear suffix", null,
                () => clearField(node, "suffix_text"));
            clearSuffixBtn.serialize = false;
            node._clearSuffixBtn = clearSuffixBtn;
            const maintenance = [clearPositiveBtn, clearNegativeBtn, clearPrefixBtn, clearSuffixBtn, clearListBtn];
            clearListBtn.label = "Delete all local wildcard files…";
            maintenance.forEach(w => setWidgetVisible(w, false));
            const previousMenu = node.getExtraMenuOptions;
            node.getExtraMenuOptions = function (_, options) {
                previousMenu?.apply(this, arguments);
                options.push(null, ...maintenance.map(w => ({ content: w.label || w.name, callback: () => w.callback() })));
            };

            const progress = node.addWidget("text", "progress", "", noop);
            progress.serialize = false;
            progress.disabled = true;
            node._progress = progress;
            node._progressText = "";
            progress.computeSize = () => [Math.max(node.size?.[0] || 320, 320), 20];
            progress.draw = function (ctx, _node, width, posY) {
                ctx.save();
                ctx.fillStyle = widgetTextColor();
                ctx.font = widgetFont(11);
                ctx.textAlign = "left";
                ctx.fillText(node._progressText, 18, posY + 14);
                ctx.restore();
            };
            setWidgetVisible(progress, false);

            const prevOnExecuted = node.onExecuted;
            node.onExecuted = function (message) {
                if (typeof prevOnExecuted === "function") {
                    try { prevOnExecuted.apply(this, arguments); } catch {}
                }
                try {
                    const ni = Array.isArray(message?.next_index) ? message.next_index[0] : undefined;
                    const total = Array.isArray(message?.total) ? message.total[0] : undefined;
                    // start_index is a static anchor now; the server owns the live
                    // position. Reflect it only in the progress line, never write it
                    // back into the widget (that write-back lost races under queueing).
                    if (typeof ni === "number" && typeof total === "number") {
                        node._progressText = `${ni} / ${total} - ${message.status?.[0] || ""}`;
                        setWidgetVisible(progress, true);
                        requestResize(node);
                    }
                    app.graph?.setDirtyCanvas(true, true);
                } catch (e) {
                    console.warn("[e2go wildcard] onExecuted:", e);
                }
            };

            reorderWidgets(node);
            refreshList(node);
            requestResize(node);
        });
    },
});
