from __future__ import annotations

from fastapi.testclient import TestClient

from afk.mcp import MCPServer
from afk.tools import ToolRegistry


def test_mcp_endpoint_returns_204_for_jsonrpc_notification():
    registry = ToolRegistry()
    server = MCPServer(registry)
    client = TestClient(server.app)

    response = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "ping",
            "params": {},
        },
    )

    assert response.status_code == 204
    assert response.text == ""
