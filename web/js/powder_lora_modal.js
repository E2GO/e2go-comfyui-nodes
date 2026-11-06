// powder_lora_modal.js — thin adapter over the shared modal core (C2/C3).
//
// Owns the lora library fetch/cache and lazy per-lora trigger-word tooltip;
// delegates all modal machinery to e2go_modal.openModal. Multi-select only
// (no pick mode — lora nodes always work off a live selection list).
//
// C4 contract (implemented by web/js/powder_lora.js, NOT here):
//   node._e2goFetchTrigger(entry) — optional hook invoked right after a
//   lora is ADDED to node.selectedLoras (not on remove, not on toggle-off).
//   This module only fires the hook; it does not fetch/write the trigger
//   into node state itself — that responsibility (and the entry's `trigger`
//   field population) belongs to C4's node code, matching the existing
//   auto-fetch-on-add behavior described in the design doc.
//
// node.selectedLoras entries (new-add shape, C4 serializes this into
// lora_config): { lora, enabled, modelStr, clipStr, trigger, useTrigger }

import { app } from "../../../scripts/app.js";
// api.fetchApi, not bare fetch: it prefixes the frontend's api_base, so these
// calls still resolve when ComfyUI is served under a sub-path (reverse proxy).
// Every custom route is mirrored under /api by server.py's add_routes.
import { api } from "../../../scripts/api.js";
import { openModal } from "./e2go_modal.js";


function collectLoraNodes(graph, out = [], visited = new Set()) {
    if (!graph || visited.has(graph)) return out;
    visited.add(graph);
    for (const n of graph._nodes || []) {
        if (n.comfyClass === "PowderLoraLoader") out.push(n);
        if (n.subgraph) collectLoraNodes(n.subgraph, out, visited);
    }
    return out;
}

const FAVORITES_KEY = "e2go.lora.favorites";

let _libraryPromise = null;

export function getLoraLibrary() {
    _libraryPromise ||= api.fetchApi("/powder_lora/get_loras")
        .then((r) => r.json())
        .then((data) => {
            const loras = Array.isArray(data?.loras) ? data.loras : [];
            // byName is derived by the modal core from the items array — no
            // need to precompute (was dead per-fetch work).
            return { loras };
        })
        .catch((err) => {
            _libraryPromise = null; // allow retry on next open
            throw err;
        });
    return _libraryPromise;
}

// Lazy trigger-word tooltip cache: module-level, keyed by lora name. Caches
// both successes (including empty-string triggers) and failures, so a lora
// is only ever fetched once per session regardless of how many times its
// row is rendered/re-rendered across modal opens.
const _triggerCache = new Map(); // name -> Promise<string>

function fetchTriggerTooltip(loraName) {
    let p = _triggerCache.get(loraName);
    if (p) return p;
    p = api.fetchApi(`/powder_lora/get_trigger?lora=${encodeURIComponent(loraName)}`)
        .then((r) => r.json())
        .then((data) => {
            const trigger = (data?.trigger || "").trim();
            if (!trigger) return "(no trigger file)";
            return trigger.length > 300 ? trigger.slice(0, 300) + "…" : trigger;
        })
        .catch(() => "(trigger unavailable)");
    _triggerCache.set(loraName, p);
    return p;
}

// Loader thunk so the core holds the overlay guard while the library fetches
// (same timing as the styler adapter).
const loraItems = () => getLoraLibrary().then((lib) => lib.loras);

export async function openLoraModal(node) {
    return openModal({
        mode: "multi",
        title: "LoRA library",
        favoritesKey: FAVORITES_KEY,
        searchPlaceholder: "Search loras…",
        items: loraItems,
        onLoadError: (err) => console.warn("[PowderLora] lora library unavailable:", err),
        tooltipFor: (l) => fetchTriggerTooltip(l.name),

        onRefresh: async () => {
            _libraryPromise = null;
            _triggerCache.clear();
            const lib = await getLoraLibrary();
            for (const n of collectLoraNodes(app.graph)) {
                n._e2goLibraryRefreshed?.(lib);
            }
            return lib.loras;
        },
        // Read node.selectedLoras fresh each call (not captured), so it always
        // reflects the latest mutations from onToggleItem/elsewhere.
        isSelected: (l) => (node.selectedLoras || []).some((x) => x.lora === l.name),
        onToggleItem: (l) => {
            const list = node.selectedLoras || (node.selectedLoras = []);
            const i = list.findIndex((x) => x.lora === l.name);
            if (i >= 0) {
                list.splice(i, 1);
            } else {
                const entry = {
                    lora: l.name,
                    enabled: true,
                    modelStr: 1.0,
                    clipStr: 1.0,
                    trigger: "",
                    useTrigger: true,
                };
                list.push(entry);
                // C4 contract: fire-and-forget hook, node owns the fetch +
                // writing the result into this entry's `trigger` field.
                node._e2goFetchTrigger?.(entry);
            }
            node._e2goApplyLayout?.();
        },
        onClose: () => node._e2goApplyLayout?.(),
    });
}
