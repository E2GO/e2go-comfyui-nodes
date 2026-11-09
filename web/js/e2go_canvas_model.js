// e2go_canvas_model.js — pure canvas/layer state for PowderCanvas.
// No ComfyUI imports; everything here is testable against bare DOM canvases.
//
// Model (Photoshop-style layer stack):
//   state.layers[0]  = background (pixels from the graph preview)
//   state.layers[1+] = paint layers (color-brush strokes / dropped images, RGBA)
//   state.activeLayer = index receiving paint/erase strokes (>= 1)
//   state.mask       = special non-baked layer -> MASK output (white = inpaint)
// Reserved per-layer fields (x/y/rotation/scale/visible/layerMask) are tier-3
// slots — serialized now so stored workflows never need a shape migration.

const UNDO_LIMIT = 20; // full-res canvas snapshots (~10MB each at 2.5MP) — keep bounded
const HISTORY_BYTES = 256 * 1024 * 1024;

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
}

function makeLayer(kind, w, h, name) {
    return {
        kind, // "background" | "paint"
        name: name || null, // user-visible label; stable across reorders/deletes
        canvas: makeCanvas(w, h),
        x: 0, y: 0, rotation: 0, scale: 1,
        visible: true,
        layerMask: null, // tier 3: black/white non-destructive eraser
    };
}

export function createState() {
    return {
        width: 0,
        height: 0,
        layers: [],       // [background, ...paint layers]
        activeLayer: 1,   // index into layers[] receiving paint/erase strokes
        paintSeq: 1,      // next "Paint N" number — never reused, so names stay stable
        mask: null,       // HTMLCanvasElement, white-on-transparent
        undoStack: [],    // {target: "mask"|"p<idx>", canvas}
        redoStack: [],
        dirty: 0,         // bumped on every pixel change; queue hook hashes off this

        paintDirty: 0,
    };
}

// Bump the paint-change marker (see createState.paintDirty). Guarded so old
// state objects (pre-field) still work.
function bumpPaint(state) {
    state.paintDirty = (state.paintDirty || 0) + 1;
}

// --- layer management (Photoshop-style stack; index 0 = background) ---------

export function addPaintLayer(state, name) {
    if (!hasContent(state)) return -1;
    pushUndo(state, "document");
    state.layers.push(makeLayer("paint", state.width, state.height,
        name || `Paint ${state.paintSeq++}`));
    state.activeLayer = state.layers.length - 1;
    state.dirty++;
    bumpPaint(state);
    return state.activeLayer;
}

export function duplicatePaintLayer(state, index) {
    const src = state.layers[index];
    if (!src || index === 0 || !hasContent(state)) return -1;
    const idx = addPaintLayer(state, `${src.name || "Paint"} copy`);
    if (idx < 0) return -1;
    state.layers[idx].visible = src.visible;
    state.layers[idx].canvas.getContext("2d").drawImage(src.canvas, 0, 0);
    state.dirty++;
    bumpPaint(state);
    return idx;
}

// Copy the background's pixels into a NEW paint layer on top — lets the user
// erase through a generated result to the original, or transform a copy of
// the base without touching layers[0] (which stays the fixed canvas).
export function duplicateBackgroundAsLayer(state) {
    const bg = state.layers[0];
    if (!bg || !bg.canvas || !hasContent(state)) return -1;
    const idx = addPaintLayer(state, "Background copy");
    if (idx < 0) return -1;
    state.layers[idx].canvas.getContext("2d").drawImage(bg.canvas, 0, 0);
    state.dirty++;
    bumpPaint(state);
    return idx;
}

