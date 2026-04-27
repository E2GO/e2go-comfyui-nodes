"""Tests for cache key generation functions."""
import pytest
from e2go_nodes.powder_conditioner import _get_cache_key
from e2go_nodes.powder_lora import _get_lora_cache_key


class TestConditioningCacheKey:
    def test_same_inputs_same_key(self):
        k1 = _get_cache_key("clip_abc", "a beautiful cat")
        k2 = _get_cache_key("clip_abc", "a beautiful cat")
        assert k1 == k2

    def test_different_clip_different_key(self):
        k1 = _get_cache_key("clip_abc", "a cat")
        k2 = _get_cache_key("clip_xyz", "a cat")
        assert k1 != k2

    def test_different_prompt_different_key(self):
        k1 = _get_cache_key("clip_abc", "a cat")
        k2 = _get_cache_key("clip_abc", "a dog")
        assert k1 != k2

    def test_format(self):
        k = _get_cache_key("clip_abc", "prompt")
        assert ":" in k
        clip_part, prompt_part = k.split(":", 1)
        assert clip_part == "clip_abc"
        assert len(prompt_part) == 16


class TestLoraCacheKey:
    def test_path_with_mtime(self, tmp_path):
        f = tmp_path / "test.safetensors"
        f.write_text("dummy")
        k1 = _get_lora_cache_key(str(f))
        k2 = _get_lora_cache_key(str(f))
        assert k1 == k2

    def test_missing_file_falls_back(self):
        k = _get_lora_cache_key("/no/such/path.safetensors")
        assert isinstance(k, str)
