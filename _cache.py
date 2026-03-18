"""
Thread-safe LRU cache for e2go_nodes.

Used by powder_lora (_LORA_CACHE) and powder_conditioner (_CONDITIONING_CACHE).
"""

from collections import OrderedDict
import threading


class LRUCache:
    """Simple LRU cache backed by an OrderedDict with a threading lock."""

    __slots__ = ("_maxsize", "_data", "_lock")

    def __init__(self, maxsize: int = 128):
        self._maxsize = maxsize
        self._data: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def get(self, key):
        """Return value for *key* (promoting it to most-recent) or None."""
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
        return None

    def put(self, key, value) -> None:
        """Insert or update *key*; evict LRU entry when full."""
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                self._data[key] = value
            else:
                if len(self._data) >= self._maxsize:
                    self._data.popitem(last=False)
                self._data[key] = value

    def remove(self, key) -> bool:
        """Remove *key*; return True if it existed."""
        with self._lock:
            if key in self._data:
                del self._data[key]
                return True
        return False

    def clear(self) -> int:
        """Remove all entries; return count of removed items."""
        with self._lock:
            n = len(self._data)
            self._data.clear()
            return n

    # ------------------------------------------------------------------
    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def __contains__(self, key) -> bool:
        with self._lock:
            return key in self._data
