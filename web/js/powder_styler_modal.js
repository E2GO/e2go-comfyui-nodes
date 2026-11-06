

import { app } from "../../../scripts/app.js";
// api.fetchApi, not bare fetch: it prefixes the frontend's api_base, so these
// calls still resolve when ComfyUI is served under a sub-path (reverse proxy).
// Every custom route is mirrored under /api by server.py's add_routes.
import { api } from "../../../scripts/api.js";
import { openModal } from "./e2go_modal.js";

const FAVORITES_KEY = "e2go.styler.favorites";

let _libraryPromise = null;

export function getStyleLibrary() {
    _libraryPromise ||= api.fetchApi("/powder_styler/get_styles")
        .then((r) => r.json())
        .then((data) => {
            const styles = Array.isArray(data?.styles) ? data.styles : [];
            // Global alphabetical index (1-based UI-only numbering): the backend
            // already returns styles sorted alphabetically (case-insensitive) —
            // see _styles.py's all_styles.sort(key=...lower()) — so position in
            // this array IS the "All" order. Never written into style_config or
            // any serialized payload; purely a rendering aid for the modal and
            // the on-node rows.
            styles.forEach((s, i) => { s.num = i + 1; });
            // The modal core derives its own byName/categories from the items
            // array — no need to precompute them here (was dead per-fetch work).
            return { styles };
        })
        .catch((err) => {
            _libraryPromise = null; // allow retry on next open
            throw err;
        });
    return _libraryPromise;
}

function previewTitle(style) {
    const parts = [];
    if (style.prefix) parts.push(`prefix: ${style.prefix}`);
    if (style.suffix) parts.push(`suffix: ${style.suffix}`);
    if (style.negative) parts.push(`negative: ${style.negative}`);
    const text = parts.join("\n");
    return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

// Loader thunk so the core holds the overlay guard while the library fetches —
// preserving the original "second open during fetch is blocked" timing.
const styleItems = () => getStyleLibrary().then((lib) => lib.styles);


function makeOnRefresh(node) {
    return async () => {
        _libraryPromise = null;
        const lib = await getStyleLibrary();

        for (const n of collectStylerNodes(app.graph)) {
            n._e2goLibraryRefreshed?.(lib);
        }
        return lib.styles;
    };
}

// Subgraph-aware sweep (same contract as powder_canvas.js collectCanvasNodes).
function collectStylerNodes(graph, out = [], visited = new Set()) {
    if (!graph || visited.has(graph)) return out;
    visited.add(graph);
    for (const n of graph._nodes || []) {
        if (n.comfyClass === "PowderStyler") out.push(n);
        if (n.subgraph) collectStylerNodes(n.subgraph, out, visited);
    }
    return out;
}

// --- user styles (category "User"): create/edit/delete + clipboard sharing --

const USER_CATEGORY = "User";

async function postUserStyle(payload) {
    const res = await api.fetchApi("/powder_styler/user_style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

function ensureEditorCss() {
    if (document.getElementById("e2go-style-editor-css")) return;
    const el = document.createElement("style");
    el.id = "e2go-style-editor-css";
    el.textContent = `
.e2go-style-editor-backdrop {
    position: fixed; inset: 0; z-index: 10001;
    background: rgba(0,0,0,.5); display: flex;
    align-items: center; justify-content: center;
}
.e2go-style-editor {
    width: 460px; max-width: 90vw; background: #202225; color: #ddd;
    border: 1px solid #444; border-radius: 8px; padding: 12px;
    font: 13px Arial, sans-serif; display: flex; flex-direction: column; gap: 8px;
}
.e2go-style-editor h3 { margin: 0 0 2px; font-size: 13px; color: #9bbdd6; font-weight: normal; }
.e2go-style-editor label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #999; }
.e2go-style-editor input, .e2go-style-editor textarea {
    background: #17181a; color: #ddd; border: 1px solid #444; border-radius: 4px;
    padding: 6px 8px; outline: none; font: 13px Arial, sans-serif; resize: vertical;
}
.e2go-style-editor textarea { min-height: 48px; }
.e2go-style-editor .err { color: #d18f8f; font-size: 12px; min-height: 14px; }
.e2go-style-editor .btns { display: flex; gap: 8px; justify-content: flex-end; }
.e2go-style-editor .btns button {
    background: #333; color: #ccc; border: 1px solid #555; border-radius: 4px;
    padding: 5px 14px; cursor: pointer;
}
.e2go-style-editor .btns button.primary { background: #2d3f52; color: #fff; }
`;
    document.head.appendChild(el);
}

// Small overlay dialog above the picker (z 10001 vs 10000). `fields` describes
// inputs; onSubmit receives {fieldName: value} and may throw — the message
// lands in the .err line and the dialog stays open. Esc/Cancel close without
// submitting; the capture-phase keydown + stopPropagation keeps Esc from also
// closing the picker modal underneath.
function openEditorDialog({ title, fields, submitLabel, onSubmit }) {
    ensureEditorCss();
    const backdrop = document.createElement("div");
    backdrop.className = "e2go-style-editor-backdrop";
    const panel = document.createElement("div");
    panel.className = "e2go-style-editor";
    backdrop.appendChild(panel);

    const h = document.createElement("h3");
    h.textContent = title;
    panel.appendChild(h);

    const inputs = {};
    for (const f of fields) {
        const label = document.createElement("label");
        label.textContent = f.label;
        const input = document.createElement(f.multiline ? "textarea" : "input");
        input.value = f.value || "";
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.rows) input.rows = f.rows;
        label.appendChild(input);
        panel.appendChild(label);
        inputs[f.name] = input;
    }

    const err = document.createElement("div");
    err.className = "err";
    const btns = document.createElement("div");
    btns.className = "btns";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.className = "primary";
    saveBtn.textContent = submitLabel || "Save";
    btns.append(cancelBtn, saveBtn);
    panel.append(err, btns);

    function close() {
        document.removeEventListener("keydown", onKey, true);
        backdrop.remove();
    }
    function onKey(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
        }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
        if (e.target === backdrop) close();
    });
    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", async () => {
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
        saveBtn.disabled = true;
        try {
            await onSubmit(values);
            close();
        } catch (e) {
            err.textContent = String(e?.message || e);
            saveBtn.disabled = false;
        }
    });

    document.body.appendChild(backdrop);
    Object.values(inputs)[0]?.focus();
}

