// powder_resolution.js — sections, swap button, live size readout and
// mode-driven widget locking for Powder Resolution (spec rev 2).
// Separator + name-keyed restore pattern mirrors powder_image_cond.js.

import { app } from "../../../scripts/app.js";
import { widgetTextColor, widgetSecondaryTextColor, widgetFont, noop, markSeparator, setWidgetVisible } from "./e2go_hide_utils.js";
import { installNameKeyedPersistence } from "./e2go_persistence.js";

const NODE_TYPE = "PowderResolution";

// Section headers inserted BEFORE these input widgets.
const SECTIONS = [
    ["aspect_ratio", "═══ Presets ═══"],
    ["custom_ratio", "═══ Custom ratio ═══"],
    ["custom_mode", "═══ Custom size ═══"],
    ["batch_size", "═══ Latent ═══"],
    ["divisible_by", "═══ Fine-tuning ═══"],
];

// Same as powder_cache_stats.js: addWidget does not auto-resize the node on
// this frontend, so grow it explicitly after decorations appear.
function requestResize(node) {
    const graphRef = app.graph;
    requestAnimationFrame(() => {
        if (app.graph !== graphRef) return;
        try {
            node.setSize([node.size?.[0] || 320, node.computeSize()[1]]);
        } catch {}
        app.graph?.setDirtyCanvas(true, true);
    });
}

// Python round() is banker's rounding; Math.round is not. Mirror Python so
// the live readout matches the backend bit-for-bit at exact .5 boundaries.
function pyRound(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}


export function computeLive(node) {
    const v = (name) => node.widgets?.find((w) => w.name === name)?.value;
    // The backend model owns this format; do not invent a /8 preview.
    if (v("latent_type") === "Auto (connected model)") return null;
    // latent grid of the chosen latent_type — the label carries it ("/16"), 8 otherwise
    const ds = parseInt(/\/(\d+)\)/.exec(v("latent_type") || "")?.[1] || "8", 10) || 8;
    // backend parity: the snap grid is never finer than the latent grid
    const divis = Math.max(parseInt(v("divisible_by") || "64", 10) || 64, ds);

    if (v("custom_mode")) {
        let w = Math.trunc(Number(v("width")) || 0);
        let h = Math.trunc(Number(v("height")) || 0);
        if (v("round_custom")) {
            w = pyRound(w / divis) * divis;
            h = pyRound(h / divis) * divis;
        } else if (w % ds || h % ds) {

            w = Math.floor(w / ds) * ds;
            h = Math.floor(h / ds) * ds;
        }
        if (w <= 0 || h <= 0) return null;
        return [w, h, "custom"];
    }

    let rx, ry, label;
    if (v("custom_ratio")) {
        rx = parseFloat(v("ratio_x"));
        ry = parseFloat(v("ratio_y"));
        label = `${rx}:${ry}`;
    } else {
        label = String(v("aspect_ratio") || "1:1").split(" ")[0];
        const parts = label.split(":");
        rx = parseFloat(parts[0]);
        ry = parseFloat(parts[1]);
    }
    if (!(rx > 0) || !(ry > 0)) return null;

    const mp = parseFloat(v("megapixel") || "1.0");
    const dim = Math.sqrt((mp * 1e6) / (rx * ry));
    const w = pyRound(Math.trunc(dim * rx) / divis) * divis;
    const h = pyRound(Math.trunc(dim * ry) / divis) * divis;
    if (w <= 0 || h <= 0) return null;
    return [w, h, label];
}

// Lock rules (spec rev 2): custom_mode > custom_ratio > preset; whatever a
// mode blocks is grayed AND mouse-dead (disabled widgets get no events).
function syncLocks(node) {
    const find = (name) => node.widgets?.find((w) => w.name === name);
    const cm = !!find("custom_mode")?.value;
    const cr = !!find("custom_ratio")?.value;
    const rc = !!find("round_custom")?.value;
    const set = (name, dis) => { const w = find(name); if (w) w.disabled = dis; };
    set("aspect_ratio", cm || cr);
    set("megapixel", cm);
    set("custom_ratio", cm);
    set("ratio_x", cm || !cr);
    set("ratio_y", cm || !cr);
    set("width", !cm);
    set("height", !cm);
    set("round_custom", !cm);
    set("divisible_by", cm && !rc);
    if (node._e2goSwapBtn) node._e2goSwapBtn.disabled = !cm;
    for (const name of ["custom_mode", "custom_ratio"]) setWidgetVisible(find(name), false);
    for (const name of ["aspect_ratio", "megapixel", "ratio_x", "ratio_y", "width", "height", "round_custom", "divisible_by"]) {
        setWidgetVisible(find(name), !find(name)?.disabled);
    }
    setWidgetVisible(node._e2goSwapBtn, cm);
    for (const [anchor, title] of SECTIONS) {
        setWidgetVisible(find(title), anchor === "batch_size" || (anchor === "divisible_by" && !(cm && !rc)));
    }
    if (node._sizeMode) node._sizeMode.value = cm ? "Pixels" : cr ? "Ratio" : "Preset";
    requestResize(node);
}

