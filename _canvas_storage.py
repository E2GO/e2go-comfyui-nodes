"""Reversible cleanup of local Canvas assets. No permanent deletion."""

import json
import re
import time
from pathlib import Path

PNG_REF = re.compile(r"(?<![\w.-])[\w.-]+\.png", re.IGNORECASE)
MIN_AGE = 7 * 86400


def references(value):
    # Includes filenames inside serialized widget JSON and nested subgraphs.
    return set(PNG_REF.findall(json.dumps(value, ensure_ascii=False)))


def protected_files(user_dir, live):
    protected = references(live)
    root = Path(user_dir)
    for path in root.rglob("*.json"):
        if path.is_symlink():
            continue
        # Read failures abort cleanup rather than treating a workflow as unused.
        protected.update(PNG_REF.findall(path.read_text(encoding="utf-8-sig")))
    return protected


def _file(root, name):
    if not isinstance(name, str) or not name or Path(name).name != name or "/" in name or "\\" in name:
        raise ValueError("Invalid Canvas filename")
    path = root / name
    if path.suffix.lower() != ".png" or path.is_symlink() or path.resolve().parent != root.resolve():
        raise ValueError("Invalid Canvas path")
    return path


def inventory(directory, protected, now=None):
    root = Path(directory)
    now = time.time() if now is None else now
    result = {"candidates": [], "trash": [], "protected": 0, "recent": 0}
    for folder, key in [(root, "candidates"), (root / ".trash", "trash")]:
        if not folder.exists():
            continue
        if folder.is_symlink() or folder.resolve() != root.resolve() / (".trash" if key == "trash" else ""):
            raise ValueError("Canvas storage cannot be a symlink")
        for path in sorted(folder.glob("*.png")):
            if path.is_symlink() or not path.is_file():
                continue
            stat = path.stat()
            if key == "candidates":
                if path.name in protected:
                    result["protected"] += 1
                    continue
                if now - stat.st_mtime < MIN_AGE:
                    result["recent"] += 1
                    continue
            # Nanosecond timestamps exceed JavaScript's exact integer range.
            result[key].append({"name": path.name, "size": stat.st_size, "mtime_ns": str(stat.st_mtime_ns)})
    return result


def move_files(directory, selection, protected, restore=False, now=None):
    root = Path(directory)
    if root.is_symlink() or (root / ".trash").resolve() != root.resolve() / ".trash":
        raise ValueError("Canvas storage cannot be a symlink")
    available = {x["name"]: x for x in inventory(root, protected, now)["trash" if restore else "candidates"]}
    source, target = (root / ".trash", root) if restore else (root, root / ".trash")
    moves = []
    for item in selection:
        name = item.get("name")
        src, dst = _file(source, name), _file(target, name)
        if available.get(name) != item:
            raise ValueError("Files changed or became referenced; scan again")
        if dst.exists():
            raise ValueError(f"Destination already exists: {name}")
        if name not in [p[0].name for p in moves]:
            moves.append((src, dst))
    target.mkdir(parents=True, exist_ok=True)
    moved = []
    try:
        for src, dst in moves:
            src.rename(dst)
            moved.append((src, dst))
    except OSError:
        for src, dst in reversed(moved):
            dst.rename(src)
        raise
    return len(moved)
