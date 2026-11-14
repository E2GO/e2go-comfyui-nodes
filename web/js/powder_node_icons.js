import { app } from "../../../scripts/app.js";

// Approved header symbols. Coordinates are 24x24; titles remain plain text in workflows.
export const NODE_ICONS = {
    "PowderCanvas": "M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a3 3 0 0 0 3-3c0-4-5-7-9-7ZM7 8h.01M12 6h.01M17 8h.01M5 13h.01",
    "PowderCanvasReview": "M2 2h13v12H2ZM2 11l4-4 4 4 2-2 3 3M11 5h.01M12 19s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3ZM17 18a1 1 0 1 0 0 2 1 1 0 0 0 0-2",
    "PowderReferences": "M7 3h14v14H7ZM3 7v14h14M7 13l4-4 4 4 2-2 4 4",
    "PowderResolution": "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8Z",
    "PowderImageConditioning": "M2 2h13v12H2ZM2 11l4-4 4 4 2-2 3 3M11 5h.01M18 12v2m0 8v-2M13 17h2m6 0h2M14.5 13.5l1.4 1.4m4.2 4.2 1.4 1.4M14.5 20.5l1.4-1.4m4.2-4.2 1.4-1.4M18 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "PowderSampler": "M4 5h16M4 12h16M4 19h16M8 2v6M16 9v6M10 16v6",
    "PowderInpaintSamplerSelect": "M2 2h13v12H2ZM2 11l4-4 4 4 2-2 3 3M11 5h.01M13 19l6-6a2 2 0 0 1 3 3l-6 6a2 2 0 0 1-3-3ZM15 17l3 3M17 15l3 3M17.5 17.5h.01",
    "PowderLoraLoader": "M3 4h7v6H3Zm0 10h7v6H3ZM10 7h4v10h-4M14 12h7m-3-3 3 3-3 3",
    "PowderPromptList": "M3 5h2m3 0h13M3 12h2m3 0h13M3 19h2m3 0h13",
    "PowderPromptWildcard": "M3 2h12l6 6v14H3ZM15 2v6h6M6 11h1m3 0h8M6 15h1m3 0h8M6 19h1m3 0h8",
    "PowderStyler": "M3 17c0-3 3-4 5-2l2 2c-1 3-5 3-8 2ZM7 15 16 4l3 3L10 17M18 13l1.1 3.4L22.5 17.5l-3.4 1.1L18 22l-1.1-3.4-3.4-1.1 3.4-1.1Z",
    "PowderConditioner": "M12 5a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 2V5Zm0 0a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 2M6 4v3l2 2M3 10h3l2 3M4 17h3l1-2M18 4v3l-2 2M21 10h-3l-2 3M20 17h-3l-1-2",
    "PowderEnhancerContext": "M2 6h13v12H7l-5 4ZM5 10h7M5 14h5M20 2v6M17 5h6",
    "PowderSwitcher": "M3 12h6l7-7h5M9 12l7 7h5M18 2l3 3-3 3M18 16l3 3-3 3",
    "PowderGridSaver": "M2 2h14v14H2ZM9 2v14M2 9h14M20 10v11m-3-3 3 3 3-3M3 21h11",
    "ClearConditioningCache": "M3 5h12v5H3Zm0 9h9v5H3ZM6 7.5h.01M6 16.5h.01M15 15l7 7M22 15l-7 7",
    "PowderCacheStats": "M3 3v18h19M7 17v-5M12 17V7M17 17V4"
};

export function drawNodeIconTitle(ctx, height, size, scale, font, selected, path) {
    const LG = globalThis.LiteGraph || {};
    const iconSize = 24;
    const gap = 6;
    const titleX = height + iconSize + gap;
    ctx.save();
    try {
        const color = selected ? (LG.NODE_SELECTED_TITLE_COLOR || "#fff")
            : (this.constructor.title_text_color || app.canvas?.node_title_color || LG.NODE_TITLE_COLOR || "#ddd");
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.save();
        ctx.translate(height, -(height + iconSize) / 2);
        ctx.stroke(path);
        ctx.restore();
        ctx.font = font || this.titleFontStyle || "14px Arial";
        ctx.fillStyle = color;
        ctx.textAlign = "left";
        let available = Math.max(0, size[0] - titleX - height);
        for (const button of this.title_buttons || []) {
            if (button.visible) available = Math.max(0, available - button.getWidth(ctx) - 2);
        }
        ctx.font = font || this.titleFontStyle || "14px Arial";
        let title = String(this.getTitle?.() ?? this.title ?? this.type ?? "");
        if (this.pinned) title += " 📌";
        if (ctx.measureText(title).width > available) {
            while (title && ctx.measureText(title + "…").width > available) title = title.slice(0, -1);
            title = title ? title + "…" : "";
        }
        ctx.fillText(title, titleX, (LG.NODE_TITLE_TEXT_Y ?? 20) - height);
    } finally {
        ctx.restore();
    }
}

// Nodes 2.0 renders HTML headers and does not invoke LiteGraph title draw hooks.
export function decorateVueNodeTitles(root, graph) {
    if (!graph) return;
    for (const header of root.querySelectorAll('.lg-node-header[data-testid]')) {
        const host = header.closest('[data-node-id]');
        const id = host?.getAttribute('data-node-id')
            ?? header.getAttribute('data-testid')?.replace(/^node-header-/, '');
        const node = graph.getNodeById?.(id) ?? graph.getNodeById?.(Number(id));
        const path = NODE_ICONS[node?.comfyClass || node?.type];
        const title = header.querySelector('[data-testid="node-title"]');
        if (!title) continue;
        if (!path) {
            title.classList.remove('powder-node-title-icon');
            title.style.removeProperty('--powder-node-title-icon');
            continue;
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
        title.style.setProperty('--powder-node-title-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
        title.classList.add('powder-node-title-icon');
    }
}

let vueObserver;
let vueFrame = 0;
function refreshVueTitles() {
    if (vueFrame) return;
    vueFrame = requestAnimationFrame(() => {
        vueFrame = 0;
        decorateVueNodeTitles(document, app.canvas?.graph || app.graph);
    });
}
function setupVueTitles() {
    if (vueObserver) return;
    const style = document.createElement('style');
    style.id = 'powder-node-title-icons';
    style.textContent = '.lg-node-header .powder-node-title-icon::before{content:"";display:block;width:24px;height:24px;flex:0 0 24px;background:currentColor;mask:var(--powder-node-title-icon) center/contain no-repeat;pointer-events:none}';
    document.head.appendChild(style);
    vueObserver = new MutationObserver(refreshVueTitles);
    vueObserver.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['data-node-id','data-testid'] });
    refreshVueTitles();
    window.addEventListener('pagehide', () => {
        vueObserver?.disconnect();
        if (vueFrame) cancelAnimationFrame(vueFrame);
        vueFrame = 0;
    }, { once:true });
}

app.registerExtension({
    name: "powder.NodeTitleIcons",
    setup: setupVueTitles,
    afterConfigureGraph: refreshVueTitles,
    beforeRegisterNodeDef(nodeType, nodeData) {
        const data = NODE_ICONS[nodeData.name];
        if (!data) return;
        const path = new Path2D(data);
        nodeType.prototype.onDrawTitleText = function (ctx, height, size, scale, font, selected) {
            drawNodeIconTitle.call(this, ctx, height, size, scale, font, selected, path);
        };
    },
});
