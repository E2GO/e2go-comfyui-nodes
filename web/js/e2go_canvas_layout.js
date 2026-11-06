import { layoutConnections, resolveLayoutContext } from "./e2go_layout_context.js";
import { canvasIcon } from "./e2go_canvas_icons.js";
import { blankLayout, readLayout, region, clone, uid, caption, importLayout, validateLayout, strings, sceneBasis, sceneNeedsSync, visibleText } from "./e2go_layout_model.js";
import { canvasDialog } from "./e2go_canvas_dialog.js";
import { reviewLayoutProposal } from "./e2go_layout_review.js";
import { computeLive } from "./powder_resolution.js";

const COLORS = ["#77c9bd", "#efbd79", "#a6a0ec", "#dc92ac", "#83bbef", "#bcd58a"];
function element(tag, text, cls) {
    const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e;
}
function css() {
    if (document.getElementById("e2go-layout-css")) return;
    const s = element("style"); s.id = "e2go-layout-css";
    s.textContent = `
    .e2go-layout{display:flex;flex-direction:column;flex:1;min-height:300px;color:#dae0e6;font:12px system-ui;background:#191d22;overflow:hidden}
    .e2go-layout[hidden]{display:none!important}.e2go-layout *{box-sizing:border-box}
    .e2go-layout button,.e2go-layout select,.e2go-layout input,.e2go-layout textarea{font:inherit;color:inherit;background:#292f37;border:1px solid #46515f;border-radius:5px;padding:5px 8px;min-width:0}
    .e2go-layout button{cursor:pointer;white-space:nowrap}.e2go-layout button:hover{background:#364350}.e2go-layout button.active{background:#285b50;border-color:#79b9a7}
    .e2go-layout button:focus-visible,.e2go-layout input:focus-visible,.e2go-layout textarea:focus-visible,.e2go-layout select:focus-visible{outline:2px solid #9eddd1;outline-offset:1px}
    .e2go-layout-tools{display:flex;gap:5px;align-items:center;flex-wrap:wrap;padding:8px;border-bottom:1px solid #343d48}
    .e2go-layout-toolgroup{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding-right:8px;margin-right:3px;border-right:1px solid #46515f;max-width:100%}
    .e2go-layout-toolgroup:last-child{border-right:0;padding-right:0;margin-right:0}
    .e2go-layout-generation{flex-basis:100%;gap:12px;border-right:0;border-bottom:1px solid #343d48;padding:0 0 6px;margin:0}
    .e2go-layout-state{display:flex;align-items:center}
    .e2go-layout-state button{font-weight:600;border-color:#b18a50}
    .e2go-layout-state strong,.e2go-layout-state small{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    .e2go-layout-model{display:flex;align-items:center;gap:6px;max-width:100%;color:#adb9c4}
    .e2go-layout-model select{width:140px;color:#dae0e6}
    .e2go-layout-source{display:flex;align-items:center;flex-wrap:wrap;gap:8px;max-width:100%}
    .e2go-layout-source label{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:#adb9c4}
    .e2go-layout-source select{max-width:100%;color:#dae0e6}
    .e2go-layout-source small{font-size:11px;color:#adb9c4}
    .e2go-layout-guide{position:absolute;top:5px;left:8px;right:8px;font-size:10px;color:#b0c2cd;pointer-events:none;z-index:1}
    .e2go-layout-tools input[type=number]{width:78px}.e2go-layout-body{display:flex;flex:1;min-height:0;position:relative}
    .e2go-layout-work{flex:1;min-width:160px;overflow:hidden;position:relative;touch-action:none;background:radial-gradient(#38414b 1px,transparent 1px);background-size:16px 16px;outline:none}
    .e2go-layout-stage{position:absolute;background:#252b32;box-shadow:0 8px 40px #0008;transform-origin:center;touch-action:none}
    .e2go-layout-stage>canvas{position:absolute;width:100%;height:100%;opacity:.45;pointer-events:none}
    .e2go-layout-box{position:absolute;border:1px solid var(--region);background:color-mix(in srgb,var(--region) 10%,transparent);cursor:move;touch-action:none}
    .e2go-layout-box.selected{z-index:2;border:2px solid var(--region);background:color-mix(in srgb,var(--region) 19%,transparent)}
    .e2go-layout-box.locked{border-style:dashed;cursor:default;pointer-events:none}.e2go-layout-box.disabled{opacity:.35}
    .e2go-layout-work.drawing{cursor:crosshair}
    .e2go-layout-work.drawing .e2go-layout-box{pointer-events:none}
    .e2go-layout-box span{position:absolute;left:3px;top:3px;max-width:calc(100% - 6px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#171e24df;padding:3px 5px;border-radius:3px;font-size:11px;pointer-events:none}
    .e2go-layout-box .grip{position:absolute;width:14px;height:14px;background:var(--region);border:1px solid #172027;border-radius:2px}
    /* Nodes 2.0 measures intrinsic widget height; inspector content must not resize the stage. */
    .e2go-layout-panel{contain:size;width:280px;flex-shrink:0;min-width:180px;overflow:auto;padding:12px;background:#21272e;border-left:1px solid #3a444e}
    .e2go-layout-divider{flex:0 0 8px;cursor:col-resize;touch-action:none;background:#252d36;position:relative}
    .e2go-layout-divider:hover,.e2go-layout-divider:focus-visible{background:#659c91;outline:none}
    .e2go-layout-divider::after{content:"";position:absolute;top:40%;bottom:40%;left:3px;border-left:2px solid #8395a4}
    .e2go-layout-panel h4{font-size:12px;margin:12px 0 8px;color:#9eddd1}.e2go-layout-panel label{display:flex;flex-direction:column;gap:5px;margin:8px 0;color:#adb9c4;font-size:11px}
    .e2go-layout-panel textarea{position:static;display:block;width:100%;resize:vertical;min-height:65px;line-height:1.5}.e2go-layout-panel .row{display:flex;gap:4px}.e2go-layout-panel .row>*{flex:1;min-width:0}.e2go-layout-panel input,.e2go-layout-panel select{width:100%}.e2go-layout-panel .geometry{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
    .e2go-layout-palette{display:flex;flex-direction:column;gap:6px;margin:8px 0;font-size:11px;color:#adb9c4}
    .e2go-layout-palette-colors{display:flex;flex-wrap:wrap;gap:6px}
    .e2go-layout-swatch{display:flex;align-items:center;gap:4px;max-width:100%}
    .e2go-layout-panel .e2go-layout-swatch input[type=color]{width:36px;height:30px;padding:2px;cursor:pointer;flex-shrink:0}
    .e2go-layout-swatch span{overflow-wrap:anywhere;min-width:0}
    .e2go-layout-list{display:flex;flex-direction:column;gap:4px}.e2go-layout-list button{text-align:left;overflow:hidden;text-overflow:ellipsis}
    .e2go-layout-status{padding:7px 10px;height:44px;flex:0 0 44px;overflow:auto;border-top:1px solid #343d48;color:#9aabba;font-size:11px;white-space:pre-wrap}.e2go-layout-status.error{color:#efb18f}
    .e2go-layout-dialog{position:fixed;inset:10% 15%;z-index:100100;background:#20272f;border:1px solid #637584;border-radius:10px;box-shadow:0 10px 80px #000a;padding:18px;display:flex;flex-direction:column;gap:10px;color:#dce5ec;font:13px system-ui}
    .e2go-layout-dialog textarea{flex:1;min-height:120px;resize:none;background:#151b21;color:#dce5ec;border:1px solid #46515f;padding:12px;font:12px monospace}.e2go-layout-dialog button{padding:7px 12px;cursor:pointer}
    @container(max-width:650px){.e2go-layout-panel{padding:8px}.e2go-layout-tools{gap:3px;padding:4px}}
    `;
    document.head.appendChild(s);
}

