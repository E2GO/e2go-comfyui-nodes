"""
HTTP endpoints for PowderPromptWildcard.

Registers three routes on ComfyUI's PromptServer. Idempotent: safe to call
multiple times. Silent no-op if server is unavailable (e.g. in tests).
"""

import json

from ._log import warn
from .powder_prompt_wildcard import WildcardLibrary


_REGISTERED = False


def register():
    global _REGISTERED
    if _REGISTERED:
        return
    try:
        from server import PromptServer  # type: ignore
        from aiohttp import web  # type: ignore
    except Exception:
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return
    routes = instance.routes

    @routes.get("/e2go/wildcards/list")
    async def _list(request):
        try:
            files = WildcardLibrary.list()
            return web.json_response({"files": files})
        except Exception as e:
            warn(f"[e2go routes] /list failed: {e!r}")
            return web.json_response({"error": "internal error"}, status=500)

    @routes.get("/e2go/wildcards/get")
    async def _get(request):
        source = request.query.get("source", "")
        name = request.query.get("name", "")
        try:
            content = WildcardLibrary.read(source, name)
            return web.json_response({"content": content})
        except FileNotFoundError:
            return web.json_response({"error": "not found"}, status=404)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            warn(f"[e2go routes] /get failed: {e!r}")
            return web.json_response({"error": "internal error"}, status=500)

    @routes.post("/e2go/wildcards/upload")
    async def _upload(request):
        try:
            payload = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "invalid json"}, status=400)
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        name = payload.get("name", "") if isinstance(payload, dict) else ""
        content = payload.get("content", "") if isinstance(payload, dict) else ""
        try:
            result = WildcardLibrary.upload(name, content)
            return web.json_response(result)
        except ValueError as e:
            msg = str(e)
            status = 413 if "too large" in msg else 400
            return web.json_response({"error": msg}, status=status)
        except Exception as e:
            warn(f"[e2go routes] /upload failed: {e!r}")
            return web.json_response({"error": "internal error"}, status=500)

    _REGISTERED = True
