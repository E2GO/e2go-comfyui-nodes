import { app } from "../../../scripts/app.js";
import { CUSTOM_ROW_HEIGHT, drawToggleButton } from "./e2go_hide_utils.js";
import { maintenanceDialog } from "./e2go_maintenance_ui.js";
import { widgetPointerX, hideNamedWidget, widgetFont, widgetTextColor, widgetSecondaryTextColor, widgetDisabledTextColor } from "./e2go_hide_utils.js";

import { resyncInputLinks, isDeliberateSlotDrop, repairLinkIdCounter, originTypeOfInput } from "./e2go_graph_wire.js";

const MAX_GROUPS = 16, MAX_CHANNELS = 8;
// Canonical ComfyUI slot colors, keyed by type; fallback for unknown/custom.
const TYPE_COLOR = {
  MODEL:"#b06cf0", CLIP:"#ffd500", VAE:"#ff6e6e", IMAGE:"#64b5f6",
  LATENT:"#ff9cf9", CONDITIONING:"#ffa931", MASK:"#81c784", "*":"#9aa0aa",
};
const colorOf = (t) => TYPE_COLOR[t] || "#9aa0aa";


const ROWS_AS_WIDGETS = true;
const ROW_H = CUSTOM_ROW_HEIGHT;
const SEP_H = 34;      // group selection button
const CAP_LINE_H = 15; // each extra wrapped caption line
const MAX_CAP_LINES = 3;
// Hard cap on a group name, matching the canvas node's renameLayer clamp.
const MAX_GROUP_NAME = 40;
const noop = () => {};

// These are actual channel inputs, not optional widget conversions. Vue's
// widget grid hides unconnected sockets until row hover and ignores the
// LiteGraph alwaysVisible flag; keep channel targets discoverable at rest.
const socketStyle = document.createElement("style");
socketStyle.textContent = '[data-widget-name^="sw_row_g"] > div:has(> .lg-slot--input) { opacity: 1 !important; }';
document.head.appendChild(socketStyle);