// Cheap "is anything painted on the mask" probe: downscale to 64x64 and scan
// alpha — full-res getImageData at 2.5MP is too slow for a context-menu open.
export function maskHasContent(state) {
    if (!state.mask) return false;
    const probe = makeCanvas(64, 64);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(state.mask, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
}

// Cheap "does this paint layer have any pixels" probe (same 64x64 downscale
// trick as maskHasContent) — lets the UI tell the user whether a Clear P
// actually removed anything or hit an already-empty layer.
export function paintLayerHasContent(state, index) {
    const layer = state.layers[index];
    if (!layer || !layer.canvas) return false;
    const probe = makeCanvas(64, 64);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(layer.canvas, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
}

export function renameLayer(state, index, name) {
    const layer = state.layers[index];
    if (!layer || index === 0) return false;
    const trimmed = String(name || "").trim();
    if (!trimmed) return false;
    layer.name = trimmed.slice(0, 40);
    state.dirty++;
    bumpPaint(state);
    return true;
}

export function removePaintLayer(state, index) {
    // Background (0) is fixed; keep at least one paint layer.
    const paintCount = state.layers.length - 1;
    if (index <= 0 || index >= state.layers.length || paintCount <= 1) return false;
    pushUndo(state, "document");
    state.layers.splice(index, 1);
    // Splice shifts everything above `index` down by one — keep activeLayer
    // pointing at the same layer (or its replacement when it was the one removed).
    if (state.activeLayer > index) state.activeLayer--;
    if (state.activeLayer >= state.layers.length) state.activeLayer = state.layers.length - 1;
    state.dirty++;
    bumpPaint(state);
    return true;
}

// Load an image file as a new paint layer: scaled to fit (never upscaled),
// centered. Pixels persist via the normal layer serialization.
export function addImageLayer(state, img) {
    const idx = addPaintLayer(state);
    if (idx < 0) return -1;
    const ctx = state.layers[idx].canvas.getContext("2d");
    const k = Math.min(state.width / img.width, state.height / img.height, 1);
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    ctx.drawImage(img, Math.round((state.width - w) / 2), Math.round((state.height - h) / 2), w, h);
    state.dirty++;
    bumpPaint(state);
    return idx;
}

export function setLayerVisible(state, index, visible) {
    const layer = state.layers[index];
    if (!layer) return;
    layer.visible = !!visible;
    state.dirty++;
    bumpPaint(state);
}

export function hasContent(state) {
    return state.width > 0 && state.height > 0;
}


export function canvasIsPristine(state) {
    if (!hasContent(state)) return true;
    if (maskHasContent(state)) return false;
    for (let i = 1; i < state.layers.length; i++) {
        if (paintLayerHasContent(state, i)) return false;
    }
    return true;
}

// Full reset back to the empty-canvas state (remove-image button): nothing
// serializes afterwards, so a saved workflow reloads empty too.
export function resetState(state, { undoable = false } = {}) {
    if (undoable) pushUndo(state, "document");
    state.width = 0;
    state.height = 0;
    state.layers = [];
    state.activeLayer = 1;
    state.paintSeq = 1;
    state.mask = null;
    if (!undoable) {
        state.undoStack.length = 0;
        state.redoStack.length = 0;
    }
    state.dirty++;
    bumpPaint(state);
}

/**
 * Contain geometry: the whole image inside width x height, aspect preserved,
 * centered. Exported so the UI can tell whether a drop will letterbox before
 * it says so in the status line.
 */
export function containBox(imgW, imgH, width, height) {
    const scale = Math.min(width / imgW, height / imgH);
    const w = Math.max(1, Math.round(imgW * scale));
    const h = Math.max(1, Math.round(imgH * scale));
    return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}


export function setBackground(state, img, width, height, { fit = false, undoable = false, preserveAlpha = false } = {}) {
    if (undoable) pushUndo(state, "document");
    const sameSize = state.width === width && state.height === height;
    if (!sameSize || !state.layers.length) {

        const hadContent = state.layers.length > 0;
        state.width = width;
        state.height = height;
        state.layers = [makeLayer("background", width, height), makeLayer("paint", width, height, "Paint 1")];
        state.activeLayer = 1;
        state.paintSeq = 2;
        state.mask = makeCanvas(width, height);
        if (hadContent && !undoable) {
            state.undoStack.length = 0;
            state.redoStack.length = 0;
        }
        bumpPaint(state); // paint stack was rebuilt (resolution changed)
    }
    state.bgPending = false;
    const bg = state.layers[0].canvas.getContext("2d");
    bg.clearRect(0, 0, width, height);
    if (fit) {
        // Black, not transparent: the margins ARE canvas content from here on
        // (the server bakes the composite over black anyway, and expandCanvas
        // fills its new area the same way) — so what the editor shows is what
        // the model will be handed.
        if (!preserveAlpha) {
            bg.fillStyle = "#000";
            bg.fillRect(0, 0, width, height);
        }
        const b = containBox(
            img.naturalWidth || img.width, img.naturalHeight || img.height, width, height);
        bg.drawImage(img, b.x, b.y, b.w, b.h);
    } else {
        bg.drawImage(img, 0, 0, width, height);
    }
    state.dirty++;
}

// Outpainting: grow the canvas by per-side margins. Background and layers
// shift by (left, top); the background's new area is black (matches the
// server's empty placeholder); the mask gets WHITE over the new area plus
// `overlap` px of bleed into the old picture so the seam regenerates too.
// A document snapshot preserves dimensions, layers and mask for undo.
export function expandCanvas(state, { left = 0, top = 0, right = 0, bottom = 0, overlap = 32 } = {}) {
    if (!hasContent(state)) return false;
    const L = Math.max(0, Math.round(left)), T = Math.max(0, Math.round(top));
    const R = Math.max(0, Math.round(right)), B = Math.max(0, Math.round(bottom));
    if (!(L || T || R || B)) return false;
    pushUndo(state, "document");
    const W = state.width + L + R, H = state.height + T + B;
    for (const [i, layer] of state.layers.entries()) {
        const c = makeCanvas(W, H);
        const ctx = c.getContext("2d");
        if (i === 0) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, W, H);
        }
        if (layer.canvas) ctx.drawImage(layer.canvas, L, T);
        layer.canvas = c;
    }
    const mask = makeCanvas(W, H);
    const mctx = mask.getContext("2d");
    if (state.mask) mctx.drawImage(state.mask, L, T);
    const ov = Math.max(0, overlap);
    mctx.fillStyle = "#fff";
    if (L) mctx.fillRect(0, 0, L + ov, H);
    if (T) mctx.fillRect(0, 0, W, T + ov);
    if (R) mctx.fillRect(W - R - ov, 0, R + ov, H);
    if (B) mctx.fillRect(0, H - B - ov, W, B + ov);
    state.mask = mask;
    state.width = W;
    state.height = H;
    state.dirty++;
    bumpPaint(state);
    return true;
}

