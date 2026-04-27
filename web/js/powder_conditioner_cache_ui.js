// Powder Conditioner — UI: disable cache_mode when use_cache=false.
//
// The Python side already treats use_cache=false as overriding cache_mode,
// so this purely cosmetic change keeps the UI honest.

import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "e2go.powder_conditioner.cache_ui",

    nodeCreated(node) {
        if (node.comfyClass !== "PowderConditioner") return;

        const useCacheWidget = node.widgets?.find(w => w.name === "use_cache");
        const cacheModeWidget = node.widgets?.find(w => w.name === "cache_mode");

        if (!useCacheWidget || !cacheModeWidget) return;

        // Sync cache_mode visual state with use_cache value.
        const syncCacheModeState = () => {
            const enabled = useCacheWidget.value === true;
            cacheModeWidget.disabled = !enabled;

            // Fallback dimming for themes where `disabled` alone isn't visible.
            if (cacheModeWidget.element) {
                cacheModeWidget.element.style.opacity = enabled ? "1.0" : "0.4";
            }

            node.setDirtyCanvas(true, true);
        };

        // Wrap the use_cache callback to keep any existing logic + add ours.
        const originalCallback = useCacheWidget.callback;
        useCacheWidget.callback = function (value) {
            if (originalCallback) originalCallback.call(this, value);
            syncCacheModeState();
        };

        // Initial sync (in case the node loads with use_cache=false).
        syncCacheModeState();
    },
});
