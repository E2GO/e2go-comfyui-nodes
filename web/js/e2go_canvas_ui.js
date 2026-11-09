import { canvasIcon } from "./e2go_canvas_icons.js";
// e2go_canvas_ui.js — PowderCanvas editor: DOM toolbar + display canvas.
// Deliberately a DOM widget (not LiteGraph hit-zones): real buttons, native
// color input, proper pointer capture. All pixel work delegates to the model.

import * as model from "./e2go_canvas_model.js";
import { findDownstream } from "./e2go_graph_wire.js";
import { computeLive as resolutionLive } from "./powder_resolution.js";
import { canvasDialog, canvasSizeDialog } from "./e2go_canvas_dialog.js";
import { mountLayoutEditor } from "./e2go_canvas_layout.js";

const CSS_ID = "e2go-canvas-css";
const CSS = `
.e2go-cv-root { --cv-font:12px; }
.e2go-cv-root { display:flex; flex-direction:column; width:100%; height:100%; background:#1b1c1e; }
.e2go-cv-bar { display:flex; flex-wrap:wrap; gap:4px; align-items:center; padding:4px; border-bottom:1px solid #333; font:11px Arial,sans-serif; color:#bbb; }
.e2go-cv-bar button { background:#2c2e31; color:#ccc; border:1px solid #4a4a4a; border-radius:3px; padding:2px 7px; cursor:pointer; font:11px Arial; }
.e2go-cv-bar button.on { background:#2d3f52; color:#fff; border-color:#5a7a9a; }
.e2go-cv-bar button:hover:not(:disabled) { background:#405265; color:#fff; border-color:#89a8c4; }
.e2go-cv-bar button:focus-visible { outline:2px solid #91c7e8; outline-offset:2px; }
.e2go-cv-bar button:active:not(:disabled) { filter:brightness(1.2); }
.e2go-cv-command button.e2go-cv-expand { background:#304e50; border-color:#527c7e; color:#deeded; margin-left:auto; }
.e2go-cv-command button.e2go-cv-expand:hover { background:#3b6062; }
.e2go-cv-command button.e2go-cv-return { background:#54383b; border-color:#80565b; color:#eadbdd; }
.e2go-cv-command button.e2go-cv-return:hover { background:#664247; }
.e2go-cv-root button:disabled { opacity:.35; cursor:default; }
.e2go-cv-bar input[type=range] { width:64px; }
.e2go-cv-bar input[type=color] { width:26px; height:20px; padding:0; border:1px solid #4a4a4a; background:none; }
.e2go-cv-bar .grp { display:flex; gap:3px; align-items:center; padding:0 4px; border-right:1px solid #333; }
.e2go-cv-status { margin-left:auto; color:#999; padding-right:6px; }
.e2go-cv-status.warn { color:#d1a05f; }
.e2go-cv-status button { margin-left:6px; padding:1px 6px; vertical-align:baseline; }
.e2go-cv-mid { display:flex; flex:1; min-height:0; }
.e2go-cv-tools { display:flex; flex-direction:column; gap:3px; padding:4px; border-right:1px solid #333; }
.e2go-cv-tools button { width:46px; height:26px; padding:0; font:11px Arial; }
.e2go-cv-tools .striplbl { font:9px Arial; letter-spacing:1px; color:#777; text-transform:uppercase; text-align:center; margin-top:4px; }
.e2go-cv-tools button.on { background:#2d3f52; border-color:#5a7a9a; color:#fff; }
.e2go-cv-tools button[title^="Mode: edit the inpaint mask"].on { background:#5a2d31; border-color:#9a5a5f; }
.e2go-cv-side { width:168px; display:flex; flex-direction:column; gap:5px; padding:6px 8px; border-left:1px solid #333; overflow-y:auto; }
.e2go-cv-side .hdr { display:flex; align-items:center; gap:4px; margin:4px 0 1px; }
.e2go-cv-side .hdr span { font:10px Arial; letter-spacing:1px; color:#888; text-transform:uppercase; flex:1; }
.e2go-cv-side .hdr button { width:20px; height:18px; padding:0; font:11px Arial; line-height:1; }
.e2go-cv-lrow { display:flex; gap:6px; align-items:center; padding:3px 5px; border-radius:3px; cursor:pointer; font:11px Arial; color:#ccc; }
.e2go-cv-lrow:hover { background:#26282c; }
.e2go-cv-lrow.active { background:#2d3f52; color:#fff; }
.e2go-cv-lrow.target { outline:1px dashed #5a7a9a; outline-offset:-2px; }
.e2go-cv-lrow .eye { cursor:pointer; width:16px; text-align:center; }
.e2go-cv-lrow .eye.off { opacity:.3; }
.e2go-cv-lrow .swatch { width:12px; height:12px; border-radius:2px; border:1px solid #555; }
.e2go-cv-lrow .thumb { width:30px; height:22px; flex-shrink:0; border:1px solid #444; border-radius:2px; background:#141517; }
.e2go-cv-lrow .lname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.e2go-cv-lrow input.lname { background:#1b1c1e; color:#fff; border:1px solid #5a7a9a; border-radius:2px; font:11px Arial; padding:0 2px; min-width:0; }
.e2go-cv-lrow .del { width:18px; height:16px; padding:0; font:10px Arial; line-height:1; background:none; border:none; color:#888; visibility:hidden; cursor:pointer; }
.e2go-cv-lrow:hover .del { visibility:visible; }
.e2go-cv-lrow .del:hover { color:#e08080; }
.e2go-cv-lrow .del.arm { visibility:visible; width:auto; padding:0 4px; color:#fff; background:#8a3038; border:1px solid #b05058; border-radius:2px; }
.e2go-cv-grouplabel { color:#777; font:10px Arial; letter-spacing:1px; text-transform:uppercase; padding:0 2px 0 6px; }
button.e2go-cv-refresh { background:#2e5d3a; border-color:#4a8f5c; color:#dff5e3; }
button.e2go-cv-refresh:hover { background:#38724a; }
.e2go-cv-view { flex:1; min-height:0; position:relative; overflow:hidden; cursor:crosshair; }
.e2go-cv-view canvas { position:absolute; left:0; top:0; touch-action:none; }
.e2go-cv-empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; pointer-events:none; color:#777; font:12px Arial; text-align:center; }
.e2go-cv-empty .big { font:13px Arial; color:#999; }
.e2go-cv-empty .kbd { border:1px dashed #555; border-radius:4px; padding:2px 8px; }
.e2go-cv-break { flex-basis:100%; height:0; }
.e2go-cv-pal { display:grid; grid-template-columns:repeat(5, 22px); gap:4px; justify-content:start; padding:2px 0; }
.e2go-cv-pal button { width:22px; height:16px; padding:0; border:1px solid #4a4a4a; border-radius:2px; cursor:pointer; transition:outline-color .3s; outline:2px solid transparent; }
.e2go-cv-pal button.stored { outline-color:#4a8f5c; transition:none; }
.e2go-cv-bar .grp .val { min-width:22px; text-align:right; color:#999; font:10px Arial; }
.e2go-cv-picker { display:flex; flex-direction:column; gap:5px; }
.e2go-cv-picker .sv { position:relative; width:100%; height:86px; cursor:crosshair; border:1px solid #444; border-radius:3px; overflow:hidden; }
.e2go-cv-picker .sv canvas { position:absolute; left:0; top:0; width:100%; height:100%; }
.e2go-cv-picker .svdot { position:absolute; width:10px; height:10px; border:2px solid #fff; border-radius:50%; box-shadow:0 0 2px #000; transform:translate(-6px,-6px); pointer-events:none; }
.e2go-cv-picker input[type=range].hue { width:100%; height:10px; -webkit-appearance:none; appearance:none; border-radius:5px;
  background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00); }
.e2go-cv-picker input[type=range].hue::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; border-radius:50%; background:#fff; border:1px solid #888; }
.e2go-cv-picker .pkrow { display:flex; gap:3px; align-items:center; }
.e2go-cv-picker .circle { width:18px; height:18px; border-radius:50%; border:1px solid #666; flex-shrink:0; }
.e2go-cv-picker .pkrow { justify-content:space-between; }
.e2go-cv-picker input[type=number] { width:30px; text-align:center; background:#1b1c1e; color:#ccc; border:1px solid #4a4a4a; border-radius:3px; font:11px Arial; padding:1px 2px; }
.e2go-cv-picker input[type=number]::-webkit-inner-spin-button { display:none; }
.e2go-cv-cmpctl { display:none; gap:3px; align-items:center; }
.e2go-cv-cmpctl.open { display:flex; }
.e2go-cv-bar .cnt { min-width:28px; text-align:center; }

.e2go-cv-float .pg { background:#2d3f52; border-color:#5a7a9a; color:#dfe9f5; }
.e2go-cv-float .pg:hover { background:#385070; }
.e2go-cv-float .peek { background:#463a5e; border-color:#7a68a8; color:#e9e2f5; }
.e2go-cv-float .peek:hover { background:#544672; }
.e2go-cv-float .peek.on { background:#5d4d85; border-color:#a892d8; color:#fff; }
.e2go-cv-float .adopt { background:#2e5d3a; border-color:#4a8f5c; color:#dff5e3; }
.e2go-cv-float .adopt:hover { background:#38724a; }
.e2go-cv-float .layer { background:#2d5050; border-color:#4a8f8a; color:#dff5f2; }
.e2go-cv-float .layer:hover { background:#376560; }
.e2go-cv-float .close { background:#502d31; border-color:#9a5a5f; color:#f5dfe1; }
.e2go-cv-float .close:hover { background:#663a3f; }
.e2go-cv-nav { position:absolute; top:6px; right:6px; display:flex; gap:4px; z-index:5; }
.e2go-cv-xfbar { position:absolute; top:6px; left:6px; display:flex; gap:4px; z-index:6; }
.e2go-cv-xfbar button { width:28px; height:28px; padding:0; border-radius:4px; cursor:pointer; font:14px Arial; }
.e2go-cv-xfbar .ok { background:#2e5d3a; border:1px solid #4a8f5c; color:#dff5e3; }
.e2go-cv-xfbar .no { background:#502d31; border:1px solid #9a5a5f; color:#f5dfe1; }
.e2go-cv-float { position:absolute; left:0; right:0; bottom:10px; margin:0 auto; width:fit-content; white-space:nowrap; z-index:6; display:flex; align-items:center; gap:4px; background:rgba(35,37,39,.92); border:1px solid #4a4a4a; border-radius:6px; padding:4px 8px; box-shadow:0 4px 16px rgba(0,0,0,.5); }
.e2go-cv-float .grip { cursor:grab; user-select:none; color:#999; font:11px Arial; letter-spacing:.08em; padding:0 4px; }
.e2go-cv-float .grip:active { cursor:grabbing; }
.e2go-cv-nav button { width:28px; height:28px; padding:0; opacity:.72; background:#2c2e31; color:#ccc; border:1px solid #4a4a4a; border-radius:4px; cursor:grab; font:14px Arial; touch-action:none; }
.e2go-cv-nav button:hover { opacity:1; }
.e2go-cv-nav button:active { cursor:grabbing; background:#2d3f52; }
.e2go-cv-menu { position:fixed; z-index:10002; background:#232527; border:1px solid #4a4a4a; border-radius:4px; padding:4px; min-width:180px; box-shadow:0 4px 16px rgba(0,0,0,.5); }
.e2go-cv-menu button { display:block; width:100%; text-align:left; background:none; border:none; color:#ccc; padding:5px 8px; border-radius:3px; cursor:pointer; font:11px Arial; }
.e2go-cv-menu button:hover:not(:disabled) { background:#2d3f52; color:#fff; }
.e2go-cv-menu button:disabled { color:#666; cursor:default; }
.e2go-cv-menu .sep { height:1px; background:#3a3a3a; margin:3px 4px; }
`;

