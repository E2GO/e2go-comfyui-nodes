import { app } from "../../../scripts/app.js";

const NODE_TYPE = "PowderPromptWildcard";
const SENTINEL = "(none)";
const POSITIVE_WIDGET = "positive_text";
const MAX_FILE_BYTES = 1_048_576;

function noop() {}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
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

function markSeparator(widget, title, node) {
    widget.disabled = true;
    widget.computeSize = () => [Math.max(node.size?.[0] || 320, 320), 24];
    widget.draw = function (ctx, _node, width, posY) {
        ctx.fillStyle = "#aaaaaa";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.fillText(title, width / 2, posY + 16);
        ctx.textAlign = "left";
    };
}

function makeDisplay(rec) {
    return `[${rec.source}] ${rec.name}`;
}

async function fetchList(node) {
    try {
        const resp = await fetch("/e2go/wildcards/list");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const files = Array.isArray(data?.files) ? data.files : [];
        node._wildcardRecords = files;
        const combo = node._wildcardCombo;
        if (combo) {
            combo.options.values = [SENTINEL, ...files.map(makeDisplay)];
            combo.value = SENTINEL;
            app.graph?.setDirtyCanvas(true, true);
        }
    } catch (e) {
        console.warn("[e2go wildcard] list failed:", e);
    }
}

function confirmReplaceIfNeeded(node) {
    const w = findWidget(node, POSITIVE_WIDGET);
    if (!w) return true;
    const cur = typeof w.value === "string" ? w.value.trim() : "";
    if (!cur) return true;
    return window.confirm("Replace current prompts? Current content will be lost.");
}

function setPositive(node, content) {
    const w = findWidget(node, POSITIVE_WIDGET);
    if (!w) return;
    w.value = content;
    if (typeof w.callback === "function") {
        try { w.callback(content); } catch {}
    }
    app.graph?.setDirtyCanvas(true, true);
}

async function loadFromCombo(node, display) {
    if (!display || display === SENTINEL) return;
    const records = node._wildcardRecords || [];
    const rec = records.find((r) => makeDisplay(r) === display);
    if (!rec) {
        console.warn("[e2go wildcard] unknown selection:", display);
        if (node._wildcardCombo) node._wildcardCombo.value = SENTINEL;
        return;
    }
    if (!confirmReplaceIfNeeded(node)) {
        if (node._wildcardCombo) node._wildcardCombo.value = SENTINEL;
        return;
    }
    try {
        const url = `/e2go/wildcards/get?source=${encodeURIComponent(rec.source)}&name=${encodeURIComponent(rec.name)}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
            throw new Error(err.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        setPositive(node, data?.content ?? "");
    } catch (e) {
        window.alert(`Load failed: ${e.message || e}`);
    } finally {
        if (node._wildcardCombo) node._wildcardCombo.value = SENTINEL;
    }
}

function pickAndUpload(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
        try {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > MAX_FILE_BYTES) {
                window.alert("File too large (>1 MiB).");
                return;
            }
            const text = await file.text();
            if (!confirmReplaceIfNeeded(node)) return;
            const resp = await fetch("/e2go/wildcards/upload", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: file.name, content: text }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
                throw new Error(err.error || `HTTP ${resp.status}`);
            }
            setPositive(node, text);
            await fetchList(node);
        } catch (e) {
            window.alert(`Upload failed: ${e.message || e}`);
        } finally {
            try { document.body.removeChild(input); } catch {}
        }
    }, { once: true });
    input.click();
}

app.registerExtension({
    name: "e2go_nodes.PowderPromptWildcard",

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        requestAnimationFrame(() => {
            const separator = node.addWidget("text", "", "", noop);
            separator.name = "e2go.wildcard.separator";
            separator.serialize = false;
            markSeparator(separator, "═══════ Wildcard ═══════", node);

            const combo = node.addWidget(
                "combo",
                "Wildcard file",
                SENTINEL,
                (value) => loadFromCombo(node, value),
                { values: [SENTINEL] },
            );
            combo.name = "e2go.wildcard.combo";
            combo.serialize = false;
            node._wildcardCombo = combo;

            const upload = node.addWidget(
                "button",
                "+ Load file...",
                null,
                () => pickAndUpload(node),
            );
            upload.name = "e2go.wildcard.upload";
            upload.serialize = false;

            fetchList(node);
            requestResize(node);
        });
    },
});
