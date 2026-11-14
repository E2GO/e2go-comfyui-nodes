const DEFAULT_WIDTH = 216;
const MAX_WIDTH = 520;
const PROPERTY = "powderCanvasSidebarWidth";

export function sidebarWidth(requested, available) {
    const max = Math.max(DEFAULT_WIDTH, Math.min(MAX_WIDTH, available - 360));
    const width = Number.isFinite(Number(requested)) ? Number(requested) : DEFAULT_WIDTH;
    return Math.round(Math.max(DEFAULT_WIDTH, Math.min(max, width)));
}

export function mountSidebarResize(node, root, mid, side) {
    const grip = document.createElement("div");
    grip.className = "e2go-cv-side-resizer";
    grip.tabIndex = 0;
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-label", "Resize layers panel");
    grip.setAttribute("aria-orientation", "vertical");
    grip.title = "Drag to resize layers panel. Double-click to reset. Arrow keys adjust width.";
    mid.insertBefore(grip, side);
    let desired = Number(node.properties?.[PROPERTY]) || DEFAULT_WIDTH;
    let drag = null;
    function apply() {
        const width = sidebarWidth(desired, root.clientWidth);
        root.style.setProperty("--e2go-side-width", `${width}px`);
        grip.setAttribute("aria-valuemin", String(DEFAULT_WIDTH));
        grip.setAttribute("aria-valuemax", String(sidebarWidth(MAX_WIDTH, root.clientWidth)));
        grip.setAttribute("aria-valuenow", String(width));
    }
    function persist() {
        node.properties ||= {};
        node.properties[PROPERTY] = desired;
        node.graph?.change?.();
    }
    function finish(e) {
        if (!drag) return;
        drag = null;
        grip.classList.remove("dragging");
        if (e && grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
        persist();
    }
    grip.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const scale = root.getBoundingClientRect().width / (root.clientWidth || 1);
        drag = { x: e.clientX, width: side.offsetWidth, scale: scale || 1 };
        grip.setPointerCapture(e.pointerId);
        grip.classList.add("dragging");
    });
    grip.addEventListener("pointermove", e => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        desired = sidebarWidth(drag.width + (drag.x - e.clientX) / drag.scale, root.clientWidth);
        apply();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(event, finish);
    grip.addEventListener("dblclick", e => {
        e.preventDefault(); e.stopPropagation(); desired = DEFAULT_WIDTH; apply(); persist();
    });
    grip.addEventListener("keydown", e => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        desired = e.key === "Home" ? DEFAULT_WIDTH : sidebarWidth(side.offsetWidth + (e.key === "ArrowLeft" ? 10 : -10), root.clientWidth);
        apply(); persist();
    });
    // Keep the user's preferred width across temporary narrow/expanded layouts.
    const observer = new ResizeObserver(() => {
        if (!drag) desired = Number(node.properties?.[PROPERTY]) || desired;
        apply();
    });
    observer.observe(root);
    apply();
    return { destroy() { drag = null; observer.disconnect(); grip.remove(); } };
}
