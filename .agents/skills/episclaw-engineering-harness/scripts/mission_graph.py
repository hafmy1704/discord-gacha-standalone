#!/usr/bin/env python3
"""Persist, checkpoint, and rehydrate an evidence-referenced mission graph."""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import errno
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Sequence


SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1
TIERS = ("light", "standard", "high")
STATES = (
    "preflight", "contract", "investigate", "red", "implement",
    "regression", "review", "closeout", "complete", "blocked",
)
EDGES: dict[str, set[str]] = {
    "preflight": {"contract", "investigate", "review", "closeout", "blocked"},
    "investigate": {"contract", "closeout", "blocked"},
    "contract": {"red", "implement", "blocked"},
    "red": {"implement", "blocked"},
    "implement": {"regression", "blocked"},
    "regression": {"implement", "review", "closeout", "blocked"},
    "review": {"implement", "closeout", "blocked"},
    "closeout": {"complete", "blocked"},
    "complete": set(),
    "blocked": {"preflight"},
}
CAPSULE_SCALARS = (
    "requested_behavior", "divergence_or_hypothesis", "responsible_seam", "next_safe_action",
)
CAPSULE_LISTS = (
    "normative_authority", "descriptive_truth", "invariants", "in_scope", "out_of_scope",
    "required_proof", "owner_gates", "decisions", "rejected_alternatives", "open_findings",
)
MISSION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def default_capsule() -> dict[str, Any]:
    capsule: dict[str, Any] = {field: "" for field in CAPSULE_SCALARS}
    capsule.update({field: [] for field in CAPSULE_LISTS})
    return capsule


def validate_mission_id(value: Any) -> str:
    if not isinstance(value, str) or not MISSION_ID_RE.fullmatch(value):
        raise ValueError("mission_id must use 1-128 letters, digits, dot, underscore, or hyphen")
    return value