function fitText(ctx, text, maxWidth) {
  let t = String(text ?? "");
  if (maxWidth <= 0) return "";
  if (ctx.measureText(t).width <= maxWidth) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

// Offscreen 2D context purely for measuring: computeSize() has no ctx of its
// own, and it must agree with draw() on the line count. Same trick (and reason)
// as powder_cache_stats.js's getMeasureCtx.
let _measureCtx = null;
function measureCtx() {
  if (_measureCtx === null) {
    try { _measureCtx = document.createElement("canvas").getContext("2d"); }
    catch { _measureCtx = undefined; }   // measurement unavailable — fail open
  }
  return _measureCtx || null;
}

// Greedy wrap by longest fitting prefix (binary search), breaking at the last
// space inside it when there is one. Character-level fallback matters here:
// group names are often single unbroken tokens.
function wrapLines(ctx, text, maxWidth, decorFirst, maxLines) {
  const lines = [];
  let rest = String(text ?? "").trim();
  while (rest.length && lines.length < maxLines) {
    const decor = lines.length === 0 ? decorFirst : (s) => s;
    let lo = 1, hi = rest.length, fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.measureText(decor(rest.slice(0, mid))).width <= maxWidth) { fit = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    let cut = fit;
    if (fit < rest.length) {
      const sp = rest.lastIndexOf(" ", fit);
      if (sp > 0) cut = sp;
    }
    lines.push(decor(rest.slice(0, cut).trim()));
    rest = rest.slice(cut).trim();
  }
  if (rest.length && lines.length) lines[lines.length - 1] += "…";
  return lines.length ? lines : [decorFirst("")];
}

// Reserve the selection mark on the left and edit/delete actions on the right.
function captionLines(name, width) {
  const ctx = measureCtx();
  if (!ctx) return [String(name)];
  ctx.font = widgetFont(12);
  const maxW = Math.max(40, width - 108);
  if (ctx.measureText(name).width <= maxW) return [name];
  return wrapLines(ctx, name, maxW, s => s, MAX_CAP_LINES);
}


function capZones(width) {
  return { rename: [width - 52, width - 26], remove: [width - 26, width] };
}

function capHit(node, gi, x, width) {
  const z = capZones(width);
  const removable = node._sw.groups.length > 1;
  if (removable && x >= z.remove[0]) node._swRemoveGroup?.(gi);
  else if (x >= z.rename[0] && x < z.rename[1]) node._swRename?.(gi);
  else node._swActivate?.(gi);
  return true;
}

// `height` may be a number or a function, so a wrapped caption can grow.
// `render` receives (ctx, width, posY, hover).
function addRowWidget(node, name, height, render, previousWidgets) {
  // Vue's legacy-widget canvas keeps a reference to the widget object.
  // Reuse it when rebuilding rows so its draw hook remains attached.
  const existing = previousWidgets?.get(name);
  const w = existing || node.addWidget("text", name, "", noop);
  if (existing) node.widgets.push(w);
  w.serialize = false;

  w.type = "e2go_sw_row";
  w.computeSize = () => {
    const width = Math.max(node.size?.[0] || 240, 240);
    return [width, typeof height === "function" ? height(width) : height];
  };
  w.draw = function (ctx, _n, width, posY) {
    w._e2goDrawWidth = width;
    ctx.save();
    // These rows own their whole look, including the on/off contrast, so they
    // must not inherit the dimming the frontend applies to `disabled` widgets.
    ctx.globalAlpha = 1;
    // Hover state via the node's own helper — the same call core uses to decide
    // whether a widget's socket is visible, so "over this row" means exactly the
    // same thing to us and to the renderer. Private, hence the optional call.
    let hover = false;
    try { hover = !!node._isMouseOverWidget?.(w); } catch {}
    try { render(ctx, width, posY, hover); } finally { ctx.restore(); }
  };
  // Belt-and-braces on the same conversion path the styler rows document: a
  // truthy onPointerDown short-circuits toConcreteWidget before it can build an
  // editor. Slot hit-testing runs BEFORE widget clicks, so consuming the click
  // here cannot interfere with dropping a wire on this row's socket.
  w.onPointerDown = () => true;
  return w;
}

// Build one row widget per input (in slot order) plus a caption per group, and
// bind each input to its row so the socket lands on it.
function buildSlotRows(node, previousWidgets) {
  const st = node._sw;
  for (let gi = 0; gi < st.groups.length; gi++) {
    const g = st.groups[gi];
    const capHeight = (width) => {
      const live = node._sw?.groups?.[gi];
      const n = live ? captionLines(live.name, width).length : 1;
      return SEP_H + (n - 1) * CAP_LINE_H;
    };
    const cap = addRowWidget(node, `sw_cap_${gi}`, capHeight, (ctx, width, posY, hover) => {
      const live = node._sw.groups[gi];
      if (!live) return;
      const lines = captionLines(live.name, width);
      const rowH = SEP_H + (lines.length - 1) * CAP_LINE_H;
      const bar = [6, posY + 3, Math.max(0, width - 64), rowH - 6];
      drawToggleButton(ctx, ...bar, live.on, hover);
      ctx.font = widgetFont(12);
      ctx.fillStyle = live.on ? "#ddf8e6" : widgetTextColor();
      ctx.textAlign = "left";
      lines.forEach((line, i) => ctx.fillText(line, 40, posY + 21 + i * CAP_LINE_H));

      {
        const z = capZones(width);
        ctx.font = widgetFont(12);
        ctx.fillStyle = widgetSecondaryTextColor();
        ctx.fillText("✎", z.rename[0] + 7, posY + rowH / 2 + 4);
        if (node._sw.groups.length > 1) ctx.fillText("✕", z.remove[0] + 8, posY + rowH / 2 + 4);
      }
    }, previousWidgets);
    // Same dispatch pair the lora/styler rows use: onPointerDown is the modern
    // path (a truthy return also short-circuits the widget-to-editor conversion),
    // w.mouse the fallback for frontends that still route through it.
    cap.tooltip = "Select this group (one group active at a time)";
    const capWidth = () => cap._e2goDrawWidth || Math.max(node.size?.[0] || 240, 240);
    cap.onPointerDown = function (pointer, _n, canvas) {
      const x = widgetPointerX(pointer, node, canvas, cap);
      return capHit(node, gi, x, capWidth());
    };
    cap.mouse = function (event, pos) {
      if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
      return capHit(node, gi, pos[0], capWidth());
    };

    // Group the visual rows without changing the underlying input indices.
    for (const inp of [...(node.inputs || [])].sort((a, b) =>
      Number(a.name.endsWith("_add")) - Number(b.name.endsWith("_add")))) {
      const m = /^g(\d+)_(c\d+|add)$/.exec(inp.name);
      if (!m || +m[1] !== gi) continue;
      const rowName = `sw_row_${inp.name}`;
      const label = inp.label || inp.name;
      const row = addRowWidget(node, rowName, ROW_H, (ctx, width, posY) => {
        // The active group's channels read at full strength, the idle ones stay
        // quiet — a second, redundant cue for "which group is live".
        const live = node._sw?.groups?.[gi];
        ctx.fillStyle = live?.on ? widgetTextColor() : widgetDisabledTextColor();
        ctx.font = widgetFont(12);
        ctx.fillText(fitText(ctx, label, Math.max(0, width - 44)), 30, posY + ROW_H / 2 + 4);
      }, previousWidgets);
      row.label = label;
      row.tooltip = label;
      // THE mechanism under test: makes this a widget-input slot.
      inp.widget = { name: rowName };
      // …and opt out of the frontend's hide-until-relevant rule for widget
      // sockets. drawSlots only paints a widget-input slot when it is hovered,
      // is a valid target of a link being dragged, has the mouse over its row,
      // is connected, or carries alwaysVisible. For a switcher the channels a
      // group holds must be readable at a glance, so we take the flag.
      inp.alwaysVisible = true;
    }
  }
}

// Undo the binding so a flag flip (or a revert) returns the inputs to the
// native column instead of leaving them pinned to widgets that no longer exist.
function clearSlotRowBindings(node) {
  for (const inp of node.inputs || []) {
    delete inp.widget;
    delete inp.alwaysVisible;
  }
}

// Remove every declared g*_c* / out_* slot ComfyUI auto-created, so the frontend
// owns the slot list. (Declared inputs still exist backend-side for lazy.)
function stripDeclaredSlots(node) {
  for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
    if (/^g\d+_c\d+$/.test(node.inputs[i].name)) node.removeInput(i);
  }
  for (let i = (node.outputs?.length || 0) - 1; i >= 0; i--) {
    if (/^out_\d+$/.test(node.outputs[i].name)) node.removeOutput(i);
  }
}

