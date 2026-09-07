# Capability / Current-Truth Matrix Template

Use during PREFLIGHT for adapters, subsystems, or product surfaces.

Allowed status vocabulary:

- PROVEN
- SOURCE-VERIFIED
- TEST-VERIFIED
- RUNTIME-VERIFIED
- PARTIAL
- MISSING
- BROKEN
- CONFIG-DEPENDENT
- UNKNOWN

| Capability | Descriptive truth | Normative authority | Execution owner | Evidence | Status | First divergence / debt |
|---|---|---|---|---|---|---|
| | | | | | | |

Do not use `SUPPORTED` as a synonym for `PROVEN` unless the evidence really proves the intended runtime behavior.

When adapters or product surfaces share a capability, add one row per semantic capability and map provider-specific support underneath it. Do not duplicate core authority into each adapter.
