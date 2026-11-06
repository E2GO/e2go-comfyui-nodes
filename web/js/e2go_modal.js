// e2go_modal.js — shared modal core (extracted from powder_styler_modal.js, C2).
//
// Generic category/search/favorites picker used by multiple e2go features
// (styles, loras…). Each feature owns its data and passes it in via `items`;
// this module owns the DOM skeleton, CSS skin (class names `e2go-style-*`,
// kept verbatim so the existing style stylesheet keeps applying), the single
// `_modalOpen` overlay guard, the category column, search filtering, favorites
// (parameterized localStorage key) and the pick / multi interaction modes.
//
// openModal(opts):
//   items            Array<{name, category}>  OR  a function returning that
//                    (or a Promise of it). A loader function lets the overlay
//                    guard be held DURING the async data fetch — same timing as
//                    the original styler, which acquired the guard before
//                    awaiting its library.
//   numbered         optional bool (opt-in, default false — lora rendering is
//                    untouched). When true, items are expected to carry a
//                    1-based `num` (global alphabetical index, UI-only). Rows
//                    render `#N` in a dimmer color before the name, and a
//                    digits-only (or "#digits") search query filters by
//                    number-prefix instead of the usual name substring search.
//   favoritesKey     localStorage key for this feature's favorites Set. Also
//                    seeds "<favoritesKey>.lastloc" — the modal reopens at the
//                    category + scroll position of the last item click.
//   mode             "multi" (checkmarks + toggle) or "pick" (highlight + close).
//   current          (pick) name of the row to highlight.
//   title            optional header title (shown when truthy).
//   searchPlaceholder optional input placeholder (default "Search…").
//   onPick(name)     (pick) called on row click, then the modal closes.
//   onToggleItem(it) (multi) called on row click; the caller mutates its own
//                    selection + relayout, then the list re-renders.
//   isSelected(it)   (multi) → boolean; drives checkmark + highlight.
//   tooltipFor(it)   → string OR Promise<string>. String: row.title set now.
//                    Promise: row.title set on resolve, rejections swallowed.
//   onClose()        optional; invoked on every close path (✕/Esc/backdrop/pick).
//   onLoadError(err) optional; invoked if the `items` loader rejects.
//   headerButtons    optional [{label, title, onClick(api)}] — extra buttons
//                    rendered between search and the ↻/✕ pair. `api` is
//                    {refresh, close}: refresh() re-runs onRefresh and
//                    re-renders (same path as the ↻ button).
//   rowButtons(it)   optional → [{label, title, onClick(it, api, el)}] — extra
//                    per-row action glyphs after the favorite star (e.g. edit/
//                    delete for user-owned items). `el` is the glyph element.
//   onRefresh()      optional async function. When present, a "↻" button is
//                    rendered in the header (between search and ✕). On click
//                    the button disables, awaits onRefresh() for a fresh items
//                    array (the adapter resets its own cache and re-fetches),
//                    then items/byName/categories/counts are re-derived and
//                    both columns re-render, preserving state.category (falls
//                    back to "All" if the category vanished from the fresh
//                    set), state.query and best-effort list scrollTop. On
//                    rejection the button flashes "↻ failed" for ~1.5s and the
//                    old items keep rendering untouched.

const FAVORITES = "★"; // sentinel category value for the pinned "Favorites" pseudo-category

