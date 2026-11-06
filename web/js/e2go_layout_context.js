const widget = (node, name, fallback) => node?.widgets?.find(w => w.name === name)?.value ?? fallback;
const kind = node => node?.comfyClass || node?.type;
const reroute = node => /reroute/i.test(kind(node) || "");

// Read only the conditioner reached by this Canvas's layout output.
export function layoutConnections(canvas) {
    const graph = canvas.graph;
    const link = id => graph?.links?.get?.(id) ?? graph?.links?.[id];
    const consumers = [], seen = new Set();
    const visit = (node, outputs) => {
        if (!node || seen.has(node.id)) return;
        seen.add(node.id);
        for (const output of outputs || []) for (const id of output.links || []) {
            const edge = link(id), next = graph?.getNodeById(edge?.target_id);
            if (kind(next) === "PowderConditioner" && next.mode !== 2 && next.mode !== 4 && next.inputs?.[edge.target_slot]?.name === "layout") consumers.push(next);
            else if (reroute(next)) visit(next, next.outputs);
        }
    };
    visit(canvas, canvas.outputs?.filter(o => o.name === "layout"));
    if (consumers.length > 1) throw new Error("AI context: this Layout feeds multiple conditioners. Use one conditioner while requesting AI suggestions.");
    const conditioner = consumers[0];
    const source = name => {
        let edge = link(conditioner?.inputs?.find(i => i.name === name)?.link);
        const visited = new Set();
        while (edge) {
            const node = graph.getNodeById(edge.origin_id);
            if (!node || visited.has(node.id) || node.mode === 2) return null;
            visited.add(node.id);
            if (!reroute(node)) return node;
            edge = link(node.inputs?.[0]?.link);
        }
        return null;
    };
    const styler = source("style"), lora = source("lora_info");
    const warnings = [];
    const styles = [];
    if (styler && kind(styler) !== "PowderStyler") warnings.push("Connected style source is not PowderStyler; its generated text is unavailable to AI.");
    if (kind(styler) === "PowderStyler" && styler.mode !== 4) {
        if (widget(styler, "style_sweep", false)) warnings.push("Style Sweep changes per generation; AI uses only the explicitly selected styles.");
        const perStyle = String(widget(styler, "strength_mode", "")).includes("per style");
        if (widget(styler, "use_positive", true) && (perStyle || Number(widget(styler, "style_mix", 1)) > 0)) {
            for (const item of JSON.parse(widget(styler, "style_config", "[]"))) {
                if (item.on !== false && item.use_positive !== false && item.name !== "None" && (!perStyle || Number(item.strength ?? 1) > 0)) styles.push({ name: item.name });
            }
        }
    }
    const loras = [];
    if (lora && kind(lora) !== "PowderLoraLoader") warnings.push("Connected LoRA info source is not PowderLoraLoader; its trigger words are unavailable to AI.");
    if (kind(lora) === "PowderLoraLoader" && lora.mode !== 4) {
        if (widget(lora, "mode", "Stack (all enabled)") === "Single") warnings.push("Single LoRA mode produces separate variants; AI does not merge their trigger words.");
        else for (const item of JSON.parse(widget(lora, "lora_config", "[]"))) {
            if (item.name && item.name !== "None" && item.on !== false && item.use_trigger !== false && item.trigger?.trim()) loras.push({ trigger: item.trigger.trim() });
        }
    }
    return { styles, loras, warnings };
}

export function resolveLayoutContext(connections, library) {
    return { ...connections, styles: connections.styles.map(item => {
        const style = library.find(s => s.name === item.name);
        if (!style) throw new Error(`AI context: style "${item.name}" was not found in the style library.`);
        return { name: item.name, prefix: style.prefix || "", suffix: style.suffix || "" };
    }) };
}
