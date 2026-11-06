// Shared monochrome toolbar icons; labels remain readable and accessible.
const paths = {
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
        style.textContent = '.e2go-canvas-icon::before{content:"";display:inline-block;width:14px;height:14px;margin-right:5px;vertical-align:-3px;background:currentColor;mask:var(--canvas-icon) center/contain no-repeat}';
        document.head.append(style);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/></svg>`;
    button.classList.add('e2go-canvas-icon');
    button.style.setProperty('--canvas-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    return button;
}
