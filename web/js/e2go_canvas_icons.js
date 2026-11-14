// Shared monochrome toolbar icons; labels remain readable and accessible.
const paths = {
    transparency: "M3 3h18v18H3Z",
    thumbnails: "M2 5h8v14H2ZM14 5h8v14h-8ZM2 15l3-4 5 6M14 15l3-4 5 6",
    sharpen: "M12 3 2 21h20ZM12 3v18h10Z",
    eyedropper: "M13 6l3-3c3-3 8 2 5 5l-3 3ZM11 6l7 7M12 8l-8 8-1 5 5-1 8-8M5 17l2 2",
    check: "m4 12 5 5L20 6",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    left: "m15 5-7 7 7 7",
    right: "m9 5 7 7-7 7",
    close: "m6 6 12 12M6 18 18 6",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    help: "M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4M12 17h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20",
    brush: "m9 14 9-11 3 3-11 9M9 14c-4-1-5 2-5 4l-2 3c7 0 10-2 8-6",
    eraser: "m3 14 10-11 8 8-9 10H8Zm4-4 8 8M12 21h9",
    fill: "m5 9 7-7 9 9-9 9-9-9Zm0 0L3 3M3 17s-4 5 0 5 0-5 0-5",
    move: "M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3",
    hand: "M8 12V5a2 2 0 0 1 4 0v6-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v10c0 8-11 8-14 3l-4-6c-1-2 2-3 3-1l3 3",
    zoom: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6M7 10h6M10 7v6",
    grid: "M3 3h18v18H3ZM9 3v18M15 3v18M3 9h18M3 15h18",
    blur: "M12 3s-7 8-7 12a7 7 0 0 0 14 0c0-4-7-12-7-12ZM9 16c0 2 1 3 3 3",
    size: "M4 4h16v16H4ZM8 12h8M12 8v8",
    none: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M6 6l12 12",
    folder: "M3 6h7l2 3h9v12H3ZM3 6V3h7l2 3h9v3",
    rotate: "M20 10a8 8 0 1 0-2 8M20 3v7h-7",

    expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    collapse: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
    edit: 'm4 16-1 5 5-1L20 8l-4-4ZM14 6l4 4',
    image: 'M3 3h18v18H3ZM3 16l5-5 4 4 3-3 6 6M15 7h.01',
    layout: 'M3 3h18v18H3ZM12 3v18M12 12h9',
    assistant: 'm14 3 2.5 6.5L23 12l-6.5 2.5L14 21l-2.5-6.5L5 12l6.5-2.5ZM4 2v6M1 5h6',
    compose: 'M3 3h10v8H3Zm0 12h8v6H3Zm12 0h6v6h-6ZM19 2v8m-4-4h8',
    rearrange: 'M3 7h4c5 0 5 10 10 10h4m-4-4 4 4-4 4M3 17h4c2 0 3-2 4-4m2-2c1-2 2-4 4-4h4m-4-4 4 4-4 4',
    sync: 'M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5',
    clear: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    save: 'M3 3h15l3 3v15H3ZM7 3v6h10V3M7 21v-7h10v7',
    copy: 'M9 9h12v12H9ZM15 9V3H3v12h6',
    layers: 'm12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5',
    mask: 'M12 3a9 9 0 1 0 0 18V3Zm0 0a9 9 0 0 1 0 18M12 7h7m-7 5h9m-9 5h7',
    storage: 'M3 4h18v6H3Zm0 10h18v6H3ZM6 7h.01M6 17h.01M10 7h8m-8 10h8',
    object: 'M4 4h16v16H4Z',
    character: 'M8 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4 21v-2a8 8 0 0 1 16 0v2',
    text: 'M4 7V3h16v4M12 3v18M8 21h8',
    undo: 'M8 3 3 8l5 5M3 8h11a7 7 0 0 1 0 14',
    redo: 'm16 3 5 5-5 5m5-5H10a7 7 0 0 0 0 14',
    fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8Z',
    import: 'M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5',
    export: 'M12 15V3m-5 5 5-5 5 5M3 16v5h18v-5',
};

export function canvasIcon(button, name) {
    if (!document.getElementById('e2go-canvas-icons')) {
        const style = document.createElement('style');
        style.id = 'e2go-canvas-icons';
        style.textContent = '.e2go-canvas-icon::before{content:"";display:inline-block;width:15px;height:15px;flex-shrink:0;margin-right:5px;vertical-align:-3px;background:currentColor;mask:var(--canvas-icon) center/contain no-repeat}';
        document.head.append(style);
    }
    if (!paths[name]) return button;
    const checker = name === "transparency" ? '<path d="M3 3h9v9H3ZM12 12h9v9h-9Z" fill="black" stroke="none"/>' : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/>${checker}</svg>`;
    button.classList.add('e2go-canvas-icon');
    button.style.setProperty('--canvas-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    return button;
}
