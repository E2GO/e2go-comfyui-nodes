import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { hideNamedWidget, scheduleReHide } from "./e2go_hide_utils.js";
import * as model from "./e2go_canvas_model.js";
import { mountCanvasEditor } from "./e2go_canvas_ui.js";
import { openCanvasStorage } from "./e2go_maintenance_ui.js";

const CONFIG_WIDGET_NAME = "canvas_config";

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function collectCanvasNodes(graph, out = [], visited = new Set()) {
    if (!graph || visited.has(graph)) return out;
    visited.add(graph);
    for (const node of graph._nodes || []) {
        if (node.comfyClass === "PowderCanvas") out.push(node);
        if (node.subgraph) collectCanvasNodes(node.subgraph, out, visited);
    }
    return out;
}

// Execution ids for nodes inside subgraphs are path strings "parent:child".
// Walk the graph tree (same recursion contract as collectCanvasNodes) and
// build the path to `target`.
function findExecPath(graph, target, prefix = [], visited = new Set()) {
    if (!graph || visited.has(graph)) return null;
    visited.add(graph);
    for (const n of graph._nodes || []) {
        if (n === target) return [...prefix, String(n.id)].join(":");
        if (n.subgraph) {
            const found = findExecPath(n.subgraph, target, [...prefix, String(n.id)], visited);
            if (found) return found;
        }
    }
    return null;
}

// Partial execution up to this canvas node: runs only the upstream branch,
// onExecuted picks up ui.images -> background refresh. Full queue untouched.
async function refreshNode(node, state) {
    const hasImageLink = node.inputs?.some((i) => i.name === "image" && i.link != null);
    if (!hasImageLink && !model.hasContent(state)) return false;
    const execId = findExecPath(app.graph, node) ?? String(node.id);

    node._e2goRefreshPending = true;
    return app.queuePrompt(0, 1, [execId]);
}

// Upload subfolder under ComfyUI's input dir. MUST match Python's
// CANVAS_SUBFOLDER in powder_canvas.py:24 — separate runtimes, so the pair is
// synced by hand; this const is the single JS-side occurrence.
const CANVAS_SUBFOLDER = "e2go_canvas";

// --- queue-time bake + upload -----------------------------------------------
//
// Global app.queuePrompt hook installed once:
// before the prompt serializes, every PowderCanvas bakes composite+mask PNGs,
// uploads them to input/e2go_canvas/ and writes filenames+hash into
// canvas_config. IS_CHANGED = hash -> untouched canvas hits the exec cache.

let _hookInstalled = false;
function installQueueHook() {
    if (_hookInstalled || typeof app.queuePrompt !== "function") return;
    _hookInstalled = true;
    const orig = app.queuePrompt.bind(app);
    let queued = Promise.resolve();
    app.queuePrompt = function (...args) {
        const run = queued.then(async () => {
        for (const node of collectCanvasNodes(app.graph)) {
            if (node.mode === 2 || node.mode === 4) continue;
            if (node._e2goCanvasPrepare) {
                try {
                    const state = node._e2goCanvasState;
                    if (!args[2]?.length && state?.bgPending && node.inputs?.some(i => i.name === "image" && i.link != null)) {
                        node._e2goCanvasSetStatus?.("Loading the background before generation…", { warn: false, ms: 0 });
                        findWidget(node, CONFIG_WIDGET_NAME).value = "{}";
                        await new Promise((resolve, reject) => {
                            const cleanup = () => { clearTimeout(timer); node._e2goBackgroundReady = null; api.removeEventListener("execution_error", failed); };
                            const failed = () => { cleanup(); reject(new Error("Background refresh failed")); };
                            const timer = setTimeout(failed, 120000);
                            api.addEventListener("execution_error", failed);
                            node._e2goBackgroundReady = error => { cleanup(); error ? reject(error) : resolve(); };
                            Promise.resolve(orig(0, 1, [findExecPath(app.graph, node) ?? String(node.id)]))
                                .then(ok => { if (ok === false) failed(); }, failed);
                        });
                        if (!collectCanvasNodes(app.graph).includes(node)) throw new Error("Workflow changed during background refresh");
                    }
                    await node._e2goCanvasPrepare();
                    if (node._e2goPrepareError) {
                        node._e2goPrepareError = false;
                        node._e2goCanvasSetStatus?.("Canvas ready", { warn: false });
                    }
                } catch (e) {
                    console.warn("[PowderCanvas] prepare failed:", e);
                    node._e2goPrepareError = true;
                    node._e2goCanvasSetStatus?.(`Upload failed: ${e.message}. Queue again to retry.`, { warn: true, ms: 0 });
                    return false;
                }
            }
        }
        return orig(...args);
        });
        queued = run.catch(() => {});
        return run;
    };
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
    );
}

async function uploadPng(blob, filename) {
    const fd = new FormData();
    fd.append("image", blob, filename);
    fd.append("subfolder", CANVAS_SUBFOLDER);
    fd.append("type", "input");
    fd.append("overwrite", "true");
    const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`upload/image ${res.status}`);
    return res.json();
}

// FNV-1a over a byte buffer, chainable via `seed` so composite+mask blobs
// fold into one hash without concatenating the (potentially large) buffers.
function fnv1a(bytes, seed = 0x811c9dc5) {
    let h = seed >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}


