# AGENTS.md

Andy is a clean standalone project. AFK is not this repository's git history or worktree base.

## Repository Shape

- Active project code lives outside `.references/`.
- `.references/afk-py/` is a copied source reference from `https://github.com/arpan404/afk`.
- Install AFK as a dependency from GitHub through `uv`; do not import it by path from `.references/afk-py`.
- Keep `.references/afk-py/` read-only unless the task is explicitly to refresh the reference copy.

## Package Management

- Use `uv` for dependency management.
- Add Python dependencies with `uv add`.
- Run project commands with `uv run`.
- Keep the Python version aligned with `.python-version` and `pyproject.toml`.

## Direction

Andy is a friendly, powerful LLM agent product built on top of AFK primitives. The first version should focus on a clean runtime boundary, policy-gated tools, memory, observable execution, and a simple interface for running agents.

## Validation

Run the narrowest useful checks for each change. For current scaffold work, prefer:

```bash
uv sync
uv run andy
```

