# Proportional Behavioral TDD Protocol

Use TDD to prove behavior, not to manufacture ceremony. Apply strictness according to [RISK_TIERS.md](RISK_TIERS.md).

## Applicability

- LIGHT: test-first is optional for non-behavioral or trivially reversible work; run meaningful verification.
- STANDARD: require RED→GREEN for bug fixes and behavior changes when practical.
- HIGH: require deterministic RED→GREEN unless reproduction is unsafe, destructive, or technically unavailable; record the exception and substitute evidence.

Common recorded exceptions include throwaway prototypes, generated code, configuration-only changes, one-way production effects, or failures that cannot be reproduced without unacceptable harm. An exception is not permission to skip verification.

## Rule 1 — RED must prove the target divergence

Record:

- normative invariant under test;
- descriptive current behavior;
- exact test name and command;
- expected result;
- observed failure;
- why the failure proves the target divergence;
- whether the test crosses the responsible seam.

Reject fixture compile failures, bad imports, unrelated network failures, wrong-layer assertions, impossible tests, and tests rewritten only to accept a desired implementation.

If the first run fails because the harness is wrong, fix the harness and rerun until the intended behavioral RED appears.

## Rule 2 — Characterize preserved behavior

Before changing a mature seam, name at least one behavior that must stay unchanged. Choose the nearest stable contract, not an incidental implementation detail.

## Rule 3 — Minimal GREEN

Make the smallest coherent change at the responsible authority seam.

After each GREEN:

1. rerun the focused test;
2. run adjacent characterization tests;
3. inspect the diff and mission graph state;
4. continue only with new evidence.

Do not stack several speculative fixes before rerunning proof.

## Rule 4 — Tests do not define truth alone

A stale test may be corrected only when normative authority and descriptive evidence show why its expectation is wrong.

Record:

- the authority for the corrected behavior;
- why the old expectation was stale or invalid;
- preserved compatibility/invariants;
- RED evidence for the actual target behavior.

## Rule 5 — Concurrency needs controlled orderings

For races, cancellation, retries, callbacks, or durable versioning, test both sides of the linearization boundary when practical.

Prefer barriers, channels, latches, fake clocks, and controllable schedulers over sleeps. Stress repetitions supplement deterministic order tests; they do not replace them.

If a race detector or equivalent cannot run, record the environmental limitation and do not claim race-detector proof.

## Rule 6 — Regression breadth follows risk

- LIGHT: focused verification.
- STANDARD: focused plus adjacent and affected build/static gates.
- HIGH: focused, adjacent, integration, stress/race, security/authority, frozen/golden, and migration/recovery proof as applicable.

Do not run a broad suite merely to create impressive evidence. Each gate must map to a credible failure mode.

## RED→GREEN ledger

| Field | Value |
|---|---|
| Finding | concise behavior |
| Normative authority | requirement/contract/policy |
| Descriptive current truth | source/runtime evidence |
| First divergence | earliest responsible seam |
| RED command | exact command |
| RED observed | expected failing behavior |
| Patch | responsible seam |
| GREEN command | exact command |
| GREEN observed | pass/fail with exit code |
| Preserved behavior | characterization evidence |
| Exceptions/limits | explicit |
| Remaining debt | explicit |
