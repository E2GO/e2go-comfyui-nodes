"""Tests for _log level handling."""
import os
import importlib
import pytest


def reload_log_module(env_value=None):
    """Reload _log with a specific E2GO_LOG_LEVEL value."""
    if env_value is None:
        os.environ.pop("E2GO_LOG_LEVEL", None)
    else:
        os.environ["E2GO_LOG_LEVEL"] = env_value
    from e2go_nodes import _log
    importlib.reload(_log)
    return _log


class TestLogLevels:
    def test_default_is_info(self, capsys):
        log_mod = reload_log_module(None)
        log_mod.info("hello")
        log_mod.log("debug detail")
        output = capsys.readouterr().out
        assert "[e2go] hello" in output
        assert "debug detail" not in output

    def test_quiet_suppresses_info(self, capsys):
        log_mod = reload_log_module("quiet")
        log_mod.info("hello")
        log_mod.warn("warning")
        output = capsys.readouterr().out
        assert "hello" not in output
        assert "WARN: warning" in output

    def test_debug_shows_everything(self, capsys):
        log_mod = reload_log_module("debug")
        log_mod.log("verbose")
        log_mod.info("summary")
        output = capsys.readouterr().out
        assert "verbose" in output
        assert "summary" in output

    def test_verbose_alias_for_debug(self, capsys):
        log_mod = reload_log_module("verbose")
        log_mod.log("verbose")
        assert "verbose" in capsys.readouterr().out

    def test_unknown_level_defaults_to_info(self, capsys):
        log_mod = reload_log_module("potato")
        log_mod.info("hello")
        log_mod.log("hidden")
        output = capsys.readouterr().out
        assert "hello" in output
        assert "hidden" not in output

    def test_warn_always_prints(self, capsys):
        log_mod = reload_log_module("quiet")
        log_mod.warn("alert")
        assert "WARN: alert" in capsys.readouterr().out

    def test_error_always_prints(self, capsys):
        log_mod = reload_log_module("quiet")
        log_mod.error("boom")
        assert "ERROR: boom" in capsys.readouterr().out