export function bakeComposite(state) {
    const out = makeCanvas(state.width, state.height);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, state.width, state.height);
    for (const layer of state.layers) {
        if (layer.visible) ctx.drawImage(layer.canvas, 0, 0);
    }
    return out;
}

export function exportMaskCanvas(state) {
    const out = makeCanvas(state.width, state.height);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, state.width, state.height);
    // Mask alpha carries the value; drawing white-on-transparent over black
    // yields the grayscale PNG the backend reads (white = inpaint).
    ctx.drawImage(state.mask, 0, 0);
    return out;
}

// --- painting ----------------------------------------------------------------

// Stroke/undo targets: "mask", "paint" (= the ACTIVE paint layer at call
// time) or "p<idx>" (a specific layer — used by undo snapshots so history
// stays correct after the user switches layers).
function resolveTarget(state, target) {
    if (target === "mask") return "mask";
    if (target === "paint") return `p${state.activeLayer}`;
    return target;
}

function targetCanvas(state, target) {
    target = resolveTarget(state, target);
    if (target === "mask") return state.mask;
    const idx = parseInt(target.slice(1), 10);
    return state.layers[idx]?.canvas;
}

// One brush stamp: radial-gradient dab (feather 0..1 = soft fraction of radius).
function dab(ctx, x, y, r, feather, color, alpha) {
    const hard = Math.max(0.01, 1 - feather);
    const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, color.replace(/rgba?\(([^)]+?)(?:,\s*[\d.]+)?\)/, "rgba($1,0)"));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = feather > 0 ? g : color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
}

