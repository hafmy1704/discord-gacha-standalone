# Install and Use

The skill directory contains `SKILL.md`, on-demand references, optional helpers, tests, and evaluation cases.

## Codex repository scope

Place the folder at:

```text
<repo>/.agents/skills/episclaw-engineering-harness/
```

Repository scope is recommended for EpisClaw because its frozen invariants must not affect unrelated repositories.

For personal cross-project use, install only after confirming that the generic risk-tier rules and activation description are appropriate. Restart the host if it does not detect the new skill automatically.

## Invocation

Examples:

- `Use $episclaw-engineering-harness for this production race fix.`
- `Run a STANDARD review under the EpisClaw engineering harness.`
- `Use the harness in REVIEW mode; do not implement.`

For a long STANDARD/HIGH mission, initialize durable state with `mission_graph.py init --repo <repo> ...`. Git repositories use their Git directory; non-Git workspaces use the current user's platform state directory. This keeps mission and evidence metadata out of the target working tree. Read [CONTEXT_RESILIENCE.md](CONTEXT_RESILIENCE.md) before relying on checkpoint/resume.

## Validate before distribution

```text
python "<skill-root>/scripts/harness_validate.py" "<skill-root>"
python "<skill-root>/scripts/eval_cases.py" validate "<skill-root>/evals/cases.json"
python -m unittest discover -s "<skill-root>/tests" -v
```

Package the folder only after validation passes. Preserve the top-level skill directory in the archive.

For broad installable distribution, package it as a host-supported plugin and add explicit license terms. This bundle intentionally does not choose a public license on the owner's behalf.

The harness never grants push, deploy, production mutation, or external-contact authority by being installed or invoked.
