export const CANVAS_MIN_WIDTH = 960;
export const CANVAS_MIN_HEIGHT = 900;
export const CANVAS_EDITOR_MIN_HEIGHT = 680;

export function clampCanvasSize(size) {
    return [Math.max(CANVAS_MIN_WIDTH, Number(size?.[0]) || 0), Math.max(CANVAS_MIN_HEIGHT, Number(size?.[1]) || 0)];
}

export function installCanvasMinimumSize(node) {
    const setSize = node.setSize;
    node.setSize = function (size, ...args) { return setSize.call(this, clampCanvasSize(size), ...args); };
    const computeSize = node.computeSize;
    if (computeSize) node.computeSize = function (...args) { return clampCanvasSize(computeSize.apply(this, args)); };
    const onResize = node.onResize;
    node.onResize = function (size, ...args) {
        const min = clampCanvasSize(size);
        size[0] = min[0]; size[1] = min[1];
        const result = onResize?.call(this, size, ...args);
        if (this.size[0] < min[0] || this.size[1] < min[1]) this.setSize(min);
        return result;
    };
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = onConfigure?.apply(this, args);
        this.setSize(this.size);
        return result;
    };
    node.setSize(node.size);
}
