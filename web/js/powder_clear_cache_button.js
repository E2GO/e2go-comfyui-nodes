// Powder Clear Conditioning Cache — "Clear now" button.
//
// Adds a button to the ClearConditioningCache node that increments the
// `trigger` INT widget. ComfyUI's IS_CHANGED logic on the Python side picks
// up the new value on the next queue and clears the cache.
//
// Manual editing of the trigger field also works; the button is just a
// shortcut for the common "I want to clear right now" case.

import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "e2go.clear_conditioning_cache.button",

    nodeCreated(node) {
        if (node.comfyClass !== "ClearConditioningCache") return;

        const triggerWidget = node.widgets?.find(w => w.name === "trigger");
        if (!triggerWidget) return;

        // Avoid adding the button twice if the extension is reloaded.
        if (node.widgets.find(w => w.name === "_clear_now_button")) return;

        node.addWidget(
            "button",
            "_clear_now_button",
            "Clear now",
            () => {
                // Wrap-around at INT max (999999 per ClearConditioningCache schema).
                const next = (triggerWidget.value + 1) % 1000000;
                triggerWidget.value = next;

                node.setDirtyCanvas(true, true);

                console.log(`[ClearConditioningCache] trigger=${next} — cache will clear on next queue`);
            },
            { serialize: false }
        );
    },
});
