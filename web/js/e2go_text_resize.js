// Per-field layout heights in graph coordinates (independent of canvas zoom).
export const clampTextHeight = value => Math.max(48, Math.min(2000, Math.round(value)));

export function arrangeTextHandles(node) {
    const handles = node._e2goTextHandles;
    if (!handles) return;
    // Vue nodes read hidden from the widget store, not the canvas isVisible callback.
    for (const [widget, handle] of handles) handle.hidden = !!widget.hidden || !!widget._e2goHide;
    const decorations = new Set(handles.values());
    node.widgets = node.widgets.filter(w => !decorations.has(w)).flatMap(w =>
        handles.has(w) ? [w, handles.get(w)] : [w]);
}

export function installTextResizing(node, matches) {
    if (node._e2goTextHandles) return;
    const handles = node._e2goTextHandles = new Map();
    let heights = {};
    const visible = widget => !widget.hidden && !widget._e2goHide && widget.type !== 'converted-widget';

    for (const widget of [...node.widgets]) {
        if (!matches(widget.name)) continue;
        widget.options ||= {};
        const originalMin = widget.options.getMinHeight;
        const originalMax = widget.options.getMaxHeight;
        const originalHeight = widget.options.getHeight;
        widget.options.getMinHeight = () => heights[widget.name] ?? originalMin?.call(widget.options) ?? 50;
        widget.options.getMaxHeight = () => heights[widget.name] ?? originalMax?.call(widget.options);
        widget.options.getHeight = () => heights[widget.name] ?? originalHeight?.call(widget.options);

        const handle = node.addWidget('text', `resize_${widget.name}`, '', () => {});
        handle.type = 'e2go_text_resize';
        handle.serialize = false;
        handle.tooltip = 'Drag up or down to resize this text field';
        handle.isVisible = () => visible(widget);
        handle.computeSize = () => [node.size?.[0] || 320, visible(widget) ? 12 : -4];
        handle.draw = (ctx, _node, width, y) => {
            if (!visible(widget)) return;
            ctx.save();
            const hover = !!node._isMouseOverWidget?.(handle);
            if (hover) {
                ctx.fillStyle = 'rgba(150, 170, 190, 0.16)';
                ctx.beginPath();
                ctx.roundRect(width / 2 - 22, y + 1, 44, 10, 4);
                ctx.fill();
            }
            ctx.fillStyle = hover ? '#c2d6e5' : '#78818a';
            for (const dx of [-9, -3, 3, 9]) {
                for (const dy of [4, 8]) {
                    ctx.beginPath();
                    ctx.arc(width / 2 + dx, y + dy, 1, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();
        };
        handle.onPointerDown = (pointer, _node, canvas) => {
            if (!visible(widget) || canvas?.read_only) return false;
            const startY = pointer.eDown?.canvasY ?? canvas.graph_mouse[1];
            const initialHeight = heights[widget.name] ?? widget.computedHeight ?? widget.options.getMinHeight();
            const initialNodeHeight = node.size[1];
            const graph = node.graph;
            let changed = false;
            pointer.onDrag = event => {
                if (node.graph !== graph || !visible(widget)) return;
                const y = event.canvasY ?? canvas.graph_mouse[1];
                if (!Number.isFinite(y)) return;
                const height = clampTextHeight(initialHeight + y - startY);
                if (height === (heights[widget.name] ?? initialHeight)) return;
                // CanvasPointer invokes onDrag before onDragStart on the first move.
                if (!changed) { graph?.beforeChange?.(); changed = true; }
                heights[widget.name] = height;
                node.setSize([node.size[0], Math.max(node.computeSize()[1], initialNodeHeight + height - initialHeight)]);
                graph?.setDirtyCanvas(true, true);
            };
            pointer.finally = () => {
                if (changed) graph?.afterChange?.();
                if (canvas) canvas.node_widget = null;
            };
            return true; // Do not turn the grip into a text editor or drag the node.
        };
        handles.set(widget, handle);
    }
    arrangeTextHandles(node);

    const serialize = node.onSerialize;
    node.onSerialize = function (info) {
        serialize?.apply(this, arguments);
        info.e2goTextHeights = { ...heights };
    };
    const configure = node.onConfigure;
    node.onConfigure = function (info) {
        heights = {};
        const saved = info?.e2goTextHeights;
        for (const widget of handles.keys()) {
            const value = saved?.[widget.name];
            if (typeof value === 'number' && Number.isFinite(value)) heights[widget.name] = clampTextHeight(value);
        }
        configure?.apply(this, arguments);
        arrangeTextHandles(this);
    };
}
