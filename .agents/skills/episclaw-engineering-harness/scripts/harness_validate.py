#!/usr/bin/env python3
"""Validate harness metadata, links, reachability, and Python syntax."""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections import deque
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import unquote


ALLOWED_FRONTMATTER = {"name", "description", "license", "allowed-tools", "metadata"}
REQUIRED_FILES = {
    "SKILL.md",
    "references/RISK_TIERS.md",
    "references/OPERATING_GRAPH.md",
    "references/CONTEXT_RESILIENCE.md",
    "references/EVAL_PROTOCOL.md",
    "scripts/mission_graph.py",
    "scripts/eval_cases.py",
    "tests/test_scripts.py",
}
LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
PLACEHOLDER_RE = re.compile(r"\b(?:TODO|FIXME|TBD)\b")
RELATIVE_HELPER_RE = re.compile(r"\bpython(?:3)?\s+[\"']?scripts/", re.IGNORECASE)


def frontmatter(skill_text: str) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    if not skill_text.startswith("---\n"):
        return {}, ["SKILL.md: missing YAML frontmatter"]
    try:
        raw, _body = skill_text[4:].split("\n---\n", 1)
    except ValueError:
        return {}, ["SKILL.md: unterminated YAML frontmatter"]
    try:
        import yaml  # type: ignore

        parsed = yaml.safe_load(raw)
        if not isinstance(parsed, dict):
            return {}, ["SKILL.md: frontmatter must be a mapping"]
        return parsed, errors
    except ImportError:
        parsed: dict[str, Any] = {}
        for line in raw.splitlines():
            if line and not line[0].isspace() and ":" in line:
                key, value = line.split(":", 1)
                parsed[key.strip()] = value.strip().strip('"\'')
        return parsed, errors
    except Exception as exc:
        return {}, [f"SKILL.md: invalid YAML: {exc}"]


def local_markdown_links(path: Path, root: Path) -> list[Path]:
    links: list[Path] = []
    text = path.read_text(encoding="utf-8")
    for match in LINK_RE.finditer(text):
        raw = match.group(1).strip().split(maxsplit=1)[0].strip("<>\"'")
        if not raw or raw.startswith(("#", "http://", "https://", "mailto:")):
            continue
        target_text = unquote(raw.split("#", 1)[0])
        target = (path.parent / target_text).resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise ValueError(f"{path.relative_to(root)}: link escapes harness: {raw}") from exc
        links.append(target)
    return links


def validate(root: Path) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    skill_path = root / "SKILL.md"
    for required in sorted(REQUIRED_FILES):
        if not (root / required).is_file():
            errors.append(f"missing required file: {required}")
    if not skill_path.is_file():
        return {"status": "FAIL", "errors": errors or ["missing SKILL.md"], "warnings": warnings}

    skill_text = skill_path.read_text(encoding="utf-8")
    metadata, metadata_errors = frontmatter(skill_text)
    errors.extend(metadata_errors)
    unknown = set(metadata) - ALLOWED_FRONTMATTER
    if unknown:
        errors.append(f"SKILL.md: unsupported frontmatter keys: {', '.join(sorted(unknown))}")
    name = metadata.get("name")
    description = metadata.get("description")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        errors.append("SKILL.md: name must be lowercase hyphen-case and at most 64 characters")
    elif root.name != name:
        errors.append(f"folder name {root.name!r} does not match skill name {name!r}")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        errors.append("SKILL.md: description must be non-empty and at most 1024 characters")

    markdown_files = sorted(root.rglob("*.md"))
    link_graph: dict[Path, list[Path]] = {}
    for path in markdown_files:
        text = path.read_text(encoding="utf-8")
        if PLACEHOLDER_RE.search(text):
            errors.append(f"{path.relative_to(root)}: unresolved placeholder token")
        if RELATIVE_HELPER_RE.search(text):
            errors.append(f"{path.relative_to(root)}: helper path must resolve from <skill-root>")
        try:
            targets = local_markdown_links(path, root)
        except ValueError as exc:
            errors.append(str(exc))
            targets = []
        link_graph[path] = targets
        for target in targets:
            if not target.exists():
                errors.append(f"{path.relative_to(root)}: broken link to {target.relative_to(root)}")

    reachable: set[Path] = set()
    queue: deque[Path] = deque([skill_path.resolve()])
    while queue:
        current = queue.popleft()
        if current in reachable:
            continue
        reachable.add(current)
        for target in link_graph.get(current, []):
            if target.suffix.lower() == ".md" and target not in reachable:
                queue.append(target)
    for reference in sorted((root / "references").glob("*.md")):
        if reference.resolve() not in reachable:
            errors.append(f"unreachable reference from SKILL.md: {reference.relative_to(root)}")

    python_files = sorted((root / "scripts").glob("*.py")) + sorted((root / "tests").glob("*.py"))
    for path in python_files:
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:
            errors.append(f"{path.relative_to(root)}:{exc.lineno}: Python syntax error: {exc.msg}")

    eval_file = root / "evals" / "cases.json"
    if eval_file.exists():
        try:
            cases = json.loads(eval_file.read_text(encoding="utf-8"))
            scripts_path = str((root / "scripts").resolve())
            if scripts_path not in sys.path:
                sys.path.insert(0, scripts_path)
            from eval_cases import validate_cases

            errors.extend(f"evals/cases.json: {error}" for error in validate_cases(cases))
        except json.JSONDecodeError as exc:
            errors.append(f"evals/cases.json: invalid JSON: {exc.msg}")
        except (ImportError, OSError) as exc:
            errors.append(f"evals/cases.json: validator unavailable: {exc}")
    else:
        warnings.append("evals/cases.json is absent; behavior evaluation is not packaged")

    return {
        "status": "FAIL" if errors else "PASS",
        "root": str(root),
        "markdown_files": len(markdown_files),
        "python_files": len(python_files),
        "reachable_markdown": len(reachable),
        "errors": errors,
        "warnings": warnings,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = validate(Path(args.root).resolve())
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"Harness validation: {result['status']}")
        for error in result["errors"]:
            print(f"[ERROR] {error}")
        for warning in result["warnings"]:
            print(f"[WARN] {warning}")
        if result["status"] == "PASS":
            print(f"Checked {result['markdown_files']} Markdown and {result['python_files']} Python files")
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
