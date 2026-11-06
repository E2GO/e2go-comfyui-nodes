// Canonical editor geometry is fractional XYWH. Model adapters own coordinate conversion.
export const clone = value => JSON.parse(JSON.stringify(value));
export const uid = () => globalThis.crypto?.randomUUID?.() || `region-${Date.now()}-${Math.random()}`;
export function blankLayout() {
    return { version: 1, enabled: false, target: "ideogram4", width: 1024, height: 1024, followResolution: true,
        promptSource: "workflow", scene: "", background: "", style: { aesthetics: "", lighting: "", medium: "", photo: "" },
        meta: [], palette: [], canvas: "single", regions: [] };
}
export function readLayout(raw) {
    const data = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    if (data && (typeof data !== "object" || Array.isArray(data))) throw new Error("Layout document must be an object.");
    if (data?.regions !== undefined && !Array.isArray(data.regions)) throw new Error("Layout regions must be an array.");
    if (data?.style !== undefined && (!data.style || typeof data.style !== "object" || Array.isArray(data.style))) throw new Error("Layout style must be an object.");
    const out = { ...blankLayout(), ...clone(data || {}) };
    out.regions = out.regions.map(r => {
        if (!r || typeof r !== "object" || !Array.isArray(r.rect) || r.rect.length !== 4) throw new Error("Every layout region needs a rectangle.");
        return { ...region(), ...r, caption: String(r.caption || ""), text: String(r.text || "") };
    });
    return out;
}
export const strings = value => Array.isArray(value) ? value : String(value || "").split(/[,\n]/).map(x => x.trim()).filter(Boolean);
export function region(label = "object", rect = [0.2, 0.2, 0.35, 0.35]) {
    return { id: uid(), label, rect, caption: "", text: "", palette: [], tags: [], enabled: true, locked: false };
}
export const sceneBasis = d => JSON.stringify({ background: d.background, style: d.style, regions: d.regions.filter(r => r.enabled !== false).map(r => ({ id: r.id, label: r.label, rect: r.rect, caption: r.caption, text: r.text, palette: r.palette })) });
export const sceneNeedsSync = d => !!d.scene?.trim() && d.sceneBasis !== sceneBasis(d);
export function visibleText(r) {
    if (r.text?.trim()) return r.text;
    const matches = [...(r.caption || "").matchAll(/"([^"\r\n]+)"|«([^»\r\n]+)»|“([^”\r\n]+)”|‘([^’\r\n]+)’|(?<!\w)'([^'\r\n]+)'(?!\w)/gu)];
    const values = matches.map(m => m.slice(1).find(v => v !== undefined).trim()).filter(Boolean);
    return values.length === 1 ? values[0] : "";
}
export function validateLayout(d, { allowMissingText = false } = {}) {
    const errors = [];
    if (!["ideogram4", "moss", "flux3"].includes(d.target)) errors.push("Choose Ideogram 4, MOSS-Image or FLUX.3.");
    if (d.enabled && !d.regions.some(r => r.enabled !== false)) errors.push("Add a region or turn off Use layout.");
    if (![d.width, d.height].every(n => Number.isInteger(n) && n >= 16 && n <= 16384)) errors.push("Canvas dimensions must be integers between 16 and 16384.");
    if (d.target === "moss" && (d.width % 16 || d.height % 16)) errors.push("MOSS dimensions must be multiples of 16.");
    for (const [i, r] of d.regions.entries()) {
        if (r.enabled === false) continue;
        if (!["object", "character", "text"].includes(r.label)) errors.push(`Region ${i + 1}: unsupported region type.`);
        const [x, y, w, h] = r.rect || [];
        if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000000001 || y + h > 1.000000001) errors.push(`Region ${i + 1}: place a non-empty box inside the canvas.`);
        if (!r.caption?.trim()) errors.push(`Region ${i + 1}: add an appearance description.`);
        if (!allowMissingText && r.label === "text" && !visibleText(r)) errors.push(`Region ${i + 1}: fill "Exact visible text" or put one exact inscription in quotes in Typography & appearance.`);
        if (!strings(r.palette).every(c => /^#[0-9a-f]{6}$/i.test(c))) errors.push(`Region ${i + 1}: palette colors use #RRGGBB.`);
    }
    return errors;
}
const r9 = v => Math.round(v * 1e9) / 1e9;
export function pixelBox(r, width, height) {
    const [x, y, w, h] = r.rect;
    return [Math.floor(r9(x * width)), Math.floor(r9(y * height)), Math.ceil(r9((x + w) * width)), Math.ceil(r9((y + h) * height))];
}
export function caption(d, draft = false) {
    const errors = validateLayout(d);
    if (errors.length) throw new Error(errors.join("\n"));
    const regions = d.regions.filter(r => r.enabled !== false);
    const scene = d.scene || (d.promptSource === "layout_only" ? regions.map(r => r.caption.trim()).join(" ") : "");
    if (d.target === "flux3") {
        const usedIds = new Set();
        const reservedIds = new Set(regions.map(r => r.id).filter(id => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(id)));
        const rows = regions.map((r, i) => {
            let id = r.id;
            if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || usedIds.has(id)) {
                id = `${r.label}_${i + 1}`;
                while (reservedIds.has(id) || usedIds.has(id)) id += "_";
            }
            usedIds.add(id);
            const [x, y, w, h] = r.rect;
            return { id, bbox: [y, x, y + h, x + w].map(v => Math.round(v * 1000)),
                desc: r.caption + (strings(r.palette).length ? ` Colors: ${strings(r.palette).join(", ")}.` : "") + (r.label === "text" ? ` Visible text: ${JSON.stringify(visibleText(r))}.` : "") };
        });
        const prose = [splitFlux3(scene)?.scene ?? scene, d.background, ...Object.values(d.style || {}), strings(d.palette).length ? `Palette: ${strings(d.palette).join(", ")}.` : "", ...rows.map(r => `<${r.id}> ${r.desc}`)].filter(v => typeof v === "string" && v).join("\n");
        return `${prose} ${JSON.stringify(rows)}`;
    }
    if (d.target === "moss") {
        const summary = {};
        if (strings(d.meta).length) summary.meta = strings(d.meta);
        summary.canvas = d.canvas || "single";
        summary.caption = [scene, d.background].filter(Boolean).join("\n");
        if (strings(d.palette).length) summary.palette = strings(d.palette);
        const items = regions.map(r => {
            const item = { label: r.label, caption: r.caption };
            if (r.label === "text") item.text = visibleText(r);
            if (strings(r.tags).length) item.tags = strings(r.tags);
            if (strings(r.palette).length) item.palette = strings(r.palette);
            const [x0, y0, x1, y1] = pixelBox(r, d.width, d.height);
            item.bbox = draft ? [x0, y0, x1, y1] : [y0 - d.height / 2, x0 - d.width / 2, y1 - d.height / 2, x1 - d.width / 2];
            return item;
        });
        return { ...(draft ? { width: d.width, height: d.height } : {}), summary, items,
            bbox_coord_space: draft ? "abs" : "abs_centralized", bbox_format: draft ? "xyxy" : "yxyx" };
    }
    const s = d.style || {};
    const style = { aesthetics: s.aesthetics || "", lighting: s.lighting || "" };
    if ("art_style" in s) { style.medium = s.medium || ""; style.art_style = s.art_style || ""; }
    else { style.photo = s.photo || ""; style.medium = s.medium || ""; }
    if (strings(d.palette).length) style.color_palette = strings(d.palette);
    return { high_level_description: scene, style_description: style, compositional_deconstruction: {
        background: d.background, elements: regions.map(r => {
            const [x, y, w, h] = r.rect;
            const item = { type: r.label === "text" ? "text" : "obj", bbox: [y, x, y + h, x + w].map(v => Math.round(v * 1000)) };
            if (r.label === "text") item.text = visibleText(r);
            item.desc = r.caption;
            if (strings(r.palette).length) item.color_palette = strings(r.palette);
            return item;
        }) } };
}
export function splitFlux3(text) {
    for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] !== "[") continue;
        try {
            const rows = JSON.parse(text.slice(i));
            if (Array.isArray(rows) && rows.length && rows.every(r => r && typeof r.id === "string" && Array.isArray(r.bbox))) return { scene: text.slice(0, i).trim(), rows };
        } catch {}
    }
    return null;
}
export function importLayout(raw, current = blankLayout()) {
    const text = typeof raw === "string" ? raw.replace(/^```(?:json)?\s*|\s*```$/g, "") : null;
    const flux = text && !text.trim().startsWith("{") ? splitFlux3(text) : null;
    if (flux) {
        const out = { ...blankLayout(), target: "flux3", width: current.width, height: current.height, enabled: current.enabled, promptSource: current.promptSource || "workflow", followResolution: false, scene: flux.scene,
            regions: flux.rows.map(r => {
                const [y0, x0, y1, x1] = r.bbox;
                if (r.bbox.length !== 4) throw new Error("Every FLUX.3 region needs four coordinates.");
                return { ...region("object", [x0 / 1000, y0 / 1000, (x1-x0) / 1000, (y1-y0) / 1000]), id: r.id, caption: r.desc || "" };
            }) };
        const errors = validateLayout(out); if (errors.length) throw new Error(errors.join("\n")); return out;
    }
    const data = text !== null ? JSON.parse(text) : clone(raw);
    if (data.version === 1 && Array.isArray(data.regions)) return readLayout(data);
    const out = blankLayout();
    out.followResolution = false;
    out.width = data.width || current.width; out.height = data.height || current.height;
    out.enabled = current.enabled;
    out.promptSource = current.promptSource || "workflow";
    if (Array.isArray(data.items)) {
        out.target = "moss"; out.scene = data.summary?.caption || "";
        out.meta = strings(data.summary?.meta); out.palette = strings(data.summary?.palette); out.canvas = data.summary?.canvas || "single";
        if (!["abs", "abs_centralized"].includes(data.bbox_coord_space) || !["xyxy", "yxyx"].includes(data.bbox_format)) throw new Error("MOSS import needs an explicit coordinate space and bbox format.");
        out.regions = data.items.map(item => {
            if (!Array.isArray(item.bbox) || item.bbox.length !== 4) throw new Error("Every MOSS item needs a bounding box.");
            let [a, b, c, e] = item.bbox;
            let [x0, y0, x1, y1] = data.bbox_format === "xyxy" ? [a, b, c, e] : [b, a, e, c];
            if (data.bbox_coord_space === "abs_centralized") { x0 += out.width / 2; x1 += out.width / 2; y0 += out.height / 2; y1 += out.height / 2; }
            return { ...region(item.label, [x0 / out.width, y0 / out.height, (x1 - x0) / out.width, (y1 - y0) / out.height]), caption: item.caption || "", text: item.text || "", palette: strings(item.palette), tags: strings(item.tags) };
        });
    } else if (data.compositional_deconstruction) {
        out.scene = data.high_level_description || ""; out.style = data.style_description || out.style;
        out.palette = strings(out.style.color_palette); out.background = data.compositional_deconstruction.background || "";
        out.regions = (data.compositional_deconstruction.elements || []).map(item => {
            if (!Array.isArray(item.bbox) || item.bbox.length !== 4) throw new Error("Unplaced Ideogram elements need bounding boxes before import into Layout.");
            const [y0, x0, y1, x1] = item.bbox;
            return { ...region(item.type === "text" ? "text" : "object", [x0 / 1000, y0 / 1000, (x1 - x0) / 1000, (y1 - y0) / 1000]), caption: item.desc || "", text: item.text || "", palette: strings(item.color_palette) };
        });
    } else throw new Error("Import a Powder Layout document, Ideogram caption or MOSS layout draft.");
    const errors = validateLayout(out);
    if (errors.length) throw new Error(errors.join("\n"));
    return out;
}