export function mountLayoutEditor(node, state, host) {
    css();
    const widget = () => node.widgets?.find(w => w.name === "layout_config");
    let data = blankLayout(), selected = new Set(), undo = [], redo = [], drawType = null;
    try { data = readLayout(widget()?.value); } catch (err) { console.warn("[Powder Layout]", err.message); }
    let zoom = 1, pan = [0, 0], snap = true, gesture = null, disposed = false, busy = false;
    const root = element("div", "", "e2go-layout"); root.hidden = true; host.append(root);
    const toolbar = element("div", "", "e2go-layout-tools"), body = element("div", "", "e2go-layout-body");
    const work = element("div", "", "e2go-layout-work"), stage = element("div", "", "e2go-layout-stage"); work.tabIndex = 0;
    work.setAttribute("aria-label", "Layout canvas");
    const bg = element("canvas"), boxes = element("div"); stage.append(bg, boxes); work.append(stage);
    const guide = element("div", "Regions describe composition; they do not edit image pixels.", "e2go-layout-guide"); work.append(guide);
    function toolGroup(label) { const group = element("div", "", "e2go-layout-toolgroup"); group.setAttribute("role", "group"); group.setAttribute("aria-label", label); toolbar.append(group); return group; }
    const generationTools = toolGroup("Layout generation"), modelTools = toolGroup("Model selection"), regionTools = toolGroup("Add regions"), viewTools = toolGroup("Layout history and view"), fileTools = toolGroup("Layout import and export"), aiTools = toolGroup("Layout AI assistant");
    const panel = element("div", "", "e2go-layout-panel"), status = element("div", "", "e2go-layout-status");
    panel.style.overscrollBehavior = "contain";
    const scrollPanel = e => {
        if (!panel.contains(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        const field = e.target.closest("textarea");
        const canScroll = field && (e.deltaY > 0 ? field.scrollTop + field.clientHeight < field.scrollHeight - 1 : field.scrollTop > 0);
        const scroller = canScroll ? field : panel;
        const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? scroller.clientHeight : 1;
        scroller.scrollTop += e.deltaY * unit;
    };
    // Nodes 2.0 forwards wheel events to the graph during ancestor capture.
    document.addEventListener("wheel", scrollPanel, { capture: true, passive: false });
    const divider = element("div", "", "e2go-layout-divider");
    divider.tabIndex = 0; divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", "Resize sidebar"); divider.setAttribute("aria-orientation", "vertical");
    let panelWidth = Number(node.properties?.e2goLayoutPanelWidth) || 280, panelDrag = null;
    function resizePanel(width = panelWidth, save = false) {
        const max = Math.max(180, Math.min(640, body.clientWidth - 168));
        const actual = Math.round(Math.max(180, Math.min(max, width)));
        panel.style.width = `${actual}px`;
        divider.setAttribute("aria-valuemin", "180"); divider.setAttribute("aria-valuemax", String(max)); divider.setAttribute("aria-valuenow", String(actual));
        if (save) { panelWidth = actual; node.properties ||= {}; node.properties.e2goLayoutPanelWidth = actual; node.graph?.change?.(); }
    }
    divider.onpointerdown = e => { if(e.button !== 0) return; e.preventDefault(); e.stopPropagation(); divider.focus(); panelDrag = {x:e.clientX, width:panel.clientWidth}; divider.setPointerCapture(e.pointerId); };
    divider.onpointermove = e => { if (!panelDrag) return; e.preventDefault(); e.stopPropagation(); const scale = body.getBoundingClientRect().width / body.clientWidth || 1; resizePanel(panelDrag.width + (panelDrag.x - e.clientX) / scale); };
    divider.onpointerup = e => { if (!panelDrag) return; panelDrag = null; resizePanel(panel.clientWidth, true); if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId); };
    divider.onpointercancel = () => { panelDrag = null; resizePanel(); };
    divider.ondblclick = () => resizePanel(280, true);
    divider.onkeydown = e => { if (!["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); resizePanel(e.key === "Home" ? 280 : panel.clientWidth + (e.key === "ArrowLeft" ? 20 : -20), true); };
    body.append(work, divider, panel); root.append(toolbar, body, status);
    const say = (text, error = false) => { status.textContent = text; status.classList.toggle("error", error); };
    const button = (parent, title, fn) => { const b = element("button", title); b.type = "button"; b.onclick = fn; parent.append(b); return b; };
    const snapshot = () => JSON.stringify(data);
    function persist() {
        if (widget()) widget().value = snapshot();
        node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
    }
    function commit(before, refresh = true) {
        if (before !== snapshot()) { undo.push(before); if (undo.length > 60) undo.shift(); redo = []; persist(); }
        if (refresh) render();
        else { const warning = panel.querySelector('[data-scene-sync]'); if (warning) warning.hidden = !sceneNeedsSync(data); }
    }
    function change(fn) { const before = snapshot(); fn(); commit(before); }
    function history(reverse) {
        const from = reverse ? redo : undo, to = reverse ? undo : redo;
        if (!from.length) return;
        to.push(snapshot()); data = readLayout(from.pop()); persist(); render();
    }
    const generationState = element("div", "", "e2go-layout-state"); generationTools.append(generationState);
    const enabled = button(generationState, "Use layout: OFF", () => change(() => { data.enabled = !data.enabled; }));
    const generationMessage = element("strong"), generationHint = element("small");
    generationMessage.setAttribute("role", "status"); generationState.append(generationMessage, generationHint);
    enabled.title = "Controls generation. Opening this editor alone does not enable layout conditioning.";
    const target = element("select"); target.setAttribute("aria-label", "Layout model");
    for (const [v, text] of [["ideogram4", "Ideogram 4"], ["moss", "MOSS-Image"], ["flux3", "FLUX.3 Klein"]]) { const o = element("option", text); o.value = v; target.append(o); }
    const modelLabel = element("label", "Model", "e2go-layout-model"); modelLabel.append(target); modelTools.append(modelLabel);
    target.onchange = () => change(() => { data.target = target.value; });
    generationTools.classList.add("e2go-layout-generation");
    const sourceGroup = element("div", "", "e2go-layout-source");
    const sourceLabel = element("label", "Prompt source");
    const source = element("select"); source.setAttribute("aria-label", "Prompt source");
    for (const [value, title] of [["workflow", "Layout + workflow prompt"], ["layout_only", "Canvas Layout only"]]) {
        const option = element("option", title); option.value = value; source.append(option);
    }
    source.onchange = () => change(() => { data.promptSource = source.value; });
    source.title = "Canvas Layout only replaces the base positive prompt. Connected styles, LoRA trigger words, LoRA weights and negative prompt still apply.";
    const sourceHint = element("small");
    sourceLabel.append(source); sourceGroup.append(sourceLabel, sourceHint); generationTools.append(sourceGroup);
    const drawButtons = new Map();
    function updateDrawTool() {
        work.classList.toggle("drawing", !!drawType);
        for (const [type, control] of drawButtons) {
            control.classList.toggle("active", drawType === type);
            control.setAttribute("aria-pressed", String(drawType === type));
        }
    }
    for (const [label, type] of [["+ Object", "object"], ["+ Character", "character"], ["+ Text", "text"]]) {
        const control = button(regionTools, label, () => {
            drawType = drawType === type ? null : type;
            render();
            if (drawType) say(`Drag on the canvas to place a ${type}. Esc cancels.`);
            work.focus();
        });
        drawButtons.set(type, control); canvasIcon(control, type);
    }
    canvasIcon(button(viewTools, "Undo", () => history(false)), "undo"); canvasIcon(button(viewTools, "Redo", () => history(true)), "redo");
    canvasIcon(button(viewTools, "Fit", () => { zoom = 1; pan = [0, 0]; fit(); }), "fit");
    const presets = element("select"); presets.setAttribute("aria-label", "Composition preset");
    for (const name of ["Add preset…", "Single subject", "Two columns", "Three panels", "Poster"]) presets.append(element("option", name));
    presets.onchange = () => {
        const name = presets.value;
        const layouts = {
            "Single subject": [["object", [.15,.1,.7,.8]]],
            "Two columns": [["object", [.05,.12,.4,.76]], ["object", [.55,.12,.4,.76]]],
            "Three panels": [["object", [.04,.12,.28,.76]], ["object", [.36,.12,.28,.76]], ["object", [.68,.12,.28,.76]]],
            "Poster": [["text", [.08,.06,.84,.14]], ["object", [.12,.25,.76,.52]], ["text", [.12,.83,.76,.1]]],
        };
        if (layouts[name]) change(() => { const added = layouts[name].map(([label, rect]) => region(label, rect)); data.regions.push(...added); selected = new Set(added.map(r => r.id)); });
        presets.selectedIndex = 0;
    }; regionTools.append(presets);
    const snapButton = button(viewTools, "Snap: ON", () => { snap = !snap; snapButton.textContent = `Snap: ${snap ? "ON" : "OFF"}`; });
    canvasIcon(button(fileTools, "Import", () => openJson(true)), "import"); canvasIcon(button(fileTools, "Export", () => openJson(false)), "export");
    let assistantDialog = null, proposalDialog = null, aiController = null;
    const aiAssistant = button(aiTools, "AI assistant", () => {
        assistantDialog?.close(); assistantDialog = canvasDialog("AI assistant");
        canvasIcon(assistantDialog.querySelector("h3"), "assistant");
        const intro = element("p", "Choose one independent action. You can also draw everything manually. All actions use local Qwen; you review the proposal before applying it.");
        intro.style.cssText = "line-height:1.5;color:#b8c7d3"; assistantDialog.append(intro);
        const label = element("label", "Description for a new composition (other actions use the current layout)");
        const scene = element("textarea"); scene.value = data.scene; scene.setAttribute("aria-label", "AI scene description");
        scene.placeholder = "Describe the subjects, their positions, and any exact lettering.";
        scene.style.cssText = "position:static;display:block;box-sizing:border-box;width:100%;min-height:100px;margin:8px 0 16px;padding:10px;background:#171e25;color:#e3ebf2;border:1px solid #657381;border-radius:6px;font:inherit";
        label.append(scene); assistantDialog.append(label);
        for (const [title, detail, keep] of [
            ["Create composition from scene", "Proposes new regions, positions and descriptions. Applying replaces the current layout. Use this when starting from an idea.", false],
            ["Rearrange existing objects", "Moves the same objects and rewrites Scene to match. Preserves descriptions, lettering, palettes, locked and disabled regions.", "rearrange"],
            ["Improve region descriptions", "Keeps all existing regions, positions and exact lettering. Rewrites only appearance descriptions. Use this when your composition is already arranged.", true],
            ["Sync scene with regions", "Creates or replaces Scene from current regions, Background and style fields. Positions come from rectangles. Old Scene prose is replaced; keep environment details in Background.", "scene"],
        ]) {
            const action = button(assistantDialog, title, () => {
                if (!keep && !scene.value.trim()) { scene.setCustomValidity("Describe the scene first, or use Sync scene with regions."); scene.reportValidity(); return; }
                scene.setCustomValidity(""); assistantDialog.close(); enhance(keep, !keep ? scene.value.trim() : undefined);
            });
            action.style.cssText = "display:block;width:100%;padding:12px;text-align:left;background:#304940;color:#e3ebf2;border:1px solid #659c91;border-radius:6px;font:inherit;cursor:pointer";
            canvasIcon(action, keep === false ? "compose" : keep === "rearrange" ? "rearrange" : keep === "scene" ? "sync" : "edit");
            action.disabled = keep && !data.regions.some(r => r.enabled !== false && (keep !== "rearrange" || !r.locked));
            if(action.disabled) { action.style.opacity = ".4"; action.title = keep === "rearrange" ? "Enable and unlock at least one region first." : "Draw or enable at least one region first."; }
            const help = element("p", detail + (keep && !data.regions.length ? " No regions yet." : "")); help.style.cssText = "font-size:12px;line-height:1.5;color:#b8c7d3;margin:6px 0 18px"; assistantDialog.append(help);
        }
        scene.oninput = () => scene.setCustomValidity("");
        button(assistantDialog, "Cancel", () => assistantDialog.close()); scene.focus();
    });
    canvasIcon(aiAssistant, "assistant");
    const stopAI = button(aiTools, "Stop waiting", () => aiController?.abort());
    stopAI.hidden = true;
    stopAI.title = "Discard this request locally. An already queued generation may still finish.";
    function field(parent, title, value, setter, options) {
        const label = element("label", title);
        const input = element(options ? "select" : "textarea"); input.setAttribute("aria-label", title);
        if (options) for (const v of options) { const o = element("option", v); o.value = v; input.append(o); }
        input.value = value || "";
        if (options) {
            input.onchange = () => { const before = snapshot(); setter(input.value); commit(before); };
        } else {
            // Persist while typing: reload/serialization can happen without a blur/change event.
            // Keep one undo entry per editing session instead of one per keystroke.
            let editing = false;
            input.onfocus = () => { editing = false; };
            input.oninput = () => {
                const before = snapshot(); setter(input.value);
                if (!editing && before !== snapshot()) { commit(before, false); editing = true; }
                else { persist(); commit(snapshot(), false); }
                renderBoxes();
            };
        }
        label.append(input); parent.append(label); return input;
    }
    function paletteField(parent, title, value, setter) {
        const group = element("div", "", "e2go-layout-palette");
        group.setAttribute("role", "group"); group.setAttribute("aria-label", title);
        group.append(element("span", title));
        const colors = element("div", "", "e2go-layout-palette-colors"); group.append(colors);
        const values = strings(value);
        values.forEach((color, i) => {
            const swatch = element("div", "", "e2go-layout-swatch");
            const input = element("input"); input.type = "color";
            const valid = /^#[0-9a-f]{6}$/i.test(color);
            input.value = valid ? color : "#ffffff";
            input.setAttribute("aria-label", `${title} color ${i + 1}`);
            input.title = valid ? color : "Choose a color to replace this invalid palette entry";
            input.onchange = () => change(() => { const next = [...values]; next[i] = input.value; setter(next); });
            swatch.append(input);
            if (!valid) {
                const note = element("span", color); note.title = "This is not a color. Put descriptions in Region prompt."; swatch.append(note);
            }
            button(swatch, "\u00d7", () => change(() => setter(values.filter((_, index) => index !== i)))).setAttribute("aria-label", `Remove ${title.toLowerCase()} color ${i + 1}`);
            colors.append(swatch);
        });
        button(group, "+ Add color", () => change(() => setter([...values, "#ffffff"])));
        parent.append(group);
    }
    function number(parent, title, value, setter, max = 16384) {
        const label = element("label", title), input = element("input"); input.type = "number"; input.min = "0"; input.max = String(max); input.value = value; input.setAttribute("aria-label", title);
        input.onchange = () => { const v = Number(input.value); if (Number.isFinite(v)) { const before = snapshot(); setter(v); commit(before, false); renderBoxes(); fit(); } }; label.append(input); parent.append(label);
    }
    function fit() {
        if (root.hidden) return;
        const scale = Math.min((work.clientWidth - 44) / data.width, (work.clientHeight - 44) / data.height);
        const w = Math.max(1, data.width * scale), h = Math.max(1, data.height * scale);
        Object.assign(stage.style, { width: `${w}px`, height: `${h}px`, left: `${(work.clientWidth - w) / 2 + pan[0]}px`, top: `${(work.clientHeight - h) / 2 + pan[1]}px`, transform: `scale(${zoom})` });
    }
    function renderBoxes() {
        boxes.replaceChildren();
        data.regions.forEach((r, i) => {
            const box = element("div", "", "e2go-layout-box"); box.dataset.id = r.id;
            const [x, y, w, h] = r.rect;
            Object.assign(box.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
            box.style.setProperty("--region", COLORS[i % COLORS.length]); box.classList.toggle("selected", selected.has(r.id));
            box.classList.toggle("locked", !!r.locked); box.classList.toggle("disabled", r.enabled === false);
            box.append(element("span", `${i + 1} · ${r.locked ? "Locked · " : ""}${r.text || r.caption || r.label}`));
            if (selected.has(r.id) && !r.locked && selected.size === 1) for (const corner of ["nw", "ne", "sw", "se"]) {
                const grip = element("i", "", "grip"); grip.dataset.corner = corner;
                grip.style[corner.includes("n") ? "top" : "bottom"] = "-7px";
                grip.style[corner.includes("w") ? "left" : "right"] = "-7px"; grip.style.cursor = `${corner}-resize`; box.append(grip);
            }
            boxes.append(box);
        });
    }
    function duplicate() {
        change(() => {
            const copies = data.regions.filter(r => selected.has(r.id)).map(r => ({ ...clone(r), id: uid(), locked: false,
                rect: [Math.min(1 - r.rect[2], r.rect[0] + .025), Math.min(1 - r.rect[3], r.rect[1] + .025), r.rect[2], r.rect[3]] }));
            data.regions.push(...copies); selected = new Set(copies.map(r => r.id));
        });
    }
    function remove() { change(() => { data.regions = data.regions.filter(r => !selected.has(r.id) || r.locked); selected.clear(); }); }
    function generationSize() {
        const consumers = (node.outputs?.find(o => o.name === "layout")?.links || []).map(id => node.graph?.links?.[id]).filter(Boolean).map(l => node.graph.getNodeById(l.target_id));
        const resolutions = consumers.map(n => n.inputs?.find(i => i.name === "layout_width")).filter(i => i?.link != null).map(i => node.graph.getNodeById(node.graph.links[i.link].origin_id));
        const candidates = resolutions.length ? resolutions : (node.graph?._nodes || []).filter(n => n.comfyClass === "PowderResolution" || n.type === "PowderResolution");
        if (!candidates.length && state.width && state.height) return [state.width, state.height];
        if (candidates.length !== 1) return null;
        const dims = computeLive(candidates[0]);
        return dims;
    }
    function matchSize() {
        const dims = generationSize();
        if (!dims) { say("Connect Resolution width/height to Conditioner's layout size inputs, or enter the actual generation dimensions here.", true); return; }
        change(() => { [data.width, data.height] = dims; data.followResolution = true; });
    }
    function render() {
        updateDrawTool();
        target.value = data.target; enabled.textContent = `Use layout: ${data.enabled ? "ON" : "OFF"}`; enabled.classList.toggle("active", data.enabled);
        enabled.disabled = !widget();
        enabled.setAttribute("aria-pressed", String(data.enabled));
        generationTools.dataset.enabled = String(data.enabled);
        generationMessage.textContent = data.enabled ? "Regions are used in generation" : "OFF: regions are ignored in generation";
        generationHint.textContent = data.enabled ? "Layout composition is active." : "Editing only. Turn ON to use this layout.";
        source.value = data.promptSource || "workflow";
        sourceGroup.dataset.source = source.value;
        sourceHint.textContent = !data.enabled ? "Applies when Layout is ON. Currently using workflow prompt." : source.value === "layout_only" ? "Base prompt ignored; styles and LoRAs kept." : "Base prompt included; styles and LoRAs kept.";
        const scroll = panel.scrollTop;
        const detailsOpen = panel.querySelector("details")?.open;
        renderBoxes(); panel.replaceChildren();
        panel.append(element("h4", "CANVAS & SCENE"));
        const sizes = element("div", "", "row"); panel.append(sizes);
        number(sizes, "Width", data.width, v => { data.width = Math.max(16, Math.round(v)); data.followResolution = false; });
        number(sizes, "Height", data.height, v => { data.height = Math.max(16, Math.round(v)); data.followResolution = false; });
        button(panel, "Match generation size", matchSize).title = "Resizes the layout proportionally; normalized box positions stay the same.";
        button(panel, `Follow size: ${data.followResolution ? "ON" : "OFF"}`, () => change(() => { data.followResolution = !data.followResolution; })).title = "Follow the connected generation size, including while the Layout tab is closed. Imports and manual dimension edits turn this off.";
        field(panel, data.promptSource === "layout_only" ? "Scene - blank uses region descriptions" : "Scene - blank uses workflow prompt", data.scene, v => { data.scene = v; data.sceneBasis = sceneBasis(data); });
        {
            const group = element("div"); group.dataset.sceneSync = ""; group.hidden = !sceneNeedsSync(data); panel.append(group);
            const warning = element("p", "Scene may contain outdated positions or descriptions. Sync it before generating.");
            warning.style.cssText = "color:#efbd79;font-size:11px;line-height:1.4"; group.append(warning);
            canvasIcon(button(group, "Sync scene with regions", () => enhance("scene")), "sync");
        }
        field(panel, "Background", data.background, v => { data.background = v; });
        const styleDetails = element("details"); styleDetails.open = !!detailsOpen; styleDetails.append(element("summary", "Style & palette")); panel.append(styleDetails);
        if (data.target !== "moss") {
            field(styleDetails, "Style type", "art_style" in data.style ? "art_style" : "photo", v => { const old = data.style; data.style = { aesthetics: old.aesthetics, lighting: old.lighting, medium: old.medium, [v]: old.photo || old.art_style || "" }; }, ["photo", "art_style"]);
            for (const k of ["aesthetics", "lighting", "medium", "art_style" in data.style ? "art_style" : "photo"]) field(styleDetails, k, data.style[k], v => { data.style[k] = v; });
        } else {
            field(styleDetails, "Image type", data.canvas, v => { data.canvas = v; }, ["single", "multi_panel", "collage"]);
            field(styleDetails, "Medium / genre tags", strings(data.meta).join(", "), v => { data.meta = strings(v); });
        }
        paletteField(styleDetails, "Scene palette", data.palette, v => { data.palette = v; });
        panel.append(element("h4", `REGIONS · ${data.regions.length}`));
        const list = element("div", "", "e2go-layout-list"); panel.append(list);
        data.regions.forEach((r, i) => { const b = button(list, `${i + 1} · ${r.enabled === false ? "OFF · " : ""}${r.text || r.caption || r.label}`, e => { selected = new Set([r.id]); render(); }); b.classList.toggle("active", selected.has(r.id)); });
        const chosen = data.regions.filter(r => selected.has(r.id));
        if (chosen.length) {
            panel.append(element("h4", chosen.length === 1 ? "SELECTED REGION" : `${chosen.length} SELECTED`));
            const row = element("div", "", "row"); panel.append(row); button(row, "Duplicate", duplicate); button(row, "Delete", remove);
            const controls = element("div", "", "row"); panel.append(controls);
            button(controls, chosen.every(r => r.locked) ? "Unlock" : "Lock", () => change(() => { const lock = !chosen.every(r => r.locked); chosen.forEach(r => { r.locked = lock; }); }));
            button(controls, chosen.every(r => r.enabled !== false) ? "Disable" : "Enable", () => change(() => { const on = !chosen.every(r => r.enabled !== false); chosen.forEach(r => { r.enabled = on; }); }));
            if (chosen.length === 1) {
                const r = chosen[0];
                let lettering, inferred;
                const updateLettering = (description = r.caption) => {
                    if (!lettering) return;
                    const resolved = visibleText({ ...r, caption: description });
                    lettering.value = resolved;
                    lettering.required = !resolved;
                    inferred.textContent = r.text?.trim() ? "Manual text. Clear this field to use the description again." : resolved ? "Auto-filled from description. Edit here to override." : "Enter exact text above, or put one inscription in quotes in the description below.";
                };
                field(panel, "Region type", r.label, v => { r.label = v; }, ["object", "character", "text"]);
                if (r.label === "text") {
                    lettering = field(panel, "Exact visible text", r.text, v => { r.text = v; updateLettering(); });
                    lettering.placeholder = 'Letters to draw, e.g. CASINO';
                    lettering.style.border = `2px solid ${COLORS[data.regions.indexOf(r) % COLORS.length]}`;
                    lettering.title = "Overrides quoted text in the description. Leave empty to use one quoted inscription automatically.";
                    inferred = element("div"); inferred.style.cssText = "font-size:11px;color:#aebbc6;overflow-wrap:anywhere"; panel.append(inferred); updateLettering();
                }
                const prompt = field(panel, r.label === "text" ? "Typography & appearance" : "Region prompt", r.caption, v => { r.caption = v; updateLettering(); });
                prompt.style.border = `3px solid ${COLORS[data.regions.indexOf(r) % COLORS.length]}`;
                prompt.rows = 4;
                prompt.placeholder = r.label === "text" ? "Describe the lettering: font, color, material and style." : "Describe what should appear here, e.g. a red ceramic teapot with a curved handle.";
                prompt.title = "Describe the contents of this region. Position and size come from its box.";
                const coords = element("div", "", "geometry"); panel.append(coords);
                for (const [i, label] of ["X", "Y", "W", "H"].entries()) number(coords, label, Math.round(r.rect[i] * (i % 2 ? data.height : data.width)), v => {
                    if (r.locked) return;
                    const divisor = i % 2 ? data.height : data.width;
                    r.rect[i] = Math.max(i > 1 ? 1 / divisor : 0, Math.min(1, v / divisor));
                    r.rect[0] = Math.min(r.rect[0], 1 - r.rect[2]); r.rect[1] = Math.min(r.rect[1], 1 - r.rect[3]);
                });
                paletteField(panel, "Region palette", r.palette, v => { r.palette = v; });
                if (data.target === "moss") field(panel, "Region tags", strings(r.tags).join(", "), v => { r.tags = strings(v); });
                const order = element("div", "", "row"); panel.append(order);
                for (const [name, delta] of [["Earlier", -1], ["Later", 1]]) button(order, name, () => change(() => {
                    const i = data.regions.indexOf(r), next = i + delta;
                    if (next >= 0 && next < data.regions.length) [data.regions[i], data.regions[next]] = [data.regions[next], data.regions[i]];
                }));
            } else {
                const align = element("div", "", "row"); panel.append(align);
                button(align, "Align left", () => change(() => { const x = Math.min(...chosen.map(r => r.rect[0])); chosen.filter(r => !r.locked).forEach(r => { r.rect[0] = x; }); }));
                button(align, "Align top", () => change(() => { const y = Math.min(...chosen.map(r => r.rect[1])); chosen.filter(r => !r.locked).forEach(r => { r.rect[1] = y; }); }));
                const distribute = element("div", "", "row"); panel.append(distribute);
                for (const [label, axis] of [["Space X", 0], ["Space Y", 1]]) button(distribute, label, () => change(() => {
                    const rows = chosen.filter(r => !r.locked).sort((a,b) => a.rect[axis] - b.rect[axis]);
                    if (rows.length < 3) return;
                    const start = rows[0].rect[axis], end = rows.at(-1).rect[axis] + rows.at(-1).rect[axis + 2];
                    const gap = (end - start - rows.reduce((sum,r) => sum + r.rect[axis + 2], 0)) / (rows.length - 1);
                    let at = start; for (const r of rows) { r.rect[axis] = at; at += r.rect[axis + 2] + gap; }
                }));
            }
        }
        panel.scrollTop = scroll;
        const issues = validateLayout(data);
        say(!widget() ? "Restart ComfyUI to enable the Layout output." : issues.length ? issues.join("\n") : `${data.width} × ${data.height} · ${data.enabled ? "Layout enabled" : "Layout off — editing only"} · Alt-drag duplicates · Alt-click selects underneath · Shift-click selects multiple · wheel zooms · middle-drag pans`, !!issues.length);
        fit();
    }
    const point = e => { const r = stage.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    work.onpointerdown = e => {
        if (e.button !== 0 && e.button !== 1) return;
        e.preventDefault(); e.stopPropagation(); work.focus();
        const p = point(e), box = e.target.closest(".e2go-layout-box"), r = data.regions.find(r => r.id === box?.dataset.id);
        const before = snapshot();
        if (e.button === 0 && e.altKey && !drawType) {
            const hits = data.regions.filter(r => p[0] >= r.rect[0] && p[0] <= r.rect[0] + r.rect[2] && p[1] >= r.rect[1] && p[1] <= r.rect[1] + r.rect[3]).reverse();
            if (!hits.length) return;
            const source = hits.find(r => selected.has(r.id)) || r || hits[0];
            gesture = { kind: "alt", start: p, screenStart: [e.clientX, e.clientY], before,
                selection: [...selected], hits: hits.map(r => r.id),
                regions: (selected.has(source.id) ? data.regions.filter(r => selected.has(r.id)) : [source]).map(clone) };
            work.setPointerCapture(e.pointerId); return;
        }
        if (e.button === 1) gesture = { kind: "pan", start: [e.clientX, e.clientY], pan: [...pan] };
        else if (drawType) {
            if (p.some(v => v < 0 || v > 1)) return;
            const r = region(drawType, [p[0], p[1], 1 / data.width, 1 / data.height]); data.regions.push(r); selected = new Set([r.id]);
            gesture = { kind: "draw", start: p, id: r.id, before, screenStart: [e.clientX, e.clientY] };
        } else if (r) {
            if (e.shiftKey) { selected.has(r.id) ? selected.delete(r.id) : selected.add(r.id); }
            else if (!selected.has(r.id)) selected = new Set([r.id]);
            gesture = r.locked || !selected.has(r.id) ? null : { kind: e.target.dataset.corner ? "resize" : "move", corner: e.target.dataset.corner, start: p, id: r.id, before,
                regions: data.regions.filter(r => selected.has(r.id) && !r.locked).map(clone) };
        } else { selected.clear(); gesture = null; }
        if (gesture) work.setPointerCapture(e.pointerId);
        render();
    };
    work.onpointermove = e => {
        if (!gesture) return;
        e.stopPropagation(); const g = gesture;
        if (g.kind === "alt") {
            if (Math.hypot(e.clientX - g.screenStart[0], e.clientY - g.screenStart[1]) < 5) return;
            const copies = g.regions.map(r => ({...clone(r), id: uid(), locked: false}));
            data.regions.push(...copies); selected = new Set(copies.map(r => r.id));
            g.regions = copies.map(clone); g.id = copies[0].id; g.kind = "move";
        }
        if (g.kind === "pan") { const scale = work.getBoundingClientRect().width / work.clientWidth || 1; pan = [g.pan[0] + (e.clientX - g.start[0]) / scale, g.pan[1] + (e.clientY - g.start[1]) / scale]; fit(); return; }
        const p = point(e).map(v => Math.max(0, Math.min(1, snap && !e.altKey ? Math.round(v * 100) / 100 : v)));
        const r = data.regions.find(r => r.id === g.id), dx = p[0] - g.start[0], dy = p[1] - g.start[1];
        if (g.kind === "draw") r.rect = [Math.min(p[0], g.start[0]), Math.min(p[1], g.start[1]), Math.max(1 / data.width, Math.abs(dx)), Math.max(1 / data.height, Math.abs(dy))];
        else if (g.kind === "move") {
            const mx = Math.max(-Math.min(...g.regions.map(r => r.rect[0])), Math.min(dx, 1 - Math.max(...g.regions.map(r => r.rect[0] + r.rect[2]))));
            const my = Math.max(-Math.min(...g.regions.map(r => r.rect[1])), Math.min(dy, 1 - Math.max(...g.regions.map(r => r.rect[1] + r.rect[3]))));
            for (const old of g.regions) data.regions.find(r => r.id === old.id).rect = [old.rect[0] + mx, old.rect[1] + my, old.rect[2], old.rect[3]];
        } else {
            const old = g.regions.find(item => item.id === g.id)?.rect || r.rect;
            let [x0, y0, w, h] = old, x1 = x0 + w, y1 = y0 + h;
            if (g.corner.includes("w")) x0 = Math.min(x1 - 1 / data.width, p[0]); else x1 = Math.max(x0 + 1 / data.width, p[0]);
            if (g.corner.includes("n")) y0 = Math.min(y1 - 1 / data.height, p[1]); else y1 = Math.max(y0 + 1 / data.height, p[1]);
            r.rect = [x0, y0, x1 - x0, y1 - y0];
        }
        renderBoxes();
    };
    work.onpointerup = e => { if (!gesture) return; const g = gesture; gesture = null; if (work.hasPointerCapture(e.pointerId)) work.releasePointerCapture(e.pointerId); if (g.kind === "alt") { const index = g.hits.findIndex(id => selected.has(id)); selected = new Set([g.hits[(index + 1) % g.hits.length]]); render(); return; } if (g.kind === "draw" && Math.hypot(e.clientX - g.screenStart[0], e.clientY - g.screenStart[1]) < 5) { data = readLayout(g.before); selected.clear(); render(); return; } if (g.kind === "draw") drawType = null; if (g.before) commit(g.before); };
    work.onpointercancel = () => { if (gesture?.before) data = readLayout(gesture.before); if (gesture?.selection) selected = new Set(gesture.selection); gesture = null; render(); };
    work.onwheel = e => { e.preventDefault(); e.stopPropagation(); zoom = Math.max(.4, Math.min(6, zoom * Math.exp(-e.deltaY * .001))); fit(); };
    work.onkeydown = e => {
        e.stopPropagation();
        if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); history(e.shiftKey); }
        else if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") { e.preventDefault(); duplicate(); }
        else if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); remove(); }
        else if (e.code === "Escape") { if (gesture?.before) data = readLayout(gesture.before); gesture = null; drawType = null; selected.clear(); render(); }
        else if (e.code.startsWith("Arrow")) { e.preventDefault(); change(() => {
            const dx = (e.code === "ArrowLeft" ? -1 : e.code === "ArrowRight" ? 1 : 0) * (e.shiftKey ? 10 : 1) / data.width;
            const dy = (e.code === "ArrowUp" ? -1 : e.code === "ArrowDown" ? 1 : 0) * (e.shiftKey ? 10 : 1) / data.height;
            data.regions.filter(r => selected.has(r.id) && !r.locked).forEach(r => { r.rect[0] = Math.max(0, Math.min(1 - r.rect[2], r.rect[0] + dx)); r.rect[1] = Math.max(0, Math.min(1 - r.rect[3], r.rect[1] + dy)); });
        }); }
    };
    let dialog = null;
    function openJson(importing) {
        dialog?.remove(); dialog = element("div", "", "e2go-layout-dialog"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", importing ? "Import layout" : "Export layout");
        dialog.append(element("strong", importing ? "Import · Powder / Ideogram / MOSS / FLUX.3" : "Export · editable document and model prompt"));
        dialog.append(element("span", "MOSS compiled coordinates use the currently selected dimensions. A MOSS draft includes its own dimensions."));
        const text = element("textarea"); text.setAttribute("aria-label", "Layout JSON"); dialog.append(text);
        const tools = element("div"); dialog.append(tools);
        const close = () => { dialog?.remove(); dialog = null; };
        if (importing) {
            const file = element("input"); file.type = "file"; file.accept = ".json,application/json"; file.onchange = async () => { if (file.files[0]) text.value = await file.files[0].text(); }; tools.append(file);
            button(tools, "Apply import", () => { try { const imported = importLayout(text.value, data); change(() => { data = imported; selected.clear(); }); close(); } catch (err) { say(err.message, true); } });
        } else {
            text.value = JSON.stringify(data, null, 2);
            button(tools, "Editable document", () => { text.value = JSON.stringify(data, null, 2); });
            button(tools, "Model prompt", () => { try { const prompt = caption(data); text.value = typeof prompt === "string" ? prompt : JSON.stringify(prompt, null, data.target === "moss" ? 0 : 4); } catch (err) { say(err.message, true); } });
            button(tools, "Copy", async () => { try { await navigator.clipboard.writeText(text.value); } catch { text.focus(); text.select(); } });
            button(tools, "Download", () => { const a = element("a"); a.href = URL.createObjectURL(new Blob([text.value], { type: "application/json" })); a.download = "powder-layout.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
        }
        button(tools, "Close", close); document.body.append(dialog); text.focus();
    }
    async function enhance(keepGeometry, sceneOverride) {
        if (busy) return;
        if (!keepGeometry && !(sceneOverride ?? data.scene).trim()) { say("Enter a scene description before creating a new composition.", true); return; }
        const original = clone(data), baseline = snapshot();
        const request = clone(original); if (sceneOverride !== undefined) request.scene = sceneOverride;
        const controller = new AbortController(); aiController = controller;
        busy = true; aiAssistant.disabled = true; aiAssistant.textContent = "AI working…"; stopAI.hidden = false;
        try {
            const { proposeLayout, loadStyleLibrary } = await import("./e2go_layout_ai.js");
            const connections = layoutConnections(node), contextBaseline = JSON.stringify(connections);
            const context = resolveLayoutContext(connections, connections.styles.length ? await loadStyleLibrary(controller.signal) : []);
            controller.signal.throwIfAborted();
            const proposed = await proposeLayout(request, keepGeometry, message => say(message), controller.signal, undefined, context);
            if (disposed) return;
            const ensureCurrent = () => {
                if (JSON.stringify(layoutConnections(node)) !== contextBaseline) throw new Error("Connected styles or LoRA triggers changed. Request a new AI proposal.");
                if (disposed || baseline !== snapshot() || baseline !== JSON.stringify(readLayout(widget()?.value))) throw new Error("Layout changed while AI was working. Discard this proposal and request a new one from your current layout.");
            };
            ensureCurrent();
            proposalDialog?.close();
            proposalDialog = reviewLayoutProposal(original, proposed, next => {
                ensureCurrent(); change(() => { data = next; selected.clear(); }); say("AI proposal applied. Undo restores the previous layout.");
            }, keepGeometry, async (previous, signal) => {
                ensureCurrent();
                const variant = await proposeLayout(request, keepGeometry, message => say(message), signal, previous, context);
                signal.throwIfAborted(); ensureCurrent(); return variant;
            });
            say(["AI proposal ready. Review it before applying.", ...context.warnings].join("\n"));
        } catch (err) {
            if (!disposed) {
                say(err.name === "AbortError" ? "Stopped waiting. Your layout is unchanged; the queued AI job may still finish." : err.message, err.name !== "AbortError");
                if (err.name !== "AbortError") {
                    assistantDialog?.close(); assistantDialog = canvasDialog("AI proposal could not be applied");
                    assistantDialog.append(element("p", err.message), element("p", "Your layout is unchanged."));
                    button(assistantDialog, "Close", () => assistantDialog.close());
                }
            }
        }
        finally { busy = false; aiController = null; stopAI.hidden = true; aiAssistant.disabled = false; aiAssistant.textContent = "AI assistant"; }
    }
    const observer = new ResizeObserver(fit); observer.observe(work);
    const panelObserver = new ResizeObserver(() => resizePanel()); panelObserver.observe(body);
    node._e2goLayoutPrepare = () => {
        if (!widget()) return;
        const latest = readLayout(widget()?.value || "{}");
        const dims = latest.followResolution ? generationSize() : null;
        if (dims && (latest.width !== dims[0] || latest.height !== dims[1])) {
            [latest.width, latest.height] = dims;
            data = latest; persist(); if (!root.hidden) render();
        }
    };
    const sizeTimer = setInterval(() => { if (!root.hidden && !gesture) { try { node._e2goLayoutPrepare(); } catch (err) { say(err.message, true); } } }, 500);
    node._e2goLayoutReload = () => {
        if (root.hidden) return;
        try { data = readLayout(widget()?.value); selected.clear(); undo = []; redo = []; render(); }
        catch (err) { say(err.message, true); }
    };
    return {
        disableGeneration() {
            data = readLayout(widget()?.value || snapshot());
            if (data.enabled) change(() => { data.enabled = false; });
        },
        reset() {
            aiController?.abort(); proposalDialog?.close();
            const target = data.target; data = blankLayout(); data.target = target;
            selected.clear(); undo = []; redo = []; drawType = null; gesture = null; zoom = 1; pan = [0, 0];
            bg.width = bg.height = 1; persist(); render();
        },
        show(on) {
            root.hidden = !on;
            if (on) {
                panelWidth = Number(node.properties?.e2goLayoutPanelWidth) || panelWidth; resizePanel();
                try { data = readLayout(widget()?.value || snapshot()); } catch (err) { say(err.message, true); }
                const layer = state.layers?.[0]?.canvas;
                if (layer) { bg.width = Math.min(1024, layer.width); bg.height = Math.round(layer.height * bg.width / layer.width); bg.getContext("2d").drawImage(layer, 0, 0, bg.width, bg.height); }
                else { bg.width = bg.height = 1; }
                guide.textContent = layer ? "Canvas image: visual guide only. Layout regions are not masks." : "Regions describe composition; they do not edit image pixels.";
                render();
            }
        },
        destroy() { disposed = true; document.removeEventListener("wheel", scrollPanel, true); aiController?.abort(); clearInterval(sizeTimer); observer.disconnect(); panelObserver.disconnect(); assistantDialog?.close(); proposalDialog?.close(); dialog?.remove(); root.remove(); delete node._e2goLayoutReload; delete node._e2goLayoutPrepare; },
    };
}
