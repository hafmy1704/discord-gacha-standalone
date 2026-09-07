#!/usr/bin/env python3
"""Maintain a best-effort-redacted, self-consistency-chained JSONL evidence index."""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import errno
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Sequence


SCHEMA_VERSION = 2
KINDS = ("snapshot", "red", "green", "regression", "review", "organic", "claim", "debt", "transition")
STATUSES = ("pass", "fail", "blocked", "info", "unknown", "waived")
SECRET_PATTERNS = (
    (re.compile(r"(?i)(authorization\s*:\s*)(?:bearer\s+)?[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer [REDACTED]"),
    (re.compile(r"(?i)(?:[A-Za-z]:\\|/)[^\s,;]*(?:root[-_]?keys?|secrets?)[^\s,;]*"), "[REDACTED_SECRET_PATH]"),
    (re.compile(r"(?i)\b((?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?token|client[_-]?secret|token|password|secret)\s*(?:[:=]|\s)\s*([^\s,;]+)"), r"\1=[REDACTED]"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[REDACTED_AWS_ACCESS_KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"), "[REDACTED_OPENAI_KEY]"),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"(https?://[^\s:/]+:)[^@\s]+@"), r"\1[REDACTED]@"),
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def redact_text(value: str) -> str:
    result = value
    for pattern, replacement in SECRET_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def record_hash(record: dict[str, Any]) -> str:
    payload = {key: value for key, value in record.items() if key != "record_hash"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def git_identity(repo: str | None) -> tuple[str | None, str | None]:
    if not repo:
        return None, None
    try:
        process = subprocess.run(
            ["git", "-C", repo, "rev-parse", "--show-toplevel", "HEAD"],
            text=True,
            capture_output=True,
            timeout=5,
        )
        if process.returncode != 0:
            return str(Path(repo).resolve()), None
        root, head = process.stdout.strip().splitlines()[:2]
        return root, head
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return str(Path(repo).resolve()), None


@contextlib.contextmanager
def ledger_lock(path: Path, timeout: float = 5.0, stale_after: float = 60.0) -> Iterator[None]:
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
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out waiting for ledger lock: {lock_path}") from exc
                time.sleep(0.05)
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} token={uuid.uuid4()} ts={time.time()}\n".encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        if acquired:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def load_and_verify(path: Path) -> list[dict[str, Any]]:
    if not path.exists() or not path.stat().st_size:
        raise ValueError(f"ledger is missing or empty: {path}")
    records: list[dict[str, Any]] = []
    expected_previous: str | None = None
    mission_id: str | None = None
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"line {line_number}: invalid JSON: {exc.msg}") from exc
            if not isinstance(record, dict):
                raise ValueError(f"line {line_number}: record must be an object")
            if record.get("schema_version") != SCHEMA_VERSION:
                raise ValueError(f"line {line_number}: unsupported schema_version")
            if line_number == 1 and record.get("kind") != "init":
                raise ValueError("line 1: first record must be kind=init")
            if mission_id is None:
                mission_id = record.get("mission_id")
            elif record.get("mission_id") != mission_id:
                raise ValueError(f"line {line_number}: mission_id changed")
            if record.get("prev_hash") != expected_previous:
                raise ValueError(f"line {line_number}: prev_hash mismatch")
            actual = record_hash(record)
            if record.get("record_hash") != actual:
                raise ValueError(f"line {line_number}: record_hash mismatch")
            expected_previous = actual
            records.append(record)
    return records


def build_record(
    *, mission_id: str, kind: str, status: str, command: str = "", exit_code: int | None = None,
    note: str = "", evidence: str = "", artifacts: list[str] | None = None,
    repo: str | None = None, head: str | None = None, previous: str | None = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "mission_id": mission_id,
        "entry_id": str(uuid.uuid4()),
        "ts": utc_now(),
        "kind": kind,
        "status": status,
        "command": command,
        "exit_code": exit_code,
        "note": note,
        "evidence": evidence,
        "artifacts": artifacts or [],
        "repo": repo,
        "head": head,
        "prev_hash": previous,
    }
    record = redact(record)
    record["record_hash"] = record_hash(record)
    return record


def append_record(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command_name", required=True)

    init_parser = subcommands.add_parser("init", help="Create a ledger with a genesis record")
    init_parser.add_argument("path")
    init_parser.add_argument("--mission-id", default=None)
    init_parser.add_argument("--repo", default=None)

    add_parser = subcommands.add_parser("add", help="Append a verified record")
    add_parser.add_argument("path")
    add_parser.add_argument("--kind", required=True, choices=KINDS)
    add_parser.add_argument("--status", required=True, choices=STATUSES)
    add_parser.add_argument("--command", default="")
    add_parser.add_argument("--exit-code", type=int)
    add_parser.add_argument("--note", default="")
    add_parser.add_argument("--evidence", default="")
    add_parser.add_argument("--artifact", action="append", default=[])
    add_parser.add_argument("--repo", default=None)

    verify_parser = subcommands.add_parser("verify", help="Verify JSON, mission identity, and hash-chain self-consistency")
    verify_parser.add_argument("path")
    args = parser.parse_args(argv)
    path = Path(args.path).resolve()

    try:
        if args.command_name == "init":
            path.parent.mkdir(parents=True, exist_ok=True)
            with ledger_lock(path):
                if path.exists() and path.stat().st_size:
                    raise ValueError(f"refusing to overwrite non-empty ledger: {path}")
                repo, head = git_identity(args.repo)
                record = build_record(
                    mission_id=args.mission_id or str(uuid.uuid4()),
                    kind="init",
                    status="info",
                    note="ledger initialized",
                    repo=repo,
                    head=head,
                )
                path.touch(exist_ok=True)
                append_record(path, record)
            print(json.dumps(record, ensure_ascii=False, sort_keys=True))
            return 0

        if args.command_name == "add":
            with ledger_lock(path):
                records = load_and_verify(path)
                repo, head = git_identity(args.repo)
                record = build_record(
                    mission_id=records[0]["mission_id"],
                    kind=args.kind,
                    status=args.status,
                    command=args.command,
                    exit_code=args.exit_code,
                    note=args.note,
                    evidence=args.evidence,
                    artifacts=args.artifact,
                    repo=repo,
                    head=head,
                    previous=records[-1]["record_hash"],
                )
                append_record(path, record)
            print(json.dumps(record, ensure_ascii=False, sort_keys=True))
            return 0

        records = load_and_verify(path)
        print(json.dumps({"status": "PASS", "records": len(records), "mission_id": records[0]["mission_id"], "head_hash": records[-1]["record_hash"]}, ensure_ascii=False))
        return 0
    except (OSError, TimeoutError, ValueError) as exc:
        print(f"evidence_ledger: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
