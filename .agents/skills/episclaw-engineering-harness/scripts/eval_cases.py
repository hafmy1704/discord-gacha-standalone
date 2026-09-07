#!/usr/bin/env python3
"""Validate harness eval cases and summarize externally produced trial results."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Sequence


TIERS = {"light", "standard", "high"}
MODES = {"preflight", "implement", "rca", "review", "closeout"}
REQUIRED_KEYS = {"id", "prompt", "expected_activation", "expected_tier", "expected_mode", "observables"}
RESULT_KEYS = {"case_id", "model", "host", "timestamp", "activation", "tier", "mode", "observable_results"}
CASE_ID_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {exc.msg}") from exc


def validate_cases(cases: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(cases, list) or not cases:
        return ["expected a non-empty JSON array"]
    identifiers: set[str] = set()
    for index, case in enumerate(cases):
        label = f"case[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{label}: expected an object")
            continue
        missing = sorted(REQUIRED_KEYS - set(case))
        unknown = sorted(set(case) - REQUIRED_KEYS)
        if missing:
            errors.append(f"{label}: missing keys: {', '.join(missing)}")
        if unknown:
            errors.append(f"{label}: unknown keys: {', '.join(unknown)}")
        identifier = case.get("id")
        if not isinstance(identifier, str) or not CASE_ID_RE.fullmatch(identifier):
            errors.append(f"{label}: id must be lowercase hyphen-case")
        elif identifier in identifiers:
            errors.append(f"{label}: duplicate id: {identifier}")
        else:
            identifiers.add(identifier)
        if not isinstance(case.get("prompt"), str) or not case.get("prompt", "").strip():
            errors.append(f"{label}: prompt must be a non-empty string")
        activation = case.get("expected_activation")
        if not (isinstance(activation, bool) or activation == "optional"):
            errors.append(f"{label}: expected_activation must be true, false, or optional")
        tier = case.get("expected_tier")
        mode = case.get("expected_mode")
        if tier is not None and (not isinstance(tier, str) or tier not in TIERS):
            errors.append(f"{label}: invalid expected_tier: {tier!r}")
        if mode is not None and (not isinstance(mode, str) or mode not in MODES):
            errors.append(f"{label}: invalid expected_mode: {mode!r}")
        if activation is True and (tier is None or mode is None):
            errors.append(f"{label}: activated cases require expected_tier and expected_mode")
        if activation is False and (tier is not None or mode is not None):
            errors.append(f"{label}: non-activated cases must use null tier and mode")
        observables = case.get("observables")
        if not isinstance(observables, list) or not observables or any(
            not isinstance(item, str) or not item.strip() for item in observables
        ):
            errors.append(f"{label}: observables must be a non-empty list of strings")
        elif len(set(observables)) != len(observables):
            errors.append(f"{label}: observables must be unique")
    return errors


def read_results(path: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError as exc:
        raise ValueError(f"results file does not exist: {path}") from exc
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            result = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"results line {line_number}: invalid JSON: {exc.msg}") from exc
        if not isinstance(result, dict):
            raise ValueError(f"results line {line_number}: expected an object")
        results.append(result)
    return results


def summarize(cases: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {case["id"]: case for case in cases}
    errors: list[str] = []
    scored = 0
    activation_correct = 0
    tier_correct = 0
    mode_correct = 0
    observable_total = 0
    observable_pass = 0
    false_positive = 0
    false_negative = 0
    seen_trials: set[tuple[str, str, str, str]] = set()
    for index, result in enumerate(results):
        missing = sorted(RESULT_KEYS - set(result))
        unknown = sorted(set(result) - RESULT_KEYS)
        if missing:
            errors.append(f"result[{index}]: missing keys: {', '.join(missing)}")
        if unknown:
            errors.append(f"result[{index}]: unknown keys: {', '.join(unknown)}")
        case_id = result.get("case_id")
        case = by_id.get(case_id)
        if case is None:
            errors.append(f"result[{index}]: unknown case_id: {case_id!r}")
            continue
        if not all(isinstance(result.get(field), str) and result[field].strip() for field in ("model", "host", "timestamp")):
            errors.append(f"result[{index}]: model, host, and timestamp are required strings")
            continue
        trial_key = (case_id, result["model"], result["host"], result["timestamp"])
        if trial_key in seen_trials:
            errors.append(f"result[{index}]: duplicate trial identity: {trial_key!r}")
            continue
        seen_trials.add(trial_key)
        actual_activation = result.get("activation")
        if not isinstance(actual_activation, bool):
            errors.append(f"result[{index}]: activation must be boolean")
            continue
        actual_tier = result.get("tier")
        actual_mode = result.get("mode")
        result_valid = not missing and not unknown
        if actual_tier is not None and actual_tier not in TIERS:
            errors.append(f"result[{index}]: invalid tier: {actual_tier!r}")
            result_valid = False
        if actual_mode is not None and actual_mode not in MODES:
            errors.append(f"result[{index}]: invalid mode: {actual_mode!r}")
            result_valid = False
        if actual_activation and (actual_tier is None or actual_mode is None):
            errors.append(f"result[{index}]: activated result requires tier and mode")
            result_valid = False
        if not actual_activation and (actual_tier is not None or actual_mode is not None):
            errors.append(f"result[{index}]: non-activated result must use null tier and mode")
            result_valid = False
        observable_results = result.get("observable_results")
        if not isinstance(observable_results, dict):
            errors.append(f"result[{index}]: observable_results must be an object")
            continue
        expected_observables = set(case["observables"])
        observed_keys = set(observable_results)
        if observed_keys != expected_observables:
            missing_observables = sorted(expected_observables - observed_keys)
            unknown_observables = sorted(observed_keys - expected_observables)
            detail = []
            if missing_observables:
                detail.append("missing " + ", ".join(missing_observables))
            if unknown_observables:
                detail.append("unknown " + ", ".join(unknown_observables))
            errors.append(f"result[{index}]: observable_results keys mismatch ({'; '.join(detail)})")
            result_valid = False
        if any(type(value) is not bool for value in observable_results.values()):
            errors.append(f"result[{index}]: observable_results values must be boolean")
            result_valid = False
        if not result_valid:
            continue
        scored += 1
        expected_activation = case["expected_activation"]
        if expected_activation == "optional":
            activation_correct += 1
        elif actual_activation == expected_activation:
            activation_correct += 1
        elif expected_activation is False:
            false_positive += 1
        else:
            false_negative += 1
        if actual_tier == case["expected_tier"]:
            tier_correct += 1
        if actual_mode == case["expected_mode"]:
            mode_correct += 1
        for observable in case["observables"]:
            observable_total += 1
            if observable_results.get(observable) is True:
                observable_pass += 1
    return {
        "status": "FAIL" if errors else "PASS",
        "results": len(results), "scored": scored, "errors": errors,
        "activation_accuracy": activation_correct / scored if scored else None,
        "tier_accuracy": tier_correct / scored if scored else None,
        "mode_accuracy": mode_correct / scored if scored else None,
        "observable_pass_rate": observable_pass / observable_total if observable_total else None,
        "false_positive": false_positive, "false_negative": false_negative,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    validate_parser = subcommands.add_parser("validate")
    validate_parser.add_argument("cases")
    validate_parser.add_argument("--json", action="store_true")
    summarize_parser = subcommands.add_parser("summarize")
    summarize_parser.add_argument("cases")
    summarize_parser.add_argument("results")
    summarize_parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        cases_path = Path(args.cases).resolve()
        cases = load_json(cases_path)
        errors = validate_cases(cases)
        if args.command == "validate":
            result = {"status": "FAIL" if errors else "PASS", "cases": len(cases) if isinstance(cases, list) else 0, "errors": errors}
        else:
            if errors:
                result = {"status": "FAIL", "results": 0, "scored": 0, "errors": errors}
            else:
                result = summarize(cases, read_results(Path(args.results).resolve()))
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"Eval cases: {result['status']}")
            for error in result["errors"]:
                print(f"[ERROR] {error}")
        return 0 if result["status"] == "PASS" else 1
    except (OSError, ValueError) as exc:
        result = {"status": "FAIL", "cases": 0, "errors": [str(exc)]}
        if getattr(args, "json", False):
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"eval_cases: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
