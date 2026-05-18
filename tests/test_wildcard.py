"""Tests for powder_prompt_wildcard."""
import pytest
from e2go_nodes.powder_prompt_wildcard import _parse_wildcard_lines


class TestParseWildcardLines:
    def test_empty_string(self):
        assert _parse_wildcard_lines("") == []

    def test_none(self):
        assert _parse_wildcard_lines(None) == []

    def test_non_string(self):
        assert _parse_wildcard_lines(123) == []

    def test_single_line(self):
        assert _parse_wildcard_lines("cat") == ["cat"]

    def test_multi_line(self):
        assert _parse_wildcard_lines("cat\ndog\nbird") == ["cat", "dog", "bird"]

    def test_blank_lines_dropped(self):
        assert _parse_wildcard_lines("cat\n\n\ndog") == ["cat", "dog"]

    def test_whitespace_only_dropped(self):
        assert _parse_wildcard_lines("cat\n   \n\t\ndog") == ["cat", "dog"]

    def test_comment_lines_dropped(self):
        assert _parse_wildcard_lines("# header\ncat\n# trailing") == ["cat"]

    def test_indented_comment_dropped(self):
        assert _parse_wildcard_lines("   # comment\ncat") == ["cat"]

    def test_hash_mid_line_kept(self):
        assert _parse_wildcard_lines("cat # not a comment") == ["cat # not a comment"]

    def test_trailing_newline_no_empty(self):
        assert _parse_wildcard_lines("cat\n") == ["cat"]

    def test_crlf(self):
        assert _parse_wildcard_lines("cat\r\ndog") == ["cat", "dog"]

    def test_strips_lines(self):
        assert _parse_wildcard_lines("  cat  \n\tdog\t") == ["cat", "dog"]


from e2go_nodes.powder_prompt_wildcard import PowderPromptWildcard


class TestGetPrompts:
    def setup_method(self):
        self.node = PowderPromptWildcard()

    def test_empty_returns_single_empty_pair(self):
        pos, neg = self.node.get_prompts("", "")
        assert pos == [""]
        assert neg == [""]

    def test_basic_pair(self):
        pos, neg = self.node.get_prompts("cat\ndog", "blurry")
        assert pos == ["cat", "dog"]
        assert neg == ["blurry", "blurry"]

    def test_negative_replicated_to_positive_count(self):
        pos, neg = self.node.get_prompts("a\nb\nc\nd", "n")
        assert len(neg) == len(pos) == 4
        assert all(x == "n" for x in neg)

    def test_blank_negative_kept_as_blank(self):
        pos, neg = self.node.get_prompts("a\nb", "")
        assert neg == ["", ""]

    def test_negative_stripped(self):
        pos, neg = self.node.get_prompts("a", "  blurry  ")
        assert neg == ["blurry"]

    def test_comments_and_blanks_in_positive(self):
        pos, neg = self.node.get_prompts("# header\n\ncat\n  \n# trailing\ndog\n", "n")
        assert pos == ["cat", "dog"]
        assert neg == ["n", "n"]

    def test_only_comments_returns_single_empty(self):
        pos, neg = self.node.get_prompts("# only\n# comments\n", "ignored")
        assert pos == [""]
        assert neg == [""]

    def test_input_types_shape(self):
        spec = PowderPromptWildcard.INPUT_TYPES()
        assert "required" in spec
        assert "positive_text" in spec["required"]
        assert "negative_text" in spec["required"]
        assert spec["required"]["positive_text"][1].get("multiline") is True
        assert spec["required"]["negative_text"][1].get("multiline") is True

    def test_class_metadata(self):
        assert PowderPromptWildcard.RETURN_TYPES == ("STRING", "STRING")
        assert PowderPromptWildcard.RETURN_NAMES == ("positive_prompts", "negative_prompts")
        assert PowderPromptWildcard.OUTPUT_IS_LIST == (True, True)
        assert PowderPromptWildcard.FUNCTION == "get_prompts"
        assert PowderPromptWildcard.CATEGORY == "e2go_nodes"


from unittest.mock import patch
from pathlib import Path
from e2go_nodes.powder_prompt_wildcard import WildcardLibrary


