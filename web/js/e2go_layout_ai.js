import { api } from "../../../scripts/api.js";
import { clone, importLayout, validateLayout, visibleText } from "./e2go_layout_model.js";
import { checkProposal } from "./e2go_layout_review.js";

function parseReply(raw, repairCaptions = false) {
    const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { return JSON.parse(text); } catch { /* Check for the model repeating a complete JSON answer. */ }
    // Qwen occasionally closes the captions object but omits the array's final ].
    // Only insert that one delimiter; never complete strings or invent entries.
    if (repairCaptions && /^\{\s*"captions"\s*:\s*\[/.test(text) && text.endsWith("}")) {
        try {
            const repaired = JSON.parse(text.slice(0, -1) + "]}");
            if (Object.keys(repaired).length === 1 && Array.isArray(repaired.captions)
                && repaired.captions.every(c => typeof c === "string")) return repaired;
        } catch { /* Other malformed responses must still fail closed. */ }
    }
    let depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
            continue;
        }
        if (c === '"') quoted = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            if (--depth !== 0) continue;
            const first = text.slice(0, i + 1);
            const parsed = JSON.parse(first);
            let rest = text.slice(i + 1).trim();
            while (rest.startsWith(first)) rest = rest.slice(first.length).trim();
            if (!rest || first.startsWith(rest)) return parsed;
            break; // Different answers or arbitrary trailing prose are ambiguous.
        }
    }
    throw new Error("Invalid JSON");
}

function compositionChanged(next, previous) {
    const movable = next.regions.filter(r => r.enabled !== false && !r.locked);
    const changed = movable.filter(r => {
        const old = previous.regions.find(other => other.id === r.id);
        if (!old) return false;
        const [x,y,w,h] = r.rect, [ox,oy,ow,oh] = old.rect;
        return Math.max(Math.abs(x+w/2-ox-ow/2), Math.abs(y+h/2-oy-oh/2), Math.abs(w-ow), Math.abs(h-oh)) >= .12;
    }).length;
    return movable.length > 0 && changed >= Math.ceil(movable.length * .6);
}

export async function loadStyleLibrary(signal) {
    const response = await api.fetchApi("/powder_styler/get_styles", { signal });
    if (!response.ok) throw new Error("Cannot read connected styles for the AI assistant.");
    return (await response.json()).styles;
}