function openStyleEditor({ style, title, onSave }) {
    openEditorDialog({
        title,
        fields: [
            { name: "name", label: "Name", value: style?.name || "" },
            { name: "prefix", label: "Prefix (before prompt)", value: style?.prefix || "", multiline: true },
            { name: "suffix", label: "Suffix (after prompt)", value: style?.suffix || "", multiline: true },
            { name: "negative", label: "Negative", value: style?.negative || "", multiline: true },
        ],
        onSubmit: async (v) => {
            if (!v.name.trim()) throw new Error("Name is required");
            await onSave({
                name: v.name.trim(),
                prefix: v.prefix,
                suffix: v.suffix,
                negative: v.negative,
            });
        },
    });
}

// Accepts a single style object or an array of them (the shape "Copy JSON"
// produces); every entry lands in the User category.
function openImportDialog({ onImport }) {
    openEditorDialog({
        title: "Import style JSON → User",
        submitLabel: "Import",
        fields: [{
            name: "json", label: "Style JSON (single style or array)",
            multiline: true, rows: 8,
            placeholder: '{"name": "My style", "prefix": "...", "suffix": "...", "negative": "..."}',
        }],
        onSubmit: async (v) => {
            let parsed;
            try {
                parsed = JSON.parse(v.json);
            } catch {
                throw new Error("Invalid JSON");
            }
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            const styles = arr.filter((s) => s && typeof s === "object" && s.name);
            if (!styles.length) throw new Error("No styles with a name found");
            await onImport(styles);
        },
    });
}

function styleToShareJson(s) {
    return JSON.stringify({
        name: s.name,
        prefix: s.prefix || "",
        suffix: s.suffix || "",
        negative: s.negative || "",
    }, null, 2);
}