function newState() {
  return {
    groups: [ { name: "Group 1", on: true, fills: {} },
              { name: "Group 2", on: false, fills: {} } ],
    channels: [],                     // [{col, type, name}] display order
    // free column pool (stable declared indices 0..MAX_CHANNELS-1)
    colFree: Array.from({ length: MAX_CHANNELS }, (_, i) => i),
  };
}

app.registerExtension({
  name: "e2go_nodes.PowderSwitcher",
  async nodeCreated(node) {
    if (node.comfyClass !== "PowderSwitcher") return;
    stripDeclaredSlots(node);
    if (!node._sw) node._sw = newState();

    // active_group widget is backend-facing; JS drives it — hide from the panel
    // using the project's established helper (same one the canvas node uses).
    hideNamedWidget(node, "active_group");

    node._swActivate = (idx) => {
      node._sw.groups.forEach((g, i) => (g.on = i === idx));
      const w = node.widgets?.find((w) => w.name === "active_group");
      if (w) w.value = idx + 1;
      redrawRows(node);
    };
    // Rename via prompt() rather than an inline input: locked in the spec —
    // simpler and robust against LiteGraph stealing focus/keys from the node.
    node._swRename = (gi) => {
      const g = node._sw.groups[gi];
      if (!g) return;
      const v = prompt(`Group name (up to ${MAX_GROUP_NAME} characters)`, g.name);
      if (v == null) return;                 // cancelled — keep the old name
      const name = v.trim().slice(0, MAX_GROUP_NAME);   // same clamp as renameLayer
      if (!name) return;                     // empty — keep the old name
      g.name = name;
      relabelGroup(node, gi);                // re-prefix this group's slot labels
      redrawRows(node);
    };

    // Thin delegates so the panel needs no switcher internals. addGroup /
    // removeGroup already call _swRender (which re-renders the panel and
    // re-snaps the height), so these must not refresh anything themselves.
    node._swAddGroup = () => addGroup(node);
    node._swRemoveGroup = (gi) => removeGroup(node, gi);
    node._swCanAddGroup = () => node._sw.groups.length < MAX_GROUPS;

    node._swRender = () => renderNode(node);
    node._swRender();
  },
});


function redrawRows(node) {
  for (const widget of node.widgets || []) widget.triggerDraw?.();
  node.setDirtyCanvas(true, true);
}

