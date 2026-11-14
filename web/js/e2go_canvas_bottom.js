// Centre RESULT in the space left beside the right-aligned mask groups, without empty columns when
// no results exist. Measurements are CSS pixels, independent of graph zoom.
export function bottomLayoutMode(width, resultWidth, masksWidth, hasResults) {
    if (!hasResults) return { layout: "mask-only", wrapResults: false };
    return {
        layout: width >= resultWidth + masksWidth + 10 ? "inline" : "stacked",
        wrapResults: resultWidth > width,
    };
}

function rowWidth(row) {
    const children = [...row.children].filter(el => !el.hidden && getComputedStyle(el).display !== "none");
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    return children.reduce((total, el) => total + el.offsetWidth, 0) + Math.max(0, children.length - 1) * gap;
}

export function mountBottomLayout(root, panel, results, controls, maskActions, maskControls, operation = null) {
    let frame = 0;
    let destroyed = false;
    function update() {
        frame = 0;
        if (destroyed || !panel.clientWidth) return;
        const style = getComputedStyle(panel);
        const width = panel.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        // Account for the two divider borders and horizontal group padding.
        const masksWidth = rowWidth(maskActions) + rowWidth(maskControls) + 26;
        const editing = operation && operation.panel.style.display !== "none";
        const mode = bottomLayoutMode(width, rowWidth(editing ? operation.controls : controls), masksWidth, editing || results.style.display !== "none");
        if (panel.dataset.layout !== mode.layout) panel.dataset.layout = mode.layout;
        if (panel.dataset.wrapResults !== String(mode.wrapResults)) panel.dataset.wrapResults = String(mode.wrapResults);
    }
    function refresh() { if (!destroyed && !frame) frame = requestAnimationFrame(update); }
    panel.dataset.layout = "mask-only";
    const observer = new ResizeObserver(refresh);
    for (const el of [root, controls, maskActions, maskControls, ...(operation ? [operation.controls] : [])]) observer.observe(el);
    refresh();
    return { refresh, destroy() { destroyed = true; observer.disconnect(); if (frame) cancelAnimationFrame(frame); } };
}
