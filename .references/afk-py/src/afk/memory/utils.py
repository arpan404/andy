"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Utility functions for memory functionality.
"""

import json
import time
import uuid
from typing import Any, cast

from afk.memory.types import JsonValue


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str = "mem") -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def json_dumps(obj: JsonValue | dict[str, Any] | list[Any] | Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def json_loads(s: str) -> JsonValue:
    return cast(JsonValue, json.loads(s))