class TestWildcardLibraryList:
    def _patch_bases(self, tmp_path, with_comfy=False):
        e2go = tmp_path / "e2go" / "wildcards"
        e2go.mkdir(parents=True)
        bases = [("e2go", e2go)]
        if with_comfy:
            comfy = tmp_path / "comfy" / "wildcards"
            comfy.mkdir(parents=True)
            bases.append(("comfy", comfy))
        return bases

    def test_empty_when_no_files(self, tmp_path):
        bases = self._patch_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            assert WildcardLibrary.list() == []

    def test_lists_files_in_e2go_base(self, tmp_path):
        bases = self._patch_bases(tmp_path)
        (bases[0][1] / "animals.txt").write_text("cat\ndog", encoding="utf-8")
        (bases[0][1] / "places.txt").write_text("paris", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            files = WildcardLibrary.list()
        assert files == [
            {"source": "e2go", "name": "animals.txt"},
            {"source": "e2go", "name": "places.txt"},
        ]

    def test_merges_both_bases_sorted_by_source_then_name(self, tmp_path):
        bases = self._patch_bases(tmp_path, with_comfy=True)
        (bases[0][1] / "z_e2go.txt").write_text("x", encoding="utf-8")
        (bases[1][1] / "a_comfy.txt").write_text("x", encoding="utf-8")
        (bases[1][1] / "b_comfy.txt").write_text("x", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            files = WildcardLibrary.list()
        assert files == [
            {"source": "comfy", "name": "a_comfy.txt"},
            {"source": "comfy", "name": "b_comfy.txt"},
            {"source": "e2go", "name": "z_e2go.txt"},
        ]

    def test_ignores_non_txt(self, tmp_path):
        bases = self._patch_bases(tmp_path)
        (bases[0][1] / "good.txt").write_text("x", encoding="utf-8")
        (bases[0][1] / "bad.md").write_text("x", encoding="utf-8")
        (bases[0][1] / "no_ext").write_text("x", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            files = WildcardLibrary.list()
        assert files == [{"source": "e2go", "name": "good.txt"}]

    def test_ignores_subdirs(self, tmp_path):
        bases = self._patch_bases(tmp_path)
        sub = bases[0][1] / "sub"
        sub.mkdir()
        (sub / "nested.txt").write_text("x", encoding="utf-8")
        (bases[0][1] / "top.txt").write_text("x", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            files = WildcardLibrary.list()
        assert files == [{"source": "e2go", "name": "top.txt"}]

    def test_ignores_missing_base(self, tmp_path):
        bases = [
            ("e2go", tmp_path / "does_not_exist"),
            ("comfy", tmp_path / "also_missing"),
        ]
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            assert WildcardLibrary.list() == []

    def test_sort_case_insensitive(self, tmp_path):
        bases = self._patch_bases(tmp_path)
        (bases[0][1] / "Zoo.txt").write_text("x", encoding="utf-8")
        (bases[0][1] / "apple.txt").write_text("x", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            files = WildcardLibrary.list()
        assert [f["name"] for f in files] == ["apple.txt", "Zoo.txt"]


class TestWildcardLibraryRead:
    def _make_bases(self, tmp_path):
        e2go = tmp_path / "e2go" / "wildcards"
        e2go.mkdir(parents=True)
        return [("e2go", e2go)]

    def test_read_existing(self, tmp_path):
        bases = self._make_bases(tmp_path)
        (bases[0][1] / "a.txt").write_text("cat\ndog\n", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            assert WildcardLibrary.read("e2go", "a.txt") == "cat\ndog\n"

    def test_read_not_found(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(FileNotFoundError):
                WildcardLibrary.read("e2go", "missing.txt")

    def test_read_bad_source(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.read("evil", "a.txt")

    def test_read_path_traversal_rejected(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.read("e2go", "../a.txt")

    def test_read_slash_in_name_rejected(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.read("e2go", "sub/a.txt")

    def test_read_backslash_in_name_rejected(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.read("e2go", "sub\\a.txt")

    def test_read_non_txt_rejected(self, tmp_path):
        bases = self._make_bases(tmp_path)
        (bases[0][1] / "x.md").write_text("hello", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.read("e2go", "x.md")

    def test_read_oversize_rejected(self, tmp_path):
        bases = self._make_bases(tmp_path)
        big = bases[0][1] / "big.txt"
        big.write_bytes(b"a" * (WildcardLibrary._MAX_FILE_BYTES + 1))
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.read("e2go", "big.txt")

    def test_read_utf8_replace_on_invalid(self, tmp_path):
        bases = self._make_bases(tmp_path)
        bad = bases[0][1] / "bad.txt"
        bad.write_bytes(b"good\xff\xfeline")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            text = WildcardLibrary.read("e2go", "bad.txt")
        assert "good" in text


import os


class TestWildcardLibraryUpload:
    def _make_bases(self, tmp_path):
        e2go = tmp_path / "e2go" / "wildcards"
        return [("e2go", e2go)]

    def test_upload_creates_folder_and_file(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            result = WildcardLibrary.upload("animals.txt", "cat\ndog\n")
        assert result == {"source": "e2go", "name": "animals.txt"}
        assert (bases[0][1] / "animals.txt").read_text(encoding="utf-8") == "cat\ndog\n"

    def test_upload_overwrites(self, tmp_path):
        bases = self._make_bases(tmp_path)
        bases[0][1].mkdir(parents=True)
        (bases[0][1] / "x.txt").write_text("old", encoding="utf-8")
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            WildcardLibrary.upload("x.txt", "new")
        assert (bases[0][1] / "x.txt").read_text(encoding="utf-8") == "new"

    def test_upload_bad_name(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.upload("../evil.txt", "x")
            with pytest.raises(ValueError):
                WildcardLibrary.upload("sub/x.txt", "x")
            with pytest.raises(ValueError):
                WildcardLibrary.upload("no_ext", "x")
            with pytest.raises(ValueError):
                WildcardLibrary.upload("x.md", "x")
            with pytest.raises(ValueError):
                WildcardLibrary.upload("", "x")

    def test_upload_oversize_rejected(self, tmp_path):
        bases = self._make_bases(tmp_path)
        big = "a" * (WildcardLibrary._MAX_FILE_BYTES + 1)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.upload("big.txt", big)

    def test_upload_non_string_content(self, tmp_path):
        bases = self._make_bases(tmp_path)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(ValueError):
                WildcardLibrary.upload("x.txt", 12345)

    def test_upload_atomic_on_failure(self, tmp_path, monkeypatch):
        """If replace() fails after write, no .tmp file should leak."""
        bases = self._make_bases(tmp_path)
        bases[0][1].mkdir(parents=True)

        def boom(src, dst):
            raise OSError("simulated")
        monkeypatch.setattr(os, "replace", boom)
        with patch.object(WildcardLibrary, "_bases", return_value=bases):
            with pytest.raises(OSError):
                WildcardLibrary.upload("x.txt", "data")
        leftovers = list(bases[0][1].iterdir())
        assert leftovers == [], f"leftover files: {leftovers}"


class TestRoutesImport:
    def test_module_imports(self):
        from e2go_nodes import _routes
        _routes.register()
        _routes.register()
