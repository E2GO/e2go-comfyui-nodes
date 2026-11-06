import { app } from "../../../scripts/app.js";
import { cursorScopeFor } from "./e2go_cursor_scope.js";
import { hideNamedWidget, scheduleReHide } from "./e2go_hide_utils.js";

export const cursorScope = node => cursorScopeFor(
    app.extensionManager?.workflow?.activeWorkflow, node.graph || app.graph);

export function installCursorControls(node, kind) {
    const scope = node.widgets?.find(w => w.name === "cursor_scope");
    if (scope) scope.serializeValue = () => cursorScope(node);
    hideNamedWidget(node, "cursor_scope");
    scheduleReHide(node, "cursor_scope");
    const repeat = node.widgets?.find(w => w.name === "repeat_last");
    if (repeat) repeat.label = "Repeat last";
}
