"""Tests for powder_conditioner._validate_lora_info."""
import pytest
from e2go_nodes.powder_conditioner import _validate_lora_info


class TestValidateLoraInfo:
    def test_pads_short_triggers(self):
        result = _validate_lora_info({"triggers": ["a", "b"], "trigger_position": "after"}, n_prompts=4)
        assert result["triggers"] == ["a", "b", "", ""]
        assert result["trigger_position"] == "after"

    def test_truncates_long_triggers(self):
        result = _validate_lora_info({"triggers": ["a", "b", "c", "d"], "trigger_position": "before"}, n_prompts=2)
        assert result["triggers"] == ["a", "b"]

    def test_non_dict_returns_default(self):
        result = _validate_lora_info("not a dict", n_prompts=3)
        assert result == {"triggers": ["", "", ""], "trigger_position": "after"}

    def test_none_returns_default(self):
        result = _validate_lora_info(None, n_prompts=3)
        assert result == {"triggers": ["", "", ""], "trigger_position": "after"}

    def test_unknown_schema_version_warns_but_parses(self):
        result = _validate_lora_info(
            {"schema_version": 999, "triggers": ["a"], "trigger_position": "after"},
            n_prompts=1,
        )
        assert result["triggers"] == ["a"]

    def test_non_string_trigger_replaced_with_empty(self):
        result = _validate_lora_info(
            {"triggers": ["a", 123, None, "d"], "trigger_position": "after"},
            n_prompts=4,
        )
        assert result["triggers"] == ["a", "", "", "d"]

    def test_unknown_trigger_position_defaults_to_after(self):
        result = _validate_lora_info(
            {"triggers": [], "trigger_position": "weird"},
            n_prompts=1,
        )
        assert result["trigger_position"] == "after"

    def test_non_list_triggers(self):
        result = _validate_lora_info(
            {"triggers": "not_a_list", "trigger_position": "before"},
            n_prompts=2,
        )
        assert result["triggers"] == ["", ""]

    def test_zero_prompts(self):
        result = _validate_lora_info({"triggers": ["a"], "trigger_position": "after"}, n_prompts=0)
        assert result["triggers"] == []

    def test_empty_dict(self):
        result = _validate_lora_info({}, n_prompts=2)
        assert result == {"triggers": ["", ""], "trigger_position": "after"}
