"""
Thread-safe LRU cache for e2go_nodes.

Used by powder_lora (_LORA_CACHE) and powder_conditioner (_CONDITIONING_CACHE).
"""

from collections import OrderedDict
import threading
import time
import sys


def resident_bytes(value, seen=None):
    """Estimate retained payload bytes; tensor views count their whole storage."""
    seen = set() if seen is None else seen
    if id(value) in seen:
        return 0
    seen.add(id(value))
    if hasattr(value, 'untyped_storage'):
        storage = value.untyped_storage()
        key = (str(value.device), storage.data_ptr())
        if key in seen:
            return 0
        seen.add(key)
        return storage.nbytes()
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(resident_bytes(k, seen) + resident_bytes(v, seen) for k, v in value.items())
    elif isinstance(value, (list, tuple, set)):
        size += sum(resident_bytes(v, seen) for v in value)
    return size


class LRUCache:
    """Simple LRU cache backed by an OrderedDict with a threading lock.

    Optional TTL eviction: entries older than ``ttl_seconds`` (since their last
    write or read) are removed lazily on access.
    """

    __slots__ = ("_maxsize", "_data", "_timestamps", "_ttl", "_lock", "_hits", "_misses", "_sizes", "_bytes", "_max_bytes")

    def __init__(self, maxsize: int = 128, ttl_seconds: float | None = None, max_bytes: int | None = None):
        self._maxsize = max(0, int(maxsize))
        self._max_bytes = max_bytes
        self._sizes = {}
        self._bytes = 0
        self._data: OrderedDict = OrderedDict()
        self._timestamps: dict = {}
        self._ttl = ttl_seconds  # None disables TTL
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0

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
            self._bytes -= self._sizes.pop(k, 0)

    def get(self, key):
        """Return value for *key* (promoting it to most-recent) or None."""
        with self._lock:
            self._evict_expired()
            if key in self._data:
                self._data.move_to_end(key)
                self._timestamps[key] = time.monotonic()
                self._hits += 1
                return self._data[key]
            self._misses += 1
        return None

    def put(self, key, value) -> None:
        size = resident_bytes(value) if self._max_bytes is not None else 0
        with self._lock:
            self._evict_expired()
            self._data.pop(key, None)
            self._timestamps.pop(key, None)
            self._bytes -= self._sizes.pop(key, 0)
            if self._maxsize == 0 or (self._max_bytes is not None and size > self._max_bytes):
                return  # Never evict useful entries to cache an oversized payload.
            while self._data and (len(self._data) >= self._maxsize or
                    (self._max_bytes is not None and self._bytes + size > self._max_bytes)):
                oldest, _ = self._data.popitem(last=False)
                self._timestamps.pop(oldest, None)
                self._bytes -= self._sizes.pop(oldest, 0)
            self._data[key] = value
            self._timestamps[key] = time.monotonic()
            self._sizes[key] = size
            self._bytes += size

    def remove(self, key) -> bool:
        """Remove *key*; return True if it existed."""
        with self._lock:
            if key in self._data:
                del self._data[key]
                self._bytes -= self._sizes.pop(key, 0)
                self._timestamps.pop(key, None)
                return True
        return False

    def clear(self) -> int:
        """Remove all entries; return count of removed items."""
        with self._lock:
            n = len(self._data)
            self._data.clear()
            self._sizes.clear()
            self._bytes = 0
            self._timestamps.clear()
            self._hits = 0
            self._misses = 0
            return n

    def stats(self) -> dict:
        """Return current cache state for diagnostics."""
        with self._lock:
            return {
                "size": len(self._data),
                "bytes": self._bytes,
                "max_bytes": self._max_bytes,
                "maxsize": self._maxsize,
                "ttl": self._ttl,
                "hits": self._hits,
                "misses": self._misses,
            }

    # ------------------------------------------------------------------
    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def __contains__(self, key) -> bool:
        with self._lock:
            return key in self._data