function nodeFileKey(node) {
    const execId = findExecPath(app.graph, node) ?? String(node.id);
    const wf = activeWfKey();
    const h = fnv1a(new TextEncoder().encode(`${wf}|${execId}`)).toString(16);
    return `${h}_${String(node.id).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}


const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");

async function persistLayers(node, state) {
    // Wait an upload in flight out instead of skipping: it may have started
    // before the change this call is for (an Expand shifts every layer), and
    // the paintDirty check below then re-uploads what it missed.
    while (node._e2goPersistBusy) await node._e2goPersistBusy;
    if (!model.hasContent(state)) return true;

    const targetPaint = state.paintDirty || 0;
    const targetMask = state.dirty || 0;
    const saveMask = state.rememberMask && targetMask !== node._e2goMaskPersistedDirty;
    if (targetPaint === node._e2goLayersPersistedPaint && !saveMask) return true;
    const run = (async () => {
        node._e2goCanvasSetSaveState?.("Saving layers…");
        try {
            const files = [];
            for (let i = 1; targetPaint !== node._e2goLayersPersistedPaint && i < state.layers.length; i++) {
                const layer = state.layers[i];
                if (!layer?.canvas) continue;
                const blob = await canvasToBlob(layer.canvas);
                const name = `${await digest(new Uint8Array(await blob.arrayBuffer()))}_layer.png`;
                await uploadPng(blob, name);
                files.push({ file: name, visible: layer.visible !== false, name: layer.name || null });
            }
            if (targetPaint !== node._e2goLayersPersistedPaint) state._layerFiles = files;
            node._e2goLayersPersistedPaint = targetPaint;
            if (saveMask) {
                const blob = await canvasToBlob(state.mask);
                const name = `${await digest(new Uint8Array(await blob.arrayBuffer()))}_editor_mask.png`;
                await uploadPng(blob, name);
                state._maskFile = name;
                node._e2goMaskPersistedDirty = targetMask;
            }
            node._e2goCanvasSetSaveState?.("Layers saved");
            return true;
        } catch (e) {
            node._e2goCanvasSetSaveState?.("Layer save failed — retry on Queue");
            node._e2goCanvasSetStatus?.("Layer save failed — Queue retries the upload.");
            console.warn("[PowderCanvas] layer persist failed:", e);
            return false;
        }
    })();
    node._e2goPersistBusy = run;
    try {
        return await run;
    } finally {
        node._e2goPersistBusy = null;
    }
}

async function prepareNode(node, state) {
    node._e2goLayoutPrepare?.();
    const cfg = findWidget(node, CONFIG_WIDGET_NAME);
    if (!cfg) return;
    if (typeof cfg.value !== "string" || !cfg.value) {
        // One observed prompt-validation failure ("Required input is missing:
        // canvas_config", node 843) never reproduced; belt-and-braces plus a
        // loud trace so a recurrence identifies the culprit.
        console.warn("[PowderCanvas] canvas_config value was", typeof cfg.value, cfg.value, "on node", node.id, "-- resetting to '{}'");
        cfg.value = "{}";
    }
    if (!model.hasContent(state)) {
        cfg.value = "{}";
        return;
    }
    // A canvas restored from a workflow whose background came from the graph
    // has no background yet: baking would hand the graph a black frame, and
    // the backend prefers the composite over `image`. Pass the input through
    // once — the run returns the picture and the editor adopts it.
    if (state.bgPending && node.inputs?.find((i) => i.name === "image")?.link != null) {
        cfg.value = "{}";
        node._e2goCanvasSetStatus?.(
            "Refreshing the graph background before applying paint and mask…",
            { warn: true, ms: 9000 });
        return;
    }

    node._e2goCanvasCommitXform?.();
    // Refresh the server-side paint-layer files BEFORE the graph serializes
    // (the queue hook runs this ahead of the real queuePrompt), so onSerialize
    // writes fresh filenames and the draft never has to inline base64.
    await persistLayers(node, state);
    // Cheap gate: nothing touched the pixels since the last prepare (dirty
    // counter unchanged) -> cfg already reflects current content, skip.
    if (node._e2goLastPreparedDirty === state.dirty && cfg.value && cfg.value !== "{}") {
        return;
    }
    // Content-addressed snapshots retain the pixels of already queued jobs. setBackground
    // bumps `dirty` on every node execution regardless of pixel identity, so
    // the dirty counter alone would defeat the backend exec cache forever --
    // hash the bytes instead so an untouched canvas keeps producing identical
    // uploads (and thus an identical IS_CHANGED value) across queues.
    const dirty = state.dirty;
    const width = state.width, height = state.height;
    const compositeCanvas = model.bakeComposite(state);
    const maskCanvas = model.exportMaskCanvas(state);
    const [compositeBlob, maskBlob] = await Promise.all([canvasToBlob(compositeCanvas), canvasToBlob(maskCanvas)]);
    const compositeBytes = new Uint8Array(await compositeBlob.arrayBuffer());
    const maskBytes = new Uint8Array(await maskBlob.arrayBuffer());
    const [compositeDigest, maskDigest] = await Promise.all([digest(compositeBytes), digest(maskBytes)]);
    const fileKey = nodeFileKey(node);
    const compositeName = `${compositeDigest}_composite.png`;
    const maskName = `${maskDigest}_mask.png`;
    // fileKey in the hash: a tab rename changes the key -> one extra
    // re-upload, harmless; identical pixels under the SAME key still skip.
    const hash = `${fileKey}:${width}x${height}:${compositeDigest}:${maskDigest}`;

    if (node._e2goLastUploadHash === hash) {
        // Same pixels as last upload: keep existing files, just refresh cfg
        // (in case something cleared it) and record the dirty marker so the
        // cheap gate above can skip baking entirely next time.
        node._e2goLastPreparedDirty = dirty;
        cfg.value = JSON.stringify({ composite: compositeName, mask: maskName, hash });
        return;
    }
    await uploadPng(compositeBlob, compositeName);
    await uploadPng(maskBlob, maskName);
    // cfg only updates after both uploads succeed -- preserves partial-upload
    // safety (a failed second upload leaves cfg pointing at the prior pair).
    cfg.value = JSON.stringify({ composite: compositeName, mask: maskName, hash });
    node._e2goLastUploadHash = hash;
    node._e2goLastPreparedDirty = dirty;
    node._e2goCanvasSetStatus?.("Canvas saved", { warn: false });
}

// --- background pickup from ui.images ----------------------------------------

// /view URL for a file we uploaded to input/e2go_canvas/ (dropped background,
// or a persisted paint layer). Cache-busted so a re-uploaded same-name file is
// re-fetched.
function e2goInputUrl(name) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(name)}&subfolder=${CANVAS_SUBFOLDER}&type=input&t=${Date.now()}`
    );
}
const droppedBgUrl = e2goInputUrl;

