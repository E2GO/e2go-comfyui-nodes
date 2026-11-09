// powder_image_cond.js — cosmetic separators for Powder Image Conditioning.
// Mirrors the separator pattern used by the wildcard/styler nodes.

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { startInputNoticeLayer, updateInputNotice } from "./e2go_input_notice.js";
import { imageInputChecks } from "./e2go_input_checks.js";
import { trackWidgetDraw, widgetSecondaryTextColor, widgetFont, noop, styleBoolToggle, markSeparator, setWidgetVisible, widgetPointerX, redrawNodeWidgets } from "./e2go_hide_utils.js";
import { autoWireCropChain, autoWireReferences } from "./e2go_graph_wire.js";
import { installNameKeyedPersistence, alignWithAnchorSlot } from "./e2go_persistence.js";

app.registerExtension({
    name: "e2go_nodes.PowderImageConditioning",

    setup() {
        startInputNoticeLayer();
        // One graph-scoped poll also observes Canvas painting and rewiring.
        setInterval(() => {
            for (const node of app.graph?._nodes || []) {
                node._e2goRefreshInputChecks?.();
                node._e2goRefreshLayoutStatus?.();
            }
        }, 500);
        api.addEventListener("execution_error", ({ detail }) => {
            if (detail?.node_type !== "PowderImageConditioning") return;
            const node = app.graph?.getNodeById(detail.node_id);
            node?._e2goSetInputError?.(detail.exception_message);
        });
        api.addEventListener("executing", ({ detail }) => {
            const node = app.graph?.getNodeById(detail?.node);
            node?._e2goSetInputError?.("");
        });
        api.addEventListener("e2go_image_input_status", ({ detail }) => {
            app.graph?.getNodeById(detail?.node_id)?._e2goSetRuntimeNotices?.(detail);
        });
    },

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
        let activeMode = findW("mode")?.value;
        let modeSettings = {};
        const canonicalMode = (mode) => ({ Inpaint: "Repaint", Img2Img: "Repaint",
            "Edit — whole image": "Edit", "Edit — masked region": "Edit" }[mode] || mode);
        const defaultsFor = (mode) => {
            const values = Object.fromEntries(Object.entries(SPEC)
                .filter(([name]) => name !== "mode").map(([name, spec]) => [name, spec.def]));
            values.denoise = mode === "Repaint" ? 0.6 : mode === "Repair" ? 0.9 : 1;
            if (mode === "Repair") { values.crop_to_mask = "auto"; values.mask_grow = 16; }
            return values;
        };
        const captureSettings = () => Object.fromEntries(inputNames
            .filter((name) => name !== "mode" && SPEC[name] && findW(name))
            .map((name) => [name, findW(name).value]));
        const applySettings = (values) => {
            for (const [name, value] of Object.entries(values)) {
                if (name !== "mode" && SPEC[name]?.ok(value) && findW(name)) findW(name).value = value;
            }
            redrawNodeWidgets(node);
        };
        const serializeModes = node.onSerialize;
        node.onSerialize = function (info) {
            serializeModes?.apply(this, arguments);
            modeSettings[canonicalMode(activeMode)] = captureSettings();
            info.e2goModeSettings = structuredClone(modeSettings);
        };
        const configureModes = node.onConfigure;
        node.onConfigure = function (info) {
            modeSettings = {};
            for (const [mode, values] of Object.entries(info?.e2goModeSettings || {})) {
                if (!["Generate", "Repaint", "Repair", "Edit", "Edit (native)"].includes(mode)) continue;
                modeSettings[mode] = defaultsFor(mode);
                for (const [name, value] of Object.entries(values || {})) {
                    if (name !== "mode" && SPEC[name]?.ok(value)) modeSettings[mode][name] = value;
                }
            }
            return configureModes?.apply(this, arguments);
        };
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
                activeMode = canonicalMode(findW("mode")?.value);
                // Safety net: re-run visibility here too, in case the
                // double-rAF below it ever races ahead of this restore.
                syncCropWidgets?.();
                syncModeWidgets?.();
            },
        });

        // Mode snapshots survive workflow saves; loading never applies presets.
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
        if (modeW) {
            const prevCb = modeW.callback;
            modeW.callback = function (v) {
                const next = canonicalMode(v);
                if (next !== canonicalMode(activeMode)) {
                    modeSettings[canonicalMode(activeMode)] = captureSettings();
                    activeMode = next;
                    node._e2goSetInputError?.("");
                    applySettings(modeSettings[next] || defaultsFor(next));
                    const crop = findW("crop_to_mask");
                    crop?.callback?.call(crop, crop.value);
                }
                if (typeof prevCb === "function") prevCb.apply(this, arguments);
                node.setDirtyCanvas?.(true, true);
            };
            const resetSettings = () => {
                const mode = canonicalMode(modeW.value);
                applySettings(defaultsFor(mode));
                modeSettings[mode] = captureSettings();
                const crop = findW("crop_to_mask");
                crop?.callback?.call(crop, crop.value);
                syncModeWidgets();
                node.setDirtyCanvas?.(true, true);
            };
            modeW.tooltip = "Choose mode. The separate reset button restores defaults for this mode only.";
            const nativeDraw = modeW.draw;
            const nativeDrawWidget = modeW.drawWidget;
            modeW.draw = function (ctx, n, width, y, height) {
                trackWidgetDraw(this, ctx, n, width, y, height);
                this._e2goDrawWidth = width;
                const h = this.height || height || 20;
                const comboWidth = width - 36;
                ctx.save();
                ctx.font = widgetFont(12);
                if (nativeDraw) nativeDraw.call(this, ctx, n, comboWidth, y, h);
                else nativeDrawWidget?.call(this, ctx, { width: comboWidth, showText: true });
                ctx.fillStyle = this.background_color || "#222";
                ctx.strokeStyle = this.outline_color || "#555";
                ctx.beginPath();
                ctx.roundRect(width - 39, y, 24, h, 5);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = this.text_color || widgetSecondaryTextColor();
                ctx.font = widgetFont(14);
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("↻", width - 27, y + h / 2);
                ctx.restore();
            };
            const hitModeRow = (x, event, canvas) => {
                const width = modeW._e2goDrawWidth || node.size[0];
                if (x >= width - 39 && x <= width - 15) {
                    resetSettings();
                    node.graph?.incrementVersion?.();
                    return true;
                }
                // The gap belongs to neither control. Arrow hit areas follow
                // the reduced native combo width, not the full node width.
                if (x > width - 51) return true;
                const direction = x >= 15 && x < 40 ? -1 : x > width - 76 ? 1 : 0;
                if (!direction) return false;
                const values = modeW.options?.values || ["Generate", "Repaint", "Edit", "Edit (native)", "Repair"];
                const index = values.indexOf(modeW.value);
                const value = values[Math.max(0, Math.min(values.length - 1, index + direction))];
                if (value !== modeW.value) {
                    if (modeW.setValue && canvas) modeW.setValue(value, { e: event, node, canvas });
                    else { modeW.value = value; modeW.callback?.(value); }
                }
                return true;
            };
            const pointerDown = modeW.onPointerDown;
            modeW.onPointerDown = function (pointer, n, canvas) {
                if (hitModeRow(widgetPointerX(pointer, node, canvas, this), pointer.eDown || pointer.event, canvas)) return true;
                return pointerDown?.call(this, pointer, n, canvas) || false;
            };
            const mouse = modeW.mouse;
            modeW.mouse = function (event, pos, ...args) {
                if ((event.type === "pointerdown" || event.type === "mousedown") && hitModeRow(pos[0], event, app.canvas)) return true;
                return mouse?.call(this, event, pos, ...args) || false;
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

        let executionError = "", executionState = "", signature = "";
        let runtimeNotices = [], runtimeState = "";
        const inputState = () => JSON.stringify({
            settings: captureSettings(), mode: modeW?.value,
            inputs: node.inputs?.map(i => [i.name, i.link]),
            // Source files and Canvas pixels can change without rewiring.
            sources: (node.inputs || []).filter(i => ["pixels", "mask", "references", "model", "vae"].includes(i.name)).map(i => {
                const link = node.graph?.links?.get?.(i.link) ?? node.graph?.links?.[i.link];
                const source = node.graph?.getNodeById(link?.origin_id);
                return [i.name, source?.id, source?._e2goCanvasState?.dirty,
                    source?.widgets?.map(w => [w.name, w.value])];
            }),
        });
        node._e2goRefreshInputChecks = () => {
            const checks = imageInputChecks(node);
            const currentState = inputState();
            if (runtimeState !== currentState) runtimeNotices = [];
            if (executionError && executionState !== currentState) executionError = "";
            for (const notice of runtimeNotices) if (!checks.some(n => n.id === notice.id)) checks.push(notice);
            if (checks.some(n => n.message === executionError)) executionError = "";
            if (executionError) checks.unshift({id: "execution", severity: "error", message: executionError});
            checks.sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));
            const next = JSON.stringify(checks);
            if (signature === next) return;
            signature = next;
            node._e2goInputNotices = checks;
            updateInputNotice(node, checks);
        };
        node._e2goSetRuntimeNotices = ({mode, notices: incoming}) => {
            if (canonicalMode(mode) !== canonicalMode(modeW?.value)) return;
            runtimeNotices = Array.isArray(incoming) ? incoming : [];
            runtimeState = inputState();
            node._e2goRefreshInputChecks();
        };
        node._e2goSetInputError = message => {
            const text = String(message || "").trim();
            if (!text) runtimeNotices = [];
            executionError = text.includes("Canvas is empty")
                ? "Image required. Load an image into Canvas, or select Generate."
                : text.replace(/^(?:\w*Error:\s*)+/, "").split("\n")[0].slice(0, 240);
            executionState = inputState();
            node._e2goRefreshInputChecks();
        };
        // New nodes start with the same defaults as Reset. Workflow configure
        // runs afterwards and restores the user's saved values by name.
        applySettings(defaultsFor(canonicalMode(activeMode)));
        syncModeWidgets();
        node.setDirtyCanvas(true, true);
    },
});