function renderNode(node) {
  const st = node._sw;

  for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
    const inp = node.inputs[i];
    if (["active_group", "hold_state"].includes(inp.name) && inp.link == null) node.removeInput(i);
  }
  // --- keep exactly one acceptor input per group ---
  for (let gi = 0; gi < st.groups.length; gi++) {
    const accName = `g${gi}_add`;
    if (!node.inputs?.some((s) => s.name === accName)) {
      node.addInput(accName, "*");
      const s = node.inputs[node.inputs.length - 1];
      s.label = `G${gi + 1} · +`; s.color_on = "#5a7a9a"; s.color_off = "#3a3f4a";
    }
  }

  resyncInputLinks(node);
  // --- controls: ONLY active_group (hidden, backend-facing) + the DOM panel.
  // Order is load-bearing: active_group must stay first (ComfyUI restores
  // widgets_values positionally, and serialize:false is not honoured on
  // workflow-save) and the panel last, so it renders below the slots. The
  // per-group native text/toggle widgets are gone — the panel replaces them.
  // Order: active_group (hidden) first — ComfyUI restores widgets_values
  // positionally — then the per-slot rows, then the "+ Group" button LAST.
  const previousWidgets = new Map((node.widgets || []).map(w => [w.name, w]));
  node.widgets = (node.widgets || []).filter((w) => w.name === "active_group");
  node._swHeaderControls = ROWS_AS_WIDGETS;
  if (ROWS_AS_WIDGETS) buildSlotRows(node, previousWidgets);
  else clearSlotRowBindings(node);

  const addBtn = node.addWidget("button", "+ Group", null, () => {
    if (node._swCanAddGroup?.()) node._swAddGroup?.();
    else setStatus(node, `Group cap (${MAX_GROUPS}).`);
  });
  addBtn.serialize = false;
  snapHeight(node);
  redrawRows(node);
}

// Keep input slots grouped: all of group 0's channels (col ascending) then its
// acceptor, then group 1's, etc. Binding renames an acceptor in place and
// renderNode appends the fresh acceptor at the tail, so without this the slots
// interleave across groups (G1·MODEL, G2·+, G1·+). Reorders node.inputs and
// repoints each surviving link's target_slot to the new index so wires stay put.
// The Python side declares 128 lazy inputs (16×8) + 8 outputs, so LiteGraph sizes
// the node for all of them at creation; stripDeclaredSlots removes the slots but
// removeInput/removeOutput never shrink node.size — leaving a giant empty column.
// Re-snap the height to the real slot/widget content (keep any wider manual width).
function snapHeight(node) {
  const min = node.computeSize();
  node.size[0] = Math.max(node.size[0] || 0, min[0], 240);
  node.size[1] = min[1];
}

// Update the group-prefix labels on a group's slots after a rename.
function relabelGroup(node, gi) {
  const st = node._sw;
  (node.inputs || []).forEach((s) => {
    const m = /^g(\d+)_c(\d+)$/.exec(s.name);
    if (m && +m[1] === gi) {
      const ch = st.channels.find((c) => c.col === +m[2]);
      s.label = `G${gi + 1} · ${ch ? ch.name : "?"}`;
    }
    if (s.name === `g${gi}_add`) s.label = `G${gi + 1} · +`;
  });
  node.setDirtyCanvas(true, true);
}


const originType = (node, si) => originTypeOfInput(node, si);

function allocCol(st) { return st.colFree.length ? st.colFree.shift() : -1; }
function freeCol(st, col) { if (!st.colFree.includes(col)) { st.colFree.push(col); st.colFree.sort((a, b) => a - b); } }

// Ensure an output slot exists for a channel (named out_{col}, index === col).
function ensureOutput(node, ch) {
  const name = `out_${ch.col}`;
  let idx = node.outputs?.findIndex((o) => o.name === name);
  if (idx == null || idx < 0) {
    // Outputs must stay index-aligned with `col`; pad with placeholders up to col.
    while ((node.outputs?.length || 0) <= ch.col) {
      const j = node.outputs?.length || 0;
      node.addOutput(`out_${j}`, "*");
      node.outputs[j].label = "";           // placeholder for an unused column
    }
    idx = ch.col;
  }
  const o = node.outputs[idx];
  o.name = name; o.type = ch.type; o.label = ch.name; o.color_on = colorOf(ch.type);
}

