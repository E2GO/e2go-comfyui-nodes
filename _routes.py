"""
HTTP endpoints for PowderPromptWildcard and PowderStyler.

Registers five routes on ComfyUI's PromptServer (wildcard list/upload/clear,
batch-cursor reset, and styles cursor reset). Idempotent: safe to call
multiple times. Silent no-op if server is unavailable (e.g. in tests).
"""

import json
import asyncio

from ._http import is_json_request
from ._log import warn
from .powder_conditioner import stamp_consumer_modes
from .powder_prompt_wildcard import WildcardLibrary, _CURSOR
from .powder_styler import _STYLE_CURSOR


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

    @routes.get('/e2go/model_profiles')
    async def _model_profiles(request):
        from ._families import MODEL_PROFILES
        return web.json_response(MODEL_PROFILES)

    # PowderConditioner reads the mode of a node downstream of it; the stamp
    # puts that mode into its own inputs so ComfyUI's cache re-runs it.
    def _stamp_prompt(json_data):
        if isinstance(json_data, dict):
            stamp_consumer_modes(json_data.get("prompt"))
        return json_data

    if hasattr(instance, "add_on_prompt_handler"):
        instance.add_on_prompt_handler(_stamp_prompt)

    async def _parse_json_body(request, invalid_json_msg="invalid body"):
        """Read a bounded JSON object and return an HTTP error for invalid requests."""
        if not is_json_request(request.content_type):
            return None, web.json_response({"error": "json required"}, status=400)
        try:
            payload = await request.json()
        except json.JSONDecodeError:
            return None, web.json_response({"error": invalid_json_msg}, status=400)
        except Exception:
            return None, web.json_response({"error": "invalid body"}, status=400)
        return payload, None

    @routes.post("/e2go/canvas/storage")
    async def _canvas_storage(request):
        data, error = await _parse_json_body(request)
        if error is not None:
            return error
        if not isinstance(data, dict) or data.get("action") not in ("scan", "trash", "restore"):
            return web.json_response({"error": "Invalid storage action"}, status=400)
        from . import _canvas_storage as storage
        from .powder_canvas import _canvas_dir
        import folder_paths
        try:
            running, pending = instance.prompt_queue.get_current_queue()
            if data["action"] != "scan" and (running or pending):
                return web.json_response({"error": "Wait until the queue is empty"}, status=409)
            protected = await asyncio.to_thread(storage.protected_files, folder_paths.get_user_directory(), [
                data.get("workflows", []), running, pending, instance.prompt_queue.get_history()
            ])
            directory = _canvas_dir()
            if data["action"] == "scan":
                return web.json_response(await asyncio.to_thread(storage.inventory, directory, protected))
            if data["action"] != "scan":
                running, pending = instance.prompt_queue.get_current_queue()
                if running or pending:
                    return web.json_response({"error": "Wait until the queue is empty"}, status=409)
                protected.update(storage.references(instance.prompt_queue.get_history()))
                selection = data.get("files")
                if not isinstance(selection, list) or not all(isinstance(x, dict) for x in selection):
                    raise ValueError("Invalid file selection")
                storage.move_files(directory, selection, protected, restore=data["action"] == "restore")
            return web.json_response(storage.inventory(directory, protected))
        except (ValueError, OSError, UnicodeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/e2go/wildcards/list")
    async def _list(request):
        try:
            files = WildcardLibrary.list()
            return web.json_response({"files": files})
        except Exception as e:
            warn(f"[e2go routes] /list failed: {e!r}")
            return web.json_response({"error": "internal error"}, status=500)

    @routes.post("/e2go/wildcards/upload")
    async def _upload(request):
        payload, err = await _parse_json_body(request, invalid_json_msg="invalid json")
        if err is not None:
            return err
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

    @routes.post("/e2go/wildcards/cursor/reset")
    async def _cursor_reset(request):
        payload, err = await _parse_json_body(request)
        if err is not None:
            return err
        node_id = payload.get("id") if isinstance(payload, dict) else None
        if node_id is None:
            return web.json_response({"error": "missing id"}, status=400)
        # reset_all: the frontend sends the graph-LOCAL id; inside a subgraph
        # the cursor is keyed by the flattened "outer:inner" execution id.
        _CURSOR.reset_all(str(node_id), str(payload.get("scope", "")))
        return web.json_response({"ok": True})

    @routes.post("/e2go/wildcards/clear")
    async def _wildcards_clear(request):
        # Destructive endpoint: the JSON content-type guard now lives in
        # _parse_json_body (shared by every state-changing route); this one
        # additionally demands an explicit confirm field.
        payload, err = await _parse_json_body(request)
        if err is not None:
            return err
        if not (isinstance(payload, dict) and payload.get("confirm") is True):
            return web.json_response({"error": "missing confirm"}, status=400)
        try:
            removed = WildcardLibrary.clear_local()
            return web.json_response({"ok": True, "removed": removed})
        except Exception as e:
            warn(f"[e2go routes] /wildcards/clear failed: {e!r}")
            return web.json_response({"error": "internal error"}, status=500)

    @routes.post("/e2go/styles/cursor/reset")
    async def _style_cursor_reset(request):
        payload, err = await _parse_json_body(request)
        if err is not None:
            return err
        node_id = payload.get("id") if isinstance(payload, dict) else None
        if node_id is None:
            return web.json_response({"error": "missing id"}, status=400)
        _STYLE_CURSOR.reset_all(str(node_id), str(payload.get("scope", "")))  # subgraph exec ids too, see above
        return web.json_response({"ok": True})

    @routes.post("/e2go/cursor/replay")
    async def _cursor_replay(request):
        payload, err = await _parse_json_body(request)
        if err is not None:
            return err
        if not isinstance(payload, dict) or payload.get("id") is None or payload.get("kind") not in ("styles", "wildcards"):
            return web.json_response({"error": "id and kind required"}, status=400)
        store = _STYLE_CURSOR if payload["kind"] == "styles" else _CURSOR
        store.replay_all(str(payload["id"]), str(payload.get("scope", "")))
        return web.json_response({"ok": True})

    _REGISTERED = True