function toRgba(hexOrRgb) {
    if (hexOrRgb.startsWith("#")) {
        let hex = hexOrRgb.slice(1);
        // Expand 3-digit shorthand (#abc -> #aabbcc) before parsing
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        const n = parseInt(hex, 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 1)`;
    }
    return hexOrRgb;
}

export function brushStroke(state, target, pts, { size, feather = 0, color = "#ffffff", opacity = 1, erase = false } = {}) {
    const canvas = targetCanvas(state, target);
    if (!canvas || !pts.length) return;
    const paintTarget = resolveTarget(state, target) !== "mask";
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    const col = target === "mask" ? "rgba(255,255,255,1)" : toRgba(color);
    const r = Math.max(0.5, size / 2);
    // Stamp along the polyline at ~1/4 radius spacing for a continuous stroke.
    const step = Math.max(1, r / 4);
    let prev = pts[0];
    dab(ctx, prev.x, prev.y, r, feather, col, opacity);
    for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
        const n = Math.ceil(dist / step);
        for (let k = 1; k <= n; k++) {
            dab(ctx, prev.x + ((p.x - prev.x) * k) / n, prev.y + ((p.y - prev.y) * k) / n, r, feather, col, opacity);
        }
        prev = p;
    }
    ctx.restore();
    state.dirty++;
    if (paintTarget) bumpPaint(state);
}

// Bucket tool: 4-neighbor flood fill from (x, y) on the target canvas.
// Tolerance is a per-channel (RGBA) max difference against the seed pixel —
// alpha included, so an empty layer floods entirely (paint-from-scratch) and
// painted blobs act as borders. Fill lands fully opaque. Caller pushUndo()s
// BEFORE calling. Returns false when the click is outside the canvas.
export function floodFill(state, target, x, y, color, tolerance = 32) {
    const canvas = targetCanvas(state, target);
    if (!canvas) return false;
    const w = canvas.width, h = canvas.height;
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    let hex = String(color).replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16) || 0;
    const fr = (n >> 16) & 255, fg = (n >> 8) & 255, fb = n & 255;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const seed = (y * w + x) * 4;
    const sr = d[seed], sg = d[seed + 1], sb = d[seed + 2], sa = d[seed + 3];
    const match = (i) => Math.abs(d[i] - sr) <= tolerance && Math.abs(d[i + 1] - sg) <= tolerance
        && Math.abs(d[i + 2] - sb) <= tolerance && Math.abs(d[i + 3] - sa) <= tolerance;
    const visited = new Uint8Array(w * h);
    const stack = [y * w + x];
    visited[y * w + x] = 1;
    while (stack.length) {
        const px = stack.pop();
        const i = px * 4;
        d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
        const cx = px % w;
        for (const np of [px - 1, px + 1, px - w, px + w]) {
            if (np < 0 || np >= w * h || visited[np]) continue;
            const nx = np % w;
            if (Math.abs(nx - cx) > 1) continue; // row wrap on the left/right neighbor
            if (!match(np * 4)) continue;
            visited[np] = 1;
            stack.push(np);
        }
    }
    ctx.putImageData(id, 0, 0);
    state.dirty++;
    if (resolveTarget(state, target) !== "mask") bumpPaint(state);
    return true;
}

export function samplePixel(state, x, y) {
    // Eyedropper source: the baked view (what the user sees, minus mask tint).
    const baked = bakeComposite(state);
    const d = baked.getContext("2d").getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return `#${((d[0] << 16) | (d[1] << 8) | d[2]).toString(16).padStart(6, "0")}`;
}

// --- undo --------------------------------------------------------------------

export function pushUndo(state, target) {
    if (target === "document") {
        state.undoStack.push({ target, document: snapshotDocument(state) });
        state.redoStack.length = 0;
        trimHistory(state.undoStack);
        return;
    }
    target = resolveTarget(state, target);
    const canvas = targetCanvas(state, target);
    if (!canvas) return;
    // drawImage snapshot: a GPU-side copy (~1ms) instead of the synchronous
    // toDataURL PNG encode (~100-300ms at 2.5MP) that froze every stroke start.
    const snap = makeCanvas(canvas.width, canvas.height);
    snap.getContext("2d").drawImage(canvas, 0, 0);
    state.undoStack.push({ target, canvas: snap });
    state.redoStack.length = 0;
    trimHistory(state.undoStack);
}

function trimHistory(stack) {
    const bytes = entry => {
        const canvases = entry.document
            ? [...entry.document.layers.map(layer => layer.canvas), entry.document.mask]
            : [entry.canvas];
        return canvases.reduce((total, canvas) => total + (canvas ? canvas.width * canvas.height * 4 : 0), 0);
    };
    let total = stack.reduce((sum, entry) => sum + bytes(entry), 0);
    while (stack.length > 1 && (stack.length > UNDO_LIMIT || total > HISTORY_BYTES)) total -= bytes(stack.shift());
}

function copyCanvas(canvas) {
    if (!canvas) return null;
    const copy = makeCanvas(canvas.width, canvas.height);
    copy.getContext("2d").drawImage(canvas, 0, 0);
    return copy;
}

function snapshotDocument(state) {
    return {
        width: state.width, height: state.height, bgPending: state.bgPending,
        activeLayer: state.activeLayer, paintSeq: state.paintSeq,
        layers: state.layers.map(layer => ({ ...layer, canvas: copyCanvas(layer.canvas) })),
        mask: copyCanvas(state.mask),
    };
}

function loadInto(canvas, dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            resolve();
        };
        img.onerror = reject;
        img.src = dataUrl;
    });
}

