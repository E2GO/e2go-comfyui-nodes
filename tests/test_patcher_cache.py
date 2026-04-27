"""Tests for weakref-aware patcher cache."""
import gc
import pytest
from e2go_nodes import powder_lora


@pytest.fixture(autouse=True)
def reset_patcher_cache():
    powder_lora._patcher_entries.clear()
    yield
    powder_lora._patcher_entries.clear()


class FakeModel:
    """Object that supports weakref."""
    pass


class FakeClip:
    pass


class TestPatcherWeakref:
    def test_lookup_miss_on_empty(self):
        m, c = FakeModel(), FakeClip()
        assert powder_lora._patcher_lookup("/p", 1.0, 0.8, 1.0, False, m, c) is None

    def test_store_and_lookup_hit(self):
        m, c = FakeModel(), FakeClip()
        powder_lora._patcher_store("/p", 1.0, 0.8, 1.0, False, m, c, ("model_lora", "clip_lora"))
        result = powder_lora._patcher_lookup("/p", 1.0, 0.8, 1.0, False, m, c)
        assert result == ("model_lora", "clip_lora")

    def test_lookup_misses_after_model_gc(self):
        m, c = FakeModel(), FakeClip()
        powder_lora._patcher_store("/p", 1.0, 0.8, 1.0, False, m, c, ("a", "b"))

        del m
        gc.collect()

        m_new = FakeModel()
        result = powder_lora._patcher_lookup("/p", 1.0, 0.8, 1.0, False, m_new, c)
        assert result is None

    def test_lookup_misses_after_clip_gc(self):
        m, c = FakeModel(), FakeClip()
        powder_lora._patcher_store("/p", 1.0, 0.8, 1.0, False, m, c, ("a", "b"))

        del c
        gc.collect()

        c_new = FakeClip()
        result = powder_lora._patcher_lookup("/p", 1.0, 0.8, 1.0, False, m, c_new)
        assert result is None

    def test_disable_clip_ignores_clip_identity(self):
        m = FakeModel()
        c1, c2 = FakeClip(), FakeClip()
        powder_lora._patcher_store("/p", 1.0, 0.8, 1.0, True, m, c1, ("a", "b"))
        result = powder_lora._patcher_lookup("/p", 1.0, 0.8, 1.0, True, m, c2)
        assert result == ("a", "b")

    def test_different_strength_misses(self):
        m, c = FakeModel(), FakeClip()
        powder_lora._patcher_store("/p", 1.0, 0.8, 1.0, False, m, c, ("a", "b"))
        result = powder_lora._patcher_lookup("/p", 1.0, 0.9, 1.0, False, m, c)
        assert result is None

    def test_eviction_at_maxsize(self):
        original_max = powder_lora._PATCHER_CACHE_MAXSIZE
        try:
            powder_lora._PATCHER_CACHE_MAXSIZE = 3
            models = [FakeModel() for _ in range(4)]
            c = FakeClip()
            for i, m in enumerate(models):
                powder_lora._patcher_store(f"/p{i}", 1.0, 0.8, 1.0, False, m, c, (f"m{i}",))
            assert powder_lora._patcher_lookup("/p0", 1.0, 0.8, 1.0, False, models[0], c) is None
            assert powder_lora._patcher_lookup("/p3", 1.0, 0.8, 1.0, False, models[3], c) is not None
        finally:
            powder_lora._PATCHER_CACHE_MAXSIZE = original_max

    def test_dead_entries_pruned_during_lookup(self):
        m1, m2 = FakeModel(), FakeModel()
        c = FakeClip()
        powder_lora._patcher_store("/p1", 1.0, 0.8, 1.0, False, m1, c, ("a",))
        powder_lora._patcher_store("/p2", 1.0, 0.8, 1.0, False, m2, c, ("b",))
        assert len(powder_lora._patcher_entries) == 2

        del m1
        gc.collect()

        powder_lora._patcher_lookup("/p2", 1.0, 0.8, 1.0, False, m2, c)
        assert len(powder_lora._patcher_entries) == 1
