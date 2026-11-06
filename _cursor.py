"""Per-node batch cursor shared by PowderPromptWildcard and PowderStyler.

Authority for "where the next batch starts" lives here and advances at
EXECUTION time -- not in the client widget (which is only re-read post-exec
and so loses races when several runs are queued before the first finishes).
Access is from the single execution worker plus the reset route's event loop;
dict get/set/pop are atomic under the GIL, so no explicit lock is needed.
The resolve->commit PAIR spans a whole run, so a reset() landing inside it is
protected by a generation check: commit is dropped when the uid was reset
after its resolve (the user's reset wins over the in-flight run).
"""


class CursorStore:
    """In-memory per-node batch cursor, keyed by str(unique_id)."""

    # Backstop against unbounded growth: entries are keyed by every node id
    # ever seen (deleted nodes and foreign workflows included) and there is no
    # natural eviction event. Far above any real workflow's node count.
    _MAX_ENTRIES = 4096

    def __init__(self):
        self._d = {}          # uid -> {"anchor": Any, "pos": int}
        self._gen = {}        # uid -> reset generation (bumped by reset())
        self._seen = {}       # uid -> generation observed at resolve() time
        self._last = {}

    def resolve(self, uid, anchor, reseed=None):
        """Position to run from. Reseed to `reseed` (default: `anchor`) if the
        node is unseen or the user changed the anchor; otherwise continue from
        the stored position."""
        if reseed is None:
            reseed = anchor
        if len(self._d) > self._MAX_ENTRIES:
            # blunt but safe: cursors reseed on the next run of each node
            self._d.clear(); self._gen.clear(); self._seen.clear()
            self._last.clear()
        self._seen[uid] = self._gen.get(uid, 0)
        e = self._d.get(uid)
        if e is None or e["anchor"] != anchor:
            return reseed
        return e["pos"]

    def commit(self, uid, start, next_pos, position=None):
        # A reset() that landed between resolve() and commit() must win:
        # dropping this commit keeps the user's reset instead of silently
        # re-writing the pre-reset position.
        ok = self._seen.get(uid, 0) == self._gen.get(uid, 0)


        self._seen.pop(uid, None)
        self._gen.pop(uid, None)
        if ok:
            self._d[uid] = {"anchor": start, "pos": next_pos}
            if position is not None:
                self._last[uid] = {"anchor": start, "pos": position}

    def last_position(self, uid, anchor, fallback=0):
        entry = self._last.get(uid)
        return entry['pos'] if entry and entry['anchor'] == anchor else fallback

    def replay_all(self, uid, scope=""):
        for key in list(self._last):
            if (key == uid or key.endswith(f':{uid}')) and (not scope or key.startswith(f'{scope}:')):
                self._d[key] = dict(self._last[key])
                self._gen[key] = self._gen.get(key, 0) + 1

    def reset(self, uid):
        self._d.pop(uid, None)
        self._last.pop(uid, None)
        self._gen[uid] = self._gen.get(uid, 0) + 1

    def reset_all(self, uid, scope=""):
        """Reset matching cursor positions and invalidate replay state within the requested scope."""
        suffix = f":{uid}"
        # _seen too: a node in its first-ever run lives only there
        for key in {k for k in (*self._d, *self._gen, *self._seen) if (k == uid or str(k).endswith(suffix)) and (not scope or str(k).startswith(f"{scope}:"))}:
            self.reset(key)
