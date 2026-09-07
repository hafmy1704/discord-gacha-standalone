#!/usr/bin/env python3
"""Check all branch/worktree changes against explicit path boundaries."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Sequence


def run_git(repo: Path, args: Sequence[str], check: bool = True) -> str:
    process = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True)
    if check and process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or "git command failed")
    return process.stdout


def optional_git(repo: Path, args: Sequence[str]) -> str | None:
    try:
        value = run_git(repo, args).strip()
        return value or None
    except RuntimeError:
        return None


def norm(path: str) -> str:
    value = path.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:/", value):
        raise ValueError(f"path must be repository-relative: {path!r}")
    parts = [part for part in value.split("/") if part and part != "."]
    if ".." in parts:
        raise ValueError(f"path traversal is not allowed: {path!r}")
    return "/".join(parts).rstrip("/")


def split_nul(value: str) -> list[str]:
    return [norm(item) for item in value.split("\0") if item]


def path_matches(file_name: str, boundary: str) -> bool:
    return file_name == boundary or file_name.startswith(boundary + "/")


def resolve_base(repo: Path, explicit: str | None) -> tuple[str, str]:
    candidates: list[tuple[str, str]] = []
    if explicit:
        candidates.append((explicit, "explicit"))
    else:
        upstream = optional_git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        if upstream:
            candidates.append((upstream, "upstream"))
        origin_head = optional_git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        if origin_head:
            candidates.append((origin_head, "origin-head"))
        candidates.extend([("origin/main", "origin-main"), ("origin/master", "origin-master")])

    for candidate, source in candidates:
        if optional_git(repo, ["rev-parse", "--verify", f"{candidate}^{{commit}}"]):
            merge_base = optional_git(repo, ["merge-base", "HEAD", candidate])
            return merge_base or candidate, source
    if explicit:
        raise RuntimeError(f"comparison ref does not resolve: {explicit}")
    return "HEAD", "working-tree-only"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Repository path")
    parser.add_argument("--base", help="Explicit comparison ref; otherwise auto-detect")
    parser.add_argument("--allow", action="append", default=[], help="Allowed repository-relative path; repeatable")
    parser.add_argument("--forbid", action="append", default=[], help="Forbidden repository-relative path; repeatable")
    parser.add_argument("--report-only", action="store_true", help="Report an unconfigured guard without failing")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    args = parser.parse_args(argv)

    try:
        root = Path(run_git(Path(args.repo).resolve(), ["rev-parse", "--show-toplevel"]).strip()).resolve()
        base, base_source = resolve_base(root, args.base)
        tracked = split_nul(run_git(root, ["diff", "--name-only", "-z", base], check=False))
        untracked = split_nul(run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
        files = sorted(set(tracked + untracked))
        allows = [norm(item) for item in args.allow]
        forbids = [norm(item) for item in args.forbid]
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"diff_scope_guard: {exc}", file=sys.stderr)
        return 2

    if not allows and not forbids:
        result = {
            "status": "UNCONFIGURED",
            "base": base,
            "base_source": base_source,
            "changed_files": files,
            "violations": [],
        }
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"Scope guard: UNCONFIGURED ({len(files)} changed file(s)); declare --allow/--forbid")
            for file_name in files:
                print(f"[UNCONFIGURED] {file_name}")
        return 0 if args.report_only else 2

    violations: list[dict[str, str]] = []
    rows: list[dict[str, str]] = []
    for file_name in files:
        reason = "OK"
        if any(path_matches(file_name, boundary) for boundary in forbids):
            reason = "FORBIDDEN"
        elif allows and not any(path_matches(file_name, boundary) for boundary in allows):
            reason = "OUTSIDE_ALLOW"
        row = {"path": file_name, "status": reason}
        rows.append(row)
        if reason != "OK":
            violations.append(row)

    result = {
        "status": "FAIL" if violations else "PASS",
        "base": base,
        "base_source": base_source,
        "allow": allows,
        "forbid": forbids,
        "changed_files": rows,
        "violations": violations,
    }
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"Comparison base: {base} ({base_source})")
        print(f"Changed files: {len(files)}")
        for row in rows:
            print(f"[{row['status']}] {row['path']}")
        print(f"\nScope guard: {result['status']}" + (f" ({len(violations)} violation(s))" if violations else ""))
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
