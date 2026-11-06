// Powder Clear Conditioning Cache — "Clear now" button.
//
// Adds a button to the ClearConditioningCache node that increments the
// `trigger` INT widget. ComfyUI's IS_CHANGED logic on the Python side picks
// up the new value on the next queue and clears the cache.
//
// Manual editing of the trigger field also works; the button is just a
// shortcut for the common "I want to clear right now" case.

import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "e2go.clear_conditioning_cache.button",

    nodeCreated(node) {
        if (node.comfyClass !== "ClearConditioningCache") return;

        const triggerWidget = node.widgets?.find(w => w.name === "trigger");
        if (!triggerWidget) return;

        // Avoid adding the button twice if the extension is reloaded. Dedup
        // on a stable marker rather than the label string — LiteGraph renders
        // a button widget's NAME as its on-canvas label, so matching on
        // "Clear now" breaks the moment the label is changed for feedback
        // (see the temporary "✓ Cleared (queued)" swap below).
        if (node.widgets.find(w => w._e2goClearButton)) return;

        // PLATFORM GOTCHA: this frontend's workflow-save path IGNORES a
        // widget's `serialize: false` flag — every widget's `.value` still
        // lands positionally in the saved widgets_values array on restore.
        // ClearConditioningCache has only `trigger` besides this button, so
        // it's harmless today, but to stay restore-proof we keep this
        // widget's `.value` a harmless constant (null, never reassigned) —
        // only its `.name` (the on-canvas label) changes at runtime, and
        // `.name` is not part of widgets_values. No onSerialize/onConfigure
        // machinery needed for a single decoration widget — an inert value
        // is sufficient.
        const ORIGINAL_LABEL = "Clear now";
        let restoreTimer = null;

        const btn = node.addWidget(
            "button",
            ORIGINAL_LABEL,
            null,
            () => {
                // Wrap-around at INT max (999999 per ClearConditioningCache schema).
                const next = (triggerWidget.value + 1) % 1000000;
                triggerWidget.value = next;


                // Transient feedback only — the clear itself happens on the
                // next queue run (IS_CHANGED picks up the new trigger value),
                // so the label says "queued", not "cleared", to avoid
                // overpromising. Guard against overlapping clicks by
                // resetting any pending restore timer.
                if (restoreTimer) clearTimeout(restoreTimer);
                btn.name = "✓ Cleared (queued)";
                node.setDirtyCanvas(true, true);
                restoreTimer = setTimeout(() => {
                    btn.name = ORIGINAL_LABEL;
                    restoreTimer = null;
                    node.setDirtyCanvas(true, true);
                }, 1500);
            },
            { serialize: false }
        );
        btn._e2goClearButton = true;
    },
});
