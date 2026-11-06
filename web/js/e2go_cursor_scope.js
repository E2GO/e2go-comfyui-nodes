// Runtime identities also distinguish two unsaved workflows and subgraphs.
// WeakMaps release closed workflows; no path or shared "unsaved" sentinel.
export function createCursorScopes(makeId = () => crypto.randomUUID()) {
    const owners = new WeakMap();
    const graphs = new WeakMap();
    const session = makeId();
    const id = (map, object) => {
        if (!object || typeof object !== "object") throw new Error("Cursor needs a workflow or graph");
        if (!map.has(object)) map.set(object, makeId());
        return map.get(object);
    };
    return (workflow, graph) => `${session}:${id(owners, workflow || graph)}:${id(graphs, graph)}`;
}

export const cursorScopeFor = createCursorScopes();