const UX_CSS = `
.e2go-cv-root { container-type:inline-size; }
.e2go-cv-root .e2go-cv-mid { position:relative; }
.e2go-cv-root .e2go-cv-tools button, .e2go-cv-root .e2go-cv-side button, .e2go-cv-empty-actions button { background:#303338; color:#eee; border:1px solid #555; border-radius:4px; }
.e2go-cv-root .e2go-cv-tools button.on { background:#2d4e6b; border-color:#86b5df; }
.e2go-cv-root .e2go-cv-tools button[title^="Mode: edit the inpaint mask"].on { background:#63353e; border-color:#cd7d8c; }
.e2go-cv-panel-toggle { display:none; }
.e2go-cv-root[data-view="empty"] .e2go-cv-tools, .e2go-cv-root[data-view="empty"] .e2go-cv-side, .e2go-cv-root[data-view="empty"] .e2go-cv-bar, .e2go-cv-root[data-view="empty"] .e2go-cv-nav { display:none; }
@container (max-width:640px) {
    .e2go-cv-root .e2go-cv-side { display:none; }
    .e2go-cv-panel-toggle { display:inline-block; }
    .e2go-cv-root[data-panels="open"] .e2go-cv-side { display:flex; position:absolute; right:0; top:0; bottom:0; z-index:8; background:#232527; box-shadow:-5px 0 16px #0008; }
}
.e2go-cv-root .e2go-cv-bar { font-size:12px; gap:6px; }
.e2go-cv-root button { min-height:26px; }
.e2go-cv-root button:focus-visible, .e2go-cv-root input:focus-visible, .e2go-cv-root select:focus-visible { outline:2px solid #8abcf0; outline-offset:2px; }
.e2go-cv-root .e2go-cv-tools button { width:64px; height:30px; }
.e2go-cv-root .e2go-cv-side { width:180px; flex-shrink:0; }
.e2go-cv-root .e2go-cv-side .hdr span, .e2go-cv-root .e2go-cv-lrow { font-size:12px; }
.e2go-cv-root .e2go-cv-lrow .eye { width:auto; min-width:20px; }
.e2go-cv-root .e2go-cv-lrow .del { min-height:24px; width:24px; font-size:12px; visibility:visible; }
.e2go-cv-root .e2go-cv-lrow .del.arm { width:auto; }
.e2go-cv-root .e2go-cv-bar .val { font-size:11px; }
.e2go-cv-root .e2go-cv-empty { pointer-events:auto; font-size:13px; }
.e2go-cv-empty-actions { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; }
.e2go-cv-command { display:flex; flex-direction:column; gap:7px; padding:7px; border-bottom:1px solid #444; font:12px Arial; flex-shrink:0; }
.e2go-cv-command-row { display:flex; flex-wrap:wrap; align-items:center; gap:7px; min-width:0; }
.e2go-cv-command-group { display:flex; flex-wrap:wrap; align-items:center; gap:5px; min-width:0; }
.e2go-cv-editors { flex-wrap:nowrap; }
.e2go-cv-results { border-left:1px solid #52606a; padding-left:8px; }
.e2go-cv-command-actions { border-top:1px solid #333b42; padding-top:6px; }
.e2go-cv-command-tools { margin-left:auto; }
.e2go-cv-command [hidden] { display:none!important; }
.e2go-cv-command button, .e2go-cv-command select, .e2go-cv-root .e2go-cv-result-size { background:#303338; color:#eee; border:1px solid #555; border-radius:4px; padding:4px 7px; }
.e2go-cv-command button.on { background:#2d4e6b; border-color:#86b5df; }
.e2go-cv-command button { cursor:pointer; }
.e2go-cv-command button:hover:not(:disabled) { background:#405265; border-color:#89a8c4; color:#fff; }
.e2go-cv-command button:focus-visible { outline:2px solid #91c7e8; outline-offset:2px; }
.e2go-cv-command button:active:not(:disabled) { filter:brightness(1.2); }
.e2go-cv-state { flex:1 1 180px; min-width:0; color:#b8c7d0; font-size:11px; }
.e2go-cv-footer { position:relative; display:flex; flex-wrap:wrap; gap:10px; padding:6px 8px; min-height:38px; box-sizing:border-box; flex-shrink:0; border-top:1px solid #444; font:12px Arial; color:#bbb; }
.e2go-cv-notice:empty { display:none; }
.e2go-cv-notice { position:absolute; inset:0; z-index:1; overflow:auto; padding:5px 8px; font:12px Arial; background:#26313a; color:#e3edf5; }
.e2go-cv-notice.warn { background:#423726; color:#ffe1a4; }
.e2go-cv-color-details summary { cursor:pointer; padding:6px 0; color:#ccc; font:12px Arial; }
.e2go-cv-mask-note { font:11px Arial; color:#b8b8b8; padding:4px 5px 8px; }
.e2go-cv-help { padding:8px; color:#ddd; background:#28313b; font:12px/1.6 Arial; }
.e2go-cv-help[hidden] { display:none; }
.e2go-cv-root .e2go-cv-float { max-width:calc(100% - 16px); box-sizing:border-box; flex-wrap:wrap; justify-content:center; }
.e2go-cv-root .e2go-cv-cmpctl { flex-wrap:wrap; justify-content:center; }
.e2go-cv-result-index { width:48px; background:#202226; border:1px solid #666; color:#fff; padding:4px; }
.e2go-cv-result-thumbs { display:flex; gap:5px; overflow-x:auto; max-width:100%; flex-basis:100%; padding:4px 0; }
.e2go-cv-result-thumbs[hidden] { display:none; }
.e2go-cv-root .e2go-cv-thumbs-toggle.on { background:#2d4e6b; border-color:#86b5df; color:#fff; }
.e2go-cv-result-thumbs button { flex-shrink:0; padding:2px; background:#222; border:2px solid transparent; color:#ddd; }
.e2go-cv-result-thumbs button.on { border-color:#8abcf0; }
.e2go-cv-result-thumbs img { display:block; width:48px; height:42px; object-fit:contain; }
.e2go-cv-expanded { position:fixed; inset:12px; z-index:10001; border:1px solid #666; border-radius:8px; overflow:hidden; box-shadow:0 0 0 30px #000a; }
.e2go-cv-expanded .e2go-cv-root { width:100%; height:100%; }
`;

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const el = document.createElement("style");
    el.id = CSS_ID;
    el.textContent = CSS + UX_CSS;
    document.head.appendChild(el);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function mountCanvasEditor(node, state, container) {
    ensureCss();
    const root = el("div", "e2go-cv-root");
    const bar = el("div", "e2go-cv-bar");
    const mid = el("div", "e2go-cv-mid");
    const toolStrip = el("div", "e2go-cv-tools");
    const view = el("div", "e2go-cv-view");
    const side = el("div", "e2go-cv-side");
    const display = document.createElement("canvas");
    view.appendChild(display);
    mid.append(toolStrip, view, side);
    root.append(bar, mid);
    container.appendChild(root);

    const commands = el("div", "e2go-cv-command");
    const editorTab = el("button", "on", "Edit canvas");
    const resultTab = el("button", "", "View results");
    const layoutTab = el("button", "", "Layout");
    editorTab.title = "Edit pixels, paint layers and the mask. Disables Layout generation; saved regions are kept.";
    layoutTab.title = "Arrange regions and describe composition. Regions are not pixel-editing masks.";
    resultTab.title = "Preview generated results. Viewing a result does not replace the Canvas image.";
    let layoutActive = false;
    const layoutEditor = mountLayoutEditor(node, state, root);
    function showLayout(active) {
        node._e2goCanvasCommitXform?.();
        layoutActive = active;
        root.dataset.layout = String(active);
        canvasActions.hidden = active;
        ui.hover = false;
        bar.style.display = active ? "none" : "";
        mid.style.display = active ? "none" : "";
        layoutTab.classList.toggle("on", active);
        layoutEditor.show(active);
        redraw();
        editorTab.classList.toggle("on", !active && !ui.previewResult);
        resultTab.classList.toggle("on", !active && !!ui.previewResult);
        editorTab.setAttribute("aria-pressed", String(!active && !ui.previewResult));
        layoutTab.setAttribute("aria-pressed", String(active));
        resultTab.setAttribute("aria-pressed", String(!active && !!ui.previewResult));
        if (active) stateLabel.textContent = "Layout · regions are not masks";
        footer.style.display = active ? "none" : "";
    }
    const stateLabel = el("span", "e2go-cv-state");
    let canvasModal = null;
    const clearCanvas = el("button", "", "Reset all…");
    clearCanvas.title = "Start fresh: remove background, paint, mask, results and layout";
    clearCanvas.onclick = () => {
        canvasModal?.close();
        canvasModal = canvasDialog("Reset Canvas and Layout?");
        const note = el("p", "", "Remove the background, all paint layers, mask, results and layout regions? This resets the editor completely. Saved image files are kept.");
        note.style.lineHeight = "1.6";
        const cancel = el("button", "", "Cancel"), reset = el("button", "", "Clear everything");
        for (const b of [cancel, reset]) b.style.cssText = "padding:9px 14px;margin:8px 8px 0 0;background:#34434f;color:#eee;border:1px solid #657381;border-radius:6px;cursor:pointer";
        reset.style.background = "#743b43";
        cancel.onclick = () => canvasModal.close();
        reset.onclick = async () => {
            reset.disabled = true;
            const keepLayout = layoutActive;
            try {
                cancelXform(); cancelExpand(); ui.stroke = null;
                await node._e2goCanvasReset?.();
                closeReview(); layoutEditor.reset();
                ui.view = { scale: 1, ox: 0, oy: 0, angle: 0, fitted: false };
                showLayout(keepLayout); rebuildLayersPanel(); redraw();
                canvasModal.close(); node.graph?.change?.();
            } catch (err) { note.textContent = err.message; reset.disabled = false; }
        };
        canvasModal.append(note, cancel, reset); cancel.focus();
    };
    const canvasMenu = el("button", "", "Canvas ▾");
    const exportMenu = el("button", "", "Export ▾");
    const panelToggle = el("button", "e2go-cv-panel-toggle", "Layers / color");
    panelToggle.onclick = () => {
        root.dataset.panels = root.dataset.panels === "open" ? "closed" : "open";
        panelToggle.setAttribute("aria-expanded", String(root.dataset.panels === "open"));
    };
    const expandEditor = el("button", "e2go-cv-expand", "Expand editor");
    const helpButton = el("button", "", "Help");
    const saveWorkflow = el("button", "", "Save Canvas + workflow");
    saveWorkflow.title = "Wait for all Canvas uploads, then save this workflow. Enable Save mask in workflow to include masks.";
    saveWorkflow.onclick = async () => {
        saveWorkflow.disabled = true;
        try { await node._e2goCanvasSaveWorkflow?.(); }
        finally { saveWorkflow.disabled = false; }
    };
    for (const [button, icon] of [[editorTab, "edit"], [resultTab, "image"], [layoutTab, "layout"], [canvasMenu, "image"], [clearCanvas, "clear"], [exportMenu, "export"], [saveWorkflow, "save"], [expandEditor, "expand"]]) canvasIcon(button, icon);
    const navigation = el("div", "e2go-cv-command-row");
    const editors = el("div", "e2go-cv-command-group e2go-cv-editors");
    editors.setAttribute("role", "group"); editors.setAttribute("aria-label", "Editors");
    editors.append(editorTab, layoutTab);
    const results = el("div", "e2go-cv-command-group e2go-cv-results");
    results.setAttribute("role", "group"); results.setAttribute("aria-label", "Generated results"); results.append(resultTab);
    const viewTools = el("div", "e2go-cv-command-group e2go-cv-command-tools");
    viewTools.setAttribute("role", "group"); viewTools.setAttribute("aria-label", "Editor view"); viewTools.append(helpButton, expandEditor);
    navigation.append(editors, results, viewTools);
    const actions = el("div", "e2go-cv-command-row e2go-cv-command-actions");
    const canvasActions = el("div", "e2go-cv-command-group");
    canvasActions.setAttribute("role", "group"); canvasActions.setAttribute("aria-label", "Canvas files and tools");
    canvasActions.append(canvasMenu, exportMenu, panelToggle);
    // Saving and the explicitly confirmed full reset apply to the whole node.
    const documentActions = el("div", "e2go-cv-command-group");
    documentActions.setAttribute("role", "group"); documentActions.setAttribute("aria-label", "Save and reset");
    documentActions.append(saveWorkflow, clearCanvas);
    actions.append(canvasActions, documentActions, stateLabel);
    commands.append(navigation, actions);
    root.prepend(commands);
    const help = el("div", "e2go-cv-help",
        "None keeps drawing off. Choose Mask or Paint to start with the brush; click the active mode again or press Esc to stop. "
        + "Use Eraser / Fill / Transform for other edits. "
        + "Drag the hand, magnifier or rotate button to navigate. [ / ] changes brush size. "
        + "Enter applies a transform; Esc cancels. Undo / Redo buttons affect the canvas; Ctrl+Z affects the workflow. "
        + "In the node, wheel and middle-drag navigate the workflow. Results are previews: Queue uses the editor canvas until you adopt a result. "
        + "Enable Save mask in workflow to restore it later. Wait for the saved status before saving the workflow; referenced files stay on this ComfyUI server.");
    help.hidden = true;
    commands.after(help);
    helpButton.onclick = () => { help.hidden = !help.hidden; };
    editorTab.onclick = () => { layoutEditor.disableGeneration(); showLayout(false); setPreview(false); };
    resultTab.onclick = () => { showLayout(false); if (ui.review) setPreview(true); };
    layoutTab.onclick = () => showLayout(true);
    const menuAt = (button, section) => {
        const r = button.getBoundingClientRect();
        showCanvasMenu(r.left, r.bottom + 3, section);
    };
    canvasMenu.onclick = () => menuAt(canvasMenu, "canvas");
    exportMenu.onclick = () => menuAt(exportMenu, "export");
    let expandedHost = null;
    expandEditor.onclick = () => {
        if (expandedHost) {
            container.appendChild(root);
            expandedHost.remove();
            expandedHost = null;
            expandEditor.textContent = "Expand editor";
            canvasIcon(expandEditor, "expand");
            expandEditor.classList.remove("e2go-cv-return");
        } else {
            expandedHost = el("div", "e2go-cv-expanded");
            expandedHost.setAttribute("role", "dialog");
            expandedHost.setAttribute("aria-label", "Powder Canvas editor");
            document.body.appendChild(expandedHost);
            expandedHost.appendChild(root);
            expandEditor.textContent = "Return to node";
            canvasIcon(expandEditor, "collapse");
            expandEditor.classList.add("e2go-cv-return");
        }
        requestAnimationFrame(() => { ui.view.fitted = false; redraw(); });
    };
    const persistentInfo = el("span");
    const saveInfo = el("span");
    const footer = el("div", "e2go-cv-footer");
    footer.append(persistentInfo, saveInfo);
    root.appendChild(footer);
    node._e2goCanvasSetSaveState = value => {
        node._e2goCanvasSaveState = value;
        saveInfo.textContent = model.hasContent(state) ? `${value} · ${state.rememberMask ? "mask persistence on" : "mask is temporary"}` : "";
    };

    // C4D-style nav handles: press-and-drag on a handle drives the view.
    const nav = el("div", "e2go-cv-nav");
    function navDragBtn(label, title, onDrag) {
        const b = el("button", "", label);
        b.title = title;
        let dragging = false;
        let last = null; // client-coord fallback when Pointer Lock is unavailable
        b.addEventListener("pointerdown", (e) => {
            if (!model.hasContent(state)) return;
            e.stopPropagation();
            e.preventDefault();
            dragging = true;
            last = { x: e.clientX, y: e.clientY };
            b.setPointerCapture(e.pointerId);
            // C4D-style handle: hide the cursor while dragging and restore it
            // exactly over the button on release. Pointer Lock delivers
            // movementX/Y deltas so the drag never "runs off" the screen.
            try { b.requestPointerLock?.()?.catch?.(() => {}); } catch {}
        });
        b.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            e.stopPropagation();
            let dx, dy;
            if (document.pointerLockElement === b) {
                dx = e.movementX;
                dy = e.movementY;
            } else if (last) {
                dx = e.clientX - last.x;
                dy = e.clientY - last.y;
                last = { x: e.clientX, y: e.clientY };
            } else {
                return; // lock lost mid-drag (Esc) with no fallback anchor
            }
            if (dx || dy) {
                onDrag(dx, dy);
                scheduleRedraw();
            }
        });
        const end = (e) => {
            dragging = false;
            last = null;
            if (document.pointerLockElement === b) document.exitPointerLock();
            try { b.releasePointerCapture(e.pointerId); } catch {}
        };
        b.addEventListener("pointerup", end);
        b.addEventListener("pointercancel", end);
        return b;
    }
    const navCenter = () => ({ x: display.width / 2, y: display.height / 2 });
    nav.append(
        navDragBtn("✋", "Drag: pan the view", (dx, dy) => {
            const r = display.getBoundingClientRect();
            const k = r.width ? display.width / r.width : 1;
            ui.view.ox += dx * k;
            ui.view.oy += dy * k;
        }),
        navDragBtn("🔍", "Drag vertically: zoom the view", (dx, dy) => {
            const c = navCenter();
            zoomAt(c.x, c.y, Math.exp(-dy * 0.005));
        }),
        navDragBtn("↻", "Drag horizontally: rotate the view (display only)", (dx) => {
            const c = navCenter();
            rotateAt(c.x, c.y, dx * 0.01);
        }),
    );
    const bResetRot = el("button", "", "0°");
    bResetRot.title = "Reset rotation only (zoom/pan preserved)";
    bResetRot.addEventListener("pointerdown", (e) => e.stopPropagation());
    bResetRot.addEventListener("click", () => {
        if (!ui.view.angle) return;
        const c = navCenter();
        rotateAt(c.x, c.y, -ui.view.angle);
        ui.view.angle = 0; // kill float residue so smoothing/checks see exactly 0
        redraw();
    });
    nav.append(bResetRot);
    const bReset = el("button", "", "⌂");
    bReset.title = "Reset view (fit, angle 0)";
    bReset.addEventListener("pointerdown", (e) => e.stopPropagation());
    bReset.addEventListener("click", () => {

        ui.pendingRelView = null;
        ui.view.fitted = false; // fitView resets scale/offset/angle
        // If the view has 0 layout size right now (a bad resize/collapse state
        // that redraw bails on), arm a one-shot refit so the fit lands as soon
        // as the element has a real size again instead of being lost.
        ui.refitArmed = true;
        clearTimeout(ui.refitArmTimer);
        ui.refitArmTimer = setTimeout(() => (ui.refitArmed = false), 500);
        redraw();
    });
    nav.append(bReset);
    const bActual = el("button", "", "1:1");
    bActual.title = "Actual pixels (100%)";
    bActual.onclick = () => {
        if (!model.hasContent(state)) return;
        const c = navCenter();
        zoomAt(c.x, c.y, 1 / ui.view.scale);
        redraw();
    };
    bActual.addEventListener("pointerdown", e => e.stopPropagation());
    nav.append(bActual);
    const bTransparency = el("button", "", "\u25a6");
    bTransparency.setAttribute("aria-label", "Transparency grid");
    bTransparency.addEventListener("pointerdown", e => e.stopPropagation());
    bTransparency.onclick = () => {
        node.properties ||= {};
        node.properties.e2goTransparencyGrid = node.properties.e2goTransparencyGrid === false;
        node.graph?.change?.();
        redraw();
    };
    nav.append(bTransparency);
    bReset.textContent = "Fit";
    view.appendChild(nav);


    const xfBar = el("div", "e2go-cv-xfbar");
    const bXfOk = el("button", "ok", "✓");
    bXfOk.title = "Apply transform (Enter)";
    const bXfCancel = el("button", "no", "✕");
    bXfCancel.title = "Cancel transform (Esc)";
    xfBar.append(bXfOk, bXfCancel);
    xfBar.style.display = "none";
    view.appendChild(xfBar);
    xfBar.addEventListener("pointerdown", (e) => e.stopPropagation());
    // The ✓/✕ bar is shared by the Move frame and the Expand-canvas frame.
    bXfOk.addEventListener("click", () => {
        if (ui.expand) { applyExpand(); return; }
        commitXform();
        setInstrument(null);
    });
    bXfCancel.addEventListener("click", () => {
        if (ui.expand) { cancelExpand(); return; }
        cancelXform();
        setInstrument(null);
    });

    // Empty-state invitation: the canvas is a black box until a background
    // arrives — say how to get one (pointer-events:none keeps drop working).
    const emptyHint = el("div", "e2go-cv-empty");
    emptyHint.append(
        el("div", "kbd", "Drop an image here"),
        el("div", "big", "or"),
        el("div", "", "📂 BG — load a file · ⟳ — pull from the graph"),
        el("div", "", "right-click — 🆕 New blank canvas (paint from scratch)"),
    );
    view.appendChild(emptyHint);
    const emptyActions = el("div", "e2go-cv-empty-actions");
    for (const [label, action] of [
        ["Load image", () => pickImageFile(f => node._e2goCanvasLoadBase?.(f))],
        ["New canvas", () => newBlankCanvas()],
        ["From graph", () => bRefresh.click()],
    ]) {
        const button = el("button", "", label);
        button.onclick = action;
        emptyActions.appendChild(button);
    }
    emptyHint.replaceChildren(el("div", "", "Drop an image here, or start with:"), emptyActions);

    // ---- editor session state (not persisted) ----
    const ui = {
        tool: "mask",            // derived: "mask" | "paint" | "erase"
        mode: "none",            // editing is off until Mask or Paint is selected
        instrument: null,
        eraseTarget: "mask",     // erase applies to the current mode's layer

        tools: {
            mask: { color: "#ff3030", size: 40, feather: 0.35, opacity: 1 },
            paint: { color: "#ff0000", size: 40, feather: 0.35, opacity: 1 },
        },
        maskOverlay: true,   // show the mask tint (eye in the Layers panel)
        view: { scale: 1, ox: 0, oy: 0, angle: 0, fitted: false },
        stroke: null,            // {target, last}
        cursor: null,            // {clientX, clientY} while over the view — brush ring
        review: null,            // {imgs, idx} — loaded results (Powder Canvas Review)
        previewResult: false,    // show the current result full-frame (display only)
        hover: false,
        historyBusy: false,      // guards against overlapping async undo/redo
        xform: null,
    };
    // Active tool's brush set (erase edits the set of the layer it erases).
    const brush = () => ui.tools[ui.tool === "erase" ? ui.eraseTarget : ui.tool];

    // ---- toolbar ----
    const btns = {};
    // MODE (what you edit: mask | paint) × INSTRUMENT (how: brush | erase).
    // ui.tool stays the derived legacy value ("mask"|"paint"|"erase") so the
    // stroke/undo paths keep working unchanged.
    function applyModeInstrument() {
        ui.eraseTarget = ui.mode === "paint" ? "paint" : "mask";
        ui.tool = ui.instrument === "erase" ? "erase" : ui.eraseTarget;
        view.style.cursor = ui.instrument ? "crosshair" : "default";
        btns.none.classList.toggle("on", ui.mode === "none");
        btns.mask.classList.toggle("on", ui.mode === "mask");
        btns.paint.classList.toggle("on", ui.mode === "paint");
        btns.brush.classList.toggle("on", ui.instrument === "brush");
        btns.erase.classList.toggle("on", ui.instrument === "erase");
        btns.fill.classList.toggle("on", ui.instrument === "fill");
        btns.move.classList.toggle("on", ui.instrument === "move");
        for (const name of ["none", "mask", "paint", "brush", "erase", "fill", "move"]) {
            btns[name].setAttribute("aria-pressed", String(btns[name].classList.contains("on")));
        }
        for (const name of ["brush", "erase", "fill", "move"]) btns[name].disabled = ui.mode === "none";
        syncBrushControls();
        rebuildLayersPanel();
    }

    function startXform() {
        ui.xform = null;
        if (!model.hasContent(state)) return;
        // Pin the CONCRETE layer index at frame-creation time, not the
        // symbolic "paint" — activeLayer can move (add/duplicate/paste-as-
        // layer all switch to the new layer) while a frame is still live,
        // and the bake must land on the layer the frame was opened on.
        const target = ui.mode === "mask" ? "mask" : `p${state.activeLayer}`;
        const canvas = target === "mask" ? state.mask : state.layers[state.activeLayer]?.canvas;
        if (!canvas) return;
        const bbox = model.contentBBox(canvas);
        if (!bbox) {
            setStatus(target === "mask" ? "mask is empty — nothing to move" : "layer is empty — nothing to move");
            setInstrument(null);
            return;
        }
        ui.xform = { target, bbox, cx: bbox.x + bbox.w / 2, cy: bbox.y + bbox.h / 2,
                     dx: 0, dy: 0, scale: 1, angle: 0 };
        scheduleRedraw();
    }
    function commitXform() {
        const xf = ui.xform;
        ui.xform = null;
        if (!xf) return;
        if (xf.dx || xf.dy || xf.scale !== 1 || xf.angle) {
            model.pushUndo(state, xf.target);
            model.bakeTransform(state, xf.target, xf);
        }
        scheduleRedraw();
    }
    function cancelXform() {
        if (!ui.xform) return;
        ui.xform = null;
        scheduleRedraw();
    }
    node._e2goCanvasCommitXform = commitXform;

    node._e2goCanvasCancelExpand = cancelExpand;
    function setMode(mode) {
        if (ui.previewResult) setPreview(false);
        ui.stroke = null;
        cancelExpand();
        commitXform();                       // leaving the old target bakes it
        ui.mode = mode;
        ui.instrument = mode === "none" ? null : "brush";
        applyModeInstrument();
        scheduleRedraw();
    }
    function setInstrument(instrument) {
        if (instrument === null) { setMode("none"); return; }
        if (ui.mode === "none") return;
        if (ui.previewResult) {
            setStatus("Viewing a result — choose Edit canvas or Use as background before drawing.", { warn: false });
            return;
        }
        ui.stroke = null;
        cancelExpand();

        commitXform();
        ui.instrument = instrument;
        applyModeInstrument();
        if (instrument === "move") startXform();
    }
    function stripBtn(name, label, title, onClick) {
        const b = el("button", "", label);
        b.title = title;
        b.addEventListener("click", onClick);
        btns[name] = b;
        return b;
    }
    // The shared swatch/sliders reflect whichever tool is active.
    function syncBrushControls() {
        const b = brush();
        {
            const [h, s2, v] = rgbToHsv(...hexToRgb(b.color));
            pk.h = h; pk.s = s2; pk.v = v;
            refreshPicker();
        }
        sSize.set(b.size);
        sFeather.set(Math.round(b.feather * 100));
        sOpacity.set(Math.round(b.opacity * 100));
        // The same slider drives paint opacity or mask-overlay density —
        // let the label say which one is being edited.
        sOpacity.lbl.textContent = (ui.tool === "erase" ? ui.eraseTarget : ui.tool) === "mask" ? "Overlay" : "Opacity";
        colorSummary.textContent = ui.mode === "none" ? "Brush settings" : ui.mode === "mask" ? "Mask overlay color" : "Paint color";
        colorDetails.open = ui.mode === "paint";
    }

    const gRefresh = el("span", "grp");
    const bRefresh = el("button", "e2go-cv-refresh", "⟳");
    bRefresh.title = "Load/refresh background: run the graph up to this node only";
    bRefresh.addEventListener("click", async () => {
        bRefresh.disabled = true;
        try {
            const res = await node._e2goCanvasRefresh?.();
            if (res === false) setStatus("connect an image first");
        } catch (e) {
            console.warn("[PowderCanvas] refresh failed:", e);
            setStatus("refresh failed (see console)");
        } finally {
            bRefresh.disabled = false;
        }
    });
    // Hidden-input file picker (same UX as LoadImage's "choose file to upload").
    function pickImageFile(cb) {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.onchange = () => { if (inp.files?.[0]) cb(inp.files[0]); };
        inp.click();
    }
    const bLoadBase = el("button", "", "📂 BG");
    bLoadBase.title = "Load base image… REPLACES the background (same as drag-and-drop)";
    bLoadBase.addEventListener("click", () => pickImageFile((f) => node._e2goCanvasLoadBase?.(f)));

    // Sizing mode for every incoming background (drop / 📂 BG / paste). The
    // canvas resolution IS the render resolution, so this decides whether a
    // new picture bends to the canvas or the canvas to the picture. Persisted
    // per node in powder_canvas.js (node.properties) — see BG_MODES there.
    const BG_MODE_TITLE = {
        auto: "Dropped/loaded picture sizing: AUTO — the picture's own resolution "
            + "wins while the canvas holds no paint and no mask; once you've worked "
            + "on it the canvas resolution is kept and the picture is fitted in. Click to change.",
        fit: "Dropped/loaded picture sizing: FIT — always keep the canvas resolution "
            + "and letterbox the picture into it (black margins are canvas content). Click to change.",
        native: "Dropped/loaded picture sizing: NATIVE — every loaded picture resizes "
            + "the canvas to its own resolution, dropping paint layers and mask. Click to change.",
    };
    const bBgMode = el("select", "e2go-cv-result-size");
    bBgMode.setAttribute("aria-label", "Incoming image size");
    for (const [value, label] of [["auto", "Image size: auto"], ["fit", "Keep canvas size"], ["native", "Use image size"]]) {
        const option = el("option", "", label); option.value = value; bBgMode.appendChild(option);
    }
    function syncBgModeBtn() {
        const m = node._e2goCanvasGetBgMode?.() || "auto";
        bBgMode.value = m;
        bBgMode.title = BG_MODE_TITLE[m] || BG_MODE_TITLE.auto;
        bBgMode.classList.toggle("on", m !== "auto"); // lit = a forced, non-default rule
    }
    bBgMode.addEventListener("change", () => {
        const next = bBgMode.value;
        node._e2goCanvasSetBgMode?.(next);
        syncBgModeBtn();
        setStatus(next === "auto"
            ? "new pictures: their own size while the canvas is untouched, canvas size once you paint"
            : next === "fit"
            ? "new pictures: always fitted into the current canvas size"
            : "new pictures: always resize the canvas to their own size",
            { warn: false, ms: 5000 });
    });
    // Properties arrive at onConfigure, AFTER this editor is built — the node
    // calls this back so a restored mode shows on the button.
    node._e2goCanvasSyncBgMode = syncBgModeBtn;
    syncBgModeBtn();

    gRefresh.append(bRefresh, bLoadBase, bBgMode);

    stripBtn("none", "None", "Editing off. Choose Mask or Paint to start drawing.", () => setMode("none"));
    stripBtn("mask", "Mask", "Edit the inpaint mask with the brush. Click again to stop editing.", () => setMode(ui.mode === "mask" ? "none" : "mask"));
    stripBtn("paint", "Paint", "Paint on the active layer with the brush. Click again to stop editing.", () => setMode(ui.mode === "paint" ? "none" : "paint"));
    stripBtn("brush", "Brush", "Tool: brush (click again or press Esc to stop drawing)", () => setInstrument(ui.instrument === "brush" ? null : "brush"));
    stripBtn("erase", "Eraser", "Tool: eraser (erases in the current mode)", () => setInstrument("erase"));
    stripBtn("fill", "Fill", "Tool: fill — click flood-fills with the current color (mask mode fills the mask)", () => setInstrument("fill"));
    stripBtn("move", "Transform", "Tool: move/rotate/scale the active layer or mask (Enter bakes, Esc cancels)", () => setInstrument("move"));


    function hexToRgb(hex) {
        let h = hex.replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const n = parseInt(h, 16) || 0;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }
    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h = 0;
        if (d) {
            if (mx === r) h = ((g - b) / d) % 6;
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return [h, mx ? d / mx : 0, mx];
    }
    function hsvToRgb(h, s, v) {
        const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) [r, g, b] = [c, x, 0];
        else if (h < 120) [r, g, b] = [x, c, 0];
        else if (h < 180) [r, g, b] = [0, c, x];
        else if (h < 240) [r, g, b] = [0, x, c];
        else if (h < 300) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }

    const pk = { h: 0, s: 1, v: 1 }; // picker state mirrors the active tool's color
    const gPicker = el("span", "e2go-cv-picker");
    const svWrap = el("div", "sv");
    const svCanvas = document.createElement("canvas");
    svCanvas.width = 148; svCanvas.height = 78;
    const svDot = el("div", "svdot");
    svWrap.append(svCanvas, svDot);
    const hueSlider = document.createElement("input");
    hueSlider.type = "range"; hueSlider.className = "hue";
    hueSlider.min = 0; hueSlider.max = 360; hueSlider.value = 0;
    const pkRow = el("div", "pkrow");
    const sysPick = el("button", "", "⊚");
    const circle = el("div", "circle");
    const numIn = () => {
        const i = document.createElement("input");
        i.type = "number"; i.min = 0; i.max = 255;
        return i;
    };
    const rIn = numIn(), gIn = numIn(), bIn = numIn();
    pkRow.append(sysPick, circle, rIn, gIn, bIn);
    gPicker.append(svWrap, hueSlider, pkRow);

    function paintSv() {
        const c = svCanvas.getContext("2d");
        const [hr, hg, hb] = hsvToRgb(pk.h, 1, 1);
        c.fillStyle = `rgb(${hr},${hg},${hb})`;
        c.fillRect(0, 0, svCanvas.width, svCanvas.height);
        const white = c.createLinearGradient(0, 0, svCanvas.width, 0);
        white.addColorStop(0, "rgba(255,255,255,1)");
        white.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = white;
        c.fillRect(0, 0, svCanvas.width, svCanvas.height);
        const black = c.createLinearGradient(0, 0, 0, svCanvas.height);
        black.addColorStop(0, "rgba(0,0,0,0)");
        black.addColorStop(1, "rgba(0,0,0,1)");
        c.fillStyle = black;
        c.fillRect(0, 0, svCanvas.width, svCanvas.height);
    }
    // refreshPicker: repaint every picker control from pk state.
    function refreshPicker() {
        paintSv();
        // Percentages: the canvas is CSS-stretched to the panel width.
        svDot.style.left = `${pk.s * 100}%`;
        svDot.style.top = `${(1 - pk.v) * 100}%`;
        hueSlider.value = Math.round(pk.h);
        const [r, g, b] = hsvToRgb(pk.h, pk.s, pk.v);
        circle.style.background = rgbToHex(r, g, b);
        rIn.value = r; gIn.value = g; bIn.value = b;
    }
    // setActiveColor: single entry point — updates the active tool, the
    // picker UI, and the view (mask tint recolors live).
    function setActiveColor(hex, { syncPk = true } = {}) {
        brush().color = hex;
        if (syncPk) {
            const [h, s, v] = rgbToHsv(...hexToRgb(hex));
            pk.h = h; pk.s = s; pk.v = v;
        }
        refreshPicker();
        scheduleRedraw();
    }
    function pkCommit() {
        const [r, g, b] = hsvToRgb(pk.h, pk.s, pk.v);
        setActiveColor(rgbToHex(r, g, b), { syncPk: false });
    }
    // SV square: drag to pick saturation/value.
    let svDragging = false;
    svWrap.addEventListener("pointerdown", (e) => {
        svDragging = true;
        svWrap.setPointerCapture(e.pointerId);
        svPointTo(e);
    });
    svWrap.addEventListener("pointermove", (e) => { if (svDragging) svPointTo(e); });
    const svEnd = (e) => {
        svDragging = false;
        try { svWrap.releasePointerCapture(e.pointerId); } catch {}
    };
    svWrap.addEventListener("pointerup", svEnd);
    svWrap.addEventListener("pointercancel", svEnd);
    function svPointTo(e) {
        const r = svCanvas.getBoundingClientRect();
        pk.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        pk.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
        pkCommit();
    }
    hueSlider.addEventListener("input", () => {
        pk.h = Number(hueSlider.value);
        pkCommit();
    });
    for (const [inp, idx] of [[rIn, 0], [gIn, 1], [bIn, 2]]) {
        inp.addEventListener("change", () => {
            const rgb = hexToRgb(brush().color);
            rgb[idx] = Math.min(255, Math.max(0, Number(inp.value) || 0));
            setActiveColor(rgbToHex(...rgb));
        });
    }
    // ⊚ system eyedropper: picks a color from ANYWHERE on screen (other
    // nodes' previews, reference images…). Chromium-only API; degrades to a
    // disabled button elsewhere. Cancel: Esc (browser-controlled).
    if (window.EyeDropper) {
        sysPick.title = "System eyedropper: pick a color from anywhere on screen (Esc cancels)";
        sysPick.addEventListener("click", async () => {
            try {
                const r = await new window.EyeDropper().open();
                if (r?.sRGBHex) setActiveColor(r.sRGBHex);
            } catch {} // user pressed Esc — not an error
        });
    } else {
        sysPick.disabled = true;
        sysPick.title = "System eyedropper needs a Chromium browser";
    }

    // --- persistent palette (global across canvases/sessions) ---------------
    const PALETTE_KEY = "e2go.canvas.palette";
    const PALETTE_DEFAULT = ["#ffffff", "#000000", "#ff3030", "#ffa500", "#ffe100",
                             "#37d67a", "#2ccce4", "#4a90e2", "#9013fe", "#f78da7"];
    function loadPalette() {
        try {
            const p = JSON.parse(localStorage.getItem(PALETTE_KEY) || "null");
            if (Array.isArray(p) && p.length === PALETTE_DEFAULT.length) return p;
        } catch {}
        return [...PALETTE_DEFAULT];
    }
    const palette = loadPalette();
    const gPalette = el("span", "e2go-cv-pal");
    gPalette.title = "Palette: click = use color, right-click = store the active tool's color";
    palette.forEach((c, i) => {
        const b = el("button", "");
        b.style.background = c;
        b.addEventListener("click", () => setActiveColor(palette[i]));
        b.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            palette[i] = brush().color;
            b.style.background = palette[i];
            // Green outline flash confirms the (otherwise invisible) store.
            b.classList.add("stored");
            setTimeout(() => b.classList.remove("stored"), 350);
            try { localStorage.setItem(PALETTE_KEY, JSON.stringify(palette)); } catch {}
        });
        gPalette.appendChild(b);
    });

    function slider(label, min, max, value, title, onInput) {
        const wrap = el("span", "grp");
        const lbl = el("span", "", label);
        wrap.append(lbl);
        const s = document.createElement("input");
        s.type = "range";
        s.min = min; s.max = max; s.value = value;
        s.title = title + " — double-click resets";
        const val = el("span", "val", String(value));
        // set(): single entry point so hotkeys/tool-switch keep label in sync.
        const set = (v) => { s.value = v; val.textContent = s.value; };
        s.addEventListener("input", () => { val.textContent = s.value; onInput(Number(s.value)); });
        // Double-click anywhere in the group resets to the initial default.
        wrap.addEventListener("dblclick", () => { set(value); onInput(Number(s.value)); });
        wrap.append(s, val);
        return { wrap, s, lbl, set };
    }
    const sSize = slider("Size", 1, 200, 40, "Brush size of the active tool (also [ and ])", (v) => { brush().size = v; scheduleRedraw(); });
    const sFeather = slider("Softness", 0, 100, 35, "Edge softness % (per tool)", (v) => (brush().feather = v / 100));
    const sOpacity = slider("Opac", 10, 100, 100, "Paint: opacity. Mask: overlay density (display only)", (v) => { brush().opacity = v / 100; scheduleRedraw(); });

    const gHist = el("span", "grp");
    const bUndo = el("button", "", "Undo");
    canvasIcon(bUndo, "undo");
    bUndo.title = "Undo canvas edit, layer operation or resize";
    bUndo.addEventListener("click", () => runHistory(model.undo));
    const bRedo = el("button", "", "Redo");
    canvasIcon(bRedo, "redo");
    bRedo.title = "Redo canvas edit";
    bRedo.addEventListener("click", () => runHistory(model.redo));
    gHist.append(bUndo, bRedo);

    // undo/redo are async and mutate shared canvases; a second call fired
    // before the first resolves (rapid double Ctrl+Z, or button + hotkey
    // overlap) would race against itself and corrupt history. Serialize
    // through a busy flag shared by both entry points (undo/redo buttons).
    function runHistory(fn) {
        if (ui.historyBusy) return;
        cancelXform();
        cancelExpand();
        setPreview(false);
        ui.historyBusy = true;
        const structural = (fn === model.undo ? state.undoStack : state.redoStack).at(-1)?.target === "document";
        Promise.resolve(fn(state)).then(async () => {
            if (structural) {
                await node._e2goCanvasPersistBase?.();
                await node._e2goCanvasPersistLayers?.();
                ui.view.fitted = false;
            }
        }).catch((e) => { console.warn("[PowderCanvas] history restore failed:", e); setStatus("Could not restore the canvas edit."); }).finally(() => {
            ui.historyBusy = false;
            redraw();
        });
    }

    const gMask = el("span", "grp");
    function opBtn(label, title, undoTarget, fn) {
        const b = el("button", "", label);
        b.title = title;
        b.addEventListener("click", (e) => {
            if (!model.hasContent(state)) return;
            if (ui.historyBusy) return;
            model.pushUndo(state, undoTarget);
            fn(e);
            redraw();
        });
        return b;
    }
    // px steps: Shift = ×4 for big images where 8px is barely visible.
    const opPx = (e) => (e.shiftKey ? 32 : 8);

    const activePaintName = () => {
        const idx = state.activeLayer;
        return state.layers[idx]?.name || `Paint ${idx}`;
    };
    const bClearP = el("button", "", "Clear selected layer");
    bClearP.title = "Clear the active paint layer (its name shows in the status bar / Layers panel)";
    bClearP.addEventListener("click", () => {
        if (!model.hasContent(state) || ui.historyBusy) return;
        const idx = state.activeLayer;
        if (idx < 1 || !state.layers[idx]) { setStatus("no active paint layer to clear"); return; }
        const name = activePaintName();
        const had = model.paintLayerHasContent(state, idx);
        const hidden = state.layers[idx].visible === false ? " (hidden)" : "";
        model.pushUndo(state, "paint");
        model.clearLayer(state, "paint");
        setStatus(had ? `cleared “${name}”${hidden}` : `“${name}” was already empty${hidden}`,
                  { warn: !had, ms: 3000 });
        redraw();
    });
    gMask.append(
        el("span", "e2go-cv-grouplabel", "mask"),
        opBtn("Invert", "Invert mask", "mask", () => model.maskInvert(state)),
        opBtn("+8", "Grow mask 8px (Shift: 32px)", "mask", (e) => model.maskGrow(state, opPx(e))),
        opBtn("−8", "Shrink mask 8px (Shift: 32px)", "mask", (e) => model.maskGrow(state, -opPx(e))),
        opBtn("Blur", "Blur mask 8px (Shift: 32px)", "mask", (e) => model.maskBlur(state, opPx(e))),
        opBtn("Clear mask", "Clear mask", "mask", () => model.clearLayer(state, "mask")),
    );

    const status = el("div", "e2go-cv-notice", "");
    status.setAttribute("role", "status");
    // Transient messages hold the status line for a few seconds, then redraw's
    // persistent info line (size · zoom · active layer) takes it back.
    let statusMsgUntil = 0;
    // `action` puts a one-click button INSIDE the message ({label, title, fn}).
    // Used where the alternative is a multi-step escape hatch nobody finds —
    // e.g. "the picture was fitted into the canvas · [↔ 1536×864]".
    function setStatus(msg, { warn = true, ms = 4000, action = null } = {}) {
        status.textContent = msg;   // also drops any button left from before
        status.classList.toggle("warn", warn);
        if (action?.fn) {
            const b = el("button", "", action.label || "apply");
            if (action.title) b.title = action.title;
            b.addEventListener("click", () => {
                statusMsgUntil = 0;     // offer spent — let the info line return
                action.fn();
                scheduleRedraw();
            });
            status.append(" ", b);
        }
        statusMsgUntil = ms === 0 ? Infinity : performance.now() + ms;
        if (ms > 0) setTimeout(() => { if (performance.now() >= statusMsgUntil) { status.replaceChildren(); scheduleRedraw(); } }, ms + 50);
    }
    // Row 1: tool + color + brush + history. Row 2 (forced break): palette +
    // mask ops — matches the approved layout mockup.
    // --- Photoshop-style layout assembly ------------------------------------
    // Top bar: refresh/load + brush params + history + mask ops + status.
    bar.append(gRefresh, sSize.wrap, sFeather.wrap, sOpacity.wrap, gHist, gMask);
    // Messages replace the footer visually, without resizing the view or
    // moving the floating result navigation when they appear or expire.
    footer.append(status);
    // Left strip: MODE (mask/paint) + TOOL (brush/erase) + system eyedropper.
    const stripLbl = (t) => el("div", "striplbl", t);

    toolStrip.append(
        stripLbl("Mode"), btns.none, btns.mask, btns.paint,
        stripLbl("Tool"), btns.brush, btns.erase, btns.fill, btns.move,
    );
    // Right side: Color panel + Layers panel.
    const layersList = el("div");
    const bAddLayer = el("button", "", "+");
    bAddLayer.title = "Add an empty paint layer";
    bAddLayer.addEventListener("click", () => {
        if (model.addPaintLayer(state) > 0) setMode("paint");

        else setStatus("no canvas yet — right-click → New blank canvas, or drop an image");
    });

    function suggestedCanvasSize() {
        try {
            const graph = node.graph;
            const getLink = (id) => (typeof graph?.links?.get === "function"
                ? graph.links.get(id) : graph?.links?.[id]) ?? null;
            const cond = findDownstream(node, graph,
                ["PowderImageConditioning"]);
            let src = null;
            const inp = cond?.inputs?.find((i) => i.name === "t2i_latent");
            if (inp?.link != null) src = graph.getNodeById(getLink(inp.link)?.origin_id) || null;
            if (!src) src = (graph?._nodes || []).find((n) => n.comfyClass === "PowderResolution") || null;
            if (src) {
                if (src.comfyClass === "PowderResolution") {
                    const live = resolutionLive(src);
                    if (live) return `${live[0]}x${live[1]}`;
                }
                const w = src.widgets?.find((x) => x.name === "width")?.value;
                const h = src.widgets?.find((x) => x.name === "height")?.value;
                if (w > 0 && h > 0) return `${w}x${h}`;
            }
        } catch {}
        return model.hasContent(state) ? `${state.width}x${state.height}` : "1024x1024";
    }

    function newBlankCanvas() {
        canvasModal?.close();
        canvasModal = canvasSizeDialog(suggestedCanvasSize().split("x").map(Number), async (w, h) => {
            const c = document.createElement("canvas"); c.width = w; c.height = h;
            const ctx = c.getContext("2d"); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
            const blob = await new Promise(resolve => c.toBlob(resolve));
            if (!blob || await node._e2goCanvasLoadBase?.(blob, { force: "native" }) === false) throw new Error("Could not create the canvas. Check the ComfyUI log.");
        });
    }


    function startExpand() {
        if (!model.hasContent(state)) { setStatus("no canvas yet — load or create one first"); return; }
        commitXform();
        ui.expand = { l: 0, t: 0, r: 0, b: 0 };
        ui.expandDrag = null;
        setStatus("drag the edges/corners outward — Enter/✓ applies, Esc/✕ cancels", { warn: false, ms: 6000 });
        scheduleRedraw();
    }
    function applyExpand() {
        const ex = ui.expand;
        ui.expand = null;
        ui.expandDrag = null;
        if (!ex) return;

        const snap = (v) => Math.max(0, Math.round(v / 16) * 16);
        const [l, t, r, b] = [snap(ex.l), snap(ex.t), snap(ex.r), snap(ex.b)];
        if (!(l || t || r || b)) { scheduleRedraw(); return; } // nothing dragged
        if (!model.expandCanvas(state, { left: l, top: t, right: r, bottom: b })) return;
        // Re-upload the grown background as the recovery bg: a reload
        // restoring the OLD file at the old size would wipe the paint stack
        // via the size-change rule.
        node._e2goCanvasPersistBase?.();

        node._e2goCanvasPersistLayers?.();
        setStatus(`canvas ${state.width}×${state.height} — new area is pre-masked, queue a Repaint`,
                  { warn: false, ms: 6000 });
        rebuildLayersPanel();
        node._e2goCanvasRedraw?.(true);
    }
    function cancelExpand() {
        if (!ui.expand) return;
        ui.expand = null;
        ui.expandDrag = null;
        scheduleRedraw();
    }

    // Shared by the Layers-panel 🖼 button and the context menu's
    // "Load image as new layer" item.
    function loadImageFileAsLayer() {
        if (!model.hasContent(state)) { setStatus("load a base image first"); return; }
        pickImageFile((f) => {
            const url = URL.createObjectURL(f);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                if (model.addImageLayer(state, img) > 0) setMode("paint");
                scheduleRedraw();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                setStatus("image failed to decode");
            };
            img.src = url;
        });
    }
    const bLoadLayer = el("button", "", "🖼");
    bLoadLayer.title = "Add an image file as a NEW layer on top (fitted, centered)";
    bLoadLayer.addEventListener("click", loadImageFileAsLayer);
    const colorHdr = el("div", "hdr");
    colorHdr.append(el("span", "", "Color"));
    const layersHdr = el("div", "hdr");
    layersHdr.append(el("span", "", "Layers"), bAddLayer, bLoadLayer);
    const colorDetails = el("details", "e2go-cv-color-details");
    const colorSummary = el("summary", "", "Mask overlay color");
    colorDetails.append(colorSummary, colorHdr, gPicker, gPalette);
    const maskHdr = el("div", "hdr");
    maskHdr.appendChild(el("span", "", "Inpaint mask"));
    const maskList = el("div");
    const maskNote = el("div", "e2go-cv-mask-note", "Temporary mask · not saved in workflow");
    const rememberMaskLabel = el("label", "e2go-cv-mask-note");
    const rememberMask = document.createElement("input");
    rememberMask.type = "checkbox";
    rememberMaskLabel.append(rememberMask, document.createTextNode(" Save mask in workflow"));
    rememberMask.onchange = async () => {
        state.rememberMask = rememberMask.checked;
        state.dirty++;
        redraw();
        if (state.rememberMask) await node._e2goCanvasPersistLayers?.();
        node.graph?.setDirtyCanvas(true, true);
    };
    side.append(colorDetails, maskHdr, maskList, rememberMaskLabel, maskNote, layersHdr, layersList, bClearP);

    // --- layers panel ---------------------------------------------------------
    // Two-step deletion also remains undoable in the canvas history.
    function delButton(title, onConfirm) {
        const del = el("button", "del", "🗑");
        del.title = title;
        let t = null;
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!del.classList.contains("arm")) {
                del.classList.add("arm");
                del.textContent = "sure?";
                t = setTimeout(() => {
                    del.classList.remove("arm");
                    del.textContent = "🗑";
                }, 1500);
                return;
            }
            clearTimeout(t);
            onConfirm(del);
        });
        return del;
    }

    function makeThumb(srcCanvas) {
        const t = document.createElement("canvas");
        t.width = 30; t.height = 22;
        t.className = "thumb";
        ui._thumbs.push({ t, src: srcCanvas });
        return t;
    }
    function refreshThumbs(force = false) {
        if (!ui._thumbs?.length) return;
        const now = performance.now();
        // Throttle: at most ~2.5 refreshes/s while painting; the trailing
        // redraws after a stroke always land the final state.
        if (!force && (ui._thumbDirty === state.dirty || now - (ui._thumbAt || 0) < 400)) return;
        ui._thumbDirty = state.dirty;
        ui._thumbAt = now;
        for (const { t, src } of ui._thumbs) {
            const c = t.getContext("2d");
            c.clearRect(0, 0, t.width, t.height);
            if (!src || !src.width || !src.height) continue;
            const k = Math.min(t.width / src.width, t.height / src.height);
            const dw = Math.max(1, src.width * k), dh = Math.max(1, src.height * k);
            c.drawImage(src, (t.width - dw) / 2, (t.height - dh) / 2, dw, dh);
        }
    }
    function rebuildLayersPanel() {
        layersList.textContent = "";
        maskList.textContent = "";
        ui._thumbs = [];
        const maskActive = ui.mode === "mask";
        // Pinned pseudo-layer: the mask (eye = overlay visibility, display only).
        const mrow = el("div", "e2go-cv-lrow" + (maskActive ? " active" : ""));
        const meye = el("button", "eye", ui.maskOverlay ? "Overlay on" : "Overlay off");
        meye.setAttribute("aria-pressed", String(ui.maskOverlay));
        meye.title = "Show/hide the mask overlay (display only — the MASK output is unaffected)";
        meye.addEventListener("click", (e) => {
            e.stopPropagation();
            ui.maskOverlay = !ui.maskOverlay;
            rebuildLayersPanel();
            scheduleRedraw();
        });
        const msw = el("span", "swatch");
        msw.style.background = ui.tools.mask.color;
        mrow.append(meye, msw, makeThumb(state.mask), el("span", "", "Mask"));
        mrow.addEventListener("click", () => setMode("mask"));
        maskList.appendChild(mrow);
        // Paint layers, topmost first (Photoshop order).
        for (let i = state.layers.length - 1; i >= 1; i--) {
            const layer = state.layers[i];
            const isActive = state.activeLayer === i;

            const activeCls = isActive && !maskActive ? " active" : "";
            const row = el("div", "e2go-cv-lrow" + activeCls);
            row.title = isActive && maskActive
                ? "Clear P target. Click: paint on this layer. Double-click: rename"
                : "Click: paint on this layer. Double-click: rename";
            const eye = el("span", "eye" + (layer.visible !== false ? "" : " off"), "👁");
            eye.title = "Show/hide layer (hidden layers are excluded from the output)";
            eye.addEventListener("click", (e) => {
                e.stopPropagation();
                model.setLayerVisible(state, i, layer.visible === false);
                rebuildLayersPanel();
                scheduleRedraw();
            });
            const name = el("span", "lname", layer.name || `Paint ${i}`);
            // Double-click renames in place (Photoshop-style) — commit on
            // Enter/blur, cancel on Esc.
            name.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                const inp = document.createElement("input");
                inp.className = "lname";
                inp.value = layer.name || `Paint ${i}`;
                inp.addEventListener("click", (ev) => ev.stopPropagation());
                inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
                inp.addEventListener("keydown", (ev) => {
                    ev.stopPropagation();
                    if (ev.key === "Enter") inp.blur();
                    else if (ev.key === "Escape") { inp.value = ""; inp.blur(); }
                });
                inp.addEventListener("blur", () => {
                    model.renameLayer(state, i, inp.value);
                    rebuildLayersPanel();
                });
                name.replaceWith(inp);
                inp.select();
                inp.focus();
            });
            const del = delButton("Delete layer (Undo restores it)", (btn) => {

                if (ui.xform && ui.xform.target === `p${i}`) cancelXform();
                else commitXform();
                if (model.removePaintLayer(state, i)) {
                    if (ui.instrument === "move") startXform();
                    rebuildLayersPanel();
                    scheduleRedraw();
                } else {

                    model.pushUndo(state, `p${i}`);
                    model.clearLayer(state, `p${i}`);
                    setStatus("the last paint layer stays — cleared it instead (↶ undoes)", { warn: false });
                    btn.classList.remove("arm");
                    btn.textContent = "🗑";
                    scheduleRedraw();
                }
            });
            row.append(eye, makeThumb(layer.canvas), name, del);
            row.addEventListener("click", () => {
                commitXform();

                cancelExpand();
                state.activeLayer = i;
                if (ui.mode === "mask") setMode("paint");
                else {
                    rebuildLayersPanel();
                    if (ui.instrument === "move") startXform();
                }
            });
            row.addEventListener("contextmenu", (e) => e.preventDefault());
            layersList.appendChild(row);
        }
        // Background (fixed bottom row).
        const bg = state.layers[0];
        const brow = el("div", "e2go-cv-lrow");
        const beye = el("span", "eye" + (bg && bg.visible === false ? " off" : ""), "👁");
        beye.title = "Show/hide the background in the output";
        beye.addEventListener("click", (e) => {
            e.stopPropagation();
            if (bg) {
                model.setLayerVisible(state, 0, bg.visible === false);
                rebuildLayersPanel();
                scheduleRedraw();
            }
        });
        const bdel = delButton("Clear whole canvas: background, layers and mask (Undo restores them)", () => {
            cancelXform(); // everything is being wiped — a live frame has nothing left to bake onto
            node._e2goCanvasClearBase?.();
            rebuildLayersPanel();
            scheduleRedraw();
        });
        brow.append(beye, makeThumb(bg?.canvas || null), el("span", "lname", "Background"), bdel);
        bdel.textContent = "Clear all";
        bdel.style.width = "auto";
        layersList.appendChild(brow);
        refreshThumbs(true); // fresh rows always paint their previews at once
    }
    // External state changes (restore, background load, undo of layer pixels)
    // don't go through the panel's own handlers — refresh it when the layer
    // signature drifts (checked once per painted frame, cheap string compare).
    let _layersSig = "";
    function syncLayersPanel() {
        const sig = state.layers.map((l, i) => `${i}${l.visible === false ? "h" : "v"}${l.name || ""}`).join(",") +
            `|a${state.activeLayer}|t${ui.tool}|m${ui.maskOverlay}|c${ui.tools.mask.color}`;
        if (sig !== _layersSig) {
            _layersSig = sig;
            rebuildLayersPanel();
        }
    }


    const cmpPrev = el("button", "pg", "◄");
    cmpPrev.title = "Previous batch result";
    const cmpNext = el("button", "pg", "►");
    cmpNext.title = "Next batch result";
    const cmpCnt = el("span", "cnt", "");
    const resultIndex = el("input", "e2go-cv-result-index");
    resultIndex.type = "number"; resultIndex.min = "1";
    resultIndex.setAttribute("aria-label", "Result number");
    resultIndex.onchange = () => {
        if (!ui.review) return;
        const index = Number(resultIndex.value);
        if (Number.isFinite(index)) ui.review.idx = Math.max(0, Math.min(ui.review.imgs.length - 1, Math.trunc(index) - 1));
        updateCmpCnt(); redraw();
    };
    const bPreview = el("button", "peek", "👁");
    bPreview.title = "Preview: show this result full-frame over the canvas (display only)";
    const cmpAdopt = el("button", "adopt", "Use as background");
    cmpAdopt.title = "Set as background: adopt this result (mask is cleared) and keep editing";
    const cmpLayer = el("button", "layer", "Add as layer");
    cmpLayer.title = "Add as layer: lay this result on top as a new paint layer — erase the parts you don't want";
    const cmpClose = el("button", "close", "✕");
    cmpClose.title = "Dismiss results";
    const cmpCtl = el("span", "e2go-cv-cmpctl");
    const resultSize = el("select", "e2go-cv-result-size");
    resultSize.setAttribute("aria-label", "Result adoption size");
    resultSize.onchange = () => updateCmpCnt();
    for (const [value, label] of [["fit", "Keep canvas size"], ["native", "Use result size"]]) {
        const option = el("option", "", label); option.value = value; resultSize.appendChild(option);
    }
    const thumbsButton = el("button", "e2go-cv-thumbs-toggle", "Thumbnails");
    const resultThumbs = el("div", "e2go-cv-result-thumbs");
    resultThumbs.hidden = true;
    thumbsButton.setAttribute("aria-pressed", "false");
    thumbsButton.title = "Show thumbnails";
    thumbsButton.onclick = () => {
        resultThumbs.hidden = !resultThumbs.hidden;
        const visible = !resultThumbs.hidden;
        thumbsButton.classList.toggle("on", visible);
        thumbsButton.setAttribute("aria-pressed", String(visible));
        thumbsButton.title = visible ? "Hide thumbnails" : "Show thumbnails";
    };
    cmpCtl.append(bPreview, cmpPrev, resultIndex, cmpCnt, cmpNext, resultSize, cmpAdopt, cmpLayer, thumbsButton, cmpClose);

    const gCompare = el("div", "e2go-cv-float");
    const cmpGrip = el("span", "grip", "RESULT");
    cmpGrip.title = "Drag to move this palette";
    gCompare.append(cmpGrip, cmpCtl);
    gCompare.appendChild(resultThumbs);
    gCompare.style.display = "none"; // hidden until results arrive
    view.appendChild(gCompare);
    // Same contract as the nav cluster: palette interactions must never
    // start a paint stroke on the canvas underneath.
    gCompare.addEventListener("pointerdown", (e) => e.stopPropagation());
    cmpGrip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // LiteGraph zooms the DOM widget via CSS transform: convert screen
        // deltas into view-local px through the rect/offset ratio.
        const vr = view.getBoundingClientRect();
        const scale = vr.width / (view.clientWidth || 1);
        const fr = gCompare.getBoundingClientRect();
        const start = { x: e.clientX, y: e.clientY,
                        left: (fr.left - vr.left) / scale, top: (fr.top - vr.top) / scale };
        cmpGrip.setPointerCapture(e.pointerId);
        const move = (ev) => {
            const left = Math.max(0, Math.min(start.left + (ev.clientX - start.x) / scale,
                                              view.clientWidth - gCompare.offsetWidth));
            const top = Math.max(0, Math.min(start.top + (ev.clientY - start.y) / scale,
                                             view.clientHeight - gCompare.offsetHeight));
            gCompare.style.left = `${left}px`;
            gCompare.style.top = `${top}px`;
            gCompare.style.bottom = "auto";
            gCompare.style.right = "auto";
            gCompare.style.margin = "0";
        };
        const up = (ev) => {
            cmpGrip.releasePointerCapture?.(ev.pointerId);
            cmpGrip.removeEventListener("pointermove", move);
            cmpGrip.removeEventListener("pointerup", up);
        };
        cmpGrip.addEventListener("pointermove", move);
        cmpGrip.addEventListener("pointerup", up);
    });

    function reviewImg() { return ui.review?.imgs[ui.review.idx] || null; }
    function updateCmpCnt() {
        if (!ui.review) return;
        cmpCnt.textContent = `/ ${ui.review.imgs.length}`;
        resultIndex.value = ui.review.idx + 1;
        resultIndex.max = ui.review.imgs.length;
        if (resultThumbs._images !== ui.review.imgs) {
            resultThumbs._images = ui.review.imgs;
            resultThumbs.replaceChildren();
            ui.review.imgs.forEach((img, i) => {
                const button = el("button", "", String(i + 1));
                const thumb = el("img"); thumb.src = img.src; thumb.alt = `Result ${i + 1}`;
                button.prepend(thumb);
                button.onclick = () => { ui.review.idx = i; updateCmpCnt(); redraw(); };
                resultThumbs.appendChild(button);
            });
            resultSize.value = node._e2goCanvasGetBgMode?.() === "fit" ? "fit" : "native";
        }
        [...resultThumbs.children].forEach((b, i) => b.classList.toggle("on", i === ui.review.idx));
        const img = reviewImg();
        resultSize.hidden = !model.hasContent(state) || (img?.naturalWidth === state.width && img?.naturalHeight === state.height);
        resultSize.options[0].textContent = `Keep canvas ${state.width}×${state.height}`;
        resultSize.options[1].textContent = `Use result ${img?.naturalWidth}×${img?.naturalHeight}`;
        resultSize.title = resultSize.value === "native"
            ? "A different size starts fresh paint layers and mask. Undo restores the previous canvas."
            : "Fit the result into the current canvas and keep paint layers. The mask is cleared. Undo restores it.";
        cmpAdopt.title = resultSize.title;
    }
    // The whole "result" group (label + strip) shows only while a batch is
    // armed — otherwise it's an empty label taking bar space.
    function showResults(open) {
        const on = !!open && !!ui.review;
        gCompare.style.display = on ? "" : "none";
        cmpCtl.classList.toggle("open", on);
    }
    // Full-frame preview of the current result (display only): painted over the
    // layers in image space by redraw(). Replaces the old divider compare.
    // Needs a canvas to paint over — on an empty canvas (results after a bg
    // clear) the palette still works, but preview stays off (✓ BG creates
    // the canvas from the result instead).
    function setPreview(on) {
        if (on) { commitXform(); cancelExpand(); ui.stroke = null; }
        ui.previewResult = !!on && !!ui.review;
        bPreview.classList.toggle("on", ui.previewResult);
        redraw();
    }
    function closeReview() {
        ui.review = null;
        ui.previewResult = false;
        bPreview.classList.remove("on");
        showResults(false);
        redraw();
    }
    bPreview.addEventListener("click", () => {
        setPreview(!ui.previewResult);
    });
    cmpPrev.addEventListener("click", () => {
        if (!ui.review) return;
        ui.review.idx = (ui.review.idx - 1 + ui.review.imgs.length) % ui.review.imgs.length;
        updateCmpCnt();
        scheduleRedraw();
    });
    cmpNext.addEventListener("click", () => {
        if (!ui.review) return;
        ui.review.idx = (ui.review.idx + 1) % ui.review.imgs.length;
        updateCmpCnt();
        scheduleRedraw();
    });
    cmpClose.addEventListener("click", closeReview);
    cmpAdopt.addEventListener("click", () => {
        commitXform(); // adopt rebuilds/replaces the stack; a live frame must bake first

        cancelExpand();
        const img = reviewImg();
        if (!img) return;
        const fit = resultSize.value === "fit" && model.hasContent(state);
        const width = fit ? state.width : img.naturalWidth;
        const height = fit ? state.height : img.naturalHeight;
        const refit = width !== state.width || height !== state.height;
        model.setBackground(state, img, width, height, { fit, undoable: true });
        setStatus(`Result adopted · canvas ${width}×${height} · mask cleared · Undo restores the previous canvas`,
            { warn: false, ms: 8000 });
        model.clearLayer(state, "mask");
        // The adopted result is the background now — make it the recovery bg
        // too, or a reload brings back the photo it replaced.
        node._e2goCanvasPersistBase?.();
        closeReview();
        node._e2goCanvasRedraw?.(refit);
    });
    cmpLayer.addEventListener("click", () => {
        const img = reviewImg();
        if (!img) return;
        if (!model.hasContent(state)) { setStatus("no canvas yet — ✓ BG first, then add other results as layers"); return; }
        if (model.addImageLayer(state, img) > 0) setMode("paint");
        closeReview();
    });

    // Session-stash accessors: the review images live only in this closure,
    // so node re-creation (workflow undo/redo, tab switch) would lose them.
    // powder_canvas.js stashes them via these hooks and hands them back.
    // Editor session prefs (brush sets, tool, view transform, mask-overlay
    // eye) also live only in this closure — restore them too, or an undo
    // resets brushes and the zoom/pan the user was working at.
    node._e2goCanvasGetUiState = () => ({
        tools: ui.tools,
        mode: ui.mode,
        instrument: ui.instrument,
        maskOverlay: ui.maskOverlay,
        // Resolution-independent view (image-space centre + zoomRel + angle);
        // survives adoption into a fresh node with a different backing size.
        relView: getRelView(),
    });
    node._e2goCanvasSetUiState = (s) => {
        if (!s) return;
        if (s.tools) ui.tools = s.tools;
        if (s.mode) ui.mode = s.mode;

        ui.instrument = ui.mode === "none" ? null : (["brush", "erase", "fill"].includes(s.instrument) ? s.instrument : "brush");
        if (typeof s.maskOverlay === "boolean") ui.maskOverlay = s.maskOverlay;
        // Restore the exact zoom/pan/rotation the user was working at, applied
        // once the display has a real size (see redraw's pendingRelView). No
        // stored view -> a clean re-fit.
        if (s.relView) {
            ui.pendingRelView = s.relView;
        } else {
            ui.view.fitted = false;
        }
        applyModeInstrument(); // re-syncs buttons, sliders, layers panel
        scheduleRedraw();
    };
    // Status line for out-of-closure callers (powder_canvas.js bg loads).
    node._e2goCanvasSetStatus = (msg, opts) => setStatus(msg, opts);
    node._e2goCanvasGetReview = () =>
        ui.review ? { imgs: ui.review.imgs, idx: ui.review.idx, cropBox: ui.review.cropBox, previewOn: ui.previewResult } : null;
    node._e2goCanvasSetReview = (review) => {
        if (!review?.imgs?.length) return;
        ui.review = { imgs: review.imgs, idx: review.idx || 0, cropBox: review.cropBox };
        updateCmpCnt();
        showResults(true);
        // Preserve whether the result was being previewed when the node died
        // (graph undo/redo) — a graph undo must not silently drop the results.
        setPreview(review.previewOn !== false);
        scheduleRedraw();
    };
    node._e2goCanvasShowReview = (urls, cropBox = null) => {
        // NO hasContent gate: results must arm on an EMPTY canvas too (user
        // cleared the bg, then generated — the palette is the only way to
        // pull the fresh result in; ✓ BG creates the canvas at native size).
        if (!urls?.length) return;

        const imgs = [];
        let settled = 0, failed = 0;
        const finish = () => {
            if (++settled !== urls.length) return;
            const ok = imgs.filter(Boolean);
            if (failed) console.warn(`[PowderCanvas] ${failed}/${urls.length} result image(s) failed to load`);
            if (!ok.length) {
                setStatus("results failed to load", { warn: true, ms: 6000 });
                return;
            }
            // Results arrive previewed full-frame: the strip opens and the
            // current result is shown over the canvas so the user can page
            // through and adopt (✓ BG) or drop as a layer (⊕ Layer).
            ui.review = { imgs: ok, idx: 0, cropBox };
            updateCmpCnt();
            showResults(true);
            setPreview(true);
            setStatus(failed ? `Results ready (${failed} failed to load). Choose a result to export or edit.`
                             : "Results ready. Export a result, use it as the background, or add it as a layer.", { warn: !!failed, ms: 6000 });
            console.info(`[PowderCanvas] ${ok.length} result(s) armed`);
        };
        urls.forEach((u, i) => {
            const im = new Image();
            im.onload = finish;
            im.onerror = () => { failed++; imgs[i] = null; finish(); };
            im.src = u;
            imgs[i] = im;
        });
    };
    applyModeInstrument();

    // ---- view transform ----
    function fitView() {
        if (!model.hasContent(state)) return;
        const vw = display.width, vh = display.height;
        if (!vw || !vh) return;
        const s = Math.min(vw / state.width, vh / state.height);
        ui.view.scale = s;
        ui.view.ox = (vw - state.width * s) / 2;
        ui.view.oy = (vh - state.height * s) / 2;
        ui.view.angle = 0;
        ui.view.fitted = true;
    }
    // Resolution-INDEPENDENT snapshot of the view: the image-space point under
    // the viewport centre + zoom relative to the fit scale + angle. Unlike the
    // raw {scale,ox,oy} (which live in THIS node's backing-store pixels), this
    // survives adoption into a fresh node with a different backing size / graph
    // zoom — applyRelView re-derives the pixel transform against the new size.
    function getRelView() {
        const vw = display.width, vh = display.height;
        if (!vw || !vh || !model.hasContent(state)) return null;
        const fit = Math.min(vw / state.width, vh / state.height);
        if (!fit) return null;
        const dx = vw / 2 - ui.view.ox, dy = vh / 2 - ui.view.oy;
        const cos = Math.cos(-ui.view.angle), sin = Math.sin(-ui.view.angle);
        return {
            zoomRel: ui.view.scale / fit,
            cx: (dx * cos - dy * sin) / ui.view.scale,
            cy: (dx * sin + dy * cos) / ui.view.scale,
            angle: ui.view.angle,
        };
    }
    // Re-derive {scale,ox,oy,angle} so image point (cx,cy) sits under the
    // viewport centre at zoomRel×fit, against the CURRENT backing size.
    function applyRelView(rv) {
        const vw = display.width, vh = display.height;
        if (!vw || !vh || !model.hasContent(state)) return false;
        const fit = Math.min(vw / state.width, vh / state.height);
        if (!fit) return false;
        const scale = rv.zoomRel * fit;
        const cos = Math.cos(rv.angle), sin = Math.sin(rv.angle);
        const sx = scale * rv.cx, sy = scale * rv.cy;
        ui.view.scale = scale;
        ui.view.angle = rv.angle;
        ui.view.ox = vw / 2 - (sx * cos - sy * sin);
        ui.view.oy = vh / 2 - (sx * sin + sy * cos);
        ui.view.fitted = true; // established view; tracks later backing resizes
        return true;
    }
    // Screen (client) px -> display backing px. ComfyUI scales DOM widgets
    // with a CSS transform (graph zoom), and the backing store includes
    // devicePixelRatio, so client coordinates must be converted before any
    // view math.
    function toBacking(e) {
        const r = display.getBoundingClientRect();
        const k = r.width ? display.width / r.width : 1;
        return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }
    function toImage(e) {
        const p = toBacking(e);
        const dx = p.x - ui.view.ox;
        const dy = p.y - ui.view.oy;
        const cos = Math.cos(-ui.view.angle), sin = Math.sin(-ui.view.angle);
        return {
            x: (dx * cos - dy * sin) / ui.view.scale,
            y: (dx * sin + dy * cos) / ui.view.scale,
        };
    }
    // Inverse of toImage: image-space point -> backing (screen) px. Used to
    // project the Move-tool frame/handles, which are drawn in screen space.
    function imageToBacking(p) {
        const cos = Math.cos(ui.view.angle), sin = Math.sin(ui.view.angle);
        const x = p.x * ui.view.scale, y = p.y * ui.view.scale;
        return { x: x * cos - y * sin + ui.view.ox, y: x * sin + y * cos + ui.view.oy };
    }
    // Zoom keeping screen point (cx,cy) fixed. Uniform scale commutes with
    // rotation, so offsets transform the same way with or without angle.
    function zoomAt(cx, cy, factor) {
        const ns = Math.min(16, Math.max(0.05, ui.view.scale * factor));
        const k = ns / ui.view.scale;
        ui.view.ox = cx - (cx - ui.view.ox) * k;
        ui.view.oy = cy - (cy - ui.view.oy) * k;
        ui.view.scale = ns;
    }
    // Rotate by da keeping screen point (cx,cy) fixed.
    function rotateAt(cx, cy, da) {
        const cos = Math.cos(da), sin = Math.sin(da);
        const vx = cx - ui.view.ox, vy = cy - ui.view.oy;
        ui.view.ox = cx - (vx * cos - vy * sin);
        ui.view.oy = cy - (vx * sin + vy * cos);
        ui.view.angle += da;
    }

    // ---- render ----
    const tint = document.createElement("canvas");
    // Editor decoration only: never draw into model layers or export buffers.
    const checkerTile = document.createElement("canvas");
    checkerTile.width = checkerTile.height = 24;
    const checkerCtx = checkerTile.getContext("2d");
    checkerCtx.fillStyle = "#383b40";
    checkerCtx.fillRect(0, 0, 24, 24);
    checkerCtx.fillStyle = "#484c52";
    checkerCtx.fillRect(0, 0, 12, 12);
    checkerCtx.fillRect(12, 12, 12, 12);
    function drawTransparency(ctx, x, y, width, height, scale = 1) {
        if (node.properties?.e2goTransparencyGrid === false) return;
        ctx.save();
        const pattern = ctx.createPattern(checkerTile, "repeat");
        const k = (window.devicePixelRatio || 1) / scale;
        pattern.setTransform(new DOMMatrix().translate(x, y).scale(k));
        ctx.fillStyle = pattern;
        ctx.fillRect(x, y, width, height);
        ctx.restore();
    }
    function drawImageBoundary(ctx, x, y, width, height, scale = 1) {
        ctx.save();
        ctx.setLineDash([]);
        ctx.lineWidth = (window.devicePixelRatio || 1) / scale;
        ctx.strokeStyle = "#a1a5ac";
        ctx.strokeRect(x, y, width, height);
        ctx.restore();
    }
    function redraw() {
        const showGrid = node.properties?.e2goTransparencyGrid !== false;
        bTransparency.setAttribute("aria-pressed", String(showGrid));
        bTransparency.title = `Transparency grid: ${showGrid ? "ON" : "OFF"} (display only)`;
        bTransparency.style.opacity = showGrid ? "1" : ".55";
        // Backing store = layout size × graph zoom × devicePixelRatio so the
        // canvas stays crisp under the CSS transform ComfyUI applies to DOM
        // widgets. CSS size stays at layout px; when the backing rescales,
        // the fitted view transform rescales with it so content stays put.
        const lw = view.clientWidth, lh = view.clientHeight;
        // Hidden/collapsed widget (workflow-tab switch, minimized node):
        // resizing the backing store against 0-size layout would trash the
        // canvas CSS size and the fitted view transform — the corruption then
        // SURVIVES the return to this tab (cursor/ring offset growing from the
        // top-left corner until a graph zoom forces a clean rebuild). Skip.
        if (!lw || !lh) return;
        const rect = view.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const zoom = rect.width ? rect.width / lw : 1;
        const bw = Math.max(1, Math.round(lw * zoom * dpr));
        const bh = Math.max(1, Math.round(lh * zoom * dpr));
        if (display.width !== bw || display.height !== bh) {
            // Workflow switches can resize width and height independently.
            // Scaling by width alone shifts the image off-screen when the
            // editor's aspect ratio changes, and that bad view gets stashed.
            const relView = ui.view.fitted ? getRelView() : null;
            display.width = bw;
            display.height = bh;
            display.style.width = lw + "px";
            display.style.height = lh + "px";
            if (relView) applyRelView(relView);
        }
        const vw = bw, vh = bh;
        const ctx = display.getContext("2d");
        ctx.clearRect(0, 0, vw, vh);
        const hasCanvas = model.hasContent(state);
        const viewingResult = !!ui.review && ui.previewResult;
        root.dataset.view = viewingResult ? "result" : hasCanvas ? "editor" : "empty";
        editorTab.classList.toggle("on", !layoutActive && !viewingResult);
        resultTab.classList.toggle("on", !layoutActive && viewingResult);
        editorTab.setAttribute("aria-pressed", String(!layoutActive && !viewingResult));
        layoutTab.setAttribute("aria-pressed", String(layoutActive));
        resultTab.setAttribute("aria-pressed", String(!layoutActive && viewingResult));
        resultTab.disabled = !ui.review;
        stateLabel.textContent = layoutActive ? "Layout · regions are not masks" : viewingResult
            ? `Result ${ui.review.idx + 1} / ${ui.review.imgs.length} · viewing only`
            : hasCanvas ? (ui.mode === "none" ? "Editing off · choose Mask or Paint" : `${ui.mode === "mask" ? "Mask" : activePaintName()} · ${ui.instrument}`) : "Empty canvas";
        for (const name of ["brush", "erase", "fill", "move"]) btns[name].disabled = viewingResult || !hasCanvas || ui.mode === "none";
        for (const button of gMask.querySelectorAll("button")) button.disabled = viewingResult || !hasCanvas;
        bClearP.disabled = viewingResult || !hasCanvas;
        bClearP.textContent = `Clear ${activePaintName()}`;
        side.style.opacity = viewingResult ? "0.6" : "1";
        saveInfo.textContent = hasCanvas ? `${node._e2goCanvasSaveState || "Layers saved"} · ${state.rememberMask ? "mask persistence on" : "mask is temporary"}` : "";
        rememberMask.checked = !!state.rememberMask;
        if (ui.maskStatusDirty !== state.dirty) {
            ui.maskStatusDirty = state.dirty;
            ui.maskStatus = model.maskHasContent(state);
        }
        maskNote.textContent = `${ui.maskStatus ? "Mask applies to generation" : "Mask is empty"} · ${state.rememberMask ? "saved with workflow after upload" : "temporary, not saved"}`;
        // History buttons mirror the stacks — a disabled ↶ says "nothing to undo".
        bUndo.disabled = state.undoStack.length === 0;
        bRedo.disabled = state.redoStack.length === 0;
        emptyHint.style.display = model.hasContent(state) ? "none" : "flex";
        xfBar.style.display = (ui.xform || ui.expand) ? "" : "none";
        if (!model.hasContent(state)) {
            // Results on an EMPTY canvas (bg cleared, then generated): draw
            // the current one fitted into the viewport so ◄ ► paging isn't
            // blind — the palette is the only route to the fresh generation
            // here, and ✓ BG adopts exactly the frame being shown.
            const rimg = ui.previewResult ? reviewImg() : null;
            if (rimg && rimg.complete && rimg.naturalWidth) {
                emptyHint.style.display = "none";
                const k = Math.min(vw / rimg.naturalWidth, vh / rimg.naturalHeight);
                const dw = rimg.naturalWidth * k, dh = rimg.naturalHeight * k;
                drawTransparency(ctx, (vw - dw) / 2, (vh - dh) / 2, dw, dh);
                ctx.drawImage(rimg, (vw - dw) / 2, (vh - dh) / 2, dw, dh);
                drawImageBoundary(ctx, (vw - dw) / 2, (vh - dh) / 2, dw, dh);
                persistentInfo.textContent = `Result ${ui.review.idx + 1}/${ui.review.imgs.length} · ${rimg.naturalWidth}×${rimg.naturalHeight} · no canvas loaded`;
                syncLayersPanel();
                return;
            }
            persistentInfo.textContent = "No canvas loaded";
            syncLayersPanel();
            // MAINTENANCE CONTRACT: these two empty-state returns skip the
            // whole content pipeline below (layers, overlays, brush ring,
            // frames). Anything that must ALSO run on an empty canvas has to
            // be added ABOVE this block, next to emptyHint/xfBar.
            return;
        }
        // Adopted view (session stash) waits here until the display has a real
        // size, then re-derives against the current backing. Falls through to
        // fitView if it can't apply yet.
        if (ui.pendingRelView) {
            if (applyRelView(ui.pendingRelView)) {
                ui.pendingRelView = null;
            } else if (!ui.view.fitted) {
                fitView();
            }
        } else if (!ui.view.fitted) {
            fitView();
        }

        const xf = ui.xform;
        const xm = xf ? model.xformMatrix(xf) : null;
        ctx.save();
        // try/finally: an exception between save() and restore() would leave
        // the leftover transform on the context FOREVER (until a backing
        // resize) — every later frame then renders offset from the cursor.
        try {
        ctx.imageSmoothingEnabled = ui.view.scale < 1 || ui.view.angle !== 0;

        ctx.imageSmoothingQuality = "high";
        ctx.translate(ui.view.ox, ui.view.oy);
        ctx.rotate(ui.view.angle);
        ctx.scale(ui.view.scale, ui.view.scale);

        drawTransparency(ctx, 0, 0, state.width, state.height, ui.view.scale);
        for (const [i, layer] of state.layers.entries()) {
            if (ui.previewResult) break;
            if (!layer.visible || !layer.canvas) continue;
            if (xm && xf.target === `p${i}`) {
                ctx.save();
                ctx.transform(xm.a, xm.b, xm.c, xm.d, xm.e, xm.f);
                ctx.drawImage(layer.canvas, 0, 0);
                ctx.restore();
            } else ctx.drawImage(layer.canvas, 0, 0);
        }
        if (ui.maskOverlay && state.mask && !ui.previewResult) {
        // mask overlay. Sizing the tint canvas reallocates
        // its backing store, so only touch width/height when the state size
        // actually changed (setting .width also implicitly clears it, which
        // the same-size clearRect branch below does explicitly instead).
        if (tint.width !== state.width || tint.height !== state.height) {
            tint.width = state.width;
            tint.height = state.height;
        }
        const tctx = tint.getContext("2d");
        tctx.clearRect(0, 0, tint.width, tint.height);
        tctx.globalCompositeOperation = "source-over";
        if (xm && xf.target === "mask") {
            tctx.setTransform(xm.a, xm.b, xm.c, xm.d, xm.e, xm.f);
            tctx.drawImage(state.mask, 0, 0);
            tctx.resetTransform();
        } else {
            tctx.drawImage(state.mask, 0, 0);
        }
        tctx.globalCompositeOperation = "source-in";
        tctx.fillStyle = ui.tools.mask.color;
        tctx.fillRect(0, 0, tint.width, tint.height);

        ctx.globalAlpha = Math.min(0.85, Math.max(0.08, ui.tools.mask.opacity * 0.8));
        ctx.drawImage(tint, 0, 0);
        ctx.globalAlpha = 1;
        }

        if (ui.previewResult && ui.review) {
            const rimg = ui.review.imgs[ui.review.idx];
            if (rimg && rimg.complete && rimg.naturalWidth) {
                const k = Math.min(state.width / rimg.naturalWidth, state.height / rimg.naturalHeight);
                const dw = rimg.naturalWidth * k, dh = rimg.naturalHeight * k;
                ctx.drawImage(rimg, (state.width - dw) / 2, (state.height - dh) / 2, dw, dh);
            }
        }
        drawImageBoundary(ctx, 0, 0, state.width, state.height, ui.view.scale);
        if (ui.previewResult && ui.review?.cropBox) {
            const [x, y, w, h] = ui.review.cropBox;
            ctx.strokeStyle = "#ffe570";
            ctx.lineWidth = 2 / ui.view.scale;
            ctx.setLineDash([6 / ui.view.scale, 4 / ui.view.scale]);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            ctx.fillStyle = "#ffe570";
            ctx.font = `${12 / ui.view.scale}px sans-serif`;
            ctx.fillText("Last generated region", x + 4 / ui.view.scale, y + 16 / ui.view.scale);
        }
        } finally {
            ctx.restore();
        }
        // Brush-radius cursor preview: image-space brush size projected to
        // the screen (dark ring under a light one so it reads on any pixel).
        if (ui.cursor && !ui.expand && (ui.instrument === "brush" || ui.instrument === "erase")) {
            const p = toBacking(ui.cursor);
            const r = Math.max(1, (brush().size / 2) * ui.view.scale);
            ctx.save();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 1, 0, Math.PI * 2);
            ctx.stroke();
            // Ring color tells the tool at a glance: active brush color for
            // mask/paint, dashed white for the eraser.
            if (ui.tool === "erase") {
                ctx.strokeStyle = "rgba(255,255,255,0.85)";
                ctx.setLineDash([4, 4]);
            } else {
                ctx.strokeStyle = brush().color;
            }
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
        // Move-tool frame + handles: drawn in backing (screen) coords, outside
        // the view-transformed save/restore above — it must stay a constant
        // on-screen size regardless of zoom, and recomputed every frame so
        // pan/zoom during a drag keeps the hit-test cache (_xformScreen) valid.
        // Expand-canvas frame: the future bounds in screen coords, with the
        // new area shaded and edge/corner handles cached for hit-testing.
        if (ui.expand) {
            const ex = ui.expand;
            const o = imageToBacking({ x: -ex.l, y: -ex.t });
            const q = imageToBacking({ x: state.width + ex.r, y: state.height + ex.b });
            const c0 = imageToBacking({ x: 0, y: 0 });
            const c1 = imageToBacking({ x: state.width, y: state.height });
            ctx.save();
            // Shade only the NEW area: outer path + inner canvas path, evenodd.
            ctx.fillStyle = "rgba(120, 190, 255, 0.14)";
            ctx.beginPath();
            ctx.rect(o.x, o.y, q.x - o.x, q.y - o.y);
            ctx.rect(c0.x, c0.y, c1.x - c0.x, c1.y - c0.y);
            ctx.fill("evenodd");
            ctx.strokeStyle = "#7ab4ff";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(o.x, o.y, q.x - o.x, q.y - o.y);
            ctx.setLineDash([]);
            const midX = (o.x + q.x) / 2, midY = (o.y + q.y) / 2;
            const handles = {
                L: { x: o.x, y: midY }, R: { x: q.x, y: midY },
                T: { x: midX, y: o.y }, B: { x: midX, y: q.y },
                TL: { x: o.x, y: o.y }, TR: { x: q.x, y: o.y },
                BL: { x: o.x, y: q.y }, BR: { x: q.x, y: q.y },
            };
            ctx.fillStyle = "#7ab4ff";
            for (const pt of Object.values(handles)) {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            ui._expandScreen = { handles };
        } else ui._expandScreen = null;
        if (xf) {
            // bbox corners -> image space through the live matrix -> screen.
            const P = [[xf.bbox.x, xf.bbox.y], [xf.bbox.x + xf.bbox.w, xf.bbox.y],
                       [xf.bbox.x + xf.bbox.w, xf.bbox.y + xf.bbox.h], [xf.bbox.x, xf.bbox.y + xf.bbox.h]]
                .map(([x, y]) => ({ x: xm.a * x + xm.c * y + xm.e, y: xm.b * x + xm.d * y + xm.f }))
                .map((p) => imageToBacking(p));
            ctx.save();
            ctx.strokeStyle = "#7ab4ff"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
            ctx.beginPath();
            P.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
            const top = { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 };
            const c = { x: (P[0].x + P[2].x) / 2, y: (P[0].y + P[2].y) / 2 };
            const n = Math.hypot(top.x - c.x, top.y - c.y) || 1;
            const rot = { x: top.x + ((top.x - c.x) / n) * 26, y: top.y + ((top.y - c.y) / n) * 26 };
            ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rot.x, rot.y); ctx.stroke();
            ctx.fillStyle = "#7ab4ff";
            for (const p of [...P, rot]) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); }
            ctx.restore();
            ui._xformScreen = { P, rot, c };     // hit-test cache for pointerdown
        } else ui._xformScreen = null;
        {
            const snap16 = (v) => Math.max(0, Math.round(v / 16) * 16); // mirrors applyExpand's snap
            const label = ui.expand
                ? `expand +${snap16(ui.expand.l)}/${snap16(ui.expand.t)}/${snap16(ui.expand.r)}/${snap16(ui.expand.b)} `
                    + `→ ${state.width + snap16(ui.expand.l) + snap16(ui.expand.r)}×${state.height + snap16(ui.expand.t) + snap16(ui.expand.b)} · Enter applies`
                : ui.xform
                ? `move · Δ${Math.round(ui.xform.dx)},${Math.round(ui.xform.dy)} · ${Math.round(ui.xform.scale * 100)}% · ${Math.round(ui.xform.angle * 180 / Math.PI)}°`
                : (ui.previewResult && ui.review
                    ? (() => {
                        const rimg = ui.review.imgs[ui.review.idx];
                        const mismatch = rimg && rimg.naturalWidth
                            && (rimg.naturalWidth !== state.width || rimg.naturalHeight !== state.height);
                        return `result ${ui.review.idx + 1}/${ui.review.imgs.length} (preview)`
                            + (mismatch ? ` · result ${rimg.naturalWidth}×${rimg.naturalHeight}` : "");
                    })()
                    : (ui.mode === "none" ? "Editing off" : ui.mode === "mask"
                        ? "Mask"
                        : (state.layers[state.activeLayer]?.name || `Paint ${state.activeLayer}`)));
            persistentInfo.textContent =
                `${state.width}×${state.height} · ${Math.round(ui.view.scale * 100)}% · ${label}`;
        }
        syncLayersPanel();
        refreshThumbs();
        // Nudge the debounced server persist of paint layers (powder_canvas.js);
        // it self-gates on the dirty counter, so view-only redraws are free.
        node._e2goOnCanvasChanged?.();
    }
    // Coalesce high-frequency redraws (pointermove can fire >120Hz) into one
    // paint per animation frame. Strokes still land in the model immediately.
    let rafPending = false;
    function scheduleRedraw() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            redraw();
        });
    }
    // refit defaults true (existing callers -- persistence restore, etc. --
    // keep snapping to fit); the Queue-time background reload passes false
    // when the image size hasn't changed so the user's zoom/pan survives.
    node._e2goCanvasRedraw = (refit = true) => {
        if (refit) {
            ui.view.fitted = false;
            // The DOM widget's layout settles a frame AFTER setSize, so the
            // synchronous fit below uses stale dimensions. Arm a one-shot
            // re-fit that the ResizeObserver consumes when the element
            // actually resizes; disarm after 500ms so a much later resize
            // doesn't unexpectedly reset the user's view.
            ui.refitArmed = true;
            clearTimeout(ui.refitArmTimer);
            ui.refitArmTimer = setTimeout(() => (ui.refitArmed = false), 500);
        }
        redraw();
    };

    // ---- pointer: draw / pan / pick ----
    function strokeTarget() {
        if (ui.tool === "erase") return ui.eraseTarget;
        return ui.tool;
    }
    view.addEventListener("pointerdown", (e) => {
        if (ui.previewResult && ui.review) {
            if (e.button === 0 && e.target === display) setStatus("Viewing a result. Choose Edit canvas, or Use as background to edit this result.", { warn: false });
            return;
        }
        // Gate everything on there being a background: no content means
        // nothing to pan, draw on, or sample — including the eyedropper.
        if (!model.hasContent(state)) return;
        if (e.button !== 0) return;
        if (ui.expand) {
            // Expand-canvas frame owns ALL clicks while armed (no strokes).
            const s = ui._expandScreen;
            if (!s) return;
            const bp = toBacking(e);
            let kind = null, best = 14 * 14;
            for (const [k, pt] of Object.entries(s.handles)) {
                const d2 = (bp.x - pt.x) ** 2 + (bp.y - pt.y) ** 2;
                if (d2 <= best) { best = d2; kind = k; }
            }
            if (!kind) return;
            ui.expandDrag = { kind, start: toImage(e), base: { ...ui.expand } };
            view.setPointerCapture(e.pointerId);
            return;
        }
        if (ui.instrument === "move") {

            if (!ui.xform) { startXform(); return; }
            const s = ui._xformScreen;
            if (!s) return;
            const bp = toBacking(e);
            const hit = (p) => Math.hypot(bp.x - p.x, bp.y - p.y) <= 10;
            let kind = null;
            if (hit(s.rot)) kind = "rotate";
            else if (s.P.some(hit)) kind = "scale";
            else if (pointInQuad(bp, s.P)) kind = "move";
            if (!kind) return;
            const ip = toImage(e);
            ui.xformDrag = { kind, start: ip, startScreen: bp,
                             base: { ...ui.xform },
                             a0: Math.atan2(bp.y - s.c.y, bp.x - s.c.x),
                             r0: Math.hypot(bp.x - s.c.x, bp.y - s.c.y) || 1 };
            view.setPointerCapture(e.pointerId);
            return;                              // never falls through to strokes
        }
        const p = toImage(e);
        if (ui.historyBusy) return;
        if (ui.instrument === "fill") {
            const target = ui.mode === "mask" ? "mask" : "paint";

            if (p.x < 0 || p.y < 0 || p.x >= state.width || p.y >= state.height) {
                setStatus("fill: click inside the picture");
                return;
            }
            // Mask fill is always full-white (the mask channel is alpha-only,
            // same rule as its brush); paint fills with the paint color.
            model.pushUndo(state, target);
            if (model.floodFill(state, target, p.x, p.y,
                    target === "mask" ? "#ffffff" : ui.tools.paint.color)) {
                redraw();
            } else {
                setStatus("fill: click inside the picture");
            }
            return;
        }
        if (ui.instrument !== "brush" && ui.instrument !== "erase") return;
        const target = strokeTarget();

        if (ui.tool === "erase") {
            const empty = target === "mask"
                ? !model.maskHasContent(state)
                : !model.paintLayerHasContent(state, state.activeLayer);
            if (empty) setStatus(target === "mask"
                ? "eraser on an EMPTY mask — nothing to erase (switch to 🖌 to paint)"
                : "eraser on an EMPTY layer — nothing to erase", { ms: 3000 });
        }
        model.pushUndo(state, target);
        ui.stroke = { target, last: p };
        view.setPointerCapture(e.pointerId);
        applyStroke([p, p]);
    });
    view.addEventListener("pointermove", (e) => {
        // No brush ring over/while-using the nav cluster or the floating
        // result palette (their pointer events bubble up through the view).
        if (nav.contains(e.target) || gCompare.contains(e.target)) {
            if (ui.cursor) {
                ui.cursor = null;
                scheduleRedraw();
            }
            return;
        }
        if (ui.expandDrag && ui.expand) {
            const d = ui.expandDrag, ip = toImage(e);
            const k = d.kind;
            if (k.includes("L")) ui.expand.l = Math.max(0, d.base.l + (d.start.x - ip.x));
            if (k.includes("R")) ui.expand.r = Math.max(0, d.base.r + (ip.x - d.start.x));
            if (k.includes("T")) ui.expand.t = Math.max(0, d.base.t + (d.start.y - ip.y));
            if (k.includes("B")) ui.expand.b = Math.max(0, d.base.b + (ip.y - d.start.y));
            scheduleRedraw();
            return;
        }
        if (ui.xformDrag && !ui.xform) {

            ui.xformDrag = null;
            return;
        }
        if (ui.xformDrag) {
            const d = ui.xformDrag, s = ui._xformScreen, bp = toBacking(e);
            if (d.kind === "move") {
                const ip = toImage(e);
                ui.xform.dx = d.base.dx + (ip.x - d.start.x);
                ui.xform.dy = d.base.dy + (ip.y - d.start.y);
            } else if (d.kind === "scale") {
                const r = Math.hypot(bp.x - s.c.x, bp.y - s.c.y);
                ui.xform.scale = Math.min(16, Math.max(0.05, d.base.scale * (r / d.r0)));
            } else {
                let a = d.base.angle + (Math.atan2(bp.y - s.c.y, bp.x - s.c.x) - d.a0);
                if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // 15°
                ui.xform.angle = a;
            }
            scheduleRedraw();
            return;
        }
        // Track the cursor for the brush-radius preview ring.
        ui.cursor = { clientX: e.clientX, clientY: e.clientY };
        if (!ui.stroke) {
            if (model.hasContent(state)) scheduleRedraw();
            return;
        }
        const p = toImage(e);
        applyStroke([ui.stroke.last, p]);
        ui.stroke.last = p;
    });
    function endStroke(e) {
        ui.expandDrag = null;
        ui.xformDrag = null;
        ui.stroke = null;
        try { view.releasePointerCapture(e.pointerId); } catch {}
    }
    // Point-in-convex-quad via cross products (frame may be rotated).
    function pointInQuad(p, Q) {
        let sign = 0;
        for (let i = 0; i < 4; i++) {
            const a = Q[i], b = Q[(i + 1) % 4];
            const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
            if (!cr) continue;
            if (!sign) sign = Math.sign(cr);
            else if (Math.sign(cr) !== sign) return false;
        }
        return true;
    }
    view.addEventListener("pointerup", endStroke);
    view.addEventListener("pointercancel", endStroke);

    // ---- context menu (right-click on the canvas view) ----------------------
    // Appended to document.body: position:fixed inside ComfyUI's transformed
    // DOM-widget would be scaled/offset by the graph zoom.
    let menuEl = null;
    function closeMenu() {
        if (!menuEl) return;
        menuEl.remove();
        menuEl = null;
        document.removeEventListener("pointerdown", onMenuAway, true);
        document.removeEventListener("wheel", closeMenu, true);
    }
    function onMenuAway(e) {
        if (menuEl && !menuEl.contains(e.target)) closeMenu();
    }
    function imageForClipboard() {
        const result = ui.previewResult && ui.review?.imgs[ui.review.idx];
        if (result?.complete && result.naturalWidth && result.naturalHeight) {
            // Copy the visible batch result at its native resolution, independently
            // of editor zoom/pan and the background retained for further editing.
            const canvas = document.createElement("canvas");
            canvas.width = result.naturalWidth;
            canvas.height = result.naturalHeight;
            canvas.getContext("2d").drawImage(result, 0, 0);
            return canvas;
        }
        return model.bakeComposite(state);
    }
    function canvasToClipboard(c, okMsg) {
        c.toBlob((blob) => {
            if (!blob || !window.ClipboardItem) { setStatus("clipboard copy failed"); return; }
            navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
                .then(() => setStatus(okMsg, { warn: false }))
                .catch((err) => {
                    console.warn("[PowderCanvas] clipboard write failed:", err);
                    setStatus("clipboard copy failed");
                });
        });
    }
    function saveImageToDisk() {
        const image = imageForClipboard();
        image.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `powder_${ui.review && ui.previewResult ? "result" : "canvas"}_${image.width}x${image.height}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
    }
    // Returns the first image blob on the clipboard, or null. Throws only on a
    // clipboard-permission/read failure (callers report that separately).
    async function readClipboardImageBlob() {
        const items = await navigator.clipboard.read();
        for (const it of items) {
            const type = it.types.find((t) => t.startsWith("image/"));
            if (type) return it.getType(type);
        }
        return null;
    }
    async function pasteAsLayer() {
        try {
            const blob = await readClipboardImageBlob();
            if (!blob) { setStatus("no image in the clipboard"); return; }
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                if (model.addImageLayer(state, img) > 0) setMode("paint");
                scheduleRedraw();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                setStatus("clipboard image failed to decode");
            };
            img.src = url;
        } catch (err) {
            console.warn("[PowderCanvas] clipboard read failed:", err);
            setStatus("clipboard read failed (browser permission?)");
        }
    }
    // Paste from the clipboard as the BACKGROUND: replaces the whole canvas
    // (same as drag-and-drop / 📂 BG), for editing a different picture in the
    // same session without a file dialog. A different-size image starts a fresh
    // mask/paint stack; a same-size one keeps the current paint (model rule).
    async function pasteAsBackground() {
        try {
            const blob = await readClipboardImageBlob();
            if (!blob) { setStatus("no image in the clipboard"); return; }
            await node._e2goCanvasLoadBase?.(blob);
        } catch (err) {
            console.warn("[PowderCanvas] clipboard read failed:", err);
            setStatus("clipboard read failed (browser permission?)");
        }
    }

    function fitNodeToAspect() {
        if (!model.hasContent(state)) { setStatus("no canvas yet"); return; }
        const curViewW = view.clientWidth || 0;
        const curViewH = view.clientHeight || 0;
        if (!curViewW || !curViewH) return;
        const desiredViewH = Math.round((curViewW * state.height) / state.width);
        if (Math.abs(desiredViewH - curViewH) <= 2) {
            setStatus("node already matches the canvas aspect", { warn: false });
            return;
        }
        node.setSize([Math.max(node.size?.[0] || 420, 420),
                      (node.size?.[1] || 400) + (desiredViewH - curViewH)]);
        node.setDirtyCanvas(true, true);
        node._e2goCanvasRedraw?.(true);
    }

    function showCanvasMenu(x, y, section = "all") {
        closeMenu();
        const has = model.hasContent(state);
        const result = ui.review && ui.previewResult;
        const hasImage = has || !!result;
        const hasMask = has && model.maskHasContent(state);
        const active = state.layers[state.activeLayer];
        const clipW = !!window.ClipboardItem;
        const clipR = !!navigator.clipboard?.read;
        const items = [
            { label: "🆕 New blank canvas…", fn: newBlankCanvas },
            { label: "Canvas storage…", icon: "storage", fn: () => node._e2goCanvasOpenStorage?.() },
            { label: "↔ Expand canvas (outpaint)", fn: startExpand, disabled: !has },
            { label: "⤢ Fit node to canvas aspect", fn: fitNodeToAspect, disabled: !has },
            { label: "📂 Load image as background…", fn: () => pickImageFile((f) => node._e2goCanvasLoadBase?.(f)) },
            { label: "🖼 Load image as new layer…", fn: loadImageFileAsLayer, disabled: !has },
            { label: "📋 Paste as background (replace)", fn: pasteAsBackground, disabled: !clipR },
            { label: "📋 Paste as new layer", fn: pasteAsLayer, disabled: !has || !clipR },
            null,
            { label: result ? "Copy result" : "Copy canvas", icon: "copy", fn: () => canvasToClipboard(imageForClipboard(), "image copied"), disabled: !hasImage || !clipW },
            { label: result ? "Save result…" : "Save canvas…", icon: "save", fn: saveImageToDisk, disabled: !hasImage },
            null,
            { label: "Copy mask", icon: "mask", fn: () => canvasToClipboard(model.exportMaskCanvas(state), "mask copied"), disabled: !hasMask || !clipW },
            { label: `Copy layer${active?.name ? ` (${active.name})` : ""}`, icon: "copy", fn: () => canvasToClipboard(active.canvas, "layer copied"), disabled: !has || !active || state.activeLayer < 1 || !clipW },
            { label: "Duplicate layer", icon: "layers", fn: () => {
                if (model.duplicatePaintLayer(state, state.activeLayer) > 0) { setMode("paint"); scheduleRedraw(); }
            }, disabled: !has || state.activeLayer < 1 },
            { label: "Duplicate background as layer", icon: "layers", fn: () => {
                if (model.duplicateBackgroundAsLayer(state) > 0) { setMode("paint"); scheduleRedraw(); }
            }, disabled: !has },
        ];
        menuEl = el("div", "e2go-cv-menu");
        const exportAt = items.findIndex(item => item?.label.startsWith("Copy "));
        const selectedItems = section === "export" ? items.slice(exportAt, exportAt + 5)
            : section === "canvas" ? items.slice(0, exportAt - 1) : items;
        for (const it of selectedItems) {
            if (!it) { menuEl.appendChild(el("div", "sep")); continue; }
            const b = el("button", "", it.label);
            if (it.icon) canvasIcon(b, it.icon);
            b.disabled = !!it.disabled;
            b.addEventListener("click", () => { closeMenu(); it.fn(); });
            menuEl.appendChild(b);
        }
        menuEl.style.left = `${x}px`;
        menuEl.style.top = `${y}px`;
        document.body.appendChild(menuEl);
        // Clamp into the viewport after measuring.
        const r = menuEl.getBoundingClientRect();
        if (r.right > innerWidth) menuEl.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
        if (r.bottom > innerHeight) menuEl.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
        document.addEventListener("pointerdown", onMenuAway, true);
        document.addEventListener("wheel", closeMenu, true);
    }
    view.addEventListener("contextmenu", (e) => {
        // Own menu instead of the browser/ComfyUI one; drawing stays on LMB.
        e.preventDefault();
        e.stopPropagation();
        if (nav.contains(e.target)) return;
        showCanvasMenu(e.clientX, e.clientY);
    });

    function applyStroke(pts) {
        const erase = ui.tool === "erase";
        model.brushStroke(state, ui.stroke.target, pts, {
            size: ui.tools[ui.stroke.target].size,
            feather: ui.tools[ui.stroke.target].feather,
            color: ui.tools.paint.color,
            // Erasing is destination-out (full removal); scaling it by the
            // Opacity slider would leave faded residue instead of a clean
            // erase, so only paint strokes honor the slider.
            opacity: erase ? 1 : (ui.stroke.target === "paint" ? ui.tools.paint.opacity : 1),
            erase,
        });
        scheduleRedraw();
    }

    // ---- hotkeys (active only while hovering the editor) ----
    view.addEventListener("pointerenter", () => (ui.hover = true));
    view.addEventListener("pointerleave", () => {
        ui.hover = false;
        ui.cursor = null; // hide the brush-radius ring
        if (model.hasContent(state)) scheduleRedraw();
    });
    function onKey(e) {
        if (!ui.hover) return;
        if (e.type !== "keydown") return;
        if (e.target?.closest?.("input, textarea, select, [contenteditable=true]")) return;

        if (e.code === "BracketLeft") { const b = brush(); b.size = Math.max(1, b.size - 5); sSize.set(b.size); scheduleRedraw(); }
        else if (e.code === "BracketRight") { const b = brush(); b.size = Math.min(200, b.size + 5); sSize.set(b.size); scheduleRedraw(); }
        else if (ui.expand && (e.code === "Enter" || e.code === "NumpadEnter")) { applyExpand(); }
        else if (ui.expand && e.code === "Escape") { cancelExpand(); }
        else if (ui.xform && (e.code === "Enter" || e.code === "NumpadEnter")) { commitXform(); setInstrument(null); }
        else if (ui.xform && e.code === "Escape") { cancelXform(); setInstrument(null); }
        else if (e.code === "Escape") { setInstrument(null); }

    }
    // Capture phase: run before ComfyUI's own document-level undo handler.
    // (keydown only: onKey bails on every other event type.)
    document.addEventListener("keydown", onKey, true);

    const resizeObserver = new ResizeObserver(() => {
        if (ui.refitArmed) {
            ui.refitArmed = false;
            ui.view.fitted = false;
        }
        redraw();
    });
    resizeObserver.observe(view);

    // Graph zoom rescales the DOM widget via CSS transform without firing
    // the ResizeObserver; poll the on-screen rect from the node's draw hook
    // and re-render when it changes so the backing store follows the zoom.
    const prevOnDrawFg = node.onDrawForeground;
    node.onDrawForeground = function (...args) {
        if (typeof prevOnDrawFg === "function") {
            try { prevOnDrawFg.apply(this, args); } catch {}
        }
        const w = view.getBoundingClientRect().width;
        if (Math.abs(w - (ui.lastRectW || 0)) > 0.5) {
            ui.lastRectW = w;
            scheduleRedraw();
        }
    };

    // Teardown: document/window listeners and the ResizeObserver outlive the
    // DOM widget's own removal, so they must be torn down explicitly on node
    // removal rather than left to garbage collection.
    const prevOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        if (typeof prevOnRemoved === "function") {
            try { prevOnRemoved.apply(this, args); } catch {}
        }
        document.removeEventListener("keydown", onKey, true);
        resizeObserver.disconnect();
        layoutEditor.destroy();
        canvasModal?.close();
        expandedHost?.remove();
        clearTimeout(ui.refitArmTimer);
        ui.previewResult = false;
        ui.xform = null;
        closeMenu(); // body-mounted context menu outlives the widget otherwise
    };

    redraw();
}
