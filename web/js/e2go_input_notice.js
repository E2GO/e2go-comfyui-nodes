import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// Separate, transient cards. They never participate in node layout or serialization.
const cards = new Map();
let layer, started = false;

function render(card) {
    const { element, notices, expanded } = card;
    const error = notices[0]?.severity === "error";
    element.style.background = error ? "#392727" : "#353022";
    element.style.borderColor = error ? "#87504a" : "#79663d";
    element.replaceChildren();
    const heading = document.createElement("button");
    heading.type = "button";
    heading.style.cssText = "display:block;width:100%;border:0;background:none;color:inherit;text-align:left;padding:0;font:600 12px Arial;cursor:pointer";
    heading.textContent = `${error ? "Check inputs" : "Warning"}${notices.length > 1 ? ` (${notices.length})  ${expanded ? "▴" : "▾"}` : ""}`;
    heading.disabled = notices.length < 2;
    heading.setAttribute("aria-expanded", String(expanded));
    heading.title = notices.length > 1 ? (expanded ? "Collapse messages" : "Show all messages") : "Input status";
    heading.onclick = () => { card.expanded = !card.expanded; render(card); };
    element.append(heading);
    for (const notice of expanded ? notices : notices.slice(0, 1)) {
        const line = document.createElement("div");
        line.style.cssText = "margin-top:7px;white-space:normal;overflow-wrap:anywhere";
        line.style.color = notice.severity === "error" ? "#ffb8ad" : "#efd18b";
        line.textContent = notice.message;
        element.append(line);
    }
}

export function updateInputNotice(node, notices) {
    let card = cards.get(node);
    if (!notices.length) {
        card?.element.remove();
        cards.delete(node);
        return;
    }
    if (!card) {
        const element = document.createElement("section");
        element.dataset.e2goNoticeNode = String(node.id);
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        element.style.cssText = "position:absolute;box-sizing:border-box;transform-origin:top left;pointer-events:auto;border:1px solid;border-radius:8px;padding:11px 13px;color:#f0d4c9;font:12px/1.45 Arial;box-shadow:0 3px 12px #0005;max-height:320px;overflow:auto";
        for (const event of ["pointerdown", "pointerup", "dblclick", "wheel", "keydown"]) {
            element.addEventListener(event, e => e.stopPropagation());
        }
        card = { element, notices, expanded: false };
        cards.set(node, card);
    }
    card.notices = notices;
    if (notices.length < 2) card.expanded = false;
    render(card);
}

export function startInputNoticeLayer() {
    if (started) return;
    started = true;
    api.addEventListener("e2go_layout_status", ({detail}) => {
        const node = app.graph?.getNodeById(detail?.node_id);
        if (node?.comfyClass !== "PowderCanvas") return;
        node._e2goLayoutCompatibility = { target: detail.target, message: String(detail.message || "") };
        let previous;
        node._e2goRefreshLayoutStatus = () => {
            const raw = node.widgets?.find(w => w.name === "layout_config")?.value;
            const key = JSON.stringify([raw, node.mode, node._e2goLayoutCompatibility]);
            if (key === previous) return;
            previous = key;
            let layout;
            try { layout = JSON.parse(raw || "{}"); } catch { layout = {}; }
            const status = node._e2goLayoutCompatibility;
            const show = layout.enabled && layout.target === status.target && status.message && node.mode !== 2 && node.mode !== 4;
            updateInputNotice(node, show ? [{id: "layout_model", severity: "error", message: status.message}] : []);
        };
        node._e2goRefreshLayoutStatus();
    });
    const position = () => {
        const graphCanvas = app.canvas;
        const container = graphCanvas?.canvas?.parentElement;
        if (container && cards.size) {
            if (!layer?.isConnected || layer.parentElement !== container) {
                layer?.remove();
                layer = document.createElement("div");
                layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:10";
                container.append(layer);
            }
            const bounds = container.getBoundingClientRect();
            const canvasBounds = graphCanvas.canvas.getBoundingClientRect();
            const scale = graphCanvas.ds.scale;
            for (const [node, card] of cards) {
                if (!node.graph || node.graph.getNodeById(node.id) !== node) {
                    card.element.remove(); cards.delete(node); continue;
                }
                if (card.element.parentElement !== layer) layer.append(card.element);
                const hidden = node.graph !== graphCanvas.graph || node.flags?.collapsed || node.mode === 2 || node.mode === 4;
                card.element.hidden = !!hidden;
                if (hidden) continue;
                const domNode = container.querySelector(`[data-node-id="${CSS.escape(String(node.id))}"]`);
                const rect = domNode?.getBoundingClientRect();
                const x = rect ? rect.left - bounds.left : canvasBounds.left - bounds.left + (node.pos[0] + graphCanvas.ds.offset[0]) * scale;
                const y = rect ? rect.bottom - bounds.top : canvasBounds.top - bounds.top + (node.pos[1] + node.size[1] + graphCanvas.ds.offset[1]) * scale;
                card.element.style.width = `${node.size[0]}px`;
                card.element.style.transform = `translate(${x}px, ${y + 10 * scale}px) scale(${scale})`;
            }
        }
        requestAnimationFrame(position);
    };
    requestAnimationFrame(position);
}
