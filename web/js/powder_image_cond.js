// powder_image_cond.js — cosmetic separators for Powder Image Conditioning.
// Mirrors the separator pattern used by the wildcard/styler nodes.

import { app } from "../../../scripts/app.js";
import { widgetSecondaryTextColor, widgetFont, noop, styleBoolToggle, markSeparator, setWidgetVisible } from "./e2go_hide_utils.js";
import { autoWireCropChain, autoWireReferences } from "./e2go_graph_wire.js";
import { installNameKeyedPersistence, alignWithAnchorSlot } from "./e2go_persistence.js";

app.registerExtension({
    name: "e2go_nodes.PowderImageConditioning",

    nodeCreated(node) {
        if (node.comfyClass !== "PowderImageConditioning") return;

        // widgets_values is POSITION-based and serialize:false is ignored on
        // save (see project memory / wildcard node): a decoration inserted
        // mid-list shifts restored values by one slot (ignore_mask inheriting
        // hard_concat_mask's true after every reload). Persist the REAL input
        // values by name and re-apply them after configure.
        const inputNames = (node.widgets || []).map((w) => w.name); // snapshot BEFORE decorations

        for (const bn of ["seamless_mask_blend", "hard_concat_mask", "ignore_mask", "blank_reference"]) styleBoolToggle(node, bn);
        const findW = (name) => node.widgets?.find((w) => w.name === name);

        const SPEC = {
            // Current modes + _LEGACY_MODES keys (powder_inpaint.py) — legacy
            // saves must not be "repaired" away from their remapped value.
            mode: { ok: (v) => ["Generate", "Repaint", "Edit", "Edit (native)", "Repair",
                "Inpaint", "Img2Img", "Edit — whole image", "Edit — masked region"].includes(v), def: "Repaint" },
            batch_size: { ok: (v) => Number.isInteger(v) && v >= 1 && v <= 64, def: 1 },
            denoise: { ok: (v) => typeof v === "number" && v >= 0 && v <= 1, def: 1.0 },

            seamless_mask_blend: { ok: (v) => typeof v === "boolean", def: true },
            concat: { ok: (v) => ["auto", "on", "off"].includes(v), def: "auto" },
            hard_concat_mask: { ok: (v) => typeof v === "boolean", def: false },
            ignore_mask: { ok: (v) => typeof v === "boolean", def: false },
            crop_to_mask: { ok: (v) => ["off", "auto", "fixed"].includes(v), def: "off" },
            crop_megapixels: { ok: (v) => typeof v === "number" && v >= 0.1 && v <= 16, def: 1.0 },
            crop_width: { ok: (v) => Number.isInteger(v) && v >= 64 && v <= 8192, def: 1024 },
            crop_height: { ok: (v) => Number.isInteger(v) && v >= 64 && v <= 8192, def: 1024 },
            context_percent: { ok: (v) => typeof v === "number" && v >= 0 && v <= 200, def: 20.0 },
            stitch_blend: { ok: (v) => Number.isInteger(v) && v >= 0 && v <= 64, def: 16 },
            mask_grow: { ok: (v) => Number.isInteger(v) && v >= 0 && v <= 256, def: 0 },
            reference_megapixels: { ok: (v) => typeof v === "number" && v >= 0.1 && v <= 16, def: 1.0 },
            blank_reference: { ok: (v) => typeof v === "boolean", def: false },
        };
        // Repair pass: every known widget ends up with a VALID value — the
        // saved name-keyed value when sane, else the current live value when
        // sane, else the spec default. Returns the repaired names.
        const sanitizeInputs = (saved) => {
            const fixed = [];
            for (const name of inputNames) {
                const w = findW(name);
                const spec = SPEC[name];
                if (!w || !spec) continue;
                const savedVal = saved && name in saved ? saved[name] : undefined;
                const pick = savedVal !== undefined && spec.ok(savedVal) ? savedVal
                    : (spec.ok(w.value) ? w.value : spec.def);
                if (w.value !== pick) fixed.push(`${name}: ${JSON.stringify(w.value)} -> ${JSON.stringify(pick)}`);
                w.value = pick; // value only; no callbacks
            }
            if (fixed.length) console.warn("[e2go] PowderImageCond repaired shifted widget values:", fixed.join(", "));
            return fixed;
        };

        for (const name of inputNames) {
            if (!SPEC[name]) console.warn(
                `[e2go] PowderImageCond: widget "${name}" has no SPEC entry — `
                + "legacy alignment and the repair pass are default-open for it");
        }
        installNameKeyedPersistence(node, {
            inputNames,
            sanitize: (name, v) =>
                SPEC[name] && !SPEC[name].ok(v) ? SPEC[name].def : v,
            legacyAlign: (vals) => {
                const okv = (name, v) => !SPEC[name] || SPEC[name].ok(v);
                for (const era of [inputNames,
                                   inputNames.filter((n) => n !== "denoise")]) {
                    const m = alignWithAnchorSlot(
                        vals, era, era.indexOf("seamless_mask_blend"), okv);
                    if (m) return m;
                }
                return null;
            },

            applyValues: false,
            afterRestore: (saved) => {
                sanitizeInputs(saved); // also runs with saved=null: pure repair
                // Safety net: re-run visibility here too, in case the
                // double-rAF below it ever races ahead of this restore.
                syncCropWidgets?.();
                syncModeWidgets?.();
            },
        });

        // Mode drives the typical denoise (Generate/Edit 1.0, Repaint 0.6).
        // Fires only on USER interaction: workflow restore assigns w.value
        // directly (positional configure and the e2goInputs rAF both skip
        // callbacks), so saved overrides are never clobbered.
        const modeW = findW("mode");
        const denW = findW("denoise");
        // An unwired denoise OUTPUT means the dial does nothing (the
        // sampler's own widget rules) — gray it so it can't mislead.
        if (denW) {
            const syncDenoiseEnabled = () => {
                const out = node.outputs?.find((o) => o.name === "denoise");
                denW.disabled = !(out?.links?.length);
                node.setDirtyCanvas?.(true, true);
            };
            const prevConn = node.onConnectionsChange;
            node.onConnectionsChange = function (...args) {
                if (typeof prevConn === "function") { try { prevConn.apply(this, args); } catch {} }
                syncDenoiseEnabled();
                mirrorReferences();
            };
            requestAnimationFrame(syncDenoiseEnabled); // initial state after load
        }

        // A reference bundle dropped here must also reach the text encoder, or
        // the model attends to images the encoder never saw. Mirror it the
        // moment the wire lands — the same "zero manual wires" contract the
        // crop chain has. All graph surgery is in e2go_graph_wire.js
        // (scenario-tested under node); the server warns as a backstop.
        const mirrorReferences = () => {

            if (app.configuringGraph) return;
            let res;
            try { res = autoWireReferences(node, node.graph || app.graph); }
            catch { return; }
            if (res.wired && res.reason !== "already") {
                console.info("[e2go] references mirrored into Powder Conditioner — the text encoder now sees the same set");
            } else if (res.reason === "foreign") {
                console.warn("[e2go] Powder Conditioner already takes a DIFFERENT reference bundle — the encoder and the model are describing different images");
            } else if (res.reason === "no-conditioner") {
                console.warn("[e2go] references are wired but no Powder Conditioner was found upstream — a VL text encoder will not see them");
            }
            if (res.edited === "wired") {
                console.info("[e2go] the edited image is now Picture 1 for the text encoder (References.edited_image wired from pixels)");
            } else if (res.edited === "foreign") {
                console.warn("[e2go] References.edited_image holds a different image than this node's pixels — the encoder's Picture 1 is not the frame being edited");
            }
        };
        if (modeW && denW) {
            const prevCb = modeW.callback;
            modeW.callback = function (v) {
                if (typeof prevCb === "function") { try { prevCb.apply(this, arguments); } catch {} }
                const auto = { Generate: 1.0, Repaint: 0.6, Edit: 1.0, "Edit (native)": 1.0, Repair: 0.9 };
                if (v in auto) {
                    denW.value = auto[v];
                    if (v === "Repair") {

                        const cw2 = findW("crop_to_mask");
                        if (cw2 && cw2.value === "off") {
                            cw2.value = "auto";
                            try { cw2.callback?.call(cw2, "auto"); } catch {}
                        }

                        const mg = findW("mask_grow");
                        if (mg && !mg.value) mg.value = 16;
                    }
                    app.graph?.setDirtyCanvas(true, true);
                }
            };
        }

        // crop_to_mask drives which sizing widgets are visible:
        // auto -> crop_megapixels; fixed -> crop_width/height; off -> none.
        const cropW = findW("crop_to_mask");
        const showW = (w, show) => {
            setWidgetVisible(w, show);
        };
        // computeSize() returns the MINIMUM size — clamp to the node's
        // current width so this never shrinks a user-widened node
        // (established pattern: powder_prompt.js requestResize, powder_styler.js requestResize).
        const relayout = () => {
            try {
                node.setSize([Math.max(node.size?.[0] || 0, 320), node.computeSize()[1]]);
            } catch {}
            app.graph?.setDirtyCanvas(true, true);
        };
        const syncCropWidgets = (v) => {
            const mode = v ?? cropW?.value ?? "off";
            const enabled = modeW?.value !== "Generate";
            showW(findW("crop_megapixels"), enabled && mode === "auto");
            showW(findW("crop_width"), enabled && mode === "fixed");
            showW(findW("crop_height"), enabled && mode === "fixed");
            showW(findW("context_percent"), enabled && mode !== "off");
            showW(findW("stitch_blend"), enabled);
            setWidgetVisible(findW("crop_prompt_hint"), enabled && mode !== "off");
            relayout();
        };

        // mode drives the reference knobs: they only exist for the edit-model
        // reference (powder_inpaint.py builds reference_latents in Edit only),
        // and the redraw band needs a mask, which Generate ignores entirely.
        // Legacy combo values map onto Edit the same way _LEGACY_MODES does
        // server-side — an old save must not hide the widgets it still uses.
        const EDIT_MODES = ["Edit", "Edit — whole image", "Edit — masked region"];
        const REF_SEPARATOR_TITLE = "═══ Edit reference ═══";
        let refSeparator = null;   // assigned in the layout pass below
        // Keep custom separators synchronized with their mode-specific controls.
        const showSeparator = (sep, show, title) => {
            if (!sep) return;
            showW(sep, show);
            if (show) markSeparator(sep, title, node);
        };
        const syncModeWidgets = (v) => {
            const mode = v ?? modeW?.value ?? "Repaint";
            const isEdit = EDIT_MODES.includes(mode);
            showW(findW("reference_megapixels"), isEdit);
            showW(findW("blank_reference"), isEdit);
            showSeparator(refSeparator, isEdit, REF_SEPARATOR_TITLE);
            showW(findW("mask_grow"), mode !== "Generate");
            showW(findW("denoise"), mode !== "Generate");
            for (const name of ["concat", "hard_concat_mask", "ignore_mask", "crop_to_mask", "seamless_mask_blend"]) showW(findW(name), mode !== "Generate");
            showSeparator(findW("═══ Fine-tuning ═══"), mode !== "Generate", "═══ Fine-tuning ═══");
            showSeparator(findW("═══ Seams ═══"), mode !== "Generate", "═══ Seams ═══");
            syncCropWidgets();
            relayout();
        };
        if (modeW) {
            const prevModeCb = modeW.callback;
            modeW.callback = function (v) {
                if (typeof prevModeCb === "function") { try { prevModeCb.apply(this, arguments); } catch {} }
                syncModeWidgets(v);
            };
        }


        const autoWireStitch = () => {
            // Factory: when the graph has no Review at all (the user is not
            // required to add nodes by hand), create one next to the decode.
            const res = autoWireCropChain(node, node.graph || app.graph, (g, decode) => {
                try {
                    const rev = window.LiteGraph?.createNode?.("PowderCanvasReview");
                    if (!rev) return null;
                    const anchor = decode || node;
                    rev.pos = [(anchor.pos?.[0] || 0) + (anchor.size?.[0] || 200) + 60,
                               (anchor.pos?.[1] || 0)];
                    // Auto-created plumbing should not claim canvas space —
                    // spawn collapsed; the user can expand it if they care.
                    rev.flags = { ...(rev.flags || {}), collapsed: true };
                    g.add(rev);
                    return rev;
                } catch { return null; }
            });
            if (!res.review) {
                console.warn("[e2go] crop_to_mask is on but no Powder Canvas Review found (and it could not be created) — the decoded result will be the crop");
            } else if (!res.decode) {
                console.warn("[e2go] crop_to_mask: no VAEDecode found downstream — wire Review's images output to your save node manually");
            }
        };
        if (cropW) {
            const prevCropCb = cropW.callback;
            cropW.callback = function (v) {
                if (typeof prevCropCb === "function") { try { prevCropCb.apply(this, arguments); } catch {} }
                syncCropWidgets(v);
                if (v !== "off") autoWireStitch();   // off leaves the wire (harmless)
            };
            // Run AFTER the e2goInputs restore rAF above so restored
            // crop_to_mask values are applied before we compute visibility.
            const graphRef = app.graph;
            requestAnimationFrame(() => {
                if (app.graph !== graphRef) return;
                requestAnimationFrame(() => {
                    if (app.graph !== graphRef) return;
                    syncCropWidgets();
                    syncModeWidgets();
                    mirrorReferences();   // a saved graph can be half-wired too

                    if ((cropW?.value ?? "off") !== "off") autoWireStitch();
                });
            });
        }

        // --- layout ------------------------------------------------------
        // Reordering the LIVE widget array is safe: onSerialize above rebuilds
        // widgets_values from `inputNames` (the INPUT_TYPES-order snapshot),
        // by name, so the wire format never sees this. Separators carry
        // serialize:false AND are stripped there, so they cost no slot either.
        const moveBefore = (name, beforeName) => {
            const ws = node.widgets || [];
            const from = ws.findIndex((w) => w.name === name);
            if (from === -1) return;
            const [w] = ws.splice(from, 1);
            const to = ws.findIndex((x) => x.name === beforeName);
            ws.splice(to === -1 ? ws.length : to, 0, w);
        };
        const addSeparator = (title, beforeName) => {
            const idx = (node.widgets || []).findIndex((w) => w.name === beforeName);
            if (idx === -1) return null;
            const sep = node.addWidget("text", title, "", noop);
            sep.serialize = false;
            markSeparator(sep, title, node);
            node.widgets.splice(node.widgets.indexOf(sep), 1);  // addWidget appends
            node.widgets.splice(idx, 0, sep);
            return sep;
        };

        // The three seam tools answer three different defects (feather = tone,
        // band = shape, DD = edit strength) and the README teaches them as a
        // trio — but INPUT_TYPES order scatters them across the node, with
        // seamless_mask_blend stranded among the expert toggles. Group them.
        moveBefore("seamless_mask_blend", "stitch_blend");
        addSeparator("═══ Fine-tuning ═══", "concat");
        addSeparator("═══ Seams ═══", "seamless_mask_blend");
        // Hidden together with its own widgets — a header with nothing under
        // it reads as a bug (Edit-only group).
        refSeparator = addSeparator(REF_SEPARATOR_TITLE, "reference_megapixels");
        const cropHint = node.addWidget("text", "crop_prompt_hint", "", noop);
        cropHint.serialize = false;
        cropHint.type = "e2go_crop_hint";
        cropHint.computeSize = () => [320, 54];
        cropHint.draw = (ctx, _node, width, y) => {
            ctx.fillStyle = "#e7ca79";
            ctx.font = widgetFont(12);
            ctx.fillText("Crop prompt: describe only the masked area.", 15, y + 14);
            ctx.fillText("The result outline shows the generated region.", 15, y + 30);
            ctx.fillText("Keep structure: try denoise 0.4–0.6; 0.9 rewrites.", 15, y + 46);
        };
        cropHint.onPointerDown = () => true;
        syncModeWidgets();
        node.setDirtyCanvas(true, true);
    },
});
