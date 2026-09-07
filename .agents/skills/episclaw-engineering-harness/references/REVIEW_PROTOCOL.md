# Independent Adversarial Review Protocol

## Reviewer role

Review the current diff or artifact against the change contract and evidence. Do not rely on the author's prose summary alone and do not modify the working tree unless a separate implementation request authorizes it.

Inputs:

- explicit base and head/worktree diff;
- change contract and risk tier;
- relevant normative authority;
- source/tests/runtime evidence;
- RED→GREEN ledger;
- frozen/domain invariants.

## Severity

### BLOCKER

Reproducible correctness, security, authority, data-loss, external-truth, forbidden-scope, or missing-proof issue that makes the proposed closure unsafe.

### SHOULD-FIX

Material robustness, maintainability, compatibility, or proof gap within scope that should be addressed before closure unless rejected with evidence, accepted by the owner, or explicitly deferred with risk.

### NOTE

Non-blocking observation, future work, or environmental verification debt.

## Attack questions

1. Is the stated divergence truly the earliest sufficient cause?
2. Does the patch sit at the responsible ownership seam?
3. Did normative and descriptive truth get conflated?
4. Was new authority invented?
5. Can input, provider, model, UI, or presentation data become authority?
6. Are external success/failure claims stronger than evidence?
7. Are partial or ambiguous effects handled safely?
8. Are stale completions, retries, callbacks, and cancellation fenced?
9. Can secrets, paths, private reasoning, or signed URLs leak?
10. Did tests change to accept a regression?
11. Did scope cross an unexplained ownership edge?
12. Are performance, compatibility, recovery, or migration risks relevant and untested?
13. Is an EpisClaw-only invariant being applied outside EpisClaw?
14. Could fallback or rollback weaken security or truth?

## Finding disposition

Each finding ends in exactly one state:

- `FIXED` — implementation and proof updated;
- `REJECTED` — technical evidence shows the finding is invalid;
- `OWNER-ACCEPTED` — appropriate owner accepts the stated residual risk;
- `DEFERRED` — follow-up, risk, and reason are recorded;
- `OPEN` — closure blocked when severity requires it.

Do not relabel an unresolved issue merely to reach zero.

## Closure

Required:

- `BLOCKER OPEN = 0`;
- every SHOULD-FIX has a recorded disposition;
- final `SAFE TO CLOSE = YES/NO` scoped to the reviewed artifact and evidence.

When no independent reviewer is available or permitted, label the result `SELF-REVIEW` and do not describe it as independent.
