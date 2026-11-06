import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// Native DOM controls give Classic and Nodes 2.0 the same readable layout,
// keyboard navigation and hit areas, independent of graph zoom.
export function maintenanceDialog(title) {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "width:min(760px,90vw);max-height:85vh;overflow:auto;background:#25272b;color:#eee;border:1px solid #666;border-radius:8px;padding:20px;font:14px/1.5 system-ui";
    const heading = document.createElement("h3"); heading.textContent = title; heading.style.marginTop = "0";
    const body = document.createElement("div");
    const footer = document.createElement("div"); footer.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;margin-top:16px";
    const close = document.createElement("button"); close.textContent = "Close"; close.onclick = () => dialog.close();
    footer.append(close); dialog.append(heading, body, footer);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.addEventListener("keydown", e => e.stopPropagation());
    document.body.append(dialog); dialog.showModal();
    const style = document.createElement("style");
    style.textContent = "dialog.e2go-maintenance button,dialog.e2go-maintenance select{font:inherit;min-height:32px;padding:4px 10px;background:#35383e;color:#eee;border:1px solid #707680;border-radius:4px}dialog.e2go-maintenance button:disabled{opacity:.45}dialog.e2go-maintenance input[type=checkbox]{width:18px;height:18px;flex-shrink:0}dialog.e2go-maintenance label{display:flex;align-items:center;gap:10px;min-height:32px;overflow-wrap:anywhere}";
    dialog.className = "e2go-maintenance"; dialog.append(style);
    return { dialog, body, footer };
}

function openWorkflows() {
    const graph = app.rootGraph || app.graph;
    const saved = [graph.serialize()];
    for (const workflow of app.extensionManager?.workflow?.openWorkflows || []) {
        if (workflow.changeTracker?.activeState) saved.push(workflow.changeTracker.activeState);
    }
    return saved;
}

export async function openCanvasStorage() {
    const { body, footer, dialog } = maintenanceDialog("Canvas storage");
    const info = document.createElement("p");
    info.textContent = "Only files older than 7 days, absent from server workflows, open tabs, queue and history are listed. Exported JSON files outside ComfyUI are not scanned. Selected files go to a recoverable trash; nothing is permanently deleted. Close other browser sessions before cleanup.";
    const status = document.createElement("p"); status.setAttribute("role", "status");
    const list = document.createElement("div"); list.style.cssText = "max-height:40vh;overflow:auto";
    body.append(info, status, list);
    let result, busy = false;
    const scan = document.createElement("button"); scan.textContent = "Scan again";
    const move = document.createElement("button"); move.textContent = "Move selected to trash";
    const restore = document.createElement("button"); restore.textContent = "Restore selected";
    footer.prepend(scan, move, restore);
    const selected = kind => [...list.querySelectorAll(`input[data-kind=${kind}]:checked`)].map(x => result[kind][+x.value]);
    const controls = () => { scan.disabled = busy; move.disabled = busy || !selected("candidates").length; restore.disabled = busy || !selected("trash").length; };
    function render() {
        list.replaceChildren();
        for (const kind of ["candidates", "trash"]) {
            const h = document.createElement("h4"); h.textContent = kind === "trash" ? "Trash (recoverable)" : "Cleanup candidates"; list.append(h);
            for (const [index, file] of result[kind].entries()) {
                const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
                input.type = "checkbox"; input.dataset.kind = kind; input.value = index; input.onchange = controls;
                text.textContent = `${file.name} — ${(file.size / 1048576).toFixed(2)} MiB`; label.append(input, text); list.append(label);
            }
            if (!result[kind].length) { const empty = document.createElement("p"); empty.textContent = "No files"; list.append(empty); }
        }
        status.textContent = `${result.protected} referenced files protected; ${result.recent} recent files kept.`;
    }
    async function request(action) {
        busy = true; controls(); status.textContent = "Checking Canvas files…";
        try {
            const response = await api.fetchApi("/e2go/canvas/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, workflows: openWorkflows(), files: action === "restore" ? selected("trash") : selected("candidates") }) });
            if (response.status === 404) throw new Error("Restart ComfyUI to enable Canvas storage tools.");
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Storage request failed");
            result = data; render();
        } catch (error) { status.textContent = error.message; }
        finally { busy = false; if (dialog.isConnected) controls(); }
    }
    scan.onclick = () => request("scan"); move.onclick = () => request("trash"); restore.onclick = () => request("restore");
    await request("scan");
}
