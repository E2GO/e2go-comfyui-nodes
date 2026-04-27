"""
Centralised logging for e2go_nodes.

Three levels controlled by env var E2GO_LOG_LEVEL:

    quiet        — only warnings and errors
    info  (default) — one summary line per node invocation + warn + error
    debug        — verbose: per-step timings, cache HIT/MISS, slot details

`log(msg)`  — debug-only verbose detail
`info(msg)` — short summary, surfaced at info+ level
`warn(msg)` — always printed
`error(msg)` — always printed
"""
import os

_LEVEL_RAW = os.environ.get("E2GO_LOG_LEVEL", "info").lower()

# Map both legacy ("verbose") and current names to canonical levels.
_LEVEL_MAP = {
    "quiet": 0,
    "warn": 0,
    "warning": 0,
    "info": 1,
    "":   1,
    "debug": 2,
    "verbose": 2,
}

_LEVEL = _LEVEL_MAP.get(_LEVEL_RAW, 1)  # unknown values → info


def log(msg: str) -> None:
    """Verbose detail. Visible only at debug level."""
    if _LEVEL >= 2:
        print(f"[e2go] {msg}")


def info(msg: str) -> None:
    """Short summary. Visible at info and debug levels."""
    if _LEVEL >= 1:
        print(f"[e2go] {msg}")


def warn(msg: str) -> None:
    """Always printed."""
    print(f"[e2go] WARN: {msg}")


def error(msg: str) -> None:
    """Always printed."""
    print(f"[e2go] ERROR: {msg}")
