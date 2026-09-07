# Proof and Claim Discipline

## Evidence levels

### SOURCE-VERIFIED

Current source directly establishes the behavior/structure.

### TEST-VERIFIED

Deterministic tests establish the specified behavior in the tested environment.

### RUNTIME-VERIFIED

A running system was inspected and the claimed behavior/state was observed.

### DEPLOYED-VERIFIED

The exact deployed artifact/environment was verified after deployment.

### CONFIG-DEPENDENT

Behavior depends on current configuration/gate state and cannot be generalized.

### INFERENCE

Reasonable conclusion from evidence, not directly proven.

### NOT IMPLEMENTED

No current implementation exists.

### UNKNOWN/CANNOT VERIFY

Evidence unavailable or insufficient.

## Forbidden claim upgrades

Do not convert:

- source proof → runtime proof;
- unit test → production proof;
- local integration → deployed proof;
- provider request → external effect committed;
- artifact path → delivered artifact;
- configured → healthy;
- active → available;
- installed/entitled → authorized;
- review absence → correctness proof.

## Organic proof

Use labels such as:

- `DETERMINISTIC TEST-PROVEN`
- `ORGANIC TEST-ENV PROVEN`
- `PRODUCTION ORGANIC PROVEN`

Name exact IDs/timestamps where appropriate without exposing secrets.

## Evidence writing

Prefer exact statements:

"Focused test X passed 20/20 on local Windows host; `-race` unavailable because CGO/GCC absent."

Avoid:

"Race-safe and production-ready."

## Ledger boundary

The evidence ledger is a best-effort-redacted, self-consistency-checked index of claims and pointers. It is not the underlying proof or an authenticated audit log.

- A command string does not prove the command ran.
- Exit code `0` does not prove the command exercised the intended behavior.
- The unkeyed hash chain detects edits whose hashes were not recomputed and accidental corruption. A writer who can replace the full ledger can recompute a valid chain, so it does not prove authorship or reveal every rewrite.
- Point to durable logs, test output, artifacts, commit IDs, runtime IDs, or owner decisions when the claim matters.

The helper redacts several common token, credential, and sensitive-path shapes on a best-effort basis; regex filtering cannot guarantee discovery of every secret. Do not pass raw secrets to the helper. Keep sensitive evidence in the system that already owns its access controls and persist only a safe pointer.

## Truth class

Label whether a claim is descriptive (what exists or happened) or normative (what is required or permitted). Current source may establish descriptive behavior while still violating a normative contract.
