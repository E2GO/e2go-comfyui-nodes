"""Shared JSON content-type guards for state-changing HTTP routes."""

JSON_CONTENT_TYPE = "application/json"


def is_json_request(content_type) -> bool:
    """True when the request declares a JSON body.

    Every STATE-CHANGING endpoint must require this. aiohttp's `request.json()`
    does NOT check the content type — it parses whatever bytes arrive — and a
    cross-site HTML <form> can only send text/plain, multipart or urlencoded.
    Demanding application/json therefore forces a CORS preflight that ComfyUI
    (shipping without permissive CORS headers by default) never answers, so the
    request dies in the browser instead of mutating the user's library while
    they merely have ComfyUI open in another tab.

    Tolerates a charset parameter ("application/json; charset=utf-8"); aiohttp
    normalizes `request.content_type` itself, but the split keeps the predicate
    correct for any caller.
    """
    if not isinstance(content_type, str):
        return False
    return content_type.split(";")[0].strip().lower() == JSON_CONTENT_TYPE
