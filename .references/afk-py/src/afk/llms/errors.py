"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

This module defines custom exceptions for error handling in the llm package.
"""

from __future__ import annotations


class LLMError(Exception):
    """Base exception for all AFK LLM-related errors."""

    pass


class LLMTimeoutError(LLMError):
    """Raised when request or stream timeout constraints are exceeded."""

    pass


class LLMRetryableError(LLMError):
    """
    Transient failures: rate limits, timeouts, provider issues, etc.
    These errors may be retried with backoff.
    """

    pass


class LLMInvalidResponseError(LLMError):
    """
    The LLM returned a response that we couldn't parse or validate.
    This may indicate a schema mismatch, provider issue, or unexpected content.
    """

    pass


class LLMConfigurationError(LLMError):
    """Raised when llm runtime/provider configuration is invalid."""

    pass


class LLMCapabilityError(LLMError):
    """
    Raised when the selected provider adapter does not support a requested
    capability (e.g., embeddings or streaming).
    """

    pass


class LLMCancelledError(LLMError):
    """Raised when an in-flight streaming request is cancelled by caller."""

    pass


class LLMInterruptedError(LLMError):
    """Raised when an in-flight request is interrupted by provider/user action."""

    pass


class LLMSessionError(LLMError):
    """Raised for invalid session lifecycle operations."""

    pass


class LLMSessionPausedError(LLMSessionError):
    """Raised when a session call is attempted while the session is paused."""

    pass