function userStyleHeaderButtons() {
    return [
        {
            label: "＋", title: "New style (saved to User category)",
            onClick: (api) => openStyleEditor({
                title: "New style (User)",
                onSave: async (s) => {
                    await postUserStyle({ action: "add", style: s });
                    await api.refresh();
                },
            }),
        },
        {
            label: "⇩", title: "Import style JSON (paste into User category)",
            onClick: (api) => openImportDialog({
                onImport: async (styles) => {
                    for (const s of styles) {
                        await postUserStyle({ action: "add", style: s });
                    }
                    await api.refresh();
                },
            }),
        },
    ];
}

function userStyleRowButtons(s) {
    if (s.category !== USER_CATEGORY) return [];
    return [
        {
            label: "✎", title: "Edit",
            onClick: (it, api) => openStyleEditor({
                title: "Edit style (User)", style: it,
                onSave: async (v) => {
                    await postUserStyle({ action: "update", style: v, original_name: it.name });
                    await api.refresh();
                },
            }),
        },
        {
            label: "⧉", title: "Copy style JSON (share it anywhere)",
            onClick: async (it, _api, el) => {
                try {
                    await navigator.clipboard.writeText(styleToShareJson(it));
                    el.textContent = "✓";
                } catch {
                    el.textContent = "✗";
                }
                setTimeout(() => { el.textContent = "⧉"; }, 1000);
            },
        },
        {
            label: "🗑", title: "Delete (click again to confirm)",
            onClick: async (it, api, el) => {
                if (el._armed) {
                    try {
                        await postUserStyle({ action: "delete", name: it.name });
                        await api.refresh();
                    } catch (e) {
                        console.warn("[PowderStyler] delete failed:", e);
                        // Surface it (the editor dialog does) and disarm NOW,
                        // not on the stale 2s timer — the row stays.
                        window.alert(`Delete failed: ${e.message || e}`);
                        el._armed = false;
                        el.classList.remove("danger");
                        el.textContent = "🗑";
                    }
                    return;
                }
                el._armed = true;
                el.classList.add("danger");
                el.textContent = "sure?";
                setTimeout(() => {
                    el._armed = false;
                    el.classList.remove("danger");
                    el.textContent = "🗑";
                }, 2000);
            },
        },
    ];
}

export async function openStyleModal(node) {
    return openModal({
        mode: "multi",
        numbered: true,
        favoritesKey: FAVORITES_KEY,
        searchPlaceholder: "Search styles…",
        items: styleItems,
        headerButtons: userStyleHeaderButtons(),
        rowButtons: userStyleRowButtons,
        onLoadError: (err) => console.warn("[PowderStyler] style library unavailable:", err),
        tooltipFor: (s) => previewTitle(s),
        onRefresh: makeOnRefresh(node),
        isSelected: (s) => (node.selectedStyles || []).some((x) => x.name === s.name),
        onToggleItem: (s) => {
            const i = (node.selectedStyles || []).findIndex((x) => x.name === s.name);
            if (i >= 0) {
                node.selectedStyles.splice(i, 1);
            } else {
                node.selectedStyles.push({
                    name: s.name, on: true, use_positive: true, use_negative: true,
                    strength: 1.0,
                });
            }
            node._e2goApplyLayout?.();
        },
        // Multi-select mutates node.selectedStyles live and needs a relayout of
        // the on-node rows on close; pick mode passes no onClose, as the caller
        // already handled onPick (setting the combo value + dirtying the canvas).
        onClose: () => node._e2goApplyLayout?.(),
    });
}

export async function openStylePicker(node, { current, title, onPick, category } = {}) {
    const filter = items => !category || category === "All styles"
        ? items : items.filter(s => s.category === category);
    return openModal({
        mode: "pick",
        numbered: true,
        favoritesKey: FAVORITES_KEY,
        searchPlaceholder: "Search styles…",
        current,
        title,
        onPick,
        items: async () => filter(await styleItems()),
        onLoadError: (err) => console.warn("[PowderStyler] style library unavailable:", err),
        tooltipFor: (s) => previewTitle(s),
        onRefresh: async () => filter(await makeOnRefresh(node)()),
    });
}