// Convert a just-connected acceptor (g{gi}_add) into a bound channel.
function swBindConnection(node, si) {
  const st = node._sw;
  const inp = node.inputs[si];
  const m = /^g(\d+)_add$/.exec(inp.name);
  if (!m) return;                         // only acceptors auto-grow
  const gi = +m[1];
  const type = originType(node, si);
  const g = st.groups[gi];
  // Rule 1: fill the first same-type channel this group hasn't filled …
  let ch = st.channels.find((c) => c.type === type && !g.fills[c.col]);
  if (!ch) {                              // … Rule 2: else create a new channel
    const col = allocCol(st);
    if (col < 0) { setStatus(node, `Channel cap reached (${MAX_CHANNELS}).`); disconnectSlot(node, si); return; }
    ch = { col, type, name: uniqueChannelName(st, type) };
    st.channels.push(ch);
  }
  // Bind: rename the acceptor slot in place (keeps the link), type/label/color it.
  inp.name = `g${gi}_c${ch.col}`;
  inp.type = type;
  inp.label = `G${gi + 1} · ${ch.name}`;
  inp.color_on = colorOf(type);
  g.fills[ch.col] = true;
  ensureOutput(node, ch);
  node._swRender();                        // re-adds a fresh acceptor for this group
}

function uniqueChannelName(st, type) {
  const same = st.channels.filter((c) => c.type === type).length;
  return same ? `${type}·${same + 1}` : type;
}
function disconnectSlot(node, si) {
  if (node.inputs?.[si]?.link != null) node.disconnectInput(si);
}
function setStatus(node, msg) { console.info("[PowderSwitcher]", msg); }

function misplacedConnections(node) {
  const inputs = node.inputs || [];
  const missing = inputs.filter(i => {
    const m = /^g(\d+)_c(\d+)$/.exec(i.name);
    return m && i.link == null && node._sw?.groups[+m[1]]?.fills[+m[2]];
  });
  return inputs.filter(i => /_add$/.test(i.name) && i.link != null).flatMap(input => {
    const link = node.graph?.links?.get?.(input.link) ?? node.graph?.links?.[input.link];
    const origin = node.graph?.getNodeById(link?.origin_id);
    if (!origin) return [];
    const targets = missing.filter(i => i.type === origin.outputs?.[link.origin_slot]?.type);
    return targets.length ? [{ input, link, origin, targets }] : [];
  });
}

function openConnectionRepair(node) {
  const graph = node.graph;
  const { body, footer } = maintenanceDialog("Restore Switcher connections");
  const info = document.createElement("p");
  info.textContent = "Choose the intended group and channel for each misplaced connection. Unselected connections remain unchanged.";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  body.append(info, status);
  const rows = misplacedConnections(node).map(item => {
    const label = document.createElement("label"), text = document.createElement("span"), select = document.createElement("select");
    label.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0";
    text.textContent = `${item.origin.title || item.origin.type} #${item.origin.id} · ${item.origin.outputs[item.link.origin_slot]?.name || item.link.origin_slot} → ${item.input.label || item.input.name}`;
    text.title = text.textContent;
    select.add(new Option("Leave unchanged", ""));
    for (const target of item.targets) {
      const m = /^g(\d+)_c(\d+)$/.exec(target.name);
      select.add(new Option(`${node._sw.groups[+m[1]].name} · ${target.label || target.name} (${target.type})`, target.name));
    }
    label.append(text, select); body.append(label);
    return { ...item, select };
  });
  if (!rows.length) status.textContent = "No misplaced connections with matching saved channels were found.";
  const apply = document.createElement("button"); apply.textContent = "Apply selected connections"; apply.disabled = !rows.length;
  footer.prepend(apply);
  apply.onclick = () => {
    const selected = rows.filter(r => r.select.value);
    if (!selected.length) { status.textContent = "Select a target first."; return; }
    const targets = selected.map(r => r.select.value);
    if (new Set(targets).size !== targets.length) { status.textContent = "Choose a different target for each connection."; return; }
    if (node.graph !== graph || selected.some(r => r.input.link !== r.link.id || !node.inputs.includes(r.input) || node.inputs.find(i => i.name === r.select.value)?.link != null)) {
      status.textContent = "Connections changed. Close and reopen this dialog."; return;
    }
    graph.beforeChange?.();
    try {
      for (const r of selected) {
        const target = node.inputs.find(i => i.name === r.select.value);
        if (!target || target.type !== r.origin.outputs?.[r.link.origin_slot]?.type) throw new Error("Target changed. Reopen this dialog.");
        node.disconnectInput(node.inputs.indexOf(r.input));
        const connected = r.origin.connect(r.link.origin_slot, node, node.inputs.indexOf(target));
        if (!connected) {
          r.origin.connect(r.link.origin_slot, node, node.inputs.indexOf(r.input));
          throw new Error("Connection rejected; original wire restored.");
        }
      }
      node.setDirtyCanvas?.(true, true);
      status.textContent = `${selected.length} connections restored. Save the workflow to keep them.`;
      apply.disabled = true;
    } catch (error) { status.textContent = error.message; }
    finally { graph.afterChange?.(); }
  };
}

