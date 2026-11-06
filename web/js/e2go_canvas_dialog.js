// Body-mounted native dialog stays readable at any graph zoom.
export function canvasDialog(title) {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", title);
    dialog.style.cssText = "width:420px;max-width:90vw;border:1px solid #657381;border-radius:12px;padding:24px;background:#222930;color:#e3ebf2;font:14px system-ui;box-shadow:0 20px 80px #0009";
    const heading = document.createElement("h3"); heading.textContent = title; heading.style.marginTop = "0"; dialog.append(heading);
    dialog.addEventListener("keydown", e => e.stopPropagation());
    dialog.addEventListener("pointerdown", e => e.stopPropagation());
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
    return dialog;
}

export function canvasSizeDialog(suggested, create) {
    const dialog = canvasDialog("New canvas");
    const form = document.createElement("form"); dialog.append(form);
    const fields = document.createElement("div"); fields.style.cssText = "display:flex;gap:12px;margin:16px 0"; form.append(fields);
    const numbers = ["Width", "Height"].map((name, i) => {
        const label = document.createElement("label"); label.textContent = name + " (px)";
        const input = document.createElement("input"); input.type = "number"; input.min = "64"; input.max = "8192"; input.step = "1"; input.required = true; input.value = suggested[i];
        input.setAttribute("aria-label", name); input.style.cssText = "display:block;width:145px;padding:10px;margin-top:6px;background:#171e25;border:1px solid #657381;border-radius:6px;color:inherit;font:inherit";
        label.append(input); fields.append(label); return input;
    });
    const presets = document.createElement("div"); presets.style.cssText = "display:flex;gap:6px;flex-wrap:wrap"; form.append(presets);
    const button = (parent, text, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.style.cssText = "padding:8px 12px;background:#34434f;color:inherit;border:1px solid #657381;border-radius:6px;cursor:pointer"; b.onclick = fn; parent.append(b); return b; };
    for (const [label, w, h] of [["Square",1024,1024],["Landscape",1344,768],["Portrait",768,1344],["Generation size",...suggested]]) button(presets,label,()=>{numbers[0].value=w;numbers[1].value=h;});
    button(presets,"Swap W / H",()=>{[numbers[0].value,numbers[1].value]=[numbers[1].value,numbers[0].value];});
    const note = document.createElement("p"); note.textContent = "Creates a blank black background. Existing paint and mask follow the normal background replacement rules. Use Reset all to start completely fresh."; note.style.cssText = "color:#aebbc6;line-height:1.5;font-size:12px"; form.append(note);
    const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:18px"; form.append(actions);
    button(actions,"Cancel",()=>dialog.close());
    const submit = button(actions,"Create canvas",()=>{}); submit.type="submit"; submit.style.background="#285b50";
    form.onsubmit = async e => { e.preventDefault(); if (!form.reportValidity()) return; submit.disabled=true; try { await create(...numbers.map(n=>Number(n.value))); dialog.close(); } catch(err) { note.textContent=err.message; } finally {submit.disabled=false;} };
    numbers[0].focus(); numbers[0].select(); return dialog;
}
