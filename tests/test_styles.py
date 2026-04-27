"""Tests for _styles.get_styles + auto-reload."""
import json
import os
import time
import pytest
from unittest.mock import patch

from e2go_nodes import _styles


@pytest.fixture
def reset_styles_state():
    _styles._STYLES_CACHE = []
    _styles._STYLES_BY_NAME_CACHE = {}
    _styles._STYLES_LAST_MTIME = 0.0
    _styles._STYLES_LAST_CHECK = 0.0
    yield
    _styles._STYLES_CACHE = []
    _styles._STYLES_BY_NAME_CACHE = {}
    _styles._STYLES_LAST_MTIME = 0.0
    _styles._STYLES_LAST_CHECK = 0.0


def write_style_file(dir_path, filename, styles):
    path = dir_path / filename
    path.write_text(json.dumps(styles), encoding="utf-8")
    return path


class TestStylesAutoReload:
    def test_initial_load(self, tmp_styles_dir, reset_styles_state):
        write_style_file(tmp_styles_dir, "a.json", [
            {"name": "Style A", "prefix": "pa", "suffix": "sa", "negative": ""},
        ])
        with patch.object(_styles, "get_styles_dir", return_value=str(tmp_styles_dir)):
            all_styles, by_name = _styles.get_styles()
        assert len(all_styles) == 1
        assert "Style A" in by_name

    def test_reload_after_mtime_change(self, tmp_styles_dir, reset_styles_state):
        path = write_style_file(tmp_styles_dir, "a.json", [
            {"name": "Style A", "prefix": "old", "suffix": "", "negative": ""},
        ])
        with patch.object(_styles, "get_styles_dir", return_value=str(tmp_styles_dir)):
            _, by_name = _styles.get_styles()
            assert by_name["Style A"]["prefix"] == "old"

            new_mtime = time.time() + 10
            write_style_file(tmp_styles_dir, "a.json", [
                {"name": "Style A", "prefix": "new", "suffix": "", "negative": ""},
            ])
            os.utime(path, (new_mtime, new_mtime))

            _styles._STYLES_LAST_CHECK = 0.0

            _, by_name = _styles.get_styles()
            assert by_name["Style A"]["prefix"] == "new"

    def test_throttle_prevents_immediate_recheck(self, tmp_styles_dir, reset_styles_state):
        write_style_file(tmp_styles_dir, "a.json", [
            {"name": "A", "prefix": "", "suffix": "", "negative": ""},
        ])
        with patch.object(_styles, "get_styles_dir", return_value=str(tmp_styles_dir)):
            _styles.get_styles()
            initial_check = _styles._STYLES_LAST_CHECK
            time.sleep(0.05)
            _styles.get_styles()
            assert _styles._STYLES_LAST_CHECK == initial_check

    def test_lazy_init_with_throttle_zero_mtime(self, tmp_styles_dir, reset_styles_state):
        write_style_file(tmp_styles_dir, "a.json", [
            {"name": "A", "prefix": "p", "suffix": "", "negative": ""},
        ])
        with patch.object(_styles, "get_styles_dir", return_value=str(tmp_styles_dir)):
            all_styles, _ = _styles.get_styles()
        assert len(all_styles) == 1

    def test_missing_directory_returns_empty(self, tmp_path, reset_styles_state):
        nonexistent = tmp_path / "no_such_dir"
        with patch.object(_styles, "get_styles_dir", return_value=str(nonexistent)):
            all_styles, by_name = _styles.get_styles()
        assert all_styles == []
        assert by_name == {}


class TestScanMtime:
    def test_scan_mtime_empty_dir_returns_zero(self, tmp_path):
        styles_dir = tmp_path / "empty"
        styles_dir.mkdir()
        assert _styles._scan_styles_mtime(str(styles_dir)) == 0.0

    def test_scan_mtime_returns_latest(self, tmp_path):
        styles_dir = tmp_path / "styles"
        styles_dir.mkdir()
        f1 = styles_dir / "a.json"
        f2 = styles_dir / "b.json"
        f1.write_text("[]")
        f2.write_text("[]")
        os.utime(f1, (1000, 1000))
        os.utime(f2, (2000, 2000))
        assert _styles._scan_styles_mtime(str(styles_dir)) == 2000.0

    def test_scan_mtime_ignores_non_json(self, tmp_path):
        styles_dir = tmp_path / "styles"
        styles_dir.mkdir()
        (styles_dir / "a.json").write_text("[]")
        (styles_dir / "readme.md").write_text("hi")
        os.utime(styles_dir / "a.json", (1000, 1000))
        os.utime(styles_dir / "readme.md", (5000, 5000))
        assert _styles._scan_styles_mtime(str(styles_dir)) == 1000.0
