// One cache selector; normalize the legacy boolean when restoring a workflow.

import { app } from "../../../scripts/app.js";
import { hideNamedWidget, scheduleReHide } from "./e2go_hide_utils.js";

app.registerExtension({
    name: "e2go.powder_conditioner.cache_ui",

    nodeCreated(node) {
        if (node.comfyClass !== "PowderConditioner") return;

        // consumer_mode is written by the server when the prompt is queued
        // (powder_conditioner.stamp_consumer_modes) — nothing to show or edit.
        hideNamedWidget(node, "consumer_mode");
        scheduleReHide(node, "consumer_mode");

        const useCacheWidget = node.widgets?.find(w => w.name === "use_cache");
        const cacheModeWidget = node.widgets?.find(w => w.name === "cache_mode");

        if (!useCacheWidget || !cacheModeWidget) return;

        // Sync cache_mode visual state with use_cache value.
        const syncCacheModeState = () => {
            if (useCacheWidget.value === false) cacheModeWidget.value = "disabled";
            useCacheWidget.value = true;
            cacheModeWidget.disabled = false;
            hideNamedWidget(node, "use_cache");
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


        const prevOnConfigure = node.onConfigure;
        node.onConfigure = function () {
            const r = prevOnConfigure?.apply(this, arguments);
            syncCacheModeState();
            requestAnimationFrame(syncCacheModeState); // belt-and-braces post-restore
            return r;
        };
    },
});
