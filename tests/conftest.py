"""
Shared fixtures for e2go_nodes tests.

Tests run OUTSIDE ComfyUI. Modules that lazy-import comfy.* are safe.
Modules that need stubbing get stubs here.
"""
import os
import sys
import types
import pytest


# Make the package importable: tests live inside the package directory, but
# pytest is invoked from there. The package's parent must be on sys.path so
# that `from e2go_nodes import ...` works.
_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PARENT = os.path.dirname(_PKG_DIR)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)


@pytest.fixture(autouse=True, scope="session")
def stub_optional_comfy_modules():
    """
    Some submodules try to register PromptServer routes at import time.
    The try/except in source code handles this gracefully, but we make
    it explicit and silent.
    """
    if "server" not in sys.modules:
        sys.modules["server"] = types.ModuleType("server")
    if "aiohttp" not in sys.modules:
        aiohttp = types.ModuleType("aiohttp")
        aiohttp.web = types.ModuleType("aiohttp.web")
        sys.modules["aiohttp"] = aiohttp
        sys.modules["aiohttp.web"] = aiohttp.web
    yield


@pytest.fixture
def tmp_styles_dir(tmp_path):
    """Create a temporary styles directory for tests."""
    styles_dir = tmp_path / "styles"
    styles_dir.mkdir()
    return styles_dir
