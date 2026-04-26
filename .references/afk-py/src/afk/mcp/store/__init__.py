"""
MCP external store package.

Contains external MCP server resolution, tool discovery/calls, and transport/types.
"""

from .registry import MCPStore, get_mcp_store, reset_mcp_store
from .types import (
    MCPRemoteCallError,
    MCPRemoteProtocolError,
    MCPRemoteTool,
    MCPServerRef,
    MCPServerResolutionError,
    MCPStoreError,
)
from .utils import normalize_json_schema

__all__ = [
    "MCPServerRef",
    "MCPRemoteTool",
    "MCPStoreError",
    "MCPServerResolutionError",
    "MCPRemoteProtocolError",
    "MCPRemoteCallError",
    "MCPStore",
    "normalize_json_schema",
    "get_mcp_store",
    "reset_mcp_store",
]
