import { canvasDialog } from "./e2go_canvas_dialog.js";
import { readLayout, validateLayout, sceneBasis, visibleText } from "./e2go_layout_model.js";

const COLORS = ["#77c9bd", "#efbd79", "#a6a0ec", "#dc92ac", "#83bbef", "#bcd58a"];
const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };

export function checkProposal(raw, original, keepGeometry) {
    const next = readLayout(raw);
    const errors = validateLayout(next, { allowMissingText: !!keepGeometry });
    if (errors.length) throw new Error(errors.join("\n"));
    if (keepGeometry && next.regions.some((r, i) => r.label === "text" && visibleText(r) !== visibleText(original.regions[i] || {}))) throw new Error("Keep the exact lettering, including the inscription quoted in the original description.");
    const placeholder = value => /^(scene|appearance|appearance description|detailed final-image caption|detailed appearance description for region \d+)$/i.test(value?.trim() || "");
    if ((placeholder(next.scene) && next.scene !== original.scene) || next.regions.some((r, i) => r.enabled !== false && placeholder(r.caption) && r.caption !== original.regions[i]?.caption)) throw new Error("AI copied schema placeholders instead of describing your scene. Request another proposal; your layout is unchanged.");
    if (next.target !== original.target || next.width !== original.width || next.height !== original.height) throw new Error("Keep the original model and canvas size.");
    next.promptSource = original.promptSource;
    next.enabled = original.enabled;
    next.followResolution = original.followResolution;
    if (keepGeometry === "rearrange") {
        const unchanged = d => JSON.stringify({ ...d, scene: "", sceneBasis: "", regions: d.regions.map(r => ({...r, rect: r.locked || r.enabled === false ? r.rect : null})) });
        if (unchanged(next) !== unchanged(readLayout(original))) throw new Error("Recomposition can change only unlocked active rectangles and Scene. Keep all objects, descriptions, palettes and lettering.");
    } else if (keepGeometry === "scene") {
        if (JSON.stringify({ ...next, scene: "", sceneBasis: "" }) !== JSON.stringify({ ...readLayout(original), scene: "", sceneBasis: "" })) throw new Error("This action can change the Scene prompt only.");
    } else if (keepGeometry) {
        const withoutCaptions = layout => JSON.stringify({ ...layout, regions: layout.regions.map(({ caption, ...rest }) => rest) });
        if (withoutCaptions(next) !== withoutCaptions(original)) throw new Error("This action can change appearance descriptions only. Keep the original regions and exact lettering.");
    }
    if (keepGeometry !== true) next.sceneBasis = sceneBasis(next);
    return next;
}

