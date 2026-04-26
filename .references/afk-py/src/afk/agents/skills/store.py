"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Skill loading and caching utilities for `SKILL.md` metadata/content.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from pathlib import Path

from ..errors import SkillResolutionError


@dataclass(frozen=True, slots=True)
class SkillDocument:
    """
    Parsed and cached `SKILL.md` document payload.
    """

    name: str
    description: str
    content: str
    checksum: str
    skill_md_path: str


@dataclass(frozen=True, slots=True)
class _SkillFileCacheEntry:
    """Cached skill document keyed by a filesystem stat signature."""

    stat_signature: tuple[int, int, int]
    doc: SkillDocument


class SkillStore:
    """
    Process-wide store for parsed skill metadata and markdown content.

    Cache invalidation is stat-based (`mtime_ns`, `size`, `inode`).
    """

    def __init__(self) -> None:
        """Initialize internal caches used for parsed skill documents."""
        self._lock = threading.RLock()
        self._file_cache: dict[Path, _SkillFileCacheEntry] = {}
        self._text_pool: dict[str, str] = {}

    def intern_text(self, text: str) -> str:
        """
        Deduplicate text content by SHA-256 hash.
        """
        digest = _sha256_text(text)
        with self._lock:
            cached = self._text_pool.get(digest)
            if cached is not None:
                return cached
            self._text_pool[digest] = text
            return text

    def load_skill_md(self, skill_md_path: Path) -> SkillDocument:
        """
        Read and parse one `SKILL.md` file with stat-based cache invalidation.
        """
        resolved = skill_md_path.resolve()
        if not resolved.exists() or not resolved.is_file():
            raise SkillResolutionError(f"skill file not found: {resolved}")

        stat = resolved.stat()
        # Signature tuple drives cache hit/miss without re-parsing unchanged files.
        signature = (stat.st_mtime_ns, stat.st_size, stat.st_ino)

        with self._lock:
            entry = self._file_cache.get(resolved)
            if entry is not None and entry.stat_signature == signature:
                return entry.doc

        text = resolved.read_text(encoding="utf-8")
        interned = self.intern_text(text)
        metadata = _parse_skill_frontmatter(interned, resolved)
        doc = SkillDocument(
            name=metadata["name"],
            description=metadata["description"],
            content=interned,
            checksum=_sha256_text(interned),
            skill_md_path=str(resolved),
        )

        with self._lock:
            self._file_cache[resolved] = _SkillFileCacheEntry(
                stat_signature=signature,
                doc=doc,
            )

        return doc


def _parse_skill_frontmatter(markdown_text: str, skill_md_path: Path) -> dict[str, str]:
    """Parse required `name` and `description` from YAML frontmatter."""
    lines = markdown_text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillResolutionError(
            f"skill file '{skill_md_path}' must start with YAML frontmatter delimited by '---'"
        )

    header_lines: list[str] = []
    closed = False
    for line in lines[1:]:
        if line.strip() == "---":
            closed = True
            break
        header_lines.append(line)

    if not closed:
        raise SkillResolutionError(
            f"skill file '{skill_md_path}' has unclosed YAML frontmatter"
        )

    parsed: dict[str, str] = {}
    for row in header_lines:
        stripped = row.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in row:
            raise SkillResolutionError(
                f"skill file '{skill_md_path}' has invalid frontmatter row: {row!r}"
            )
        key, value = row.split(":", 1)
        normalized_key = key.strip().lower()
        # Accept quoted or unquoted values while keeping parsing intentionally strict.
        normalized_value = value.strip().strip("\"'")
        if normalized_key in {"name", "description"} and normalized_value:
            parsed[normalized_key] = normalized_value

    missing = [field for field in ("name", "description") if field not in parsed]
    if missing:
        raise SkillResolutionError(
            f"skill file '{skill_md_path}' frontmatter missing required fields: {', '.join(missing)}"
        )

    return parsed


def _sha256_text(text: str) -> str:
    """Return SHA-256 digest for UTF-8 encoded `text`."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


_SKILL_STORE: SkillStore | None = None
_SKILL_STORE_LOCK = threading.Lock()


def get_skill_store() -> SkillStore:
    """
    Return process-wide skill store singleton.
    """
    global _SKILL_STORE
    if _SKILL_STORE is not None:
        return _SKILL_STORE
    with _SKILL_STORE_LOCK:
        if _SKILL_STORE is None:
            _SKILL_STORE = SkillStore()
    return _SKILL_STORE


def reset_skill_store() -> None:
    """
    Reset process-wide skill store singleton.

    Intended for test isolation.
    """
    global _SKILL_STORE
    with _SKILL_STORE_LOCK:
        _SKILL_STORE = None
