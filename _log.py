"""
Centralised logging for e2go_nodes.

log()   – verbose, silent unless E2GO_LOG_LEVEL=debug
warn()  – always printed
error() – always printed
"""

import os

_LEVEL = os.environ.get("E2GO_LOG_LEVEL", "").lower()
_VERBOSE = _LEVEL in ("debug", "verbose")


def log(msg: str) -> None:
    """Print only when E2GO_LOG_LEVEL=debug."""
    if _VERBOSE:
        print(f"[e2go] {msg}")


def warn(msg: str) -> None:
    print(f"[e2go] WARN: {msg}")


def error(msg: str) -> None:
    print(f"[e2go] ERROR: {msg}")
