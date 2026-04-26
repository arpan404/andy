"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Defines the custom exceptions used by the prebuilt tools.
"""

from afk.tools.core.errors import ToolExecutionError


class FileAccessError(ToolExecutionError):
    """Raised when a file access operation fails, such as when a file is not found or a path escapes the allowed root directory."""

    pass
