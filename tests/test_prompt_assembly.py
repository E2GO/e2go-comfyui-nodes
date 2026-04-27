"""Tests for powder_conditioner._assemble_prompt and _assemble_negative."""
import pytest
from e2go_nodes.powder_conditioner import _assemble_prompt, _assemble_negative


class TestAssemblePrompt:
    def test_wrap_position(self):
        result = _assemble_prompt(
            prompt="cat", trigger="trigger", style_prefix="pre", style_suffix="suf",
            trigger_position="after", style_position="wrap",
        )
        assert result == "pre, cat, suf, trigger"

    def test_before_position(self):
        result = _assemble_prompt(
            prompt="cat", trigger="trigger", style_prefix="pre", style_suffix="suf",
            trigger_position="after", style_position="before",
        )
        assert result == "pre, suf, cat, trigger"

    def test_after_position(self):
        result = _assemble_prompt(
            prompt="cat", trigger="trigger", style_prefix="pre", style_suffix="suf",
            trigger_position="after", style_position="after",
        )
        assert result == "cat, pre, suf, trigger"

    def test_trigger_before(self):
        result = _assemble_prompt(
            prompt="cat", trigger="trigger", style_prefix="pre", style_suffix="suf",
            trigger_position="before", style_position="wrap",
        )
        assert result == "trigger, pre, cat, suf"

    def test_empty_parts_skipped(self):
        result = _assemble_prompt(
            prompt="cat", trigger="", style_prefix="", style_suffix="",
            trigger_position="after", style_position="wrap",
        )
        assert result == "cat"

    def test_whitespace_only_treated_as_empty(self):
        result = _assemble_prompt(
            prompt="cat", trigger="   ", style_prefix="", style_suffix="",
            trigger_position="after", style_position="wrap",
        )
        assert result == "cat"

    def test_all_empty_returns_empty(self):
        result = _assemble_prompt(
            prompt="", trigger="", style_prefix="", style_suffix="",
            trigger_position="after", style_position="wrap",
        )
        assert result == ""


class TestAssembleNegative:
    def test_combines_user_and_style(self):
        result = _assemble_negative("blurry", "low quality")
        assert result == "blurry, low quality"

    def test_skips_empty(self):
        result = _assemble_negative("blurry", "")
        assert result == "blurry"

    def test_both_empty(self):
        assert _assemble_negative("", "") == ""

    def test_whitespace_only_skipped(self):
        result = _assemble_negative("blurry", "   ")
        assert result == "blurry"