// --- background sizing policy ------------------------------------------------
//
// Which resolution wins when a new background lands — the canvas's or the
// picture's. Persisted per node in `properties` (LiteGraph serializes those,
// so it survives save/load without touching the position-based widgets_values).
//   "auto"   - the picture's own size when the canvas has nothing to lose
//              (no paint pixels, no mask), the canvas's size once there IS work
//   "fit"    - always keep the canvas resolution, contain the picture in it
//   "native" - always adopt the picture's own resolution
export const BG_MODES = ["auto", "fit", "native"];
const BG_MODE_PROP = "e2goBgSize";

export function bgMode(node) {
    const m = node?.properties?.[BG_MODE_PROP];
    return BG_MODES.includes(m) ? m : "auto";
}

function setBgMode(node, mode) {
    if (!BG_MODES.includes(mode)) return;
    node.properties = node.properties || {};
    node.properties[BG_MODE_PROP] = mode;
}

// force: override the node's mode for this one load.
// autoIsFit: in "auto", behave as "fit" — used by the graph-result pickup,
//   where the canvas resolution is the render resolution and a returned image
//   must never move it (only an explicit "native" mode may).
function resolveFit(node, state, { force = null, autoIsFit = false } = {}) {
    if (!model.hasContent(state)) return false; // no canvas yet: the picture wins, always
    const mode = force || bgMode(node);
    if (mode === "native") return false;
    if (mode === "fit") return true;
    return autoIsFit ? true : !model.canvasIsPristine(state);
}

// Load a URL into the editor background: set model bg, LoadImage-like node
// auto-size, refit. Shared by the ui.images pickup and drag-and-drop.
function applyBackgroundFromUrl(node, state, url, sizing = {}) {
    // Generation token: of several concurrent loads (queue pickup vs. a
    // fresh drag-and-drop vs. onConfigure restore) only the LATEST may
    // land — decode order is not request order, so without this a slow
    // queue image silently replaced the user's just-dropped background.
    const gen = (node._e2goBgGen = (node._e2goBgGen || 0) + 1);
    let finishLoad;
    const pending = node._e2goBgLoad = new Promise(resolve => { finishLoad = resolve; });
    const img = new Image();
    img.onerror = () => {
        finishLoad(false);
        if (node._e2goBgGen !== gen) return;
        console.warn("[PowderCanvas] background failed to load:", url);
        node._e2goCanvasSetStatus?.("background image failed to load", { warn: true, ms: 6000 });
        node._e2goBackgroundReady?.(new Error("Background image failed to load"));
    };
    img.onload = () => {
        if (node._e2goBgGen !== gen) { finishLoad(true); return; }

        const fit = resolveFit(node, state, sizing);
        const targetW = fit ? state.width : img.naturalWidth;
        const targetH = fit ? state.height : img.naturalHeight;
        const sizeChanged = state.width !== targetW || state.height !== targetH;
        // Covers drag-drop, 📂 BG, paste-as-background, and the queue bg
        // pickup: a live Move frame must bake before the background (and
        // possibly the whole paint stack) is replaced. No-op if none is live.
        node._e2goCanvasCancelExpand?.();
        node._e2goCanvasCommitXform?.();
        const prevW = state.width, prevH = state.height;
        model.setBackground(state, img, targetW, targetH, { fit, undoable: !!sizing.undoable, preserveAlpha: !!sizing.preserveAlpha });
        node._e2goBackgroundReady?.();
        if (fit && (img.naturalWidth !== targetW || img.naturalHeight !== targetH)) {
            // Never silent: the picture on screen is no longer the file's own
            // pixels, and the black margins are canvas content the model will
            // see. Name the escape hatch too — without it "how do I get its
            // native size back" has no discoverable answer.
            const b = model.containBox(img.naturalWidth, img.naturalHeight, targetW, targetH);
            const bars = b.w !== targetW || b.h !== targetH;
            node._e2goCanvasSetStatus?.(
                `image ${img.naturalWidth}×${img.naturalHeight} fitted into the `
                + `${targetW}×${targetH} canvas (${b.w}×${b.h})`
                + `${bars ? " — black margins are canvas content; mask them to fill" : ""}`,
                {
                    ms: 12000,
                    // One click instead of "✕ clear, then drop again": reload
                    // the SAME url with the canvas size out of the way. Its
                    // paint/mask work is dropped by the resize — which is
                    // exactly what the old two-step escape hatch did too.
                    action: {
                        label: `↔ ${img.naturalWidth}×${img.naturalHeight}`,
                        title: "Resize the canvas to this picture's native size (drops paint layers and mask)",
                        fn: () => applyBackgroundFromUrl(node, state, url, { force: "native", undoable: true }),
                    },
                });
        } else if (sizeChanged && prevW > 1 && prevH > 1) {

            const shrink = targetW * targetH < prevW * prevH;
            node._e2goCanvasSetStatus?.(
                `background ${prevW}×${prevH} → ${state.width}×${state.height}`
                + `${shrink ? " — canvas got SMALLER, downstream renders follow" : ""}`,
                { warn: shrink, ms: 8000 });
        }

        node.setDirtyCanvas(true, true);
        node._e2goCanvasRedraw?.(sizeChanged);
        finishLoad(true);
    };
    img.src = url;
    return pending;
}

