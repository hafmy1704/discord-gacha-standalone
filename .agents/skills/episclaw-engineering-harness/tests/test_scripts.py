from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_script(name: str):
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(command: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    process = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if check and process.returncode != 0:
        raise AssertionError(f"command failed: {command}\nstdout={process.stdout}\nstderr={process.stderr}")
    return process


def git(repo: Path, *args: str) -> str:
    return run(["git", "-C", str(repo), *args]).stdout.strip()


def init_repo(path: Path) -> str:
    run(["git", "init", "--initial-branch", "main", str(path)])
    git(path, "config", "user.email", "harness@example.invalid")
    git(path, "config", "user.name", "Harness Test")
    (path / "src").mkdir()
    (path / ".github" / "workflows").mkdir(parents=True)
    (path / "src" / "base.txt").write_text("base\n", encoding="utf-8")
    (path / ".github" / "workflows" / "ci.yml").write_text("name: ci\n", encoding="utf-8")
    git(path, "add", ".")
    git(path, "commit", "-m", "base")
    return git(path, "rev-parse", "HEAD")


class ScopeGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.guard = load_script("diff_scope_guard")

    def test_norm_preserves_dot_prefixed_path(self) -> None:
        self.assertEqual(self.guard.norm(".github/workflows/ci.yml"), ".github/workflows/ci.yml")
        self.assertEqual(self.guard.norm("./.github/workflows/ci.yml"), ".github/workflows/ci.yml")

    def test_unconfigured_guard_is_not_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "repo"
            base = init_repo(repo)
            (repo / "untracked.txt").write_text("new\n", encoding="utf-8")
            process = run(
                [sys.executable, str(SCRIPTS / "diff_scope_guard.py"), "--repo", str(repo), "--base", base],
                check=False,
            )
            self.assertEqual(process.returncode, 2)
            self.assertIn("UNCONFIGURED", process.stdout)

    def test_guard_sees_committed_staged_unstaged_and_untracked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "repo"
            base = init_repo(repo)
            (repo / ".github" / "workflows" / "ci.yml").write_text("name: changed\n", encoding="utf-8")
            git(repo, "add", ".github/workflows/ci.yml")
            git(repo, "commit", "-m", "branch change")
            (repo / "src" / "staged.txt").write_text("staged\n", encoding="utf-8")
            git(repo, "add", "src/staged.txt")
            (repo / "src" / "base.txt").write_text("unstaged\n", encoding="utf-8")
            (repo / "docs").mkdir()
            (repo / "docs" / "new.md").write_text("untracked\n", encoding="utf-8")
            process = run([
                sys.executable, str(SCRIPTS / "diff_scope_guard.py"),
                "--repo", str(repo), "--base", base,
                "--allow", ".github", "--allow", "src", "--allow", "docs", "--json",
            ])
            result = json.loads(process.stdout)
            observed = {row["path"] for row in result["changed_files"]}
            self.assertEqual(result["status"], "PASS")
            self.assertTrue({".github/workflows/ci.yml", "src/staged.txt", "src/base.txt", "docs/new.md"} <= observed)


class GitSnapshotTests(unittest.TestCase):
    def test_snapshot_uses_upstream_and_includes_all_change_classes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base_dir = Path(temporary)
            repo = base_dir / "repo"
            remote = base_dir / "remote.git"
            init_repo(repo)
            run(["git", "clone", "--bare", str(repo), str(remote)])
            git(repo, "remote", "add", "origin", str(remote))
            git(repo, "push", "--set-upstream", "origin", "main")
            (repo / "committed.txt").write_text("committed\n", encoding="utf-8")
            git(repo, "add", "committed.txt")
            git(repo, "commit", "-m", "ahead")
            (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
            git(repo, "add", "staged.txt")
            (repo / "src" / "base.txt").write_text("unstaged\n", encoding="utf-8")
            (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")

            process = run([
                sys.executable, str(SCRIPTS / "git_snapshot.py"), "--repo", str(repo), "--json",
            ])
            result = json.loads(process.stdout)
            self.assertEqual(result["comparison_ref"], "origin/main")
            self.assertEqual(result["comparison_source"], "upstream")
            self.assertEqual(result["ahead"], 1)
            self.assertTrue({"committed.txt", "staged.txt", "src/base.txt", "untracked.txt"} <= set(result["changed_files"]))


class EvidenceLedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ledger_module = load_script("evidence_ledger")

    def test_redaction_and_tamper_detection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Path(temporary) / "evidence.jsonl"
            script = str(SCRIPTS / "evidence_ledger.py")
            run([sys.executable, script, "init", str(ledger), "--mission-id", "mission-1"])
            secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
            run([
                sys.executable, script, "add", str(ledger), "--kind", "green", "--status", "pass",
                "--command", f"curl -H 'Authorization: Bearer {secret}' https://example.invalid",
                "--note", "password hunter2; AWS_SECRET_ACCESS_KEY AKIAEXAMPLE123456789",
                "--artifact", r"C:\root-keys\production.pem",
            ])
            contents = ledger.read_text(encoding="utf-8")
            self.assertNotIn(secret, contents)
            self.assertNotIn("hunter2", contents)
            self.assertNotIn("AKIAEXAMPLE123456789", contents)
            self.assertNotIn("production.pem", contents)
            self.assertEqual(run([sys.executable, script, "verify", str(ledger)]).returncode, 0)

            records = contents.splitlines()
            tampered = json.loads(records[1])
            tampered["note"] = "changed after append"
            records[1] = json.dumps(tampered)
            ledger.write_text("\n".join(records) + "\n", encoding="utf-8")
            process = run([sys.executable, script, "verify", str(ledger)], check=False)
            self.assertEqual(process.returncode, 1)
            self.assertIn("record_hash mismatch", process.stderr)

    def test_ledger_lock_is_os_held_and_not_stolen(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Path(temporary) / "evidence.jsonl"
            with self.ledger_module.ledger_lock(ledger, timeout=0.2):
                with self.assertRaises(TimeoutError):
                    with self.ledger_module.ledger_lock(ledger, timeout=0.05):
                        self.fail("a held OS lock must not be stolen")


class MissionGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.graph = load_script("mission_graph")

    def complete_context(self, path: Path) -> None:
        path.write_text(json.dumps({
            "requested_behavior": "Make long missions resumable after compaction.",
            "normative_authority": ["Explicit owner request"],
            "descriptive_truth": ["Mission state currently stores graph position only"],
            "divergence_or_hypothesis": "Conversation-only contract is lost during compaction",
            "responsible_seam": "mission_graph persistence",
            "invariants": ["Canonical transitions remain unchanged"],
            "in_scope": ["mission state and checkpoint verification"],
            "out_of_scope": ["deployment"],
            "required_proof": ["checkpoint round trip", "drift detection"],
            "owner_gates": ["push remains closed"],
            "decisions": ["Persist a compact mission capsule"],
            "rejected_alternatives": ["Rely on chat summaries"],
            "open_findings": [],
            "next_safe_action": "Run focused tests",
        }), encoding="utf-8")

    def test_valid_path_and_invalid_skip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mission = Path(temporary) / "mission.json"
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "init", str(mission), "--tier", "standard", "--mission-id", "m-1"])
            invalid = run([
                sys.executable, script, "transition", str(mission), "--to", "complete", "--evidence", "none",
            ], check=False)
            self.assertEqual(invalid.returncode, 1)
            path = ("contract", "implement", "regression", "review", "closeout", "complete")
            for state in path:
                run([sys.executable, script, "transition", str(mission), "--to", state, "--evidence", f"proof:{state}"])
            state = json.loads(mission.read_text(encoding="utf-8"))
            self.assertEqual(state["state"], "complete")
            self.assertEqual(len(state["history"]), 7)

    def test_blocked_mission_can_resume_only_at_origin_or_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mission = Path(temporary) / "mission.json"
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "init", str(mission), "--tier", "high"])
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "scope"])
            run([sys.executable, script, "transition", str(mission), "--to", "blocked", "--evidence", "owner gate"])
            invalid = run([
                sys.executable, script, "transition", str(mission), "--to", "review", "--evidence", "not enough",
            ], check=False)
            self.assertEqual(invalid.returncode, 1)
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "owner approved"])

    def test_checkpoint_rehydrates_capsule_and_detects_repository_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            init_repo(repo)
            mission = repo / ".harness-mission.json"
            context = root / "context.json"
            self.complete_context(context)
            script = str(SCRIPTS / "mission_graph.py")

            run([sys.executable, script, "init", str(mission), "--tier", "high", "--mission-id", "compact-safe"])
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "owner request"])
            checkpoint = run([
                sys.executable, script, "checkpoint", str(mission), "--repo", str(repo),
                "--context-file", str(context), "--evidence", "contract frozen",
            ])
            checkpoint_result = json.loads(checkpoint.stdout)
            self.assertEqual(checkpoint_result["status"], "CHECKPOINTED")

            resume = run([sys.executable, script, "resume", str(mission), "--repo", str(repo)])
            resumed = json.loads(resume.stdout)
            self.assertEqual(resumed["status"], "RESUME_ALLOWED")
            self.assertEqual(resumed["capsule"]["responsible_seam"], "mission_graph persistence")

            (repo / "src" / "base.txt").write_text("drifted\n", encoding="utf-8")
            stale = run([sys.executable, script, "resume", str(mission), "--repo", str(repo)], check=False)
            self.assertEqual(stale.returncode, 3)
            self.assertEqual(json.loads(stale.stdout)["status"], "PREFLIGHT_REQUIRED")

    def test_concurrent_expected_revision_allows_exactly_one_transition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mission = Path(temporary) / "mission.json"
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "init", str(mission), "--tier", "high", "--mission-id", "concurrent"])
            command = [
                sys.executable, script, "transition", str(mission), "--to", "contract",
                "--evidence", "same baseline", "--expected-revision", "0",
            ]
            first = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            second = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            first.communicate()
            second.communicate()
            self.assertEqual(sorted([first.returncode, second.returncode]), [0, 1])
            state = json.loads(mission.read_text(encoding="utf-8"))
            self.assertEqual(state["revision"], 1)
            self.assertEqual(len(state["history"]), 2)

    def test_legacy_schema_is_upgraded_on_first_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mission = Path(temporary) / "mission.json"
            mission.write_text(json.dumps({
                "schema_version": 1,
                "mission_id": "legacy",
                "tier": "standard",
                "state": "preflight",
                "previous_state": None,
                "blocked_from": None,
                "history": [{"ts": "2026-01-01T00:00:00+00:00", "from": None, "to": "preflight", "evidence": [], "note": "legacy"}],
            }), encoding="utf-8")
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "upgrade"])
            state = json.loads(mission.read_text(encoding="utf-8"))
            self.assertEqual(state["schema_version"], 2)
            self.assertEqual(state["revision"], 1)
            self.assertIn("capsule", state)

    def test_state_validation_rejects_boolean_revision_and_incoherent_history(self) -> None:
        base = {
            "schema_version": 2,
            "mission_id": "strict-state",
            "tier": "standard",
            "state": "preflight",
            "revision": 0,
            "capsule": self.graph.default_capsule(),
            "checkpoint": None,
            "checkpoint_count": 0,
            "history": [{
                "ts": "2026-01-01T00:00:00+00:00", "from": None, "to": "preflight",
                "evidence": [], "note": "init",
            }],
        }
        boolean_revision = dict(base, revision=True)
        with self.assertRaisesRegex(ValueError, "revision"):
            self.graph.validate_state(boolean_revision)
        incoherent = dict(base, state="contract", revision=1)
        with self.assertRaisesRegex(ValueError, "latest history"):
            self.graph.validate_state(incoherent)

    def test_state_validation_rejects_illegal_edges_and_forged_blocked_origin(self) -> None:
        illegal = {
            "schema_version": 2,
            "mission_id": "illegal-edge",
            "tier": "high",
            "state": "complete",
            "revision": 1,
            "previous_state": "preflight",
            "blocked_from": None,
            "capsule": self.graph.default_capsule(),
            "checkpoint": None,
            "checkpoint_count": 0,
            "history": [
                {"ts": "2026-01-01T00:00:00+00:00", "from": None, "to": "preflight", "evidence": [], "note": "init"},
                {"ts": "2026-01-01T00:00:01+00:00", "from": "preflight", "to": "complete", "evidence": ["forged"], "note": "skip", "revision": 1},
            ],
        }
        with self.assertRaisesRegex(ValueError, "illegal transition"):
            self.graph.validate_state(illegal)

        blocked = dict(illegal)
        blocked.update({
            "mission_id": "forged-blocked-origin", "state": "blocked", "revision": 2,
            "previous_state": "contract", "blocked_from": "complete",
            "history": [
                {"ts": "2026-01-01T00:00:00+00:00", "from": None, "to": "preflight", "evidence": [], "note": "init"},
                {"ts": "2026-01-01T00:00:01+00:00", "from": "preflight", "to": "contract", "evidence": ["scope"], "note": "", "revision": 1},
                {"ts": "2026-01-01T00:00:02+00:00", "from": "contract", "to": "blocked", "evidence": ["gate"], "note": "", "revision": 2},
            ],
        })
        with self.assertRaisesRegex(ValueError, "blocked_from"):
            self.graph.validate_state(blocked)

    def test_resume_rejects_a_checkpoint_from_an_earlier_graph_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            init_repo(repo)
            mission = root / "mission.json"
            context = root / "context.json"
            self.complete_context(context)
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "init", str(mission), "--tier", "high", "--mission-id", "stale-graph"])
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "contract"])
            run([
                sys.executable, script, "checkpoint", str(mission), "--repo", str(repo),
                "--context-file", str(context), "--evidence", "contract checkpoint",
            ])
            run([sys.executable, script, "transition", str(mission), "--to", "red", "--evidence", "valid red"])
            resume = run([sys.executable, script, "resume", str(mission), "--repo", str(repo)], check=False)
            self.assertEqual(resume.returncode, 3)
            result = json.loads(resume.stdout)
            self.assertEqual(result["status"], "PREFLIGHT_REQUIRED")
            self.assertTrue(any("checkpoint" in reason and "revision" in reason for reason in result["reasons"]))

    def test_non_git_checkpoint_requires_opt_in_and_detects_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "artifact.txt").write_text("v1\n", encoding="utf-8")
            mission = root / "mission.json"
            context = root / "context.json"
            self.complete_context(context)
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "init", str(mission), "--tier", "high", "--mission-id", "non-git"])
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "contract"])
            denied = run([
                sys.executable, script, "checkpoint", str(mission), "--repo", str(workspace),
                "--context-file", str(context), "--evidence", "snapshot",
            ], check=False)
            self.assertEqual(denied.returncode, 1)
            run([
                sys.executable, script, "checkpoint", str(mission), "--repo", str(workspace),
                "--allow-non-git", "--context-file", str(context), "--evidence", "snapshot",
            ])
            self.assertEqual(run([sys.executable, script, "resume", str(mission), "--repo", str(workspace)]).returncode, 0)
            (workspace / "artifact.txt").write_text("v2\n", encoding="utf-8")
            self.assertEqual(run([
                sys.executable, script, "resume", str(mission), "--repo", str(workspace),
            ], check=False).returncode, 3)

    def test_resume_detects_evidence_ledger_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            init_repo(repo)
            mission = root / "mission.json"
            context = root / "context.json"
            ledger = root / "evidence.jsonl"
            self.complete_context(context)
            graph = str(SCRIPTS / "mission_graph.py")
            evidence = str(SCRIPTS / "evidence_ledger.py")
            run([sys.executable, evidence, "init", str(ledger), "--mission-id", "ledger-bound"])
            run([sys.executable, graph, "init", str(mission), "--tier", "high", "--mission-id", "ledger-bound"])
            run([sys.executable, graph, "transition", str(mission), "--to", "contract", "--evidence", "contract"])
            run([
                sys.executable, graph, "checkpoint", str(mission), "--repo", str(repo),
                "--context-file", str(context), "--ledger", str(ledger), "--evidence", "ledger bound",
            ])
            self.assertEqual(run([
                sys.executable, graph, "resume", str(mission), "--repo", str(repo), "--ledger", str(ledger),
            ]).returncode, 0)
            run([
                sys.executable, evidence, "add", str(ledger), "--kind", "claim", "--status", "info",
                "--note", "new evidence after checkpoint",
            ])
            stale = run([
                sys.executable, graph, "resume", str(mission), "--repo", str(repo), "--ledger", str(ledger),
            ], check=False)
            self.assertEqual(stale.returncode, 3)
            self.assertIn("evidence ledger changed", json.loads(stale.stdout)["reasons"])

    def test_resume_detects_branch_change_at_identical_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            init_repo(repo)
            mission = root / "mission.json"
            context = root / "context.json"
            self.complete_context(context)
            script = str(SCRIPTS / "mission_graph.py")
            run([sys.executable, script, "init", str(mission), "--tier", "high", "--mission-id", "branch-bound"])
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "contract"])
            run([
                sys.executable, script, "checkpoint", str(mission), "--repo", str(repo),
                "--context-file", str(context), "--evidence", "branch checkpoint",
            ])
            git(repo, "checkout", "-b", "alternate")
            stale = run([sys.executable, script, "resume", str(mission), "--repo", str(repo)], check=False)
            self.assertEqual(stale.returncode, 3)
            self.assertIn("repository branch changed", json.loads(stale.stdout)["reasons"])

    def test_resume_detects_skip_worktree_content_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            init_repo(repo)
            mission = root / "mission.json"
            context = root / "context.json"
            self.complete_context(context)
            script = str(SCRIPTS / "mission_graph.py")
            git(repo, "update-index", "--skip-worktree", "src/base.txt")
            run([sys.executable, script, "init", str(mission), "--tier", "high", "--mission-id", "skip-worktree"])
            run([sys.executable, script, "transition", str(mission), "--to", "contract", "--evidence", "contract"])
            run([
                sys.executable, script, "checkpoint", str(mission), "--repo", str(repo),
                "--context-file", str(context), "--evidence", "content checkpoint",
            ])
            self.assertEqual(run([sys.executable, script, "resume", str(mission), "--repo", str(repo)]).returncode, 0)
            (repo / "src" / "base.txt").write_text("hidden drift\n", encoding="utf-8")
            self.assertEqual(git(repo, "status", "--porcelain"), "")
            stale = run([sys.executable, script, "resume", str(mission), "--repo", str(repo)], check=False)
            self.assertEqual(stale.returncode, 3)
            self.assertIn("repository worktree_digest changed", json.loads(stale.stdout)["reasons"])

    def test_locate_uses_git_dir_or_explicit_user_state_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            init_repo(repo)
            script = str(SCRIPTS / "mission_graph.py")
            git_result = json.loads(run([
                sys.executable, script, "locate", "--repo", str(repo), "--mission-id", "m-git", "--json",
            ]).stdout)
            self.assertEqual(git_result["storage"], "git-dir")
            self.assertIn("episclaw", Path(git_result["mission_path"]).parts)
            workspace = root / "plain"
            workspace.mkdir()
            state_root = root / "state"
            plain_result = json.loads(run([
                sys.executable, script, "locate", "--repo", str(workspace), "--mission-id", "m-plain",
                "--state-root", str(state_root), "--json",
            ]).stdout)
            self.assertEqual(plain_result["storage"], "user-state")
            self.assertTrue(Path(plain_result["mission_path"]).is_relative_to(state_root))

    def test_mission_lock_is_os_held_and_not_stolen(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mission = Path(temporary) / "mission.json"
            with self.graph.mission_lock(mission, timeout=0.2):
                with self.assertRaises(TimeoutError):
                    with self.graph.mission_lock(mission, timeout=0.05):
                        self.fail("a held OS lock must not be stolen")


class EvalCasesTests(unittest.TestCase):
    def test_packaged_cases_pass_strict_schema_validation(self) -> None:
        script = str(SCRIPTS / "eval_cases.py")
        cases = ROOT / "evals" / "cases.json"
        process = run([sys.executable, script, "validate", str(cases), "--json"])
        result = json.loads(process.stdout)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["cases"], 11)

    def test_summary_rejects_missing_observables_and_invalid_actual_mode(self) -> None:
        module = load_script("eval_cases")
        cases = [{
            "id": "strict-result",
            "prompt": "Review this change",
            "expected_activation": True,
            "expected_tier": "high",
            "expected_mode": "review",
            "observables": ["review remained read-only", "findings were dispositioned"],
        }]
        results = [{
            "case_id": "strict-result", "model": "test", "host": "local",
            "timestamp": "2026-01-01T00:00:00Z", "activation": True,
            "tier": "high", "mode": "invented",
            "observable_results": {"review remained read-only": True},
        }]
        summary = module.summarize(cases, results)
        self.assertEqual(summary["status"], "FAIL")
        self.assertTrue(any("invalid mode" in error for error in summary["errors"]))
        self.assertTrue(any("observable_results keys" in error for error in summary["errors"]))

    def test_summary_allows_multiple_distinct_trials_for_one_case(self) -> None:
        module = load_script("eval_cases")
        cases = [{
            "id": "repeat-trial", "prompt": "Review this change", "expected_activation": True,
            "expected_tier": "high", "expected_mode": "review", "observables": ["read-only"],
        }]
        base = {
            "case_id": "repeat-trial", "model": "test", "host": "local", "activation": True,
            "tier": "high", "mode": "review", "observable_results": {"read-only": True},
        }
        first = dict(base, timestamp="2026-01-01T00:00:00Z")
        second = dict(base, timestamp="2026-01-01T00:01:00Z")
        summary = module.summarize(cases, [first, second])
        self.assertEqual(summary["status"], "PASS")
        self.assertEqual(summary["scored"], 2)

        duplicate = module.summarize(cases, [first, dict(first)])
        self.assertEqual(duplicate["status"], "FAIL")
        self.assertTrue(any("duplicate trial" in error for error in duplicate["errors"]))

    def test_invalid_case_schema_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cases = Path(temporary) / "cases.json"
            cases.write_text('[{"id":"duplicate"},{"id":"duplicate"}]', encoding="utf-8")
            process = run([
                sys.executable, str(SCRIPTS / "eval_cases.py"), "validate", str(cases), "--json",
            ], check=False)
            self.assertEqual(process.returncode, 1)
            self.assertEqual(json.loads(process.stdout)["status"], "FAIL")

    def test_result_summary_scores_supplied_outcomes_without_judging_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cases = root / "cases.json"
            results = root / "results.jsonl"
            observable = "returns to PREFLIGHT before mutation"
            cases.write_text(json.dumps([{
                "id": "stale-checkpoint",
                "prompt": "Resume stale work.",
                "expected_activation": True,
                "expected_tier": "high",
                "expected_mode": "preflight",
                "observables": [observable],
            }]), encoding="utf-8")
            results.write_text(json.dumps({
                "case_id": "stale-checkpoint",
                "model": "test-model",
                "host": "local-test",
                "timestamp": "2026-09-04T00:00:00Z",
                "activation": True,
                "tier": "high",
                "mode": "preflight",
                "observable_results": {observable: True},
            }) + "\n", encoding="utf-8")
            process = run([
                sys.executable, str(SCRIPTS / "eval_cases.py"), "summarize", str(cases), str(results), "--json",
            ])
            summary = json.loads(process.stdout)
            self.assertEqual(summary["status"], "PASS")
            self.assertEqual(summary["activation_accuracy"], 1.0)
            self.assertEqual(summary["observable_pass_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