async function shiftBetween(state, fromStack, toStack) {
    const entry = fromStack.pop();
    if (!entry) return false;
    if (entry.target === "document") {
        toStack.push({ target: "document", document: snapshotDocument(state) });
        trimHistory(toStack);
        Object.assign(state, entry.document);
        state._layerFiles = [];
        state.dirty++;
        bumpPaint(state);
        return true;
    }
    const canvas = targetCanvas(state, entry.target);
    if (!canvas) return false;
    const snap = makeCanvas(canvas.width, canvas.height);
    snap.getContext("2d").drawImage(canvas, 0, 0);
    toStack.push({ target: entry.target, canvas: snap });
    trimHistory(toStack);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(entry.canvas, 0, 0);
    state.dirty++;
    if (entry.target !== "mask") bumpPaint(state); // paint layer restored
    return true;
}

export function undo(state) { return shiftBetween(state, state.undoStack, state.redoStack); }
export function redo(state) { return shiftBetween(state, state.redoStack, state.undoStack); }

// --- mask post-ops ------------------------------------------------------------

export function maskInvert(state) {
    if (!state.mask) return;
    const inv = makeCanvas(state.width, state.height);
    const ctx = inv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, state.width, state.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(state.mask, 0, 0);
    const m = state.mask.getContext("2d");
    m.clearRect(0, 0, state.width, state.height);
    m.drawImage(inv, 0, 0);
    state.dirty++;
}

export function maskBlur(state, px) {
    if (!state.mask || px <= 0) return;
    const tmp = makeCanvas(state.width, state.height);
    const ctx = tmp.getContext("2d");
    ctx.filter = `blur(${px}px)`;
    ctx.drawImage(state.mask, 0, 0);
    const m = state.mask.getContext("2d");
    m.clearRect(0, 0, state.width, state.height);
    m.drawImage(tmp, 0, 0);
    state.dirty++;
}

export function maskGrow(state, px) {
    if (!state.mask || !px) return;
    const shrink = px < 0;
    const amount = Math.abs(px);
    if (shrink) {
        // shrink = invert -> grow -> invert
        maskInvert(state);
        maskGrow(state, amount);
        maskInvert(state);
        return;
    }
    const tmp = makeCanvas(state.width, state.height);
    const ctx = tmp.getContext("2d");
    ctx.filter = `blur(${amount}px)`;
    ctx.drawImage(state.mask, 0, 0);
    // Threshold the blurred alpha so grow stays a hard expansion.
    const id = ctx.getImageData(0, 0, state.width, state.height);
    const d = id.data;
    for (let i = 3; i < d.length; i += 4) {
        const on = d[i] > 24;
        d[i] = on ? 255 : 0;
        if (on) { d[i - 3] = 255; d[i - 2] = 255; d[i - 1] = 255; }
    }
    ctx.putImageData(id, 0, 0);
    const m = state.mask.getContext("2d");
    m.clearRect(0, 0, state.width, state.height);
    m.drawImage(tmp, 0, 0);
    state.dirty++;
}

export function clearLayer(state, target) {
    const canvas = targetCanvas(state, target);
    if (!canvas) return;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    state.dirty++;
    if (resolveTarget(state, target) !== "mask") bumpPaint(state);
}


