# Project Verification Profile Template

Create a project-local profile only when repeated work would otherwise rediscover the same commands and boundaries. Keep commands executable from the repository root and do not copy secrets into the profile.

```yaml
schema_version: 1
project: <name>
default_risk_tier: standard
default_branch: <auto-or-name>

commands:
  focused_test: <command with documented target placeholder>
  adjacent_test: <command>
  integration_test: <command or null>
  full_test: <command or null>
  build: <command or null>
  typecheck: <command or null>
  lint: <command or null>
  format_check: <command or null>
  static_analysis: <command or null>
  race: <command or null>
  migration_up: <command or null>
  migration_down: <command or null>

scope:
  normal_roots:
    - <path-prefix>
  sensitive_roots:
    - <path-prefix>
  forbidden_without_owner:
    - <path-prefix>

proof:
  frozen_suites:
    - <command>
  runtime_probe: <command or null>
  deployed_artifact_identity: <method or null>
```

## Rules

- `null` means unavailable, not passed.
- Document placeholders such as `{test_path}`; never guess substitutions.
- Keep production credentials and secret values outside the profile.
- Treat a profile as configuration, not authority to deploy or mutate external state.
- Update the profile when commands change; a stale profile is a failed preflight finding.