function loadFavorites(key) {
    try {
        const raw = localStorage.getItem(key);
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

function saveFavorites(key, set) {
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
        // ignore quota / storage errors
    }
}

// Last-location memory: the modal reopens at the category + scroll where the
// user last clicked an item (added a style/lora, picked a sweep value), instead
// of always starting at "All". Keyed per feature off favoritesKey, so styler
// and lora each remember their own place.
function loadLastLocation(key) {
    try {
        const loc = JSON.parse(localStorage.getItem(key));
        return loc && typeof loc === "object" ? loc : null;
    } catch {
        return null;
    }
}

function saveLastLocation(key, loc) {
    try {
        localStorage.setItem(key, JSON.stringify(loc));
    } catch {
        // ignore quota / storage errors
    }
}

const CSS = `
.e2go-style-modal-backdrop {
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(0,0,0,0.5); display: flex;
    align-items: center; justify-content: center;
}
.e2go-style-modal {
    width: 720px; max-width: 92vw; height: 560px; max-height: 85vh;
    background: #202225; color: #ddd; border: 1px solid #444;
    border-radius: 8px; display: flex; flex-direction: column;
    font: 13px Arial, sans-serif;
}
.e2go-style-modal header {
    display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid #383838;
}
.e2go-style-modal header input {
    flex: 1; background: #17181a; color: #ddd; border: 1px solid #444;
    border-radius: 4px; padding: 6px 8px; outline: none;
}
.e2go-style-modal header button {
    background: #333; color: #ccc; border: 1px solid #555;
    border-radius: 4px; padding: 4px 10px; cursor: pointer;
}
.e2go-style-modal header button.e2go-style-refresh:disabled {
    opacity: .5; cursor: default;
}
.e2go-style-modal-title {
    color: #9bbdd6; font-size: 12px; align-self: center; white-space: nowrap;
}
.e2go-style-body { display: flex; flex: 1; min-height: 0; }
.e2go-style-cats {
    width: 170px; overflow-y: auto; border-right: 1px solid #383838; padding: 6px 0;
}
.e2go-style-cats div {
    padding: 6px 12px; cursor: pointer; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
}
.e2go-style-cats div.active { background: #2d3f52; color: #fff; }
.e2go-style-cats div:hover { background: #2a2c30; }
.e2go-style-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.e2go-style-list div {
    padding: 5px 14px; cursor: pointer; display: flex; gap: 8px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.e2go-style-list div:hover { background: #2a2c30; }
.e2go-style-list div.selected { color: #9fd49f; }
.e2go-style-list .check { width: 14px; display: inline-block; }
.e2go-style-list .num { color: #888; flex-shrink: 0; }
.e2go-style-list .fav { margin-left: auto; opacity: .6; }
.e2go-style-list .fav.on { opacity: 1; color: #e8c96a; }
.e2go-style-list .rowbtn { opacity: .55; }
.e2go-style-list .rowbtn:hover { opacity: 1; }
.e2go-style-list .rowbtn.danger { color: #d18f8f; }
`;

function ensureCss() {
    if (document.getElementById("e2go-style-modal-css")) return;
    const el = document.createElement("style");
    el.id = "e2go-style-modal-css";
    el.textContent = CSS;
    document.head.appendChild(el);
}

// A digits-only query, or "#" followed by digits, is a number-prefix search
// (opts.numbered mode only); anything else falls back to the name search.
// Returns the digit string, or null when the query isn't number-shaped.
function numberQueryDigits(q) {
    const m = /^#?(\d+)$/.exec(q.trim());
    return m ? m[1] : null;
}

let _modalOpen = false;

// Single overlay across ALL consumers: a lora modal and a style modal must not
// stack. `mode` selects behavior: "multi" toggles entries via opts.onToggleItem
// and shows checkmarks (highlight = opts.isSelected); "pick" highlights the row
// whose name === opts.current and calls opts.onPick(name) then closes on any row
// click. Categories, search and favorites are identical in both modes.
export async function openModal(opts) {
    const mode = opts.mode;
    // Double-open guard: rapid clicks (or an in-flight data load) must not
    // stack a second backdrop + keydown listener. Applies to every consumer —
    // only one overlay at a time.
    if (_modalOpen || document.querySelector(".e2go-style-modal-backdrop")) {
        document.querySelector(".e2go-style-modal-backdrop input")?.focus();
        return;
    }
    _modalOpen = true;
    const previousFocus = document.activeElement;
    const loading = document.createElement("div");
    loading.className = "e2go-library-loading";
    loading.setAttribute("role", "status");
    loading.style.cssText = "position:fixed;z-index:100000;top:20px;left:50%;transform:translateX(-50%);padding:16px;background:#292b30;color:white;border-radius:6px";
    loading.textContent = "Loading library…";
    document.body.appendChild(loading);

    // Resolve items with the guard held, so a load-in-flight second open is
    // blocked exactly like the original styler (which acquired the guard before
    // awaiting its library).
    let items;
    try {
        const src = opts.items;
        // 15s timeout: a hung loader fetch would otherwise hold _modalOpen
        // forever, bricking EVERY modal consumer until page reload.
        items = await Promise.race([
            Promise.resolve(typeof src === "function" ? src() : src),
            new Promise((_, rej) => setTimeout(
                () => rej(new Error("modal loader timed out (15s)")), 15000)),
        ]);
    } catch (err) {
        _modalOpen = false;
        loading.setAttribute("role", "alert");
        loading.textContent = `Library could not be loaded: ${err.message}. Close this message and reopen the library to retry. `;
        const dismiss = document.createElement("button");
        dismiss.textContent = "Close";
        dismiss.onclick = () => { loading.remove(); previousFocus?.focus(); };
        loading.appendChild(dismiss);
        dismiss.focus();
        opts.onLoadError?.(err);
        return;
    }
    items = Array.isArray(items) ? items : [];
    loading.remove();
    ensureCss();

    const favoritesKey = opts.favoritesKey;
    const favorites = loadFavorites(favoritesKey);
    const current = opts.current;

    // Derive the name index and per-category counts from the items themselves;
    // each feature no longer has to precompute them. `let` (not `const`): a
    // refresh re-derives all three from a freshly fetched items array.
    let byName = new Map(items.map((it) => [it.name, it]));
    let counts = new Map();
    for (const it of items) {
        counts.set(it.category, (counts.get(it.category) || 0) + 1);
    }
    let categories = [...counts.entries()].map(([name, count]) => ({ name, count }));

    const state = { category: "All", query: "" };

    // Restore the last-clicked location (category + scroll). Falls back to
    // "All" when nothing was saved yet or the saved category no longer exists.
    const lastLocKey = favoritesKey ? favoritesKey + ".lastloc" : null;
    const lastLoc = lastLocKey ? loadLastLocation(lastLocKey) : null;
    if (
        lastLoc &&
        (lastLoc.category === FAVORITES || counts.has(lastLoc.category))
    ) {
        state.category = lastLoc.category;
    }

    const backdrop = document.createElement("div");
    backdrop.className = "e2go-style-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "e2go-style-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", opts.title || "Library");
    backdrop.appendChild(modal);

    const header = document.createElement("header");
    if (opts.title) {
        const titleEl = document.createElement("span");
        titleEl.className = "e2go-style-modal-title";
        titleEl.textContent = opts.title;
        header.appendChild(titleEl);
    }
    const search = document.createElement("input");
    search.placeholder = opts.searchPlaceholder || "Search…";
    search.setAttribute("aria-label", search.placeholder);
    header.append(search);
    for (const hb of opts.headerButtons || []) {
        const b = document.createElement("button");
        b.textContent = hb.label;
        if (hb.title) b.title = hb.title;
        // Async onClick (user-style import etc.) can reject — an unhandled
        // rejection left the old list rendering with no visible error.
        b.addEventListener("click", () => {
            Promise.resolve(hb.onClick?.(api)).catch((e) =>
                console.warn("[e2go modal] header action failed:", e));
        });
        header.append(b);
    }
    let refreshBtn = null;
    if (opts.onRefresh) {
        refreshBtn = document.createElement("button");
        refreshBtn.className = "e2go-style-refresh";
        refreshBtn.textContent = "↻";
        refreshBtn.title = "Refresh library";
        header.append(refreshBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close library");
    header.append(closeBtn);

    const body = document.createElement("div");
    body.className = "e2go-style-body";
    const catsEl = document.createElement("div");
    catsEl.className = "e2go-style-cats";
    const listEl = document.createElement("div");
    listEl.className = "e2go-style-list";
    body.append(catsEl, listEl);
    modal.append(header, body);

    function close() {
        _modalOpen = false;
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        previousFocus?.focus();
        // The caller decides what post-close work is needed. Styler multi mode
        // uses this to relayout the on-node rows; pick mode passes nothing, as
        // the caller already handled onPick.
        opts.onClose?.();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        if (e.key === "Tab") {
            const controls = [...modal.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')];
            const index = controls.indexOf(document.activeElement);
            if (e.shiftKey && index <= 0) { e.preventDefault(); controls.at(-1)?.focus(); }
            else if (!e.shiftKey && (index < 0 || index === controls.length - 1)) { e.preventDefault(); controls[0]?.focus(); }
        }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement.closest('.e2go-style-list, .e2go-style-cats')) {
            const parent = document.activeElement.closest('.e2go-style-list, .e2go-style-cats');
            const controls = [...parent.children].filter(el=>el.tabIndex === 0);
            const current = document.activeElement.closest('[data-library-action]');
            const index = controls.indexOf(current);
            e.preventDefault();
            controls[(index + (e.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length]?.focus();
        }
    }
    function action(el, label) {
        el.tabIndex = 0;
        el.dataset.libraryAction = "true";
        el.setAttribute("role", "button");
        if (label) el.setAttribute("aria-label", label);
        el.addEventListener("keydown", e => {
            if (e.target === el && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault(); e.stopPropagation(); el.click();
            }
        });
    }
    backdrop.addEventListener("pointerdown", (e) => {
        if (e.target === backdrop) close();
    });
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    function renderCats() {
        const restoreFocus = catsEl.contains(document.activeElement);
        catsEl.textContent = "";

        const favCount = [...favorites].filter((n) => byName.has(n)).length;
        const favEl = document.createElement("div");
        favEl.textContent = `★ Favorites (${favCount})`;
        if (state.category === FAVORITES) favEl.className = "active";
        favEl.onclick = () => { state.category = FAVORITES; renderCats(); renderList(); };
        catsEl.appendChild(favEl);
        action(favEl);

        const all = document.createElement("div");
        all.textContent = `All (${items.length})`;
        if (state.category === "All") all.className = "active";
        all.onclick = () => { state.category = "All"; renderCats(); renderList(); };
        catsEl.appendChild(all);
        action(all);

        const sortedCats = [...categories].sort((a, b) => a.name.localeCompare(b.name));
        for (const c of sortedCats) {
            const el = document.createElement("div");
            el.textContent = `${c.name} (${c.count})`;
            if (state.category === c.name) el.className = "active";
            el.onclick = () => { state.category = c.name; renderCats(); renderList(); };
            catsEl.appendChild(el);
            action(el);
        }
        if (restoreFocus) catsEl.querySelector('.active')?.focus();
    }

    function renderList() {
        const focused = document.activeElement;
        const focusedRow = focused.closest?.('.e2go-style-list > div');
        const focusName = focusedRow?.dataset.name;
        const focusFavorite = focused.classList?.contains('fav');
        listEl.textContent = "";
        const q = state.query.toLowerCase();
        const numDigits = opts.numbered ? numberQueryDigits(state.query) : null;
        const inFavorites = state.category === FAVORITES;
        for (const it of items) {
            if (inFavorites) {
                if (!favorites.has(it.name)) continue;
            } else if (state.category !== "All" && it.category !== state.category) {
                continue;
            }
            if (numDigits != null) {
                if (it.num == null || !String(it.num).startsWith(numDigits)) continue;
            } else if (q && !it.name.toLowerCase().includes(q)) {
                continue;
            }
            const row = document.createElement("div");
            row.dataset.name = it.name;
            action(row, it.name);
            const check = document.createElement("span");
            check.className = "check";
            const isSel = mode === "multi" ? !!opts.isSelected?.(it) : false;
            check.textContent = mode === "multi" && isSel ? "✓" : "";
            if (mode === "multi") row.setAttribute("aria-pressed", String(isSel));
            row.append(check);
            if (opts.numbered && it.num != null) {
                const numEl = document.createElement("span");
                numEl.className = "num";
                numEl.textContent = `#${it.num}`;
                row.append(numEl);
            }
            const label = document.createElement("span");
            label.textContent = it.name;
            const fav = document.createElement("span");
            const isFav = favorites.has(it.name);
            fav.className = isFav ? "fav on" : "fav";
            fav.textContent = isFav ? "★" : "☆";
            action(fav, `${isFav ? "Remove from" : "Add to"} favorites: ${it.name}`);
            fav.onclick = (e) => {
                e.stopPropagation();
                if (favorites.has(it.name)) {
                    favorites.delete(it.name);
                } else {
                    favorites.add(it.name);
                }
                saveFavorites(favoritesKey, favorites);
                renderList();
                renderCats();
            };
            row.append(label, fav);
            for (const rb of opts.rowButtons?.(it) || []) {
                const btn = document.createElement("span");
                btn.className = "rowbtn";
                btn.textContent = rb.label;
                action(btn, rb.title || rb.label);
                if (rb.title) btn.title = rb.title;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    rb.onClick?.(it, api, btn);
                };
                row.appendChild(btn);
            }
            const tip = opts.tooltipFor?.(it);
            if (tip != null) {
                if (typeof tip.then === "function") {
                    tip.then((val) => { if (val != null) row.title = val; }).catch(() => {});
                } else {
                    row.title = tip;
                }
            }
            const highlighted = mode === "multi" ? isSel : it.name === current;
            if (highlighted) row.className = "selected";
            row.onclick = () => {
                if (lastLocKey) {
                    saveLastLocation(lastLocKey, {
                        category: state.category,
                        scrollTop: listEl.scrollTop,
                    });
                }
                if (mode === "pick") {
                    opts.onPick?.(it.name);
                    close();
                    return;
                }
                opts.onToggleItem?.(it);
                renderList();
                [...listEl.children].find(el => el.dataset.name === it.name)?.focus();
            };
            listEl.appendChild(row);
        }
        if (!listEl.children.length) {
            const empty = document.createElement("p");
            empty.setAttribute("role", "status");
            empty.textContent = "No matches. Try another search or category.";
            listEl.appendChild(empty);
        }
        if (focusName) {
            const row = [...listEl.children].find(el => el.dataset.name === focusName);
            (focusFavorite ? row?.querySelector('.fav') : row)?.focus();
        }
    }

    // Programmatic refresh shared by the ↻ button and headerButtons/rowButtons
    // callbacks (via api.refresh): re-runs onRefresh, re-derives the indexes and
    // re-renders both columns, preserving category (fallback "All") + scroll.
    async function doRefresh() {
        const scrollTop = listEl.scrollTop;
        const fresh = await opts.onRefresh();
        items = Array.isArray(fresh) ? fresh : [];
        byName = new Map(items.map((it) => [it.name, it]));
        counts = new Map();
        for (const it of items) {
            counts.set(it.category, (counts.get(it.category) || 0) + 1);
        }
        categories = [...counts.entries()].map(([name, count]) => ({ name, count }));
        if (state.category !== "All" && state.category !== FAVORITES && !counts.has(state.category)) {
            state.category = "All";
        }
        renderCats();
        renderList();
        listEl.scrollTop = scrollTop;
    }

    const api = { refresh: doRefresh, close };

    if (refreshBtn) {
        refreshBtn.addEventListener("click", async () => {
            refreshBtn.disabled = true;
            const prevLabel = refreshBtn.textContent;
            try {
                await doRefresh();
                refreshBtn.disabled = false;
            } catch (err) {
                console.warn("[e2go modal] refresh failed:", err);
                refreshBtn.textContent = "↻ failed";
                setTimeout(() => {
                    refreshBtn.textContent = prevLabel;
                    refreshBtn.disabled = false;
                }, 1500);
            }
        });
    }

    search.addEventListener("input", () => {
        state.query = search.value;
        if (state.query && state.category !== "All" && state.category !== FAVORITES) {
            state.category = "All";
            renderCats();
        }
        renderList();
    });

    renderCats();
    renderList();
    document.body.appendChild(backdrop);
    // Scroll restore needs the list in the DOM (scrollTop is clamped to 0 on
    // detached elements); best-effort — content may have changed since save.
    if (lastLoc && state.category === lastLoc.category && lastLoc.scrollTop > 0) {
        listEl.scrollTop = lastLoc.scrollTop;
    }
    search.focus();
}
