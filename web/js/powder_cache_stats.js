import { app } from "../../../scripts/app.js";
import { widgetTextColor } from "./e2go_hide_utils.js";

const NODE_TYPE = "PowderCacheStats";
const LINE_HEIGHT = 16;
const TOP_PADDING = 8;
const BOTTOM_PADDING = 8;

function noop() {}


function buildRollupLine(statsText) {
    let stats;
    try {
        stats = JSON.parse(statsText);
    } catch {
        return null;
    }
    if (!stats || typeof stats !== "object") return null;

    const cond = stats.conditioning_cache || {};
    const loras = stats.lora_raw_cache || {};
    const styles = stats.styles_loaded;

    const parts = [];

    if (cond.size !== undefined && cond.maxsize !== undefined) {
        let hitSuffix = "";
        if (typeof cond.hits === "number" && typeof cond.misses === "number") {
            const total = cond.hits + cond.misses;
            if (total > 0) {
                const pct = Math.round((cond.hits / total) * 100);
                hitSuffix = ` (hit ${pct}%)`;
            }
        }
        parts.push(`cond ${cond.size}/${cond.maxsize}${hitSuffix}`);
    }
    if (loras.size !== undefined && loras.maxsize !== undefined) {
        parts.push(`loras ${loras.size}/${loras.maxsize}`);
    }
    if (typeof styles === "number") {
        parts.push(`styles ${styles}`);
    }

    return parts.length ? parts.join(" · ") : null;
}

// Lazily created offscreen 2D context, used only to measure text width so
// computeSize() and draw() agree on wrapping without either owning a live
// canvas.
let _measureCtx = null;
function getMeasureCtx() {
    if (_measureCtx === null) {
        try {
            _measureCtx = document.createElement("canvas").getContext("2d");
        } catch {
            _measureCtx = undefined; // measurement unavailable — fail open
        }
    }
    return _measureCtx || null;
}

// The rollup line (unlike the raw JSON lines below it) can run past the
// node's drawable width — e.g. "cond 64/64 (hit 100%) ·
// loras 32/32 · styles 999" needs ~420px at 11px monospace vs. the ~320px
// default node width. If it doesn't fit, split it into two lines at the
// " · " boundary nearest the midpoint. Falls back to returning it unsplit
// if there's no separator to split at or measurement isn't available.
function wrapRollupLine(line, maxWidth) {
    const ctx = getMeasureCtx();
    if (!ctx) return [line];
    ctx.font = "11px monospace";
    if (ctx.measureText(line).width <= maxWidth) return [line];

    const sepPositions = [];
    let idx = line.indexOf(" · ");
    while (idx !== -1) {
        sepPositions.push(idx);
        idx = line.indexOf(" · ", idx + 1);
    }
    if (sepPositions.length === 0) return [line];

    const mid = line.length / 2;
    let splitAt = sepPositions[0];
    let bestDist = Math.abs(splitAt - mid);
    for (const pos of sepPositions) {
        const dist = Math.abs(pos - mid);
        if (dist < bestDist) {
            bestDist = dist;
            splitAt = pos;
        }
    }
    return [line.slice(0, splitAt), line.slice(splitAt + 3)]; // +3 skips " · "
}

// Shared by computeSize() and draw() so both agree on the exact line count
// (and therefore height) for the current node width.
function getDisplayLines(node, maxWidth) {
    const rawLines = (node._e2goStatsText || "").split("\n");
    if (rawLines.length === 0) return rawLines;
    const [firstLine, ...restLines] = rawLines;
    const wrapped = wrapRollupLine(firstLine, Math.max(maxWidth - 12, 0));
    return [...wrapped, ...restLines];
}

function requestResize(node) {
    const graphRef = app.graph;
    requestAnimationFrame(() => {
        if (app.graph !== graphRef) return;
        try {
            node.setSize([node.size?.[0] || 360, node.computeSize()[1]]);
        } catch {}
        app.graph?.setDirtyCanvas(true, true);
    });
}

app.registerExtension({
    name: "e2go_nodes.PowderCacheStats",

    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        requestAnimationFrame(() => {
            // PLATFORM GOTCHA: this frontend's workflow-save path IGNORES a
            // widget's `serialize: false` flag — every widget's `.value`
            // still lands positionally in the saved widgets_values array on
            // restore. PowderCacheStats has only this one widget today, so
            // it's harmless, but to stay restore-proof we never let this
            // widget's `.value` carry real state: it's created with "" and
            // stays "" forever. The actual display text lives on the node
            // (node._e2goStatsText, mirroring styler's _sweepProgress
            // pattern) and is read directly by draw()/computeSize() below.
            // No onSerialize/onConfigure machinery needed for a single
            // decoration widget — an inert constant value is sufficient.
            const preview = node.addWidget("text", "stats", "", noop);
            preview.serialize = false;
            preview.disabled = true;
            node._statsPreview = preview;
            node._e2goStatsText = "(no data yet — run the node)";

            preview.computeSize = () => {
                const width = Math.max(node.size?.[0] || 320, 320);
                const lines = getDisplayLines(node, width);
                const height = lines.length * LINE_HEIGHT + TOP_PADDING + BOTTOM_PADDING;
                return [width, height];
            };

            preview.draw = function (ctx, _node, width, posY) {
                const lines = getDisplayLines(node, width);
                ctx.fillStyle = widgetTextColor();
                // monospace kept deliberately: the stats preview is column-aligned.
                ctx.font = "11px monospace";
                ctx.textAlign = "left";
                let y = posY + TOP_PADDING + 10;
                for (const line of lines) {
                    ctx.fillText(line, 6, y);
                    y += LINE_HEIGHT;
                }
                ctx.textAlign = "left";
            };

            const prevOnExecuted = node.onExecuted;
            node.onExecuted = function (message) {
                if (typeof prevOnExecuted === "function") {
                    try { prevOnExecuted.apply(this, arguments); } catch {}
                }
                try {
                    const text = message?.text?.[0];
                    if (typeof text === "string") {
                        const rollup = buildRollupLine(text);
                        node._e2goStatsText = rollup ? `${rollup}\n${text}` : text;
                    }
                    requestResize(node);
                } catch (e) {
                    console.warn("[e2go cache stats] onExecuted:", e);
                }
            };

            requestResize(node);
        });
    },
});