// Recover the specific old slot-reorder corruption only when saved group
// metadata identifies one unambiguous missing channel for one stray wire.
function repairMisplacedLink(node) {
  const stray = (node.inputs || []).filter(i => /_add$/.test(i.name) && i.link != null);
  const missing = (node.inputs || []).filter(i => {
    const m = /^g(\d+)_c(\d+)$/.exec(i.name);
    return m && i.link == null && node._sw?.groups[+m[1]]?.fills[+m[2]];
  });
  if (stray.length !== 1 || missing.length !== 1) return false;
  const links = node.graph?.links;
  const link = links?.get ? links.get(stray[0].link) : links?.[stray[0].link];
  const origin = node.graph?.getNodeById(link?.origin_id);
  if (!origin || origin.outputs?.[link.origin_slot]?.type !== missing[0].type) return false;
  const originSlot = link.origin_slot;
  node.disconnectInput(node.inputs.indexOf(stray[0]));
  origin.connect(originSlot, node, node.inputs.indexOf(missing[0]));
  return true;
}


app.registerExtension({
  name: "e2go_nodes.PowderSwitcher.wiring",
  async nodeCreated(node) {
    if (node.comfyClass !== "PowderSwitcher") return;

    const prevConnectInput = node.onConnectInput;
    node.onConnectInput = function (targetSlot, type, output, originNode, originSlot) {
      if (typeof prevConnectInput === "function") {
        try { if (prevConnectInput.apply(this, arguments) === false) return false; } catch {}
      }
      const inp = this.inputs?.[targetSlot];
      if (!inp || !/^g\d+_add$/.test(inp.name)) return true;

      let dragging = false;
      try { dragging = !!(app.canvas?.connecting_links?.length); } catch {}
      if (!dragging) return true;
      // Vue positions sockets in DOM rows; getConnectionPos can still carry
      // the classic widget coordinates. Use the actual hovered socket there.
      const key = CSS.escape(`${this.id}-in-${targetSlot}`);
      const socket = document.querySelector(`[data-slot-key="${key}"]`);
      if (socket?.getBoundingClientRect().width) {
        return !!socket.closest(".lg-slot--input")?.matches(":hover");
      }
      let pointer = null, slotPos = null;
      try { pointer = app.canvas?.graph_mouse; } catch {}
      try { slotPos = this.getConnectionPos?.(true, targetSlot); } catch {}
      if (isDeliberateSlotDrop(slotPos, pointer)) return true;
      setStatus(this, "Drop the connection directly on the '+' input to add a channel");
      return false;
    };
    const prev = node.onConnectionsChange;
    node.onConnectionsChange = function (type, index, connected, link_info) {
      if (typeof prev === "function") { try { prev.apply(this, arguments); } catch {} }
      // 1 === LiteGraph.INPUT
      if (type === 1 && connected && link_info) {
        const inp = this.inputs?.[index];
        if (inp && /^g\d+_add$/.test(inp.name)) {
          // Finish the frontend's connection transaction before changing slot
          // order. Vue otherwise writes its old indices back over our reorder.
          const linkId = link_info.id;
          queueMicrotask(() => {
            if (!this.graph || this._swRestoring || inp.link !== linkId) return;
            const current = this.inputs.indexOf(inp);
            if (current >= 0 && /^g\d+_add$/.test(inp.name)) swBindConnection(this, current);
          });
        }
      }
    };
  },
});