app.registerExtension({
    name: "e2go_nodes.PowderResolution",

    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        // Name-keyed persistence (e2go_persistence.js): widgets_values is
        // POSITION-based and serialize:false is ignored on save — the
        // rewritten positional array carries exactly the real inputs, so the
        // separators/button/badge decorations below cost no slot.
        const { findW } = installNameKeyedPersistence(node, {
            afterRestore: (saved) => { if (saved) syncLocks(node); },
        });
        node._sizeMode = node.addWidget("combo", "Size mode", "Preset", value => {
            findW("custom_mode").value = value === "Pixels";
            findW("custom_ratio").value = value === "Ratio";
            syncLocks(node);
        }, { values: ["Preset", "Ratio", "Pixels"] });
        node._sizeMode.serialize = false;
        node.widgets.splice(node.widgets.indexOf(node._sizeMode), 1);
        node.widgets.unshift(node._sizeMode);


        for (const name of ["custom_mode", "custom_ratio", "round_custom"]) {
            const w = findW(name);
            if (!w) continue;
            const prevCb = w.callback;
            w.callback = function () {
                if (typeof prevCb === "function") { try { prevCb.apply(this, arguments); } catch {} }
                syncLocks(node);
                app.graph?.setDirtyCanvas(true, true);
            };
        }
        const prevOnWidgetChanged = node.onWidgetChanged;
        node.onWidgetChanged = function () {
            if (typeof prevOnWidgetChanged === "function") {
                try { prevOnWidgetChanged.apply(this, arguments); } catch {}
            }
            syncLocks(node);
            app.graph?.setDirtyCanvas(true, true);
        };

        requestAnimationFrame(() => {
            // Group separators, inserted before their anchor widgets.
            for (const [anchorName, title] of SECTIONS) {
                const anchor = (node.widgets || []).findIndex((w) => w.name === anchorName);
                if (anchor === -1) continue;
                const sep = node.addWidget("text", title, "", noop);
                sep.serialize = false;
                markSeparator(sep, title, node);
                // addWidget appends; move it into place.
                node.widgets.splice(node.widgets.indexOf(sep), 1);
                node.widgets.splice(anchor, 0, sep);
            }

            // Swap BUTTON (custom-size only): swaps the width/height field
            // values in place. A button, not a toggle — nothing serialized.
            const swapBtn = node.addWidget("button", "⇆ swap width ↔ height", null, () => {
                const wW = findW("width");
                const hW = findW("height");
                if (!wW || !hW || !findW("custom_mode")?.value) return;
                const tmp = wW.value;
                wW.value = hW.value;
                hW.value = tmp;
                app.graph?.setDirtyCanvas(true, true);
            });
            swapBtn.serialize = false;
            node._e2goSwapBtn = swapBtn;
            // Move it right after "height".
            const hIdx = (node.widgets || []).findIndex((w) => w.name === "height");
            if (hIdx !== -1) {
                node.widgets.splice(node.widgets.indexOf(swapBtn), 1);
                node.widgets.splice(hIdx + 1, 0, swapBtn);
            }

            // Live size readout: recomputed every draw from current widget
            // values (formula mirrored from the backend) — no execution
            // needed. Inert "" value, appended last (serialize gotcha).
            const badge = node.addWidget("text", "result", "", noop);
            badge.serialize = false;
            badge.disabled = true;

            badge.computeSize = () => [node.size?.[0] || 320, 24];

            badge.draw = function (ctx, _node, width, posY) {
                const live = computeLive(node);
                const text = live
                    ? `${live[0]} × ${live[1]} (${live[2]})`
                    : (node.widgets?.find(w => w.name === "latent_type")?.value === "Auto (connected model)"
                        ? "Auto — format resolved from model on Queue" : "— invalid size —");
                ctx.fillStyle = widgetTextColor();
                ctx.font = "12px monospace";
                ctx.textAlign = "center";
                ctx.fillText(text, width / 2, posY + 16);
                ctx.textAlign = "left";
            };

            syncLocks(node);
            requestResize(node);
        });
    },
});
