#!/usr/bin/env python3
"""Produce a portable Git checkpoint without assuming a branch name."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Sequence


def run_git(repo: Path, args: Sequence[str], timeout: float, check: bool = True) -> str:
    process = subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if check and process.returncode != 0:
        detail = process.stderr.strip() or process.stdout.strip() or "git command failed"
        raise RuntimeError(f"git {' '.join(args)}: {detail}")
    return process.stdout.strip()


def optional_git(repo: Path, args: Sequence[str], timeout: float) -> str | None:
    try:
        output = run_git(repo, args, timeout)
        return output or None
    except (RuntimeError, subprocess.TimeoutExpired):
        return None


def split_nul(value: str) -> list[str]:
    return [item for item in value.split("\0") if item]


def resolve_comparison_ref(repo: Path, explicit: str | None, timeout: float) -> tuple[str | None, str]:
    candidates: list[tuple[str, str]] = []
    if explicit:
        candidates.append((explicit, "explicit"))
    else:
        upstream = optional_git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], timeout)
        if upstream:
            candidates.append((upstream, "upstream"))
        origin_head = optional_git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], timeout)
        if origin_head:
            candidates.append((origin_head, "origin-head"))
        candidates.extend([("origin/main", "origin-main"), ("origin/master", "origin-master")])

    for candidate, source in candidates:
        if optional_git(repo, ["rev-parse", "--verify", f"{candidate}^{{commit}}"], timeout):
            return candidate, source
    return None, "unavailable"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Repository path (default: current directory)")
    parser.add_argument("--base", help="Explicit comparison ref; otherwise detect upstream/origin default")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    parser.add_argument("--timeout", type=float, default=10.0, help="Per-command timeout in seconds")
    args = parser.parse_args(argv)

    try:
        requested_repo = Path(args.repo).resolve()
        root_text = run_git(requested_repo, ["rev-parse", "--show-toplevel"], args.timeout)
        root = Path(root_text).resolve()
        branch = optional_git(root, ["branch", "--show-current"], args.timeout) or "(detached)"
        head = run_git(root, ["rev-parse", "HEAD"], args.timeout)
        comparison_ref, comparison_source = resolve_comparison_ref(root, args.base, args.timeout)

        merge_base: str | None = None
        ahead: int | None = None
        behind: int | None = None
        if comparison_ref:
            merge_base = optional_git(root, ["merge-base", "HEAD", comparison_ref], args.timeout)
            counts = optional_git(root, ["rev-list", "--left-right", "--count", f"{comparison_ref}...HEAD"], args.timeout)
            if counts:
                left, right = counts.split()
                behind, ahead = int(left), int(right)

        staged = split_nul(run_git(root, ["diff", "--cached", "--name-only", "-z"], args.timeout, check=False))
        unstaged = split_nul(run_git(root, ["diff", "--name-only", "-z"], args.timeout, check=False))
        untracked = split_nul(run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"], args.timeout))

        diff_base = merge_base or "HEAD"
        tracked_since_base = split_nul(
            run_git(root, ["diff", "--name-only", "-z", diff_base], args.timeout, check=False)
        )
        changed_files = sorted(set(tracked_since_base + untracked))
        diff_stat = run_git(root, ["diff", "--stat", diff_base], args.timeout, check=False)
        status = run_git(root, ["status", "--porcelain=v1", "--untracked-files=all"], args.timeout, check=False)

        data = {
            "schema_version": 2,
            "repo": str(root),
            "branch": branch,
            "head": head,
            "comparison_ref": comparison_ref,
            "comparison_source": comparison_source,
            "merge_base": merge_base,
            "ahead": ahead,
            "behind": behind,
            "worktree_clean": not bool(status),
            "changed_files": changed_files,
            "staged_files": sorted(set(staged)),
            "unstaged_files": sorted(set(unstaged)),
            "untracked_files": sorted(set(untracked)),
            "diff_stat": diff_stat,
        }

        if args.json:
            print(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            print("# Git checkpoint")
            print(f"- Repo: `{root}`")
            print(f"- Branch: `{branch}`")
            print(f"- HEAD: `{head}`")
            print(f"- Comparison: `{comparison_ref or 'unavailable'}` ({comparison_source})")
            print(f"- Merge base: `{merge_base or 'unavailable'}`")
            print(f"- Ahead/behind: `{ahead if ahead is not None else 'unknown'}/{behind if behind is not None else 'unknown'}`")
            print(f"- Worktree clean: `{'YES' if data['worktree_clean'] else 'NO'}`")
            if changed_files:
                print("- Changed files:")
                for file_name in changed_files:
                    print(f"  - `{file_name}`")
            if diff_stat:
                print("\n## Diff stat\n\n```text")
                print(diff_stat)
                print("```")
        return 0
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"git_snapshot: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