function loadBackgroundFromMessage(node, state, message) {
    // Custom ui key (see powder_canvas.py): ui.images would ALSO render the
    // frontend's native in-node preview, duplicating the editor.
    const im = Array.isArray(message?.e2go_canvas_bg) ? message.e2go_canvas_bg[0] : null;
    if (!im) return;
    const url = api.apiURL(
        `/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${im.type || "temp"}&t=${Date.now()}`
    );

    applyBackgroundFromUrl(node, state, url, { autoIsFit: true });
}

// Workflow-tab switches AND ComfyUI's workflow undo/redo DESTROY and
// re-create every node. Restoring from the (often stale) graph snapshot then
// rolled strokes/mask back — but the user decided graph undo must never touch
// canvas content. So the ENTIRE live canvas state is stashed when a node dies
// and adopted wholesale when it is re-created, bypassing the snapshot restore.
// Keyed by workflow + node id so two workflows with colliding node ids don't
// bleed into each other. Nothing here ever touches the workflow file.
let loadingCanvasWorkflow = false;
const sessionCanvas = new Map(); // "wfKey|nodeId" -> live state object
// Entries hold full-res canvases + up-to-20-deep undo/redo snapshots — a
// worst-case entry is hundreds of MB, so an entry-count cap alone could pin
// ~2 GB. Cap by estimated retained BYTES too, LRU-evicting oldest first.
const SESSION_CANVAS_CAP = 8;
const SESSION_CANVAS_BYTE_BUDGET = 512 * 1024 * 1024; // ~512 MB retained max
function stashBytes(entry) {
    const st = entry?.state;
    const reviewBytes = (entry?.review?.imgs || []).reduce((sum, img) =>
        sum + (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0) * 4, 0);
    if (!st?.width) return reviewBytes;
    const frame = st.width * st.height * 4;
    const undoDepth = (st.undoStack?.length || 0) + (st.redoStack?.length || 0);
    const layerCount = (st.layers?.length || 0) + 1; // +1 mask
    return frame * (layerCount + undoDepth) + reviewBytes;
}
function stashSet(key, entry) {
    sessionCanvas.delete(key); // re-insert = move to newest position
    sessionCanvas.set(key, entry);
    let total = 0;
    for (const e of sessionCanvas.values()) total += stashBytes(e);
    while (sessionCanvas.size > SESSION_CANVAS_CAP ||
           (total > SESSION_CANVAS_BYTE_BUDGET && sessionCanvas.size > 1)) {
        const oldestKey = sessionCanvas.keys().next().value;
        total -= stashBytes(sessionCanvas.get(oldestKey));
        sessionCanvas.delete(oldestKey); // oldest first
    }
}

function activeWfKey() {
    try {
        const wf = app.extensionManager?.workflow?.activeWorkflow;
        return String(wf?.path || wf?.key || "");
    } catch { return ""; }
}

function canvasStashKey(node) {
    return `${node._e2goWfKey || ""}|${node.id}`;
}

// Move the stashed state's fields into the fresh node's state object (the UI
// closure captured the object identity, so fields are copied, not swapped).
function adoptState(state, st) {
    state.width = st.width;
    state.height = st.height;
    state.layers = st.layers;
    state.bgPending = st.bgPending;
    state.mask = st.mask;
    state.rememberMask = st.rememberMask;
    state._maskFile = st._maskFile;
    state.activeLayer = st.activeLayer;
    state.paintSeq = st.paintSeq;
    state.undoStack = st.undoStack;
    state.redoStack = st.redoStack;
    // Carry the last-persisted server filenames so a serialize right after an
    // adopt (tab switch / graph undo) still references the layers; the pixels
    // are unchanged by the adopt, so the files stay valid.
    state._layerFiles = st._layerFiles;
    state.paintDirty = st.paintDirty || 0;
    state.dirty++;
}

// --- extension ---------------------------------------------------------------