// On disconnect of a bound channel slot: clear the fill; if the channel is now
// empty across ALL groups, prune it (free col, drop its output). Then collapse
// the freed input slot back into nothing (it stays as an unused acceptor is not
// created — the per-group acceptor already exists).
function swUnbind(node, si) {
  const st = node._sw;
  const inp = node.inputs[si];
  const m = /^g(\d+)_c(\d+)$/.exec(inp.name);
  if (!m) return;
  const gi = +m[1], col = +m[2];
  delete st.groups[gi].fills[col];
  node.removeInput(si);                         // drop the now-empty channel slot

  resyncInputLinks(node);
  const stillUsed = st.groups.some((g) => g.fills[col]);
  if (!stillUsed) {
    st.channels = st.channels.filter((c) => c.col !== col);
    freeCol(st, col);
    const oi = node.outputs?.findIndex((o) => o.name === `out_${col}`);
    if (oi != null && oi >= 0) {
      // Keep index alignment: blank the output instead of removing interior ones.
      const o = node.outputs[oi]; o.type = "*"; o.label = ""; o.color_on = colorOf("*");
      // Trim trailing blank outputs.
      for (let i = node.outputs.length - 1; i >= 0; i--) {
        const used = st.channels.some((c) => c.col === i);
        if (used) break;
        node.removeOutput(i);
      }
    }
  }
  node._swRender();
}

function addGroup(node) {
  const st = node._sw;
  if (st.groups.length >= MAX_GROUPS) return setStatus(node, `Group cap (${MAX_GROUPS}).`);
  st.groups.push({ name: `Group ${st.groups.length + 1}`, on: false, fills: {} });
  node._swRender();
}
function removeGroup(node, gi) {
  const st = node._sw;
  if (st.groups.length <= 1) return setStatus(node, "Keep at least one group.");
  const retained = [];
  node._swRemovingGroup = true;
  for (const [index, input] of (node.inputs || []).entries()) {
    if (input.link == null) continue;
    const links = node.graph?.links;
    const link = links?.get ? links.get(input.link) : links?.[input.link];
    if (link && !input.name.startsWith(`g${gi}_`)) {
      retained.push({ input, origin: node.graph.getNodeById(link.origin_id), slot: link.origin_slot });
    }
    node.disconnectInput(index);
  }
  // Disconnect + remove this group's slots.
  for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
    if (new RegExp(`^g${gi}_(c\\d+|add)$`).test(node.inputs[i].name)) {
      if (node.inputs[i].link != null) node.disconnectInput(i);
      node.removeInput(i);
    }
  }
  st.groups.splice(gi, 1);
  // Close the index gap: every slot g{k}_* with k > gi becomes g{k-1}_*.
  renumberGroupsAfterRemoval(node, gi);

  const activeIdx = st.groups.findIndex((g) => g.on);
  node._swActivate(activeIdx >= 0 ? activeIdx : 0);
  // Prune channels no surviving group fills.
  for (const ch of [...st.channels]) {
    if (!st.groups.some((g) => g.fills[ch.col])) {
      st.channels = st.channels.filter((c) => c.col !== ch.col);
      freeCol(st, ch.col);
      const oi = node.outputs?.findIndex((o) => o.name === `out_${ch.col}`);
      if (oi >= 0) { node.outputs[oi].type = "*"; node.outputs[oi].label = ""; }
    }
  }
  node._swRender();
  node._swRemovingGroup = false;
  for (const { input, origin, slot } of retained) {
    const index = node.inputs.indexOf(input);
    if (origin && index >= 0) origin.connect(slot, node, index);
  }
}
// After splicing group `removedGi` out, every slot named g{k}_* with k > removedGi
// shifts down by one so group indices stay contiguous (backend reads
// g{active}_c{col}). Renaming a slot's `.name` keeps its link (links reference the
// slot object/index, not the name), so no reconnection is needed. Each old k maps
// to a distinct new k-1 and the removed group's own slots are already gone, so
// there are no name collisions regardless of iteration order.
function renumberGroupsAfterRemoval(node, removedGi) {
  (node.inputs || []).forEach((s) => {
    const m = /^g(\d+)_(c\d+|add)$/.exec(s.name);
    if (!m) return;
    const k = +m[1];
    if (k > removedGi) s.name = `g${k - 1}_${m[2]}`;   // label refreshed by renderNode
  });
}

