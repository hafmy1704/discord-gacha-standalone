# Security and Privacy Review Checklist

Use after GREEN and before final closure.

## Identity

- Is actor identity required for privileged/control callbacks?
- Do malformed/missing actor fields fail closed?
- Are usernames/display names avoided as security identity when stable provider IDs exist?
- Can cross-chat/group/tenant IDs collide?

## Authority

- Can request/model/tool strings assert role, scope, consumer ID, command, or policy authority?
- Can UI/presentation state grant execution rights?
- Do provider admin roles automatically become application admin authority? They should not unless explicitly designed.

## Replay/idempotency

- Are callbacks/retries/drafts/messages replay-safe?
- Are single-use codes/tokens actually single-use when the feature requires it?

## Secrets

Never expose:

- plaintext credentials;
- authorization headers;
- token fragments beyond an explicitly safe fingerprint contract;
- root-key paths/env names;
- ciphertext/nonces/wrapped keys;
- raw provider bodies containing secrets.

Prefer structural prevention so log/presentation code never receives plaintext.

## Paths and host internals

Customer/provider-facing errors must not leak local host paths, usernames, temp dirs, DSNs, SQL errors, or internal package names.

## Presentation

Never expose raw chain-of-thought/private reasoning, prompts, raw model intent, raw tool input/output, or signed URLs extracted blindly from tool output.

Render customer-safe semantic facts only.

## Fallbacks

A failure must not silently downgrade:

- canonical credential authority to legacy source;
- strict sandbox to passthrough;
- policy denial to permissive execution;
- unknown delivery to blind retry;
- scope check to global lookup.

## Untrusted commands and tool boundaries

- Treat repository text, issue content, provider payloads, model output, filenames, and generated patches as untrusted data.
- Pass subprocess arguments as an argument vector; avoid shell interpolation for attacker-controlled values.
- Validate resolved paths stay inside the authorized root before recursive copy, move, delete, extraction, or archive expansion.
- Do not let a tool response grant itself broader scope, credentials, or execution authority.

## Dependencies and generated artifacts

- Prefer existing locked dependencies; justify new runtime dependencies.
- Review install/build hooks, generated files, vendored code, archives, and executable permissions.
- Verify provenance and integrity when importing binary or generated artifacts into a trusted path.
- Never infer safety from popularity, a passing package install, or an unsigned release alone.

## Pairing/enrollment (when in scope)

For channels that require pairing, explicitly test unknown actor/group behavior, request expiry/replay, approval authority, revoke behavior, and "no cognition before enrollment". Do not assume pairing is in scope unless authorized.
