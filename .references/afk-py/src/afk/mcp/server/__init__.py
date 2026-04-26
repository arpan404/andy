"""
MCP server package.

Contains HTTP app wiring and JSON-RPC protocol handling for local MCP serving.
"""

from .runtime import MCPServer, MCPServerConfig, create_mcp_server

__all__ = [
    "MCPServer",
    "MCPServerConfig",
    "create_mcp_server",
]