app.registerExtension({
  name: "e2go_nodes.PowderSwitcher.groups",
  async nodeCreated(node) {
    if (node.comfyClass !== "PowderSwitcher") return;
    const prevMenu = node.getExtraMenuOptions;
    node._swOpenRepair = () => openConnectionRepair(node);
    node.getExtraMenuOptions = function (canvas, options) {
      if (typeof prevMenu === "function") { try { prevMenu.apply(this, arguments); } catch {} }
      options.push(
        { content: "➕ Add group", callback: () => addGroup(this) },
        { content: "Restore misplaced connections…", callback: () => openConnectionRepair(this) },
        ...this._sw.groups.map((g, gi) => this._sw.groups.length > 1
          ? { content: `✕ Remove ${g.name}`, callback: () => removeGroup(this, gi) }
          : null).filter(Boolean),
      );
    };
    const prevDisc = node.onConnectionsChange;
    node.onConnectionsChange = function (type, index, connected, link_info) {
      if (typeof prevDisc === "function") { try { prevDisc.apply(this, arguments); } catch {} }
      if (type === 1 && !connected && !this._swRemovingGroup) {
        const inp = this.inputs?.[index];
        if (inp && /^g\d+_c\d+$/.test(inp.name)) {
          // Replacing a wire first disconnects the old one. Keep its slot
          // alive until LiteGraph finishes attaching the replacement.
          queueMicrotask(() => {
            if (!this.graph || this._swRestoring) return;
            const current = this.inputs.indexOf(inp);
            if (current < 0) return;
            if (inp.link == null) swUnbind(this, current);
          });
        }
      }
    };
  },
});

app.registerExtension({
  name: "e2go_nodes.PowderSwitcher.persist",
  async nodeCreated(node) {
    if (node.comfyClass !== "PowderSwitcher") return;

    const prevSer = node.onSerialize;
    node.onSerialize = function (info) {
      if (typeof prevSer === "function") { try { prevSer.apply(this, arguments); } catch {} }
      info.properties = info.properties || {};
      info.properties.e2goSwitcher = {
        groups: this._sw.groups.map((g) => ({ name: g.name, on: g.on, fills: Object.keys(g.fills).map(Number) })),
        channels: this._sw.channels.map((c) => ({ col: c.col, type: c.type, name: c.name })),
      };
    };

    const prevCfg = node.onConfigure;
    node.onConfigure = function (info) {
      this._swRestoring = true;
      if (typeof prevCfg === "function") { try { prevCfg.apply(this, arguments); } catch {} }

      requestAnimationFrame(() => {
        if (repairMisplacedLink(this)) setStatus(this, "Recovered a misplaced group connection from saved channel metadata.");
        this._swRestoring = false;

        const c = repairLinkIdCounter(this.graph);
        if (c && c.after !== c.before) {
          setStatus(this, `Link ID counter was behind (${c.before} -> ${c.after}) — ` +
                          `corrected to prevent overwriting existing links`);
        }
        const r = resyncInputLinks(this);
        if (r.cleared || r.fixed) {
          setStatus(this, `Graph repaired: stale references cleared ${r.cleared}, ` +
                          `links reindexed ${r.fixed}`);
          this.setDirtyCanvas?.(true, true);
        }
      });
      const meta = info?.properties?.e2goSwitcher;
      if (!meta) return;                       // fresh node -> scaffold default already set
      const used = new Set();
      this._sw = {
        groups: meta.groups.map((g) => ({
          name: g.name, on: !!g.on,
          fills: Object.fromEntries((g.fills || []).map((c) => (used.add(c), [c, true]))),
        })),
        channels: (meta.channels || []).map((c) => ({ col: c.col, type: c.type, name: c.name })),
        colFree: Array.from({ length: MAX_CHANNELS }, (_, i) => i).filter((i) => !used.has(i)),
      };
      // LiteGraph restored the slots by name; re-apply labels/colors/types.
      (this.inputs || []).forEach((s) => {
        const m = /^g(\d+)_c(\d+)$/.exec(s.name);
        if (m) {
          const ch = this._sw.channels.find((c) => c.col === +m[2]);
          if (ch) { s.type = ch.type; s.label = `G${+m[1] + 1} · ${ch.name}`; s.color_on = colorOf(ch.type); }
          return;
        }
        const a = /^g(\d+)_add$/.exec(s.name);
        if (a) s.label = `G${+a[1] + 1} · +`;
      });
      (this.outputs || []).forEach((o) => {
        const m = /^out_(\d+)$/.exec(o.name);
        if (m) { const ch = this._sw.channels.find((c) => c.col === +m[1]);
          if (ch) { o.type = ch.type; o.label = ch.name; o.color_on = colorOf(ch.type); } }
      });
      this._swRender();
    };
  },
});
