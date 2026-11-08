"""Small filesystem guards for user-selected assets and atomic local writes."""

import os
import re
import tempfile


def plain_filename(name):
    """Reject separators, drive/stream syntax and Windows device names on every OS."""
    return (isinstance(name, str) and bool(name) and name not in (".", "..")
            and not re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
            and name == name.rstrip(" .")
            and not re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", name))


def atomic_write(path, content):
    """Replace a file using an exclusively created temporary sibling.

    Never open a predictable temporary name or follow a destination file link.
    The caller owns validation of the destination directory.
    """
    path = os.path.abspath(path)
    fd, temporary = tempfile.mkstemp(prefix=".powder-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