def validate_capsule_update(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("context file must contain a JSON object")
    allowed = set(CAPSULE_SCALARS + CAPSULE_LISTS)
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unknown capsule field(s): {', '.join(unknown)}")
    result: dict[str, Any] = {}
    for field, item in value.items():
        if field in CAPSULE_SCALARS:
            if not isinstance(item, str):
                raise ValueError(f"capsule field {field} must be a string")
            result[field] = item.strip()
        else:
            if not isinstance(item, list) or any(not isinstance(entry, str) for entry in item):
                raise ValueError(f"capsule field {field} must be a list of strings")
            result[field] = [entry.strip() for entry in item if entry.strip()]
    return result


def read_context_file(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    context_path = Path(path).resolve()
    try:
        value = json.loads(context_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"context file does not exist: {context_path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid context JSON: {exc.msg}") from exc
    return validate_capsule_update(value)


def merge_capsule(current: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    merged = default_capsule()
    merged.update(current)
    merged.update(update)
    return validate_capsule_update(merged)


def migrate_state(state: dict[str, Any]) -> dict[str, Any]:
    schema = state.get("schema_version")
    if schema == LEGACY_SCHEMA_VERSION:
        migrated = dict(state)
        migrated["schema_version"] = SCHEMA_VERSION
        migrated["revision"] = max(0, len(migrated.get("history", [])) - 1)
        migrated["capsule"] = default_capsule()
        migrated["checkpoint"] = None
        migrated["checkpoint_count"] = 0
        for index, entry in enumerate(migrated.get("history", [])):
            if isinstance(entry, dict) and index:
                entry.setdefault("revision", index)
        return migrated
    if schema == SCHEMA_VERSION:
        migrated = dict(state)
        migrated["history"] = [dict(entry) if isinstance(entry, dict) else entry for entry in state.get("history", [])]
        inferred_revision = 0
        for index, entry in enumerate(migrated["history"]):
            if not index or not isinstance(entry, dict):
                continue
            if "revision" not in entry:
                inferred_revision += 1
                entry["revision"] = inferred_revision
            elif type(entry["revision"]) is int:
                inferred_revision = entry["revision"]
        return migrated
    if schema != SCHEMA_VERSION:
        raise ValueError("unsupported mission schema")
    raise AssertionError("unreachable")


def validate_state(state: dict[str, Any]) -> dict[str, Any]:
    validate_mission_id(state.get("mission_id"))
    if state.get("tier") not in TIERS or state.get("state") not in STATES:
        raise ValueError("mission contains an invalid tier or state")
    history = state.get("history")
    if not isinstance(history, list) or not history:
        raise ValueError("mission history must be a non-empty list")
    if type(state.get("revision")) is not int or state["revision"] < 0:
        raise ValueError("mission revision must be a non-negative integer")
    state["capsule"] = merge_capsule(default_capsule(), state.get("capsule", {}))
    checkpoint_count = state.get("checkpoint_count", 0)
    if type(checkpoint_count) is not int or checkpoint_count < 0:
        raise ValueError("mission checkpoint_count must be a non-negative integer")
    state.setdefault("checkpoint_count", 0)
    previous_target: str | None = None
    previous_revision = 0
    derived_blocked_from: str | None = None
    visited: set[str] = set()
    for index, entry in enumerate(history):
        if not isinstance(entry, dict):
            raise ValueError(f"mission history entry {index} must be an object")
        target = entry.get("to")
        source = entry.get("from")
        if target not in STATES or (source is not None and source not in STATES):
            raise ValueError(f"mission history entry {index} has an invalid state")
        if index == 0:
            if source is not None or target != "preflight":
                raise ValueError("mission history must begin at preflight")
        else:
            revision = entry.get("revision")
            if type(revision) is not int or revision <= previous_revision or revision > state["revision"]:
                raise ValueError(f"mission history entry {index} has an invalid revision")
            if source != previous_target:
                raise ValueError(f"mission history entry {index} does not continue the prior state")
            allowed = target in EDGES[source]
            if source == "blocked" and target == derived_blocked_from:
                allowed = True
            if source == "regression" and target == "closeout" and state["tier"] != "light":
                allowed = False
            if source == "closeout" and target == "complete" and state["tier"] in {"standard", "high"} and "review" not in visited:
                allowed = False
            if not allowed:
                raise ValueError(f"mission history entry {index} has an illegal transition: {source} -> {target}")
            if target == "blocked":
                derived_blocked_from = source
            elif source == "blocked":
                derived_blocked_from = None
            previous_revision = revision
        if not isinstance(entry.get("ts"), str) or not isinstance(entry.get("note", ""), str):
            raise ValueError(f"mission history entry {index} has invalid metadata")
        evidence = entry.get("evidence", [])
        if not isinstance(evidence, list) or any(not isinstance(item, str) for item in evidence):
            raise ValueError(f"mission history entry {index} evidence must be a list of strings")
        previous_target = target
        visited.add(target)
    if previous_target != state["state"]:
        raise ValueError("mission state does not match the latest history entry")
    if state.get("previous_state") != history[-1].get("from"):
        raise ValueError("mission previous_state does not match the latest history entry")
    expected_blocked_from = derived_blocked_from if state["state"] == "blocked" else None
    if state.get("blocked_from") != expected_blocked_from:
        raise ValueError("mission blocked_from does not match the persisted blocked origin")
    expected_revision = len(history) - 1 + checkpoint_count
    if state["revision"] != expected_revision:
        raise ValueError(f"mission revision is incoherent: expected {expected_revision}, observed {state['revision']}")
    checkpoint = state.get("checkpoint")
    if checkpoint is None:
        if checkpoint_count:
            raise ValueError("mission checkpoint_count is nonzero without a checkpoint")
    elif not isinstance(checkpoint, dict):
        raise ValueError("mission checkpoint must be an object or null")
    else:
        required = {
            "checkpoint_id", "ts", "mission_revision", "state", "capsule_sha256",
            "repository", "ledger", "evidence", "note", "capsule_gaps",
        }
        if set(checkpoint) != required:
            raise ValueError("mission checkpoint fields do not match schema")
        mission_revision = checkpoint.get("mission_revision")
        if type(mission_revision) is not int or not 0 <= mission_revision <= state["revision"]:
            raise ValueError("mission checkpoint has an invalid mission_revision")
        if checkpoint.get("state") not in STATES:
            raise ValueError("mission checkpoint has an invalid state")
        if not isinstance(checkpoint.get("checkpoint_id"), str) or not checkpoint["checkpoint_id"]:
            raise ValueError("mission checkpoint_id must be a non-empty string")
        if not isinstance(checkpoint.get("ts"), str):
            raise ValueError("mission checkpoint timestamp must be a string")
        if not isinstance(checkpoint.get("capsule_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", checkpoint["capsule_sha256"]):
            raise ValueError("mission checkpoint capsule_sha256 is invalid")
        if checkpoint.get("repository") is not None and not isinstance(checkpoint["repository"], dict):
            raise ValueError("mission checkpoint repository must be an object or null")
        if checkpoint.get("ledger") is not None and not isinstance(checkpoint["ledger"], dict):
            raise ValueError("mission checkpoint ledger must be an object or null")
        for field in ("evidence", "capsule_gaps"):
            if not isinstance(checkpoint.get(field), list) or any(not isinstance(item, str) for item in checkpoint[field]):
                raise ValueError(f"mission checkpoint {field} must be a list of strings")
        if not isinstance(checkpoint.get("note"), str):
            raise ValueError("mission checkpoint note must be a string")
        if checkpoint_count < 1:
            raise ValueError("mission checkpoint_count must be positive when a checkpoint exists")
    return state


def read_state(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"mission file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid mission JSON: {exc.msg}") from exc
    if not isinstance(raw, dict):
        raise ValueError("mission state must be a JSON object")
    return validate_state(migrate_state(raw))


def write_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(state, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if os.name == "nt":
            import ctypes

            move_file = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
            move_file.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
            move_file.restype = ctypes.c_int
            if not move_file(str(temporary), str(path), 0x1 | 0x8):  # REPLACE_EXISTING | WRITE_THROUGH
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _try_file_lock(handle: Any) -> bool:
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError as exc:
        if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
            return False
        raise


def _unlock_file(handle: Any) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def mission_lock(path: Path, timeout: float = 10.0, stale_after: float = 120.0) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(path) + ".lock")
    _ = stale_after  # Compatibility only: OS-held locks do not use age-based reclamation.
    deadline = time.monotonic() + timeout
    handle = lock_path.open("a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
        os.fsync(handle.fileno())
    acquired = False
    try:
        while not acquired:
            acquired = _try_file_lock(handle)
            if not acquired:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out waiting for mission lock: {lock_path}")
                time.sleep(0.05)
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} token={uuid.uuid4()} ts={time.time()}\n".encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        if acquired:
            _unlock_file(handle)
        handle.close()


def check_expected_revision(state: dict[str, Any], expected: int | None) -> None:
    if expected is not None and state["revision"] != expected:
        raise ValueError(f"revision conflict: expected {expected}, observed {state['revision']}")


def has_visited(state: dict[str, Any], target: str) -> bool:
    return any(entry.get("to") == target for entry in state["history"])


def validate_transition(state: dict[str, Any], target: str) -> None:
    current = state["state"]
    if target not in STATES:
        raise ValueError(f"unknown target state: {target}")
    if current == "blocked" and target == state.get("blocked_from"):
        return
    if target not in EDGES[current]:
        raise ValueError(f"invalid transition: {current} -> {target}")
    if current == "regression" and target == "closeout" and state["tier"] != "light":
        raise ValueError("STANDARD/HIGH missions must pass through REVIEW before CLOSEOUT")
    if current == "closeout" and target == "complete" and state["tier"] in {"standard", "high"}:
        if not has_visited(state, "review"):
            raise ValueError("STANDARD/HIGH missions cannot complete without visiting REVIEW")


def capsule_gaps(state: dict[str, Any]) -> list[str]:
    capsule = state["capsule"]
    if state["tier"] == "light":
        required = ("requested_behavior", "next_safe_action")
    else:
        required = (
            "requested_behavior", "normative_authority", "descriptive_truth", "in_scope",
            "out_of_scope", "required_proof", "next_safe_action",
        )
    if state["state"] not in {"preflight", "investigate", "blocked"}:
        required += ("responsible_seam", "invariants")
    if state["state"] == "investigate":
        required += ("divergence_or_hypothesis",)
    return [field for field in required if not capsule.get(field)]


def _run_git(repo: Path, args: Sequence[str], check: bool = True) -> bytes:
    process = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, timeout=15)
    if check and process.returncode != 0:
        detail = (process.stderr or process.stdout).decode("utf-8", "replace").strip() or "git command failed"
        raise RuntimeError(f"git {' '.join(args)}: {detail}")
    return process.stdout


def _has_git_marker(path: Path) -> bool:
    candidate = path.resolve()
    if candidate.is_file():
        candidate = candidate.parent
    return any((parent / ".git").exists() for parent in (candidate, *candidate.parents))


def _git_worktree_root(repo: Path) -> bytes | None:
    try:
        value = _run_git(repo, ["rev-parse", "--show-toplevel"])
        return value.strip() or None
    except RuntimeError:
        if _has_git_marker(repo):
            raise
        return None


def _split_nul(value: bytes) -> list[str]:
    return [item.decode("utf-8", "surrogateescape") for item in value.split(b"\0") if item]


def _hash_path(hasher: Any, root: Path, relative: str, excluded: set[Path]) -> None:
    candidate = root / relative
    try:
        absolute = candidate.absolute()
        if absolute in excluded:
            hasher.update(b"excluded\0" + relative.encode("utf-8", "surrogateescape") + b"\0")
            return
        metadata = candidate.lstat()
        hasher.update(relative.encode("utf-8", "surrogateescape") + b"\0")
        if stat.S_ISLNK(metadata.st_mode):
            hasher.update(b"symlink\0" + os.readlink(candidate).encode("utf-8", "surrogateescape") + b"\0")
        elif stat.S_ISREG(metadata.st_mode):
            hasher.update(f"file-mode:{stat.S_IMODE(metadata.st_mode)}\0".encode("ascii"))
            with candidate.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
        else:
            hasher.update(f"mode:{metadata.st_mode}\0".encode("ascii"))
    except FileNotFoundError:
        hasher.update(b"missing\0" + relative.encode("utf-8", "surrogateescape") + b"\0")


def git_snapshot(repo: Path, excluded: set[Path]) -> dict[str, Any] | None:
    root_raw = _git_worktree_root(repo)
    if not root_raw:
        return None
    root = Path(root_raw.decode("utf-8", "surrogateescape")).resolve()
    head_raw = _run_git(root, ["rev-parse", "HEAD"])
    branch_raw = _run_git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    unstaged_names = _split_nul(_run_git(root, ["diff", "--name-only", "-z"]))
    staged_names = _split_nul(_run_git(root, ["diff", "--cached", "--name-only", "-z"]))
    tracked = [
        relative for relative in _split_nul(_run_git(root, ["ls-files", "-z"]))
        if (root / relative).absolute() not in excluded
    ]
    untracked = [
        relative for relative in _split_nul(_run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
        if (root / relative).absolute() not in excluded
    ]
    hasher = hashlib.sha256()
    for record in _run_git(root, ["ls-files", "--stage", "-z"]).split(b"\0"):
        if not record:
            continue
        _, separator, raw_path = record.partition(b"\t")
        if not separator:
            raise RuntimeError("git ls-files --stage returned an invalid record")
        relative = raw_path.decode("utf-8", "surrogateescape")
        if (root / relative).absolute() not in excluded:
            hasher.update(b"index\0" + record + b"\0")
    for record in _run_git(root, ["ls-files", "-v", "-z"]).split(b"\0"):
        if not record:
            continue
        _, separator, raw_path = record.partition(b" ")
        if not separator:
            raise RuntimeError("git ls-files -v returned an invalid record")
        relative = raw_path.decode("utf-8", "surrogateescape")
        if (root / relative).absolute() not in excluded:
            hasher.update(b"index-flags\0" + record + b"\0")
    for relative in sorted(set(tracked)):
        _hash_path(hasher, root, relative, excluded)
    for relative in sorted(untracked):
        _hash_path(hasher, root, relative, excluded)
    submodules = _run_git(root, ["submodule", "status", "--recursive"])
    hasher.update(b"submodules\0" + submodules + b"\0")
    changed = sorted(
        relative for relative in set(unstaged_names + staged_names + untracked)
        if (root / relative).absolute() not in excluded
    )
    branch = branch_raw.decode("utf-8", "replace").strip()
    return {
        "kind": "git", "root": str(root),
        "head": head_raw.decode("ascii").strip(),
        "branch": "(detached)" if branch == "HEAD" else branch,
        "worktree_digest": hasher.hexdigest(), "changed_files": changed[:200],
        "changed_files_truncated": len(changed) > 200, "captured_at": utc_now(),
    }


def filesystem_snapshot(root: Path, excluded: set[Path]) -> dict[str, Any]:
    if not root.is_dir():
        raise ValueError(f"non-Git snapshot root is not a directory: {root}")
    hasher = hashlib.sha256()
    files: list[str] = []
    for candidate in sorted(root.rglob("*"), key=lambda item: str(item).casefold()):
        absolute = candidate.absolute()
        if absolute in excluded:
            continue
        if not candidate.is_symlink() and candidate.is_dir():
            continue
        relative = candidate.relative_to(root).as_posix()
        files.append(relative)
        _hash_path(hasher, root, relative, excluded)
    return {
        "kind": "filesystem", "root": str(root), "head": None, "branch": None,
        "worktree_digest": hasher.hexdigest(), "changed_files": files[:200],
        "changed_files_truncated": len(files) > 200, "captured_at": utc_now(),
    }


def repository_snapshot(repo: str, *, allow_non_git: bool, excluded: set[Path]) -> dict[str, Any]:
    root = Path(repo).resolve()
    snapshot = git_snapshot(root, excluded)
    if snapshot is not None:
        return snapshot
    if not allow_non_git:
        raise ValueError("target is not a Git repository; pass --allow-non-git to authorize a filesystem snapshot")
    return filesystem_snapshot(root, excluded)


def file_snapshot(path: str) -> dict[str, Any]:
    target = Path(path).resolve()
    if not target.is_file():
        raise ValueError(f"evidence ledger does not exist: {target}")
    hasher = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return {"path": str(target), "sha256": hasher.hexdigest(), "bytes": target.stat().st_size}


def snapshot_differences(expected: dict[str, Any], observed: dict[str, Any]) -> list[str]:
    return [
        f"repository {field} changed" for field in ("kind", "root", "head", "branch", "worktree_digest")
        if expected.get(field) != observed.get(field)
    ]


def capsule_digest(capsule: dict[str, Any]) -> str:
    canonical = json.dumps(capsule, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def default_state_root() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        return Path(base) if base else Path.home() / "AppData" / "Local"
    base = os.environ.get("XDG_STATE_HOME")
    return Path(base) if base else Path.home() / ".local" / "state"


def locate_mission(repo: str, mission_id: str, state_root: str | None = None) -> tuple[Path, str]:
    mission_id = validate_mission_id(mission_id)
    requested = Path(repo).resolve()
    root_raw = _git_worktree_root(requested)
    if root_raw:
        root = Path(root_raw.decode("utf-8", "surrogateescape")).resolve()
        relative = f"episclaw/missions/{mission_id}/mission.json"
        raw = _run_git(root, ["rev-parse", "--git-path", relative]).decode("utf-8", "surrogateescape").strip()
        git_path = Path(raw)
        return ((git_path if git_path.is_absolute() else root / git_path).resolve(), "git-dir")
    base = Path(state_root).resolve() if state_root else default_state_root().resolve()
    workspace_key = hashlib.sha256(str(requested).casefold().encode("utf-8")).hexdigest()[:20]
    return (base / "episclaw-engineering-harness" / "workspaces" / workspace_key / "missions" / mission_id / "mission.json", "user-state")


def evaluate_resume(state: dict[str, Any], repo: str | None, ledger: str | None, mission_path: Path) -> tuple[dict[str, Any], int]:
    checkpoint = state.get("checkpoint")
    reasons: list[str] = []
    observed_repo: dict[str, Any] | None = None
    observed_ledger: dict[str, Any] | None = None
    if not checkpoint:
        reasons.append("no checkpoint exists")
    else:
        if checkpoint.get("mission_revision") != state["revision"]:
            reasons.append("checkpoint revision is not current")
        if checkpoint.get("state") != state["state"]:
            reasons.append("checkpoint graph state is not current")
        expected_repo = checkpoint.get("repository")
        if expected_repo:
            repo_path = repo or expected_repo.get("root")
            try:
                exclusions = {mission_path.absolute(), Path(str(mission_path) + ".lock").absolute()}
                expected_ledger = checkpoint.get("ledger")
                ledger_path = ledger or (expected_ledger.get("path") if expected_ledger else None)
                if ledger_path:
                    exclusions.add(Path(ledger_path).resolve().absolute())
                observed_repo = repository_snapshot(
                    repo_path,
                    allow_non_git=expected_repo.get("kind") == "filesystem",
                    excluded=exclusions,
                )
                reasons.extend(snapshot_differences(expected_repo, observed_repo))
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
                reasons.append(f"repository verification failed: {exc}")
        expected_ledger = checkpoint.get("ledger")
        if expected_ledger:
            ledger_path = ledger or expected_ledger.get("path")
            try:
                observed_ledger = file_snapshot(ledger_path)
                if observed_ledger.get("sha256") != expected_ledger.get("sha256"):
                    reasons.append("evidence ledger changed")
            except (OSError, ValueError) as exc:
                reasons.append(f"evidence ledger verification failed: {exc}")
        if checkpoint.get("capsule_sha256") != capsule_digest(state["capsule"]):
            reasons.append("mission capsule changed after checkpoint")
    gaps = capsule_gaps(state)
    if gaps:
        reasons.append("capsule gaps: " + ", ".join(gaps))
    result = {
        "status": "PREFLIGHT_REQUIRED" if reasons else "RESUME_ALLOWED",
        "mission_id": state["mission_id"], "tier": state["tier"], "state": state["state"],
        "revision": state["revision"], "capsule": state["capsule"], "checkpoint": checkpoint,
        "observed_repository": observed_repo, "observed_ledger": observed_ledger, "reasons": reasons,
    }
    return result, 3 if reasons else 0


def mermaid(tier: str | None = None) -> str:
    tier_note = f"    note right of PREFLIGHT: tier = {tier.upper()}\n" if tier else ""
    return """stateDiagram-v2
    [*] --> PREFLIGHT
    PREFLIGHT --> CONTRACT: authorized change
    PREFLIGHT --> INVESTIGATE: diagnosis
    PREFLIGHT --> REVIEW: review only
    PREFLIGHT --> CLOSEOUT: preflight only
    INVESTIGATE --> CONTRACT: first divergence
    INVESTIGATE --> CLOSEOUT: diagnosis only
    CONTRACT --> RED: behavior change
    CONTRACT --> IMPLEMENT: LIGHT / exception
    RED --> IMPLEMENT: valid RED
    IMPLEMENT --> REGRESSION: focused proof
    REGRESSION --> IMPLEMENT: failed gate
    REGRESSION --> REVIEW: STANDARD / HIGH
    REGRESSION --> CLOSEOUT: LIGHT
    REVIEW --> IMPLEMENT: material finding
    REVIEW --> CLOSEOUT: dispositioned
    CLOSEOUT --> COMPLETE: evidence-backed report
    PREFLIGHT --> BLOCKED
    INVESTIGATE --> BLOCKED
    CONTRACT --> BLOCKED
    RED --> BLOCKED
    IMPLEMENT --> BLOCKED
    REGRESSION --> BLOCKED
    REVIEW --> BLOCKED
    CLOSEOUT --> BLOCKED
    BLOCKED --> PREFLIGHT: reassess
""" + tier_note + "    COMPLETE --> [*]"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    init_parser = subcommands.add_parser("init")
    init_parser.add_argument("path", nargs="?")
    init_parser.add_argument("--tier", required=True, choices=TIERS)
    init_parser.add_argument("--mission-id")
    init_parser.add_argument("--repo")
    init_parser.add_argument("--state-root")
    init_parser.add_argument("--context-file")

    transition_parser = subcommands.add_parser("transition")
    transition_parser.add_argument("path")
    transition_parser.add_argument("--to", required=True, choices=STATES)
    transition_parser.add_argument("--evidence", action="append", required=True)
    transition_parser.add_argument("--note", default="")
    transition_parser.add_argument("--expected-revision", type=int)

    checkpoint_parser = subcommands.add_parser("checkpoint")
    checkpoint_parser.add_argument("path")
    checkpoint_parser.add_argument("--repo")
    checkpoint_parser.add_argument("--allow-non-git", action="store_true")
    checkpoint_parser.add_argument("--allow-no-repo", action="store_true")
    checkpoint_parser.add_argument("--context-file")
    checkpoint_parser.add_argument("--ledger")
    checkpoint_parser.add_argument("--evidence", action="append", required=True)
    checkpoint_parser.add_argument("--note", default="")
    checkpoint_parser.add_argument("--expected-revision", type=int)
    checkpoint_parser.add_argument("--allow-incomplete", action="store_true")

    resume_parser = subcommands.add_parser("resume")
    resume_parser.add_argument("path")
    resume_parser.add_argument("--repo")
    resume_parser.add_argument("--ledger")

    verify_parser = subcommands.add_parser("verify")
    verify_parser.add_argument("path")
    verify_parser.add_argument("--repo")
    verify_parser.add_argument("--ledger")

    locate_parser = subcommands.add_parser("locate")
    locate_parser.add_argument("--repo", required=True)
    locate_parser.add_argument("--mission-id", required=True)
    locate_parser.add_argument("--state-root")
    locate_parser.add_argument("--json", action="store_true")

    status_parser = subcommands.add_parser("status")
    status_parser.add_argument("path")
    status_parser.add_argument("--json", action="store_true")

    mermaid_parser = subcommands.add_parser("mermaid")
    mermaid_parser.add_argument("--tier", choices=TIERS)
    args = parser.parse_args(argv)

    try:
        if args.command == "mermaid":
            print(mermaid(args.tier))
            return 0
        if args.command == "locate":
            path, storage = locate_mission(args.repo, args.mission_id, args.state_root)
            result = {"mission_path": str(path), "storage": storage}
            print(json.dumps(result, ensure_ascii=False) if args.json else str(path))
            return 0
        if args.command == "init":
            mission_id = validate_mission_id(args.mission_id or str(uuid.uuid4()))
            if args.path:
                path = Path(args.path).resolve()
                storage = "explicit"
            elif args.repo:
                path, storage = locate_mission(args.repo, mission_id, args.state_root)
            else:
                raise ValueError("init requires PATH or --repo for automatic durable placement")
            capsule = merge_capsule(default_capsule(), read_context_file(args.context_file))
            with mission_lock(path):
                if path.exists():
                    raise ValueError(f"refusing to overwrite mission file: {path}")
                state = {
                    "schema_version": SCHEMA_VERSION, "mission_id": mission_id, "tier": args.tier,
                    "state": "preflight", "revision": 0, "previous_state": None, "blocked_from": None,
                    "capsule": capsule, "checkpoint": None, "checkpoint_count": 0,
                    "history": [{"ts": utc_now(), "from": None, "to": "preflight", "evidence": [], "note": "mission initialized"}],
                }
                write_state(path, state)
            output = dict(state)
            output.update({"mission_path": str(path), "storage": storage})
            print(json.dumps(output, ensure_ascii=False))
            return 0

        path = Path(args.path).resolve()
        if args.command == "status":
            state = read_state(path)
            if args.json:
                print(json.dumps(state, indent=2, ensure_ascii=False))
            else:
                print(f"Mission {state['mission_id']}: {state['state'].upper()} ({state['tier'].upper()})")
                print(f"Revision: {state['revision']}; transitions: {max(0, len(state['history']) - 1)}; checkpoints: {state['checkpoint_count']}")
            return 0
        if args.command in {"resume", "verify"}:
            state = read_state(path)
            result, exit_code = evaluate_resume(state, args.repo, args.ledger, path)
            if args.command == "verify":
                result = {key: result[key] for key in ("status", "mission_id", "state", "revision", "reasons")}
            print(json.dumps(result, ensure_ascii=False))
            return exit_code
        if args.command == "checkpoint":
            with mission_lock(path):
                state = read_state(path)
                check_expected_revision(state, args.expected_revision)
                state["capsule"] = merge_capsule(state["capsule"], read_context_file(args.context_file))
                gaps = capsule_gaps(state)
                if gaps and not args.allow_incomplete:
                    raise ValueError("capsule is incomplete: " + ", ".join(gaps))
                if not args.repo and state["tier"] in {"standard", "high"} and not args.allow_no_repo:
                    raise ValueError("STANDARD/HIGH checkpoint requires --repo or explicit --allow-no-repo")
                exclusions = {path.absolute(), Path(str(path) + ".lock").absolute()}
                if args.ledger:
                    exclusions.add(Path(args.ledger).resolve().absolute())
                repo_snapshot = repository_snapshot(args.repo, allow_non_git=args.allow_non_git, excluded=exclusions) if args.repo else None
                ledger_snapshot = file_snapshot(args.ledger) if args.ledger else None
                state["revision"] += 1
                state["checkpoint_count"] += 1
                state["checkpoint"] = {
                    "checkpoint_id": str(uuid.uuid4()), "ts": utc_now(), "mission_revision": state["revision"],
                    "state": state["state"], "capsule_sha256": capsule_digest(state["capsule"]),
                    "repository": repo_snapshot, "ledger": ledger_snapshot, "evidence": args.evidence,
                    "note": args.note, "capsule_gaps": gaps,
                }
                write_state(path, state)
            print(json.dumps({
                "status": "CHECKPOINTED", "mission_id": state["mission_id"], "state": state["state"],
                "revision": state["revision"], "checkpoint_id": state["checkpoint"]["checkpoint_id"], "capsule_gaps": gaps,
            }, ensure_ascii=False))
            return 0

        with mission_lock(path):
            state = read_state(path)
            check_expected_revision(state, args.expected_revision)
            validate_transition(state, args.to)
            current = state["state"]
            if args.to == "blocked":
                state["blocked_from"] = current
            elif current == "blocked":
                state["blocked_from"] = None
            state["previous_state"] = current
            state["state"] = args.to
            state["revision"] += 1
            state["history"].append({
                "ts": utc_now(), "from": current, "to": args.to, "evidence": args.evidence,
                "note": args.note, "revision": state["revision"],
            })
            write_state(path, state)
        output = dict(state["history"][-1])
        output["mission_id"] = state["mission_id"]
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except (OSError, RuntimeError, TimeoutError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"mission_graph: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