export function reviewLayoutProposal(current, proposed, apply, keepGeometry, regenerate) {
    const dialog = canvasDialog("Review AI proposal");
    dialog.style.width = "1000px"; dialog.style.maxHeight = "90vh"; dialog.style.overflow = "auto";
    const style = el("style");
    style.textContent = `
      .e2go-review-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
      .e2go-review-pane{min-width:0}.e2go-review-pane svg{display:block;width:100%;height:260px;background:#171e25;border:1px solid #46515f}
      .e2go-review-pane ol{padding-left:25px;max-height:190px;overflow:auto;font-size:12px;line-height:1.5}
      .e2go-review-pane li{margin:8px 0;overflow-wrap:anywhere;white-space:pre-wrap}
      .e2go-review-pane p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:85px;overflow:auto}
      .e2go-review-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
      .e2go-review-actions button{padding:9px 14px;background:#34434f;color:inherit;border:1px solid #657381;border-radius:6px;cursor:pointer}
      .e2go-review-actions button:disabled{opacity:.4;cursor:default}
      @media(max-width:650px){.e2go-review-pair{grid-template-columns:1fr}}
    `;
    dialog.append(style, el("p", keepGeometry === "rearrange" ? "Compare the new composition and matching Scene. Locked and disabled regions stay fixed." : keepGeometry === "scene" ? "Compare the Scene prompt. All regions stay unchanged." : keepGeometry ? "Compare appearance descriptions. Positions and exact lettering stay unchanged." : "Compare region placement and descriptions before replacing your layout. Boxes show placement, not a generated image."));
    const pair = el("div"); pair.className = "e2go-review-pair"; dialog.append(pair);
    function preview(layout, title, pane) {
        pane.replaceChildren(el("h4", `${title} · ${layout.width} × ${layout.height}`));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
        svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${title} region placement`);
        // All coordinates share the document aspect ratio, including portrait layouts.
        const frame = document.createElementNS(svg.namespaceURI, "rect");
        frame.setAttribute("width", layout.width); frame.setAttribute("height", layout.height); frame.setAttribute("fill", "#29323c"); svg.append(frame);
        const list = el("ol");
        layout.regions.forEach((region, index) => {
            const color = COLORS[index % COLORS.length], [x, y, w, h] = region.rect;
            const box = document.createElementNS(svg.namespaceURI, "rect");
            for (const [key, value] of Object.entries({ x: x * layout.width, y: y * layout.height, width: w * layout.width, height: h * layout.height, fill: color, "fill-opacity": .12, stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke", opacity: region.enabled === false ? .3 : 1 })) box.setAttribute(key, value);
            const label = document.createElementNS(svg.namespaceURI, "text");
            label.setAttribute("x", x * layout.width + 6); label.setAttribute("y", y * layout.height + layout.height * .045);
            label.setAttribute("font-size", layout.height * .04); label.setAttribute("fill", color); label.textContent = index + 1;
            const tooltip = document.createElementNS(svg.namespaceURI, "title"); tooltip.textContent = region.text || region.caption; box.append(tooltip);
            svg.append(box, label);
            const item = el("li", `${region.label}${region.enabled === false ? " · disabled" : ""}${region.text ? ` · “${region.text}”` : ""}\n${region.caption}`);
            item.style.color = color; list.append(item);
        });
        pane.append(svg, el("p", [layout.scene, layout.background, ...Object.values(layout.style || {}).filter(v => typeof v === "string")].filter(Boolean).join("\n")), list);
    }
    const before = el("section"), after = el("section"); before.className = after.className = "e2go-review-pane"; pair.append(before, after);
    preview(current, "Current layout", before);
    const advanced = el("details"), text = el("textarea"); advanced.append(el("summary", "Edit proposal JSON"), text);
    text.setAttribute("aria-label", "AI proposal JSON"); text.value = JSON.stringify(proposed, null, 2);
    text.style.cssText = "position:static;box-sizing:border-box;width:100%;height:200px;margin-top:8px;background:#151b21;color:#dce5ec;font:12px monospace";
    dialog.append(advanced);
    const warning = el("p"); warning.setAttribute("role", "status"); warning.style.cssText = "color:#efb18f;white-space:pre-wrap"; dialog.append(warning);
    const error = el("p"); error.setAttribute("role", "alert"); error.style.cssText = "color:#efb18f;white-space:pre-wrap"; dialog.append(error);
    const actions = el("div"); actions.className = "e2go-review-actions"; dialog.append(actions);
    const discard = el("button", "Discard"), accept = el("button", "Apply proposal"); actions.append(discard, accept);
    discard.onclick = () => dialog.close();
    let next;
    function refresh() {
        try { next = checkProposal(text.value, current, keepGeometry); preview(next, "AI proposal", after); error.textContent = ""; const missing = validateLayout(next); warning.textContent = missing.length ? `You can apply these changes. Before generating:\n${missing.join("\n")}` : ""; accept.disabled = false; }
        catch (err) { next = null; warning.textContent = ""; after.replaceChildren(el("p", "Fix the proposal to display its preview.")); error.textContent = err.message; accept.disabled = true; }
    }
    if (regenerate) {
        const variantLabel = !keepGeometry || keepGeometry === "rearrange" ? "Another composition" : "Another text variant";
        const another = el("button", variantLabel); actions.prepend(another);
        let controller = null;
        dialog.addEventListener("close", () => controller?.abort());
        another.onclick = async () => {
            controller = new AbortController();
            another.disabled = true; accept.disabled = true; text.disabled = true;
            another.textContent = "Generating..."; error.textContent = "";
            try {
                const variant = await regenerate(next || proposed, controller.signal);
                if (!dialog.open) return;
                const checked = checkProposal(variant, current, keepGeometry);
                const unchanged = JSON.stringify(checked) === JSON.stringify(next || proposed);
                text.value = JSON.stringify(checked, null, 2); refresh();
                if (unchanged) error.textContent = "No further changes proposed. The current proposal remains available.";
            } catch (err) {
                if (!dialog.open) return;
                refresh(); error.textContent = err.message;
            } finally {
                controller = null; another.disabled = false; text.disabled = false;
                another.textContent = variantLabel;
            }
        };
    }
    text.oninput = refresh;
    accept.onclick = () => { refresh(); if (!next) return; try { apply(next); dialog.close(); } catch (err) { error.textContent = err.message; accept.disabled = true; } };
    refresh(); discard.focus(); return dialog;
}
