from __future__ import annotations

import time
from pathlib import Path

import pytest

from afk.agents.errors import SkillResolutionError
from afk.agents.lifecycle.runtime import resolve_skills
from afk.agents.skills import reset_skill_store


def _write_skill(skill_root: Path, *, name: str, description: str, body: str) -> None:
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        (f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"),
        encoding="utf-8",
    )


def test_resolve_skills_uses_frontmatter_metadata(tmp_path: Path):
    reset_skill_store()
    skills_root = tmp_path / ".agents" / "skills"
    _write_skill(
        skills_root / "folder_name",
        name="resolved-name",
        description="Resolved description",
        body="# Skill",
    )

    resolved = resolve_skills(
        skill_names=["folder_name"],
        skills_dir=skills_root,
        cwd=tmp_path,
    )

    assert len(resolved.resolved_skills) == 1
    skill = resolved.resolved_skills[0]
    assert skill.name == "resolved-name"
    assert skill.description == "Resolved description"


def test_resolve_skills_requires_frontmatter_name_and_description(tmp_path: Path):
    reset_skill_store()
    skills_root = tmp_path / ".agents" / "skills"
    skill_root = skills_root / "bad_skill"
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text("# missing frontmatter\n", encoding="utf-8")

    with pytest.raises(SkillResolutionError):
        resolve_skills(
            skill_names=["bad_skill"],
            skills_dir=skills_root,
            cwd=tmp_path,
        )


def test_skill_store_cache_invalidates_when_skill_md_changes(tmp_path: Path):
    reset_skill_store()
    skills_root = tmp_path / ".agents" / "skills"
    skill_root = skills_root / "cache_skill"

    _write_skill(
        skill_root,
        name="name-v1",
        description="description-v1",
        body="# Skill V1",
    )

    first = resolve_skills(
        skill_names=["cache_skill"],
        skills_dir=skills_root,
        cwd=tmp_path,
    )

    time.sleep(0.002)
    _write_skill(
        skill_root,
        name="name-v2",
        description="description-v2",
        body="# Skill V2",
    )

    second = resolve_skills(
        skill_names=["cache_skill"],
        skills_dir=skills_root,
        cwd=tmp_path,
    )

    assert first.resolved_skills[0].name == "name-v1"
    assert second.resolved_skills[0].name == "name-v2"
    assert first.resolved_skills[0].description == "description-v1"
    assert second.resolved_skills[0].description == "description-v2"
    assert first.resolved_skills[0].checksum != second.resolved_skills[0].checksum