// setTransform args for: rotate+scale around (cx, cy), then shift by (dx, dy).
export function xformMatrix({ cx, cy, dx, dy, scale, angle }) {
    const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
    return {
        a: c, b: s, c: -s, d: c,
        e: cx + dx - c * cx + s * cy,
        f: cy + dy - s * cx - c * cy,
    };
}

// Bbox of alpha>0 pixels in an RGBA buffer; null when fully transparent.
export function bboxFromAlpha(data, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3]) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Bbox of the painted content. Full-res getImageData runs ONCE per tool entry
// (not per frame) — acceptable even at 2.5MP; the 64x64 probe pattern used by
// maskHasContent is not enough here (we need exact pixels for the frame).
export function contentBBox(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return bboxFromAlpha(id.data, canvas.width, canvas.height);
}

// Bake a move/rotate/scale into the target's pixels (PS Free Transform commit).
// Snapshot -> clear -> redraw through the matrix; the part pushed off the
// canvas is clipped (PS semantics). Caller pushUndo()s BEFORE calling.
export function bakeTransform(state, target, t) {
    if (!t.dx && !t.dy && t.scale === 1 && !t.angle) return; // identity: no-op
    const canvas = targetCanvas(state, target);
    if (!canvas) return;
    const snap = makeCanvas(canvas.width, canvas.height);
    snap.getContext("2d").drawImage(canvas, 0, 0);
    const ctx = canvas.getContext("2d");
    const m = xformMatrix(t);
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(snap, 0, 0);
    ctx.restore();
    state.dirty++;
    if (resolveTarget(state, target) !== "mask") bumpPaint(state);
}

// --- persistence (workflow save/restore; bg comes back from the next Queue) --

export function serializeState(state) {
    if (!hasContent(state)) return null;

    const files = Array.isArray(state._layerFiles) ? state._layerFiles : [];
    return {
        width: state.width,
        height: state.height,
        paintLayers: files.map((f) => ({
            file: f.file,
            visible: f.visible !== false,
            name: f.name || null,
        })),
        activeLayer: state.activeLayer,
        paintSeq: state.paintSeq,
        rememberMask: !!state.rememberMask,
        maskFile: state.rememberMask ? state._maskFile || null : null,
        // Old workflows remain unmasked unless persistence was opted into.
    };
}

export async function restoreState(state, data) {
    if (!data || !data.width || !data.height) return;
    state.width = data.width;
    state.height = data.height;
    // Fresh mask BEFORE any await: redraws fired mid-restore (ResizeObserver
    // during a workflow-tab switch) must never see width>0 with mask=null —
    // drawImage(null) throws inside redraw's save/restore and permanently
    // corrupts the display context (cursor/ring offset until a backing reset).
    state.mask = makeCanvas(data.width, data.height);
    state.rememberMask = !!data.rememberMask;
    state._maskFile = data.rememberMask ? data.maskFile || null : null;
    state.layers = [makeLayer("background", data.width, data.height)];
    // The background itself is never saved — it comes back from the recovery
    // file or from the graph. Until one lands, the layer is blank and must
    // not be baked into a composite (see powder_canvas.js prepareNode).
    state.bgPending = true;
    const stack = Array.isArray(data.paintLayers) && data.paintLayers.length
        ? data.paintLayers
        : [{ dataUrl: data.paintDataUrl || null, visible: true }]; // legacy saves
    for (const [i, entry] of stack.entries()) {
        // Legacy saves have no names — fall back to positional numbering.
        const layer = makeLayer("paint", data.width, data.height, entry.name || `Paint ${i + 1}`);
        layer.visible = entry.visible !== false;
        state.layers.push(layer);
        if (entry.dataUrl) await loadInto(layer.canvas, entry.dataUrl);
    }
    state.activeLayer = Math.min(
        Math.max(1, data.activeLayer ?? 1), state.layers.length - 1);
    state.paintSeq = Math.max(data.paintSeq || 1, state.layers.length);
    if (state.rememberMask && data.maskDataUrl) await loadInto(state.mask, data.maskDataUrl);
    state.dirty++;
    bumpPaint(state);
}