// Review-result routing: a global "executed" listener is sturdier than
// patching the node prototype (works regardless of when/how the node type
// was registered, and logs its own delivery for diagnosis).
// Resolve an EXECUTION node id ("outer:inner" inside subgraphs) to the live
// graph node, walking subgraph boundaries segment by segment.
function findNodeByExecId(graph, execId) {
    if (execId == null) return null;
    const segs = String(execId).split(":");
    let g = graph, node = null;
    for (const s of segs) {
        node = g?.getNodeById?.(Number(s)) ?? g?.getNodeById?.(s) ?? null;
        if (!node) return null;
        g = node.subgraph;
    }
    return node;
}

// BFS upstream through input links for the PowderCanvas feeding this node.
function upstreamCanvas(start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
        const n = queue.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        if (n.comfyClass === "PowderCanvas" || n.type === "PowderCanvas") return n;
        for (const inp of n.inputs || []) {
            if (inp.link == null) continue;
            const links = n.graph?.links;
            const link = links?.get?.(inp.link) ?? links?.[inp.link];
            const src = link ? n.graph?.getNodeById?.(link.origin_id) : null;
            if (src) queue.push(src);
        }
    }
    return null;
}

api.addEventListener("executed", (ev) => {
    const output = ev?.detail?.output;
    const entries = Array.isArray(output?.e2go_canvas_review) ? output.e2go_canvas_review : [];
    if (!entries.length) return;
    const urls = entries.map((im) => api.apiURL(
        `/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${im.type || "temp"}&t=${Date.now()}`
    ));

    const revNode = findNodeByExecId(app.graph, ev?.detail?.node);
    let target = revNode ? upstreamCanvas(revNode) : null;
    if (!target) {
        const canvases = collectCanvasNodes(app.graph);
        if (!canvases.length) {
            console.warn("[PowderCanvasReview] results arrived but no PowderCanvas in the graph");
            return;
        }
        if (canvases.length > 1) {
            console.warn("[PowderCanvasReview] source canvas not traceable; delivering to the first one");
        }
        target = canvases[0];
    }

    const key = entries.map((im) => `${im.subfolder || ""}/${im.filename}`).join("|");
    if (target._e2goLastReviewKey === key) return;
    target._e2goLastReviewKey = key;
    console.info(`[PowderCanvasReview] delivering ${urls.length} result(s) to canvas #${target.id}`);
    target._e2goCanvasShowReview?.(urls, output.e2go_crop_box?.[0] || null);
});

