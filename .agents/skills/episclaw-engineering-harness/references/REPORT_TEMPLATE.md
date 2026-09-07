# Engineering Mission Closeout Template

Use only the section depth required by the selected risk tier.

## LIGHT

- Status and what is not proven:
- Changed scope:
- Verification command/result:
- Diff inspection:
- Commit/push/deploy truth:
- Remaining debt:

## STANDARD

### Status

Use an evidence label from [PROOF_AND_CLAIMS.md](PROOF_AND_CLAIMS.md) and state what is not proven.

### Starting truth

- Repository/branch/starting HEAD:
- Review baseline/upstream:
- Initial worktree:
- Relevant runtime/deployed state:

### Contract and truth

- Normative authority:
- Descriptive current truth:
- Conflicts and owner decisions:
- First divergence or implementation rationale:
- Responsible seam:

### RED→GREEN

| Finding | RED/exception | Patch seam | GREEN | Preserved behavior |
|---|---|---|---|---|
| | | | | |

### Scope and regression

- Production source:
- Tests:
- Docs/evidence:
- Exact commands/results:
- Unexpected edges and justification:

### Review

- Independent or self-review:
- BLOCKER dispositions:
- SHOULD-FIX dispositions:
- NOTES/debt:
- SAFE TO CLOSE:

### Delivery truth

- Local commit:
- Push/PR:
- Deploy/restart:
- Final HEAD/worktree:

## HIGH additions

Include all STANDARD fields plus:

### Mission graph

- Tier and transitions:
- Blocked/owner-gate states:
- Evidence references per major edge:

### Context resilience

- Mission revision and checkpoint ID:
- Capsule completeness:
- Repository/ledger fingerprint verification:
- Resume result (`RESUME_ALLOWED` / `PREFLIGHT_REQUIRED` / not applicable):
- Concurrent-writer fencing used or why not applicable:
- Compaction, restart, or handoff limitations:

### Concurrency/idempotency

- Linearization points:
- Deterministic order tests:
- Stress repetitions:
- Race tooling:
- Ambiguous external outcomes:

### Security/authority

- Identity and tenant scope:
- Policy/capability authority:
- Secret/path/private-output leakage:
- Fallback and rollback behavior:
- External-effect truth:

### Migration/recovery

- Compatibility window:
- Backup/restore or rollback proof:
- Up/down or expand/contract evidence:
- Remaining irreversible risk:

### Organic/deployed proof

- Exact environment/artifact identity:
- Organic test IDs/timestamps:
- Durable/external observation:
- If absent: NOT RUN / NOT AUTHORIZED / NOT REQUIRED.

### Forbidden expansion proof

State whether unrelated architecture, providers, auth semantics, production secrets/config/data, deployment, and future milestones were touched.
