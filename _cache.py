"""
Thread-safe LRU cache for e2go_nodes.

Used by powder_lora (_LORA_CACHE) and powder_conditioner (_CONDITIONING_CACHE).
"""

from collections import OrderedDict
import threading
import time


class LRUCache:
    """Simple LRU cache backed by an OrderedDict with a threading lock.

    Optional TTL eviction: entries older than ``ttl_seconds`` (since their last
    write or read) are removed lazily on access.
    """

    __slots__ = ("_maxsize", "_data", "_timestamps", "_ttl", "_lock")

    def __init__(self, maxsize: int = 128, ttl_seconds: float | None = None):
        self._maxsize = maxsize
        self._data: OrderedDict = OrderedDict()
        self._timestamps: dict = {}
        self._ttl = ttl_seconds  # None disables TTL
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def _evict_expired(self) -> None:
        """Remove entries whose last access is older than _ttl. Caller holds _lock."""
        if self._ttl is None:
            return
        now = time.monotonic()
        expired = [k for k, ts in self._timestamps.items() if now - ts > self._ttl]
        for k in expired:
            self._data.pop(k, None)
            self._timestamps.pop(k, None)

    def get(self, key):
        """Return value for *key* (promoting it to most-recent) or None."""
        with self._lock:
            self._evict_expired()
            if key in self._data:
                self._data.move_to_end(key)
                self._timestamps[key] = time.monotonic()
                return self._data[key]
        return None

    def put(self, key, value) -> None:
        """Insert or update *key*; evict LRU entry when full."""
        with self._lock:
            self._evict_expired()
            now = time.monotonic()
            if key in self._data:
                self._data.move_to_end(key)
                self._data[key] = value
            else:
                if len(self._data) >= self._maxsize:
                    oldest_key, _ = self._data.popitem(last=False)
                    self._timestamps.pop(oldest_key, None)
                self._data[key] = value
            self._timestamps[key] = now

    def remove(self, key) -> bool:
        """Remove *key*; return True if it existed."""
        with self._lock:
            if key in self._data:
                del self._data[key]
                self._timestamps.pop(key, None)
                return True
        return False

    def clear(self) -> int:
        """Remove all entries; return count of removed items."""
        with self._lock:
            n = len(self._data)
            self._data.clear()
            self._timestamps.clear()
            return n

    def stats(self) -> dict:
        """Return current cache state for diagnostics."""
        with self._lock:
            return {
                "size": len(self._data),
                "maxsize": self._maxsize,
                "ttl": self._ttl,
            }

    # ------------------------------------------------------------------
    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def __contains__(self, key) -> bool:
        with self._lock:
            return key in self._data
