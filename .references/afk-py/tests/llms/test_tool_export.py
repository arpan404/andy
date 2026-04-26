from __future__ import annotations

import pytest
from pydantic import BaseModel

from afk.llms.tool_export import (
    export_tools_for_provider,
    normalize_json_schema,
    toolspec_to_openai_tool,
)
from afk.tools import ToolRegistry, tool


class EchoArgs(BaseModel):
    text: str


@tool(args_model=EchoArgs, name="echo", description="Echo text")
def echo(args: EchoArgs) -> str:
    return args.text


def test_normalize_json_schema_handles_non_dict_and_missing_fields():
    assert normalize_json_schema("bad") == {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }
    assert normalize_json_schema({}) == {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }
    assert normalize_json_schema({"type": "array"}) == {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }


def test_normalize_json_schema_coerces_invalid_properties_and_required():
    normalized = normalize_json_schema(
        {
            "type": "array",
            "properties": {
                "ok": {"type": "string"},
                "bad": None,
            },
            "required": ["ok", "missing", 123],
            "additionalProperties": "invalid",
        }
    )

    assert normalized["type"] == "object"
    assert normalized["properties"] == {
        "ok": {"type": "string"},
        "bad": {},
    }
    assert normalized["required"] == ["ok"]
    assert normalized["additionalProperties"] is False


def test_toolspec_to_openai_tool_maps_core_fields():
    mapped = toolspec_to_openai_tool(echo.spec)

    assert mapped["type"] == "function"
    assert mapped["function"]["name"] == "echo"
    assert mapped["function"]["description"] == "Echo text"
    assert mapped["function"]["parameters"]["type"] == "object"


def test_export_tools_for_provider_supports_aliases():
    exported_openai = export_tools_for_provider([echo], format="openai")
    exported_litellm = export_tools_for_provider([echo], format="litellm")
    exported_function = export_tools_for_provider([echo], format="function")

    assert exported_openai[0]["function"]["name"] == "echo"
    assert exported_litellm[0]["function"]["name"] == "echo"
    assert exported_function[0]["function"]["name"] == "echo"


def test_export_tools_for_provider_rejects_unknown_format():
    registry = ToolRegistry()
    registry.register(echo)

    with pytest.raises(ValueError, match="Unknown export format"):
        export_tools_for_provider(registry.list(), format="unknown")
