"""Tests for powder_conditioner._get_clip_hash structural fingerprint."""
import torch
import pytest
from e2go_nodes import powder_conditioner


class FakeParam:
    def __init__(self, shape, dtype=torch.float32):
        self.shape = torch.Size(shape) if not isinstance(shape, torch.Size) else shape
        self.dtype = dtype


class FakeCondModel:
    def __init__(self, params):
        self._params = params

    def named_parameters(self):
        for i, p in enumerate(self._params):
            yield f"layer_{i}.weight", p


class FakeClip:
    def __init__(self, cond_stage_model):
        self.cond_stage_model = cond_stage_model


@pytest.fixture(autouse=True)
def reset_hash_refs():
    powder_conditioner._clip_hash_refs.clear()
    yield
    powder_conditioner._clip_hash_refs.clear()


class TestClipHash:
    def test_stable_across_calls(self):
        params = [FakeParam([10, 20]), FakeParam([5])]
        model = FakeCondModel(params)
        clip = FakeClip(model)

        h1 = powder_conditioner._get_clip_hash(clip)
        h2 = powder_conditioner._get_clip_hash(clip)
        assert h1 == h2

    def test_different_shapes_different_hash(self):
        m1 = FakeCondModel([FakeParam([10, 20])])
        m2 = FakeCondModel([FakeParam([10, 30])])
        c1 = FakeClip(m1)
        c2 = FakeClip(m2)

        assert powder_conditioner._get_clip_hash(c1) != powder_conditioner._get_clip_hash(c2)

    def test_different_dtypes_different_hash(self):
        m1 = FakeCondModel([FakeParam([10], dtype=torch.float32)])
        m2 = FakeCondModel([FakeParam([10], dtype=torch.float16)])
        c1 = FakeClip(m1)
        c2 = FakeClip(m2)

        assert powder_conditioner._get_clip_hash(c1) != powder_conditioner._get_clip_hash(c2)

    def test_no_cond_stage_returns_fallback(self):
        clip = FakeClip(None)
        h = powder_conditioner._get_clip_hash(clip)
        assert "no_cond_stage" in h or "fallback" in h

    def test_no_params_returns_marker(self):
        m = FakeCondModel([])
        c = FakeClip(m)
        h = powder_conditioner._get_clip_hash(c)
        assert "no_params" in h or h.startswith("FakeCondModel:")

    def test_weakref_memoisation(self):
        m = FakeCondModel([FakeParam([10])])
        clip = FakeClip(m)
        h1 = powder_conditioner._get_clip_hash(clip)
        h2 = powder_conditioner._get_clip_hash(clip)
        assert h1 == h2
        live_count = sum(1 for ref, _ in powder_conditioner._clip_hash_refs if ref() is not None)
        assert live_count >= 1


class TestIsUnstableClip:
    def test_flux_marker_detected(self):
        class Flux2TEModel_:
            pass
        m = Flux2TEModel_()
        c = FakeClip(m)
        assert powder_conditioner._is_unstable_clip(c) is True

    def test_t5_marker_detected(self):
        class T5Encoder:
            pass
        m = T5Encoder()
        c = FakeClip(m)
        assert powder_conditioner._is_unstable_clip(c) is True

    def test_mixed_precision_marker_detected(self):
        class MixedPrecisionTextEncoder:
            pass
        m = MixedPrecisionTextEncoder()
        c = FakeClip(m)
        assert powder_conditioner._is_unstable_clip(c) is True

    def test_quantized_marker_detected(self):
        class QuantizedCLIP:
            pass
        m = QuantizedCLIP()
        c = FakeClip(m)
        assert powder_conditioner._is_unstable_clip(c) is True

    def test_sdxl_clip_not_unstable(self):
        class SDXLClipModel:
            pass
        m = SDXLClipModel()
        c = FakeClip(m)
        assert powder_conditioner._is_unstable_clip(c) is False

    def test_no_cond_stage_not_unstable(self):
        c = FakeClip(None)
        assert powder_conditioner._is_unstable_clip(c) is False