export async function proposeLayout(layout, keepGeometry, report, signal, previous, context = { styles: [], loras: [], warnings: [] }) {
    const original = clone(layout);
    // Scene is derived prose, not a geometry constraint. Feeding stale prose back
    // to the small local model makes it repeat contradictory positions and poses.
    if (keepGeometry === "scene" || keepGeometry === "rearrange") layout = {...layout, scene: ""};
    const active = original.regions.filter(r => r.enabled !== false);
    const movable = original.regions.filter(r => r.enabled !== false && !r.locked);
    if (keepGeometry && !active.length) throw new Error("Add or enable at least one region first.");
    if (keepGeometry) {
        const missing = original.regions.findIndex(r => r.enabled !== false && !r.caption?.trim() && !(keepGeometry === true && r.label === "text" && r.text?.trim()));
        if (missing >= 0) throw new Error(`Region ${missing + 1}: enter a short subject description first. AI cannot infer its identity from an empty rectangle.`);
    }
    if (keepGeometry === "rearrange" && !active.some(r => !r.locked)) throw new Error("All active regions are locked. Unlock at least one region to change the composition.");
    const format = `Output a JSON object with version=1, "target":"${layout.target}", width=${layout.width}, height=${layout.height}, scene (the actual image description), background (environment only), and regions (one entry per subject). Each region has label, caption (actual visual appearance without placement), text (exact lettering for text regions, empty otherwise), and rect (four numbers: left,top,width,height, fractional 0..1). The label MUST be exactly "object", "character" or "text", never a subject name. Keep artistic style unspecified unless explicitly requested. Use ONLY fractional XYWH geometry for every target.`;
    let instruction = keepGeometry        ? `Refine the appearance descriptions of the supplied regions. Return exactly one valid JSON object with this shape: ${JSON.stringify({ captions: original.regions.map((r, i) => `Detailed appearance description for region ${i + 1}`) })}. Replace the placeholder strings with improved descriptions in the same order. Expand each short caption into 15 to 35 words with concrete appearance details; do not merely repeat the input caption. Keep exactly ${original.regions.length} captions. Describe shape, materials, colors and typography while preserving the requested style and identity. Describe APPEARANCE ONLY. Do not introduce a pose, movement, floating, flight, action, location or spatial relationship unless it is explicitly stated in that region caption. Use noun phrases about visible features rather than sentences about what a subject does. Do not add objects, coordinates or visible lettering. Return JSON only; use one pair of double quotes around each string and escape any quotation marks inside it. No Markdown.`
        : `Create a spatial composition for an image of ${layout.width} by ${layout.height} pixels. ${format} Keep every requested subject and exact visible wording in its original language. No invented people, signage or extra subjects. Rectangles annotate placement, not visible borders. Natural overlap and nesting are allowed. Fill the style fields consistently with the requested medium. Return JSON only, no Markdown or explanation.`;
    instruction += ' Generate actual content for this request, never copy schema labels such as scene or appearance as values.';
    instruction += ' When a text region has empty text but a quoted inscription in its caption, preserve that exact inscription and its quotation marks in the refined caption. Never translate or replace it.';
    instruction += ' Workflow context is visual guidance, not additional subjects. Respect its requested medium and appearance. Do not copy style boilerplate or LoRA trigger tokens into the output: the conditioner adds them later. If no medium is specified anywhere, do not invent photorealism, cinematic rendering, anime, watercolor or another style. Rectangles use TOP-LEFT origin and positive Y DOWN. Spatial hints override conflicting scene wording. Ignore disabled regions when describing the scene; preserve their stored captions during description refinement. Never duplicate a subject to satisfy conflicting descriptions. For description refinement, describe appearance without changing placement or inventing extra body parts.';
    if (previous) instruction += ` Produce a different alternative to this previous proposal: ${JSON.stringify(keepGeometry === "rearrange" ? {rects: previous.regions.filter(r => r.enabled !== false && !r.locked).map(r => r.rect)} : keepGeometry === "scene" ? {scene: previous.scene} : keepGeometry ? {captions: previous.regions.map(r => r.caption)} : previous)}. Preserve all constraints and requested identities. Do not repeat the previous wording.`;
    const visualStyle = [layout.scene, ...Object.values(layout.style || {}), ...context.styles.flatMap(s => [s.prefix, s.suffix])].filter(Boolean).join(" ");
    let prompt = keepGeometry ? JSON.stringify({ scene: layout.scene, background: layout.background, style: layout.style, workflow_context: context, visual_style: visualStyle || "Unspecified. Describe subjects and positions only; omit rendering medium and lighting.", regions: layout.regions.filter(r => keepGeometry !== "scene" || r.enabled !== false).map(r => ({ label: r.label, caption: r.caption, text: r.text, rect: r.rect, locked: !!r.locked, spatial_hint: `${r.rect[1] + r.rect[3] / 2 < 1/3 ? "upper" : r.rect[1] + r.rect[3] / 2 > 2/3 ? "lower" : "middle"} ${r.rect[0] + r.rect[2] / 2 < 1/3 ? "left" : r.rect[0] + r.rect[2] / 2 > 2/3 ? "right" : "center"} of the image`, enabled: r.enabled })) })
        : JSON.stringify({ scene: layout.scene, background: layout.background, style: layout.style, workflow_context: context });
    if (keepGeometry === "rearrange") {
        const required = Math.max(1, Math.ceil(movable.length * .6));
        instruction = `You arrange objects on an image canvas. Redesign the WHOLE composition, not just its first object. Change the position or scale of at least ${required} of the ${movable.length} movable subjects substantially: shift their centers by at least 0.12 of the canvas or change their width/height by at least 0.12. Rebalance the main subjects and supporting elements together. Keep sky above ground, distant scenery behind foreground subjects, and preserve subject relationships described in the captions. Natural overlap is allowed. Do not merely copy the current rectangles or swap their order. ${previous ? "Make this different from BOTH the current layout and the previous alternative." : "Choose a clearly different arrangement of the main subjects."} Return ONLY a JSON object with a "rects" array of exactly ${movable.length} objects, in movable-subject order. Each object has four numeric fields: "left", "top", "width", "height". All values are fractions from 0 to 1. Origin is top left. left+width and top+height must not exceed 1. Keep useful subject sizes. Fixed subjects cannot move and must not be included in the response. No prose, no Markdown.`;
        const describe = r => ({subject:r.caption,left:r.rect[0],top:r.rect[1],width:r.rect[2],height:r.rect[3]});
        prompt = JSON.stringify({movable_subjects:movable.map(describe),fixed_subjects:active.filter(r=>r.locked).map(describe),previous_alternative:previous?.regions.filter(r=>r.enabled!==false&&!r.locked).map(describe)});
    }
    if (keepGeometry === "scene") {
        // Spatial language is compiled from geometry, not guessed by the LLM.
        // The model sees only explicit environment/style inputs, so it cannot
        // resurrect a stale subject or say that a lower object floats above it.
        instruction = 'Write one concise image-prompt sentence describing ONLY the supplied background and visual style. Preserve the requested environment. Do not add subjects, objects, positions, poses or an unspecified medium. Do not copy LoRA trigger tokens. Return JSON with a string field "setting"; use an empty string if there is no environment or style information. No Markdown.';
        if (previous) instruction += ' Use different wording from the previous setting while preserving its meaning.';
        prompt = JSON.stringify({background:layout.background,style:layout.style,workflow_context:context,previous_setting:previous?.scene?.split('\n')[0]});
    }
    const graph = {
        "1": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_int8_convrot.safetensors", type: "krea2", device: "default" } },
        "2": { class_type: "TextGenerate", inputs: { clip: ["1", 0], prompt, system_prompt: instruction, max_length: 3072, sampling_mode: "off", thinking: false, use_default_template: true, mtp: "off" } },
        "3": { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
    };
    if (previous || keepGeometry === "rearrange") Object.assign(graph["2"].inputs, {
        sampling_mode: "on", "sampling_mode.temperature": 0.65, "sampling_mode.top_k": 40,
        "sampling_mode.top_p": 0.9, "sampling_mode.min_p": 0.05, "sampling_mode.repetition_penalty": 1.05,
        "sampling_mode.seed": crypto.getRandomValues(new Uint32Array(1))[0],
    });
    report("AI proposal queued locally — your layout stays unchanged until you apply the proposal.");
    signal?.throwIfAborted();
    const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(`Layout enhancer could not start: ${JSON.stringify(result.error || result.node_errors || result)}`);
    for (let i = 0; i < 600; i++) {
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 1000);
            signal?.addEventListener("abort", abort, { once: true });
        });
        const response = await api.fetchApi(`/history/${encodeURIComponent(result.prompt_id)}`, { signal });
        if (!response.ok) throw new Error("Could not read the AI result. Check the ComfyUI connection.");
        const history = await response.json();
        signal?.throwIfAborted();
        const record = history[result.prompt_id];
        if (!record) continue;
        if (record.status?.status_str !== "success") throw new Error("Layout enhancer failed. Check the ComfyUI log; your layout was not changed.");
        const raw = record.outputs?.["3"]?.text?.[0];
        if (!raw) throw new Error("Layout enhancer returned no proposal.");
        if (keepGeometry) {
            let parsed;
            try { parsed = parseReply(raw, keepGeometry === true); }
            catch { throw new Error("AI returned incomplete or invalid JSON. Request another proposal; your layout is unchanged."); }
            if (!parsed || typeof parsed !== "object") throw new Error("AI returned no structured proposal. Your layout is unchanged.");
            if (keepGeometry === "rearrange") {
                let rects = Array.isArray(parsed) ? parsed : parsed.rects;
                if (Array.isArray(rects) && rects.every(Number.isFinite) && rects.length === movable.length * 4)
                    rects = Array.from({length: movable.length}, (_, i) => rects.slice(i * 4, i * 4 + 4));
                if (!Array.isArray(rects) || rects.length !== movable.length) throw new Error("AI changed the region count. Composition rejected.");
                movable.forEach((r, i) => {
                    const box = rects[i];
                    r.rect = Array.isArray(box) ? box : box && [box.left, box.top, box.width, box.height];
                    // Fit a valid-sized proposed box into the canvas, just like a
                    // manual drag at its edge. Never resize or repair invalid sizes.
                    if (r.rect?.length === 4 && r.rect.every(Number.isFinite) && r.rect.every(v => v >= 0 && v <= 1)) {
                        r.rect[0] = Math.min(r.rect[0], 1 - r.rect[2]);
                        r.rect[1] = Math.min(r.rect[1], 1 - r.rect[3]);
                    }
                });
                checkProposal(original, layout, "rearrange");
                const comparisons = previous ? [layout, previous] : [layout];
                if (comparisons.some(comparison => !compositionChanged(original, comparison))) throw new Error("AI changed too few objects to create a new composition. Your layout is unchanged; request another proposal.");
                report("New positions proposed. Synchronizing Scene with the new rectangles...");
                const synced = await proposeLayout(original, "scene", report, signal, undefined, context);
                return checkProposal(synced, layout, "rearrange");
            }
            if (keepGeometry === "scene") {
                if (typeof parsed.setting !== "string") throw new Error("AI returned no scene setting.");
                const placements = active.map(r => {
                    const [x,y,w,h] = r.rect;
                    const horizontal = x+w/2 < .4 ? "left" : x+w/2 > .6 ? "right" : "center";
                    const vertical = y+h/2 < 1/3 ? "upper" : y+h/2 > 2/3 ? "lower" : "middle";
                    return `${r.caption.trim()}${r.label === "text" && visibleText(r) ? `; exact visible text: ${JSON.stringify(visibleText(r))}` : ""}. Placement: ${vertical} ${horizontal} of the image.`;
                });
                original.scene = [parsed.setting.trim(), ...placements].filter(Boolean).join('\n');
                return checkProposal(original, layout, keepGeometry);
            }
            if (!Array.isArray(parsed.captions) || parsed.captions.length !== original.regions.length || parsed.captions.some((c, i) => typeof c !== "string" || (original.regions[i].enabled !== false && !c.trim()))) throw new Error("AI returned a different region count. Proposal rejected; geometry and text remain unchanged.");
            original.regions.forEach((r, idx) => {
                if (r.enabled === false) return;
                if (/^(scene|appearance|appearance description|detailed final-image caption|detailed appearance description for region \d+)$/i.test(parsed.captions[idx].trim())) throw new Error(`Region ${idx + 1}: AI returned a placeholder instead of an improved description.`);
                const lettering = r.label === "text" && !r.text?.trim() ? visibleText(r) : "";
                const expected = r.label === "text" ? visibleText(r) : "";
                const proposedText = visibleText({ caption: parsed.captions[idx] });
                if (expected && proposedText && proposedText !== expected) throw new Error(`Region ${idx + 1}: AI changed or translated the inscription. Expected ${JSON.stringify(expected)}. Your layout is unchanged.`);
                r.caption = parsed.captions[idx];
                // The model owns appearance, not the user's exact inscription.
                if (lettering && !visibleText(r)) r.caption += ` Inscription: «${lettering}».`;
            });
            return checkProposal(original, layout, keepGeometry);
        }
        const proposal = importLayout(raw, original);
        if (proposal.target !== original.target || proposal.width !== original.width || proposal.height !== original.height) throw new Error("AI changed the model or canvas size. Proposal rejected; your layout is unchanged.");
        proposal.regions.push(...clone(original.regions.filter(r => r.enabled === false)));
        proposal.promptSource = original.promptSource;
        proposal.enabled = original.enabled;
        proposal.followResolution = original.followResolution;
        const errors = validateLayout(proposal);
        if (errors.length) throw new Error(errors.join("\n"));
        return checkProposal(proposal, layout, keepGeometry);
    }
    throw new Error("Layout enhancer is still queued or timed out. Your layout was not changed.");
}
