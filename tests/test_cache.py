"""Tests for _cache.LRUCache."""
import time
import pytest
from e2go_nodes._cache import LRUCache


class TestLRUBasics:
    def test_get_missing_returns_none(self):
        c = LRUCache(maxsize=3)
        assert c.get("missing") is None

    def test_put_get_roundtrip(self):
        c = LRUCache(maxsize=3)
        c.put("k", "v")
        assert c.get("k") == "v"

    def test_overflow_evicts_lru(self):
        c = LRUCache(maxsize=2)
        c.put("a", 1)
        c.put("b", 2)
        c.put("c", 3)
        assert c.get("a") is None
        assert c.get("b") == 2
        assert c.get("c") == 3

    def test_get_promotes_to_recent(self):
        c = LRUCache(maxsize=2)
        c.put("a", 1)
        c.put("b", 2)
        c.get("a")
        c.put("c", 3)
        assert c.get("a") == 1
        assert c.get("b") is None
        assert c.get("c") == 3

    def test_remove_returns_true_when_present(self):
        c = LRUCache(maxsize=3)
        c.put("k", "v")
        assert c.remove("k") is True
        assert c.get("k") is None

    def test_remove_returns_false_when_missing(self):
        c = LRUCache(maxsize=3)
        assert c.remove("missing") is False

    def test_clear_returns_count(self):
        c = LRUCache(maxsize=3)
        c.put("a", 1)
        c.put("b", 2)
        assert c.clear() == 2
        assert len(c) == 0

    def test_len(self):
        c = LRUCache(maxsize=3)
        assert len(c) == 0
        c.put("a", 1)
        assert len(c) == 1

    def test_contains(self):
        c = LRUCache(maxsize=3)
        c.put("a", 1)
        assert "a" in c
        assert "b" not in c


class TestLRUWithTTL:
    def test_no_ttl_default(self):
        c = LRUCache(maxsize=3)
        c.put("k", "v")
        time.sleep(0.05)
        assert c.get("k") == "v"

    def test_ttl_expires_entry(self):
        c = LRUCache(maxsize=3, ttl_seconds=0.1)
        c.put("k", "v")
        time.sleep(0.2)
        assert c.get("k") is None

    def test_ttl_resets_on_get(self):
        c = LRUCache(maxsize=3, ttl_seconds=0.3)
        c.put("k", "v")
        time.sleep(0.15)
        assert c.get("k") == "v"
        time.sleep(0.2)
        assert c.get("k") == "v"

    def test_ttl_resets_on_put(self):
        c = LRUCache(maxsize=3, ttl_seconds=0.3)
        c.put("k", "v1")
        time.sleep(0.15)
        c.put("k", "v2")
        time.sleep(0.2)
        assert c.get("k") == "v2"

    def test_eviction_cleans_timestamps(self):
        c = LRUCache(maxsize=2, ttl_seconds=10.0)
        c.put("a", 1)
        c.put("b", 2)
        c.put("c", 3)
        assert len(c._timestamps) == 2
        assert "a" not in c._timestamps


class TestLRUStats:
    def test_stats_shape(self):
        c = LRUCache(maxsize=10, ttl_seconds=60)
        c.put("a", 1)
        c.put("b", 2)
        s = c.stats()
        assert s["size"] == 2
        assert s["maxsize"] == 10
        assert s["ttl"] == 60

    def test_stats_no_ttl(self):
        c = LRUCache(maxsize=10)
        s = c.stats()
        assert s["ttl"] is None
