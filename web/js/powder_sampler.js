
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { widgetSecondaryTextColor, widgetFont, markSeparator, setWidgetVisible } from "./e2go_hide_utils.js";
import { autoWireDenoise, resolveDenoiseSource } from "./e2go_graph_wire.js";
import { installNameKeyedPersistence, alignPrefixWithTrailingSlot } from "./e2go_persistence.js";
import { stepsHintText } from "./e2go_steps.js";

const noop = () => {};

app.registerExtension({
    name: "e2go_nodes.PowderSampler",
    nodeCreated(node) {
        if (node.comfyClass !== "PowderSampler") return;


        const widgetAccepts = (name, v) => {
            const w2 = findW(name);
            if (!w2) return false;
            const allowed = w2.options?.values;
            if (Array.isArray(allowed)) return allowed.includes(v);
            return typeof v === typeof w2.value;
        };
        const { findW } = installNameKeyedPersistence(node, {
            legacyAlign: (vals, names) =>
                alignPrefixWithTrailingSlot(vals, names, widgetAccepts),
        });

        const applyProfile = node.addWidget("button", "Apply profile to sampler", null, async () => {
            try {
                const res = await api.fetchApi('/e2go/model_profiles');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const profiles = await res.json();
                const selected = findW('model_profile')?.value;
                const profile = profiles[selected];
                if (!profile) { applyProfile.label = 'Manual — settings unchanged'; return; }
                for (const [key, value] of Object.entries(profile.settings)) {
                    const widget = findW(key);
                    if (widget) { widget.value = value; widget.callback?.(value); }
                }
                applyProfile.label = `${selected}: ${profile.channels}ch /${profile.downscale}`;
                applyProfile.options ||= {};
                applyProfile.options.tooltip = `Encoder: ${profile.encoder}. VAE: ${profile.vae}. Loaders stay unchanged.`;
                node.graph?.setDirtyCanvas(true, true);
            } catch (error) {
                applyProfile.label = `Profile unavailable: ${error.message}`;
            }
        });
        applyProfile.serialize = false;

        const val = (name, dflt) => {
            const x = node.widgets?.find((v) => v.name === name)?.value;
            return x === undefined ? dflt : x;
        };

        const liveDenoise = () => {
            const resolved = resolveDenoiseSource(node, node.graph || app.graph);
            if (resolved !== null) return resolved;
            const own = Number(val("denoise", 1.0));
            return Number.isFinite(own) ? own : 1.0;
        };


        const w = node.addWidget("text", "steps_hint", "", noop);
        w.serialize = false;
        w.type = "e2go_sampler_hint";
        w.computeSize = () => [Math.max(node.size?.[0] || 240, 240), 20];
        w.onPointerDown = () => true;
        w.draw = function (ctx, _n, width, posY) {
            const hint = stepsHintText(val("steps", 10), liveDenoise(),
                                       val("auto_steps", true),
                                       val("inpaint_boost", "soft"));
            ctx.save();
            ctx.fillStyle = widgetSecondaryTextColor();
            ctx.font = widgetFont(12);
            ctx.textAlign = "center";
            ctx.fillText(hint, width / 2, posY + 14);
            ctx.restore();
        };


        const sep = node.addWidget("text", "═══ Inpaint boost ═══", "", noop);
        sep.serialize = false;
        markSeparator(sep, "═══ Inpaint boost ═══", node, 240);
        const ws = node.widgets;
        const boostIdx = ws.findIndex((v) => v.name === "inpaint_boost");
        if (boostIdx >= 0) {
            ws.splice(ws.indexOf(sep), 1);
            ws.splice(boostIdx, 0, sep);
        }


        const sepFlux = node.addWidget("text", "═══ Flux.2 ═══", "", noop);
        sepFlux.serialize = false;
        markSeparator(sepFlux, "═══ Flux.2 ═══", node, 240);
        const fluxIdx = ws.findIndex((v) => v.name === "flux2_shift");
        if (fluxIdx >= 0) {
            ws.splice(ws.indexOf(sepFlux), 1);
            ws.splice(fluxIdx, 0, sepFlux);
        } else {
            ws.splice(ws.indexOf(sepFlux), 1);
        }

        let advanced = false;
        const advancedButton = node.addWidget("button", "Mask / batch / Flux.2 settings ▸", null, () => {
            advanced = !advanced;
            syncAdvanced();
        });
        advancedButton.serialize = false;
        advancedButton.tooltip = "Mask boost, batch similarity and Flux.2 shift. These settings apply only to the corresponding inputs/models.";
        const syncAdvanced = () => {
            for (const widget of [sep, sepFlux, findW("inpaint_boost"), findW("similarity"), findW("flux2_shift")]) setWidgetVisible(widget, advanced);
            const ideogramMode = findW("ideogram_mode");
            if (ideogramMode) {
                ideogramMode.label = "Ideogram sampling";
                setWidgetVisible(ideogramMode, ["Manual", "Ideogram 4"].includes(val("model_profile", "Manual"))
                    || val("scheduler", "simple") === "ideogram4" || val("ideogram_mode", "Standard") !== "Standard");
            }
            advancedButton.label = advanced ? "Mask / batch / Flux.2 settings ▾" : "Mask / batch / Flux.2 settings ▸";
            node.setSize([node.size[0], node.computeSize()[1]]);
            node.setDirtyCanvas(true, true);
        };
        const restoreAdvanced = () => {
            advanced = val("inpaint_boost", "soft") !== "soft" || Number(val("similarity", 0)) !== 0 || val("flux2_shift", "auto") !== "auto";
            syncAdvanced();
        };
        const previousConfigure = node.onConfigure;
        node.onConfigure = function () {
            previousConfigure?.apply(this, arguments);
            requestAnimationFrame(restoreAdvanced);
        };
        requestAnimationFrame(restoreAdvanced);
        for (const name of ["model_profile", "scheduler", "ideogram_mode"]) {
            const widget = findW(name);
            if (!widget) continue;
            const previous = widget.callback;
            widget.callback = function () {
                const result = previous?.apply(this, arguments);
                syncAdvanced();
                return result;
            };
        }
        const prevConn = node.onConnectionsChange;
        node.onConnectionsChange = function (type, index, connected) {
            if (typeof prevConn === "function") { try { prevConn.apply(this, arguments); } catch {} }
            if (app.configuringGraph) return;
            if (type !== 1 || !connected) return;

            const inp = this.inputs?.[index];
            if (inp?.name === "steps" && inp.link != null) {
                this.disconnectInput(index);
                console.warn("[e2go] PowderSampler: wired steps rejected; set base steps in the widget because denoise scaling is handled by the sampler");
                return;
            }
            const res = autoWireDenoise(this, this.graph || app.graph);
            if (res.reason === "foreign" && !this._e2goDenWarned) {
                this._e2goDenWarned = true;
                console.warn("[e2go] PowderSampler: denoise already has a connection; leaving it unchanged");
            }
        };
    },
});