app.registerExtension({
    name: "e2go_nodes.PowderCanvas",
    beforeLoadGraph() { loadingCanvasWorkflow = true; },
    onGraphLoadError() { loadingCanvasWorkflow = false; },
    afterLoadGraph() {
        loadingCanvasWorkflow = false;
        for (const node of collectCanvasNodes(app.graph)) {
            const restore = node._e2goRestoreAfterWorkflow;
            node._e2goRestoreAfterWorkflow = null;
            restore?.();
            node._e2goPendingCanvasInfo = null;
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowderCanvas") return;

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            origOnSerialize?.apply(this, arguments);

            if (this._e2goPendingCanvasInfo) {
                info.e2goCanvasEditor = this._e2goPendingCanvasInfo.e2goCanvasEditor;
                return;
            }
            if (this._e2goCanvasState) {
                info.e2goCanvasEditor = model.serializeState(this._e2goCanvasState);
            }
            if (this._e2goDroppedBg) {
                info.e2goCanvasEditor = { ...(info.e2goCanvasEditor || {}), droppedBg: this._e2goDroppedBg };
            }
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            if (nodeData.output_name?.includes("layout") && !this.outputs?.some(o => o.name === "layout")) this.addOutput("layout", "STRING");
            hideNamedWidget(this, CONFIG_WIDGET_NAME);
            hideNamedWidget(this, "layout_config");
            this._e2goLayoutReload?.();
            // properties (the bg sizing mode) land in this call, after the
            // editor was built — refresh the toolbar toggle. Before the early
            // returns below: the mode is independent of canvas content.
            this._e2goCanvasSyncBgMode?.();
            const restore = () => {
                const state = this._e2goCanvasState;
                if (!state) return;

                if (model.hasContent(state)) return;
                // Node re-created within this session (workflow undo/redo, tab
                // switch): adopt the LIVE canvas wholesale — strokes, mask, undo
                // stack, compare results — and ignore the graph snapshot. Checked
                // INDEPENDENTLY of the snapshot: undoing past the point where the
                // canvas first got content re-configures with ed=null, and the
                // stashed live canvas must still come back.
                const ed = info?.e2goCanvasEditor;
                // afterLoadGraph runs after ComfyUI activates the destination tab.
                // A matching node id in another workflow is never a valid fallback.
                const wfNow = activeWfKey();
                this._e2goWfKey = wfNow;
                const stashKey = canvasStashKey(this);
                const stash = wfNow ? sessionCanvas.get(stashKey) : null;
                if (stash?.state && (stash.state.width || stash.review?.imgs?.length)) {
                    sessionCanvas.delete(stashKey);
                    adoptState(state, stash.state);
                    this._e2goDroppedBg = stash.droppedBg || ed?.droppedBg || null;
                    if (stash.uiState) this._e2goCanvasSetUiState?.(stash.uiState);
                    if (stash.review) this._e2goCanvasSetReview?.(stash.review);
                    this._e2goLastReviewKey = stash.lastReviewKey;
                    // A restored relView is applied via pendingRelView on the next
                    // sized redraw — do NOT force a refit (refit=false), which
                    // would arm the ResizeObserver to clobber it. No stored view
                    // -> refit for a clean fit.
                    this._e2goCanvasRedraw?.(stash.uiState?.relView ? false : true);
                    return;
                }
                if (!ed) return;
                // sizing: the recovery bg is the ORIGINAL file, which may be larger
                // than the canvas it was fitted into. Restoring a saved size must
                // reproduce the workflow exactly, so that path forces "fit"; with
                // no saved size the normal mode decides (there is no canvas yet
                // anyway, so the picture wins).
                const finishWithDroppedBg = (sizing = {}) => {
                    if (ed.droppedBg) {
                        this._e2goDroppedBg = ed.droppedBg;
                        return applyBackgroundFromUrl(this, state, droppedBgUrl(ed.droppedBg), sizing);
                    }
                };
                if (ed.width && ed.height) {
                    // New saves reference paint layers by server filename; turn
                    // those into /view URLs restoreState can load (old saves keep
                    // their inline dataUrl and pass through untouched). A restored
                    // layer's filename is also re-seeded onto _layerFiles so the
                    // first serialize after load doesn't drop it before the next
                    // persist runs.
                    if (Array.isArray(ed.paintLayers)) {
                        for (const l of ed.paintLayers) {
                            if (l && l.file && !l.dataUrl) l.dataUrl = e2goInputUrl(l.file);
                        }
                        state._layerFiles = ed.paintLayers
                            .filter((l) => l && l.file)
                            .map((l) => ({ file: l.file, visible: l.visible !== false, name: l.name || null }));
                    }
                    if (ed.rememberMask && ed.maskFile) ed.maskDataUrl = e2goInputUrl(ed.maskFile);
                    this._e2goRestoreLoad = model.restoreState(state, ed).then(() => {
                        this._e2goCanvasRedraw?.();
                        // setBackground preserves same-size paint/mask, so the
                        // dropped bg loads AFTER strokes are back.
                        return finishWithDroppedBg({ force: "fit", preserveAlpha: true });
                    }).catch((e) => {
                        // A corrupt layer dataUrl rejects mid-loop; recover what
                        // we can (bg at least) instead of a dead half-state.
                        console.warn("[PowderCanvas] snapshot restore failed:", e);
                        this._e2goCanvasRedraw?.();
                        finishWithDroppedBg({ force: "fit", preserveAlpha: true });
                        return false;
                    });
                } else {
                    finishWithDroppedBg();
                }
            };
            if (loadingCanvasWorkflow) {
                this._e2goPendingCanvasInfo = info;
                this._e2goRestoreAfterWorkflow = restore;
            } else restore();
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "PowderCanvas") return;

        installQueueHook();
        hideNamedWidget(node, CONFIG_WIDGET_NAME);
        hideNamedWidget(node, "layout_config");

        const state = model.createState();
        node._e2goCanvasState = state;

        node._e2goWfKey = activeWfKey();
        // Debounced server persist of the paint stack on idle: the queue hook
        // persists synchronously before every prompt, and this is the
        // between-queues safety net so an explicit .json save (no intervening
        // Queue) still captures recent strokes. Fired from the editor's redraw
        // via this hook; cheap (early-returns unless the pixels actually
        // changed since the last persist).
        let persistTimer = null;

        node._e2goCanvasPersistLayers = () => {
            clearTimeout(persistTimer);
            return persistLayers(node, state);
        };
        node._e2goCanvasOpenStorage = () => openCanvasStorage();
        node._e2goCanvasSaveWorkflow = async () => {
            const graph = app.rootGraph || app.graph;
            const workflow = app.extensionManager?.workflow?.activeWorkflow;
            try {
                node._e2goCanvasSetSaveState?.("Saving Canvas and workflow…");
                const versions = new Map();
                for (const n of collectCanvasNodes(graph)) {
                    if (await n._e2goCanvasWaitForLoad() === false) throw new Error("Canvas could not finish loading. Reload its missing image before saving.");
                    n._e2goCanvasCommitXform?.();
                    // Include changes made during an upload; do not save stale pixels.
                    let stable = false;
                    for (let attempt = 0; attempt < 3 && !stable; attempt++) {
                        const st = n._e2goCanvasState;
                        const version = `${st.dirty}:${st.paintDirty}`;
                        if (!await n._e2goCanvasPersistBase() || !await n._e2goCanvasPersistLayers()) {
                            throw new Error("Canvas upload failed. Retry saving.");
                        }
                        stable = version === `${st.dirty}:${st.paintDirty}`;
                    }
                    if (!stable) throw new Error("Canvas is still changing. Finish editing and save again.");
                    versions.set(n, `${n._e2goCanvasState.dirty}:${n._e2goCanvasState.paintDirty}`);
                }
                if ([...versions].some(([n, version]) => version !== `${n._e2goCanvasState.dirty}:${n._e2goCanvasState.paintDirty}`)) throw new Error("Canvas changed during saving. Save again after editing.");
                if (graph !== (app.rootGraph || app.graph) || workflow !== app.extensionManager?.workflow?.activeWorkflow) {
                    throw new Error("Workflow changed during saving. Save the current workflow again.");
                }
                const command = app.extensionManager?.command;
                if (command?.execute) await command.execute("Comfy.SaveWorkflow");
                else {
                    // Classic frontends without the command service still support JSON workflows.
                    const url = URL.createObjectURL(new Blob([JSON.stringify(graph.serialize(), null, 2)], { type: "application/json" }));
                    const a = document.createElement("a"); a.href = url; a.download = "workflow.json"; a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
                node._e2goCanvasSetSaveState?.("Canvas saved — workflow save requested");
                return true;
            } catch (error) {
                node._e2goCanvasSetSaveState?.("Save failed");
                node._e2goCanvasSetStatus?.(error.message, { warn: true, ms: 12000 });
                return false;
            }
        };
        node._e2goOnCanvasChanged = () => {
            // Only schedule when a PAINT layer changed (mask/view churn is
            // ignored — see persistLayers), so mask painting stays smooth.
            if ((state.paintDirty || 0) === node._e2goLayersPersistedPaint
                && (!state.rememberMask || (state.dirty || 0) === node._e2goMaskPersistedDirty)) return;
            if (!node._e2goPersistBusy) node._e2goCanvasSetSaveState?.("Layer changes pending");
            clearTimeout(persistTimer);
            persistTimer = setTimeout(() => persistLayers(node, state), 2000);
        };
        // Stash the whole live canvas when the node dies (undo/redo, workflow
        // switch) — canvas objects are kept by reference, no encode cost.
        const prevOnRemoved = node.onRemoved;
        node.onRemoved = function (...args) {
            if (typeof prevOnRemoved === "function") {
                try { prevOnRemoved.apply(this, args); } catch {}
            }
            clearTimeout(persistTimer);
            const st = this._e2goCanvasState;
            const review = this._e2goCanvasGetReview?.() || null;
            if (st && (model.hasContent(st) || review?.imgs?.length)) {
                stashSet(canvasStashKey(this), {
                    state: st,
                    droppedBg: this._e2goDroppedBg,
                    review,
                    lastReviewKey: this._e2goLastReviewKey,
                    uiState: this._e2goCanvasGetUiState?.() || null,
                });
            }
        };
        node._e2goCanvasPrepare = () => prepareNode(node, state);
        node._e2goCanvasRefresh = () => refreshNode(node, state);
        // Replace the background with an image blob: upload to input/e2go_canvas/
        // and load it like a graph preview. Shared by drag-and-drop and the
        // toolbar's Load-base (📂) file picker.
        // Remove the image entirely: empty canvas + no recovery bg, so neither
        // a reload nor a workflow save brings it back.
        node._e2goCanvasClearBase = () => {
            node._e2goCanvasCancelExpand?.();
            node._e2goDroppedBg = null;
            sessionCanvas.delete(canvasStashKey(node));
            model.resetState(state, { undoable: true });
            node._e2goCanvasRedraw?.(false);
        };
        // Re-upload the CURRENT background pixels into the recovery-bg slot
        // WITHOUT reloading them into the editor — outpaint grows the bg in
        // place, and a reload restoring the old file at the old size would
        // wipe the paint stack via the size-change rule.
        node._e2goCanvasPersistBase = async () => {
            try {
                const bg = state.layers?.[0]?.canvas;
                if (!bg || state.bgPending) { if (!bg) node._e2goDroppedBg = null; return true; }
                const blob = await canvasToBlob(bg);
                const name = `${await digest(new Uint8Array(await blob.arrayBuffer()))}_dropped.png`;
                await uploadPng(blob, name);
                node._e2goDroppedBg = name;
                return true;
            } catch (err) {
                console.warn("[PowderCanvas] base persist failed:", err);
                return false;
            }
        };
        // Background-sizing mode (auto/fit/native), read+written by the toolbar
        // toggle. Lives in node.properties so LiteGraph persists it with the
        // workflow; the editor never imports from this module (circular).
        node._e2goCanvasGetBgMode = () => bgMode(node);
        node._e2goCanvasSetBgMode = (mode) => setBgMode(node, mode);
        // sizing (optional): same options as applyBackgroundFromUrl —
        // { force: "native" | "fit" }. The blank-canvas maker passes
        // force:"native" because a size the user TYPED must not be letterboxed
        // into the old canvas.
        // Serialize drops so an older upload cannot replace the visible
        // background after a newer drop. Files are immutable snapshots.
        let dropSeq = 0;
        let dropChain = Promise.resolve();
        node._e2goCanvasWaitForLoad = async () => {
            if (await dropChain === false || await node._e2goRestoreLoad === false) return false;
            return await node._e2goBgLoad !== false;
        };
        node._e2goCanvasReset = async () => {
            ++dropSeq;
            await node._e2goCanvasWaitForLoad();
            while (node._e2goPersistBusy) await node._e2goPersistBusy;
            clearTimeout(persistTimer);
            node._e2goDroppedBg = null;
            node._e2goLastReviewKey = null;
            node._e2goLastPreparedDirty = null;
            sessionCanvas.delete(canvasStashKey(node));
            model.resetState(state);
            state.bgPending = false;
            state._layerFiles = [];
            const cfg = node.widgets?.find(w => w.name === CONFIG_WIDGET_NAME);
            if (cfg) cfg.value = "{}";
            node._e2goCanvasRedraw?.(false);
        };
        node._e2goCanvasLoadBase = (blob, sizing = {}) => {
            const seq = ++dropSeq;
            dropChain = dropChain.then(() => (seq === dropSeq ? loadBase(blob, sizing) : null));
            return dropChain;
        };
        const loadBase = async (blob, sizing) => {
            try {
                // Saved workflows retain their own background even after
                // another drop into this same editor.
                const name = `${await digest(new Uint8Array(await blob.arrayBuffer()))}_dropped.png`;
                await uploadPng(blob, name);
                node._e2goDroppedBg = name;
                return await applyBackgroundFromUrl(node, state, droppedBgUrl(name), { ...sizing, undoable: true });
            } catch (err) {
                console.warn("[PowderCanvas] load base failed:", err);
                return false;
            }
        };

        const container = document.createElement("div");
        container.style.cssText =
            "display:flex;flex-direction:column;width:100%;height:100%;min-height:220px;overflow:hidden;";

        container.addEventListener("pointerdown", () => {
            const wf = activeWfKey();
            if (wf) node._e2goWfKey = wf;
        }, true);
        const widget = node.addDOMWidget("e2go_canvas_ui", "div", container, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 260,
        });
        node._e2goCanvasContainer = container;

        mountCanvasEditor(node, state, container);

        // The editor deliberately has no wheel behavior (nav is buttons-only);
        // DOM widgets swallow wheel events, so re-dispatch them to the graph
        // canvas — wheel over the node zooms the graph like on any other node.
        container.addEventListener(
            "wheel",
            (e) => {
                const target = app.canvas?.canvas;
                if (!target) return;
                e.preventDefault();
                e.stopPropagation();
                target.dispatchEvent(new WheelEvent("wheel", e));
            },
            { passive: false }
        );

        // Layout owns middle-button panning inside its workspace.
        // Elsewhere middle-button drag pans the graph; DOM widgets
        // swallow the pointer events. Re-dispatch the pointerdown to the
        // graph canvas -- LiteGraph pointer-captures and handles the rest of
        // the drag itself. Capture phase so nav buttons can't stop it first.
        container.addEventListener(
            "pointerdown",
            (e) => {
                if (e.button !== 1) return;
                if (e.target.closest?.(".e2go-layout-work")) return;
                const target = app.canvas?.canvas;
                if (!target) return;
                e.preventDefault();
                e.stopPropagation();
                target.dispatchEvent(new PointerEvent("pointerdown", e));
            },
            { capture: true }
        );

        // Drag-and-drop an image file straight onto the node: upload it to
        // input/e2go_canvas/ and make it the editor background. The baked
        // composite carries it into the graph, so the backend is untouched.
        const ASSET_MIME = "application/x-comfy-asset-info"; // Assets-panel drags: JSON with {src: url}
        container.addEventListener("dragover", (e) => {
            const types = e.dataTransfer?.types || [];
            if (types.includes("Files") || types.includes(ASSET_MIME)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|tiff?|jfif|ico)$/i;
        const isImageFile = (f) => f.type.startsWith("image/") || (!f.type && IMG_EXT.test(f.name || ""));
        container.addEventListener("drop", async (e) => {
            const file = [...(e.dataTransfer?.files || [])].find(isImageFile);
            let assetSrc = null;
            if (!file) {
                try {
                    assetSrc = JSON.parse(e.dataTransfer?.getData(ASSET_MIME) || "null")?.src || null;
                } catch {}
                if (!assetSrc) {
                    // Plain URL drags (e.g. an <img> dragged from elsewhere in the page).
                    const uri = (e.dataTransfer?.getData("text/uri-list") || "").split("\n")[0].trim();
                    if (uri && !uri.startsWith("#")) assetSrc = uri;
                }
            }
            if (!file && !assetSrc) return; // let ComfyUI handle non-image drops (workflows)
            e.preventDefault();
            e.stopPropagation();
            try {
                let blob = file;
                if (!blob) {
                    const res = await fetch(assetSrc);
                    if (!res.ok) throw new Error(`fetch ${res.status} for dropped asset`);
                    blob = await res.blob();
                    if (!blob.type.startsWith("image/")) throw new Error(`dropped asset is ${blob.type || "unknown"}, not an image`);
                }
                await node._e2goCanvasLoadBase(blob);
            } catch (err) {
                console.warn("[PowderCanvas] drop failed:", err);
            }
        });

        const prevOnExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            if (typeof prevOnExecuted === "function") {
                try { prevOnExecuted.apply(this, arguments); } catch {}
            }
            const hadBg = Array.isArray(message?.e2go_canvas_bg) && message.e2go_canvas_bg.length > 0;
            if (!hadBg) node._e2goBackgroundReady?.(new Error("The connected branch returned no background"));
            loadBackgroundFromMessage(node, state, message);
            if (node._e2goRefreshPending) {
                node._e2goRefreshPending = false;
                if (!hadBg) node._e2goCanvasSetStatus?.(
                    "graph returned no image — upstream node muted/bypassed or nothing wired into `image`?",
                    { warn: true, ms: 7000 });
            }
        };

        if (!node.size || node.size[1] < 420) node.setSize([420, 480]);
        scheduleReHide(node, CONFIG_WIDGET_NAME, () => {});
        scheduleReHide(node, "layout_config", () => {});
    },
});
